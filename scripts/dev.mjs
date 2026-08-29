import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function waitForPort(port, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: "127.0.0.1" }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for port ${port}`));
          return;
        }
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

const engine = spawn("pnpm", ["--filter", "engine", "start"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

try {
  await waitForPort(7789);
} catch (err) {
  engine.kill();
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const web = spawn("pnpm", ["--filter", "web", "dev"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

function shutdown(code = 0) {
  engine.kill();
  web.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

engine.on("exit", (code) => {
  if (code) shutdown(code);
});
web.on("exit", (code) => {
  if (code) shutdown(code);
});
