import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchEngine } from "./start-engine.mjs";
import { viteCli } from "./web-build.mjs";

const enginePort = Number.parseInt(process.env.PORT ?? "", 10) || 7789;
const stdio = ["inherit", "inherit", "inherit", "ipc"];
const engine = launchEngine({ ...process.env, PORT: String(enginePort) }, { stdio });
const web = spawn(process.execPath, [viteCli(), ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL("../apps/web/", import.meta.url)),
  stdio,
  env: {
    ...process.env, TOKEN_ANALYSER_MANAGED_DEV: "1",
    TOKEN_ANALYSER_API_URL: process.env.TOKEN_ANALYSER_API_URL ?? `http://127.0.0.1:${enginePort}`,
  },
});

let stopping = false;
let listening = false;
let proxyWaiting = false;
function notifyProxy() {
  if (listening && proxyWaiting && web.connected) {
    proxyWaiting = false;
    web.send({ type: "engine-listening" });
  }
}
engine.on("message", (message) => {
  if (message?.type === "listening") { listening = true; notifyProxy(); }
});
web.on("message", (message) => {
  if (message?.type === "proxy-waiting") { proxyWaiting = true; notifyProxy(); }
});

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of [engine, web]) {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  }
}
for (const child of [engine, web]) {
  child.on("error", (error) => { console.error(error.message); stop(1); });
  child.once("exit", (code) => stop(code ?? 0));
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
