import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const engine = fileURLToPath(new URL("..", import.meta.url));

async function sessionAfterRestart(home: string): Promise<{ cwd: string; path: string }> {
  const env = { ...process.env, TOKEN_ANALYSER_HOME: home, PORT: "0", PRICING_AUTO_UPDATE: "0", QWEN_PRICING_AUTO_UPDATE: "0" };
  Reflect.deleteProperty(env, "FIXTURE_DIR");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: engine, env, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      exited.then(() => { throw new Error("engine exited before listening"); }),
    ]);
    const url = (message as { url: string }).url;
    await expect.poll(async () => {
      const body = await (await fetch(url + "/sessions")).json() as { indexing?: unknown; sessions: unknown[] };
      return !body.indexing && body.sessions.length === 1;
    }, { timeout: 10_000 }).toBe(true);
    return await (await fetch(url + "/sessions/shared")).json() as { cwd: string; path: string };
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

it("retains discovery precedence on cold and warm startup and reconciles offline edits", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "ledger-startup-"));
  const first = path.join(home, "first.jsonl");
  const second = path.join(home, "second.jsonl");
  function record(cwd: string) {
    return JSON.stringify({ type: "session_meta", timestamp: "2026-08-27T00:00:00Z", payload: { id: "shared", cwd } }) + "\n";
  }
  try {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ watch_paths: [first, second] }));
    writeFileSync(first, record("/previous") + "\n".repeat(4000));
    writeFileSync(second, record("/canonical"));
    expect(await sessionAfterRestart(home)).toMatchObject({ path: second, cwd: "/canonical" });
    expect(await sessionAfterRestart(home)).toMatchObject({ path: second, cwd: "/canonical" });
    writeFileSync(first, record("/edited-shadow"));
    expect(await sessionAfterRestart(home)).toMatchObject({ path: second, cwd: "/canonical" });
    writeFileSync(second, record("/edited-while-closed"));
    expect(await sessionAfterRestart(home)).toMatchObject({ path: second, cwd: "/edited-while-closed" });
    rmSync(second);
    expect(await sessionAfterRestart(home)).toMatchObject({ path: first, cwd: "/edited-shadow" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
