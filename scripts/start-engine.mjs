import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/engine",
);
const proxyConfigured = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
].some((name) => Boolean(process.env[name]));
const proxyFlagSupported = process.allowedNodeEnvironmentFlags.has(
  "--use-env-proxy",
);
const args = [
  ...(proxyConfigured && proxyFlagSupported ? ["--use-env-proxy"] : []),
  "--import",
  "tsx",
  "src/server.ts",
];

if (proxyConfigured && !proxyFlagSupported) {
  console.warn(
    "This Node.js version cannot use the configured proxy for model price updates.",
  );
}

const engine = spawn(process.execPath, args, {
  cwd: engineDir,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => engine.kill(signal));
}

engine.on("exit", (code, signal) => {
  process.exitCode =
    code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
