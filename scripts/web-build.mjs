import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNode } from "./node-check.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = path.join(root, "apps/web");
const dist = path.join(web, "dist");
const stamp = path.join(dist, ".build-state.json");

function digest(base, entries) {
  const hash = createHash("sha256");
  function visit(name) {
    const file = path.join(base, name);
    if (file === stamp || !existsSync(file)) return;
    if (statSync(file).isDirectory()) {
      for (const entry of readdirSync(file).sort()) visit(path.join(name, entry));
    } else {
      hash.update(name).update("\0").update(createHash("sha256").update(readFileSync(file)).digest());
    }
  }
  for (const name of entries) visit(name);
  return hash.digest("hex");
}

function buildInputs() {
  const sources = digest(root, [
    "apps/web/src", "apps/web/public", "apps/web/e2e", "apps/web/index.html",
    "apps/web/vite.config.ts", "apps/web/tsconfig.json", "apps/web/package.json",
    "apps/web/.env", "apps/web/.env.local", "apps/web/.env.production", "apps/web/.env.production.local",
    "pnpm-lock.yaml", "tsconfig.base.json", "tokens.css", "scripts/web-build.mjs",
  ]);
  const environment = Object.keys(process.env).filter((key) => key.startsWith("VITE_")).sort()
    .map((key) => [key, process.env[key]]);
  return createHash("sha256").update(JSON.stringify([sources, process.env.NODE_ENV ?? "production", environment])).digest("hex");
}

export function viteCli() {
  const manifest = createRequire(path.join(web, "package.json")).resolve("vite/package.json");
  return path.resolve(path.dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin.vite);
}

export function buildWeb({ reuse = false } = {}) {
  assertSupportedNode();
  const index = path.join(dist, "index.html");
  if (reuse && !existsSync(path.join(web, "src"))) {
    if (existsSync(index) && (!existsSync(stamp) ||
        JSON.parse(readFileSync(stamp, "utf8")).outputs === digest(dist, ["."]))) return;
    throw new Error("Packaged UI assets are incomplete. Reinstall the package to restore them.");
  }
  const inputs = buildInputs();
  if (reuse && existsSync(index) && existsSync(stamp)) {
    try {
      const previous = JSON.parse(readFileSync(stamp, "utf8"));
      if (previous.inputs === inputs && previous.outputs === digest(dist, ["."])) return;
    } catch { /* An incomplete build is rebuilt below. */ }
  }
  const result = spawnSync(process.execPath, [viteCli(), "build"], { cwd: web, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  writeFileSync(stamp, JSON.stringify({ inputs, outputs: digest(dist, ["."]) }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWeb();
