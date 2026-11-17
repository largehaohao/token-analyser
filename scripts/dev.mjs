import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enginePort = Number.parseInt(process.env.PORT ?? "7789", 10) || 7789;

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
  detached: true,
});

try {
  await waitForPort(enginePort);
} catch (err) {
  killTree(engine);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const web = spawn("pnpm", ["--filter", "web", "dev"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
  detached: true,
});

function killTree(child) {
  if (child.pid == null || child.exitCode != null) return;
  try {
    // Negative pid signals the whole process group (pnpm → node → tsx/vite),
    // so restarts do not leave orphaned engines holding the port.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function shutdown(code = 0) {
  killTree(engine);
  killTree(web);
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
