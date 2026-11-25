import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchEngine } from "./start-engine.mjs";
import { viteCli } from "./web-build.mjs";

function defaultLogFile() {
  const home = process.env.TOKEN_ANALYSER_HOME ?? path.join(homedir(), ".token-analyser");
  return path.join(home, "dev-supervisor.log");
}

function exitDescription(code, signal) {
  return signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
}

export function createDevSupervisor(options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const enginePort = Number.parseInt(env.PORT ?? "", 10) || 7789;
  const stdio = ["inherit", "inherit", "inherit", "ipc"];
  const engineFactory = options.engineFactory ?? launchEngine;
  const webFactory = options.webFactory ?? ((command, args, childOptions) => spawn(command, args, childOptions));
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const logFile = options.logFile ?? defaultLogFile();
  const log = options.log ?? ((message) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.error(line);
    try {
      mkdirSync(path.dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${line}\n`);
    } catch {
      return;
    }
  });

  let engine;
  let web;
  let engineTimer;
  let webTimer;
  let engineDelayMs = 250;
  let webDelayMs = 250;
  let listening = false;
  let proxyWaiting = false;
  let stopping = false;

  function sendWeb(message) {
    if (web?.connected) web.send(message);
  }

  function notifyProxy() {
    if (!listening || !proxyWaiting) return;
    proxyWaiting = false;
    sendWeb({ type: "engine-listening" });
  }

  function scheduleEngineRestart() {
    if (stopping || engineTimer) return;
    const delayMs = engineDelayMs;
    engineDelayMs = Math.min(engineDelayMs * 2, 5_000);
    log(`engine exited unexpectedly; restarting in ${delayMs}ms`);
    engineTimer = setTimer(() => {
      engineTimer = undefined;
      if (!stopping) startEngine();
    }, delayMs);
  }

  function scheduleWebRestart() {
    if (stopping || webTimer) return;
    const delayMs = webDelayMs;
    webDelayMs = Math.min(webDelayMs * 2, 5_000);
    log(`web exited unexpectedly; restarting in ${delayMs}ms`);
    webTimer = setTimer(() => {
      webTimer = undefined;
      if (!stopping) startWeb();
    }, delayMs);
  }

  function startEngine() {
    if (stopping) return;
    const child = engineFactory({
      ...env,
      PORT: String(enginePort),
      TOKEN_ANALYSER_MANAGED_DEV: "1",
    }, { stdio });
    engine = child;
    let finished = false;
    child.on("message", (message) => {
      if (engine !== child || message?.type !== "listening") return;
      listening = true;
      engineDelayMs = 250;
      proxyWaiting = true;
      notifyProxy();
    });
    child.on("error", (error) => {
      if (finished || engine !== child || stopping) return;
      finished = true;
      engine = undefined;
      log(`engine process error: ${error.message}`);
      listening = false;
      sendWeb({ type: "engine-down" });
      proxyWaiting = true;
      scheduleEngineRestart();
    });
    child.once("exit", (code, signal) => {
      if (engine !== child) return;
      finished = true;
      engine = undefined;
      if (stopping) return;
      listening = false;
      sendWeb({ type: "engine-down" });
      proxyWaiting = true;
      log(`engine exited (${exitDescription(code, signal)})`);
      scheduleEngineRestart();
    });
  }

  function startWeb() {
    if (stopping) return;
    const child = webFactory(process.execPath, [viteCli(), ...argv], {
      cwd: fileURLToPath(new URL("../apps/web/", import.meta.url)),
      stdio,
      env: {
        ...env,
        TOKEN_ANALYSER_MANAGED_DEV: "1",
        TOKEN_ANALYSER_API_URL: env.TOKEN_ANALYSER_API_URL ?? `http://127.0.0.1:${enginePort}`,
      },
    });
    web = child;
    let finished = false;
    proxyWaiting = false;
    child.on("message", (message) => {
      if (web !== child || message?.type !== "proxy-waiting") return;
      proxyWaiting = true;
      notifyProxy();
    });
    child.on("error", (error) => {
      if (finished || web !== child || stopping) return;
      finished = true;
      web = undefined;
      proxyWaiting = false;
      log(`web process error: ${error.message}`);
      scheduleWebRestart();
    });
    child.once("exit", (code, signal) => {
      if (web !== child) return;
      finished = true;
      web = undefined;
      proxyWaiting = false;
      if (stopping) return;
      log(`web exited (${exitDescription(code, signal)})`);
      scheduleWebRestart();
    });
  }

  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    if (engineTimer) clearTimer(engineTimer);
    if (webTimer) clearTimer(webTimer);
    for (const child of [engine, web]) {
      if (child && child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    }
    process.exitCode = code;
  }

  return {
    start() {
      startEngine();
      startWeb();
    },
    stop,
  };
}
