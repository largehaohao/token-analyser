import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNode } from "./node-check.mjs";

export function launchEngine(env, options = {}) {
  assertSupportedNode();
  const engineDir = fileURLToPath(new URL("../packages/engine/", import.meta.url));
  const proxyConfigured = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].some((key) => env[key]);
  const proxySupported = process.allowedNodeEnvironmentFlags.has("--use-env-proxy");
  if (proxyConfigured && !proxySupported) {
    console.warn("This Node.js version cannot use the configured proxy for model price updates.");
  }
  return spawn(process.execPath, [
    ...(proxyConfigured && proxySupported ? ["--use-env-proxy"] : []),
    "--import", "tsx", "src/server.ts",
  ], { cwd: engineDir, env, stdio: "inherit", ...options });
}

export function runEngine(env = process.env) {
  const engine = launchEngine(env);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => engine.kill(signal));
  engine.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runEngine();
