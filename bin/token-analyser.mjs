#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNode } from "../scripts/node-check.mjs";

assertSupportedNode();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = path.join(root, "packages/engine");
const webDist = path.join(root, "apps/web/dist");
const [command, ...rest] = process.argv.slice(2);

function run(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: engineDir,
    env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exitCode =
      code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}

if (command === "analyse") {
  run(["--import", "tsx", "src/analyse-cli.ts", ...rest], process.env);
} else if (command != null && command !== "serve") {
  console.error("Usage: token-analyser [serve]\n       token-analyser analyse <session.jsonl|state.vscdb|opencode.db> [--json]");
  process.exit(1);
} else {
  if (!existsSync(path.join(webDist, "index.html"))) {
    console.error(
      "UI bundle is missing. From the repository run `pnpm install` and `pnpm build`, then `pnpm exec token-analyser`.",
    );
    process.exit(1);
  }
  const port = process.env.PORT ?? "7788";
  run(["--import", "tsx", "src/server.ts"], {
    ...process.env,
    SERVE_UI: "1",
    PORT: port,
  });
}
