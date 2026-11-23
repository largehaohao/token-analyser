import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EnvironmentRequestError,
  RemoteEnvironmentHub,
  SSH_SESSION_ROOTS,
  isSessionEnvironment,
  syncSshMirror,
  type CommandResult,
  type CommandRunner,
} from "../src/environments.ts";
import { startServer } from "../src/server.ts";
import { SessionStore } from "../src/store.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted/wait-poll.jsonl",
);
const dirs: string[] = [];

afterEach(() => {
  delete process.env.TOKEN_ANALYSER_HOME;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "env-hub-"));
  dirs.push(dir);
  process.env.TOKEN_ANALYSER_HOME = dir;
  return dir;
}

function rootListing(present: string) {
  return "/home/john\n" + SSH_SESSION_ROOTS.map((root) => root.remote === present ? "1" : "0").join("") + "\n";
}

function runner(copied: string[]): CommandRunner {
  return async (argv): Promise<CommandResult> => {
    if (argv[0] === "ssh") {
      const command = argv.at(-1) ?? "";
      if (command.startsWith("printf")) return { code: 0, stdout: rootListing(".codex/sessions"), stderr: "" };
      if (command.includes(".codex/sessions")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    }
    if (argv[0] === "rsync") {
      const source = argv.at(-2) ?? "";
      const dest = argv.at(-1) ?? "";
      if (!source.includes(".codex/sessions")) return { code: 0, stdout: "", stderr: "" };
      mkdirSync(dest, { recursive: true });
      copyFileSync(fixture, path.join(dest, "session.jsonl"));
      copied.push(dest);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(argv.join(" "));
  };
}

describe("session environments", () => {
  it("only accepts the local machine and 192.168.1.102", () => {
    expect(isSessionEnvironment("local")).toBe(true);
    expect(isSessionEnvironment("192.168.1.102")).toBe(true);
    expect(isSessionEnvironment("192.168.1.103")).toBe(false);
    expect(isSessionEnvironment("john@192.168.1.102")).toBe(false);
  });

  it("mirrors a remote session root and analyses it locally", async () => {
    home();
    const copied: string[] = [];
    const hub = new RemoteEnvironmentHub({ runner: runner(copied), freshMs: 60_000 });
    const store = await hub.prepare("192.168.1.102");
    expect(copied).toHaveLength(1);
    expect(store.list().map((item) => item.id)).toContain("s-poll");
    const again = await hub.prepare("192.168.1.102");
    expect(again).toBe(store);
    expect(copied).toHaveLength(1);
  });

  it("serves the last snapshot after a background SSH failure and can retry", async () => {
    home();
    let now = 10;
    let offline = false;
    const successful = runner([]);
    const hub = new RemoteEnvironmentHub({
      now: () => now,
      freshMs: 15,
      runner: async (argv) => offline ? { code: 255, stdout: "", stderr: "offline" } : successful(argv),
    });
    const first = await hub.prepare("192.168.1.102");
    now = 26;
    offline = true;
    expect(await hub.prepare("192.168.1.102")).toBe(first);
    await vi.waitFor(() => expect(hub.status("192.168.1.102")).toEqual({ syncedAt: 10, failed: true }));
    offline = false;
    expect(await hub.prepare("192.168.1.102", { force: true })).toBe(first);
    expect(hub.status("192.168.1.102")).toEqual({ syncedAt: 26, failed: false });
  });

  it("mirrors Cursor commits in the WAL and retries if the generation changes", async () => {
    const dir = home();
    const source = path.join(dir, "state.vscdb");
    const original = new DatabaseSync(source);
    let copied = 0;
    let checked = 0;
    try {
      original.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE test (id INTEGER); PRAGMA wal_checkpoint(TRUNCATE);");
      original.exec("INSERT INTO test VALUES (1);");
      const files = await syncSshMirror({
        mirror: path.join(dir, "mirror"),
        runner: async (argv) => {
          const command = argv.at(-1)!;
          if (argv[0] === "ssh") {
            if (command.startsWith("printf")) return { code: 0, stdout: rootListing(".config/Cursor/User/globalStorage/state.vscdb"), stderr: "" };
            if (command.startsWith("db=")) {
              checked += 1;
              return { code: 0, stdout: checked === 1 ? "generation-a" : "generation-b", stderr: "" };
            }
            return { code: command.includes("globalStorage/state.vscdb") ? 0 : 1, stdout: "", stderr: "" };
          }
          expect(argv).toContain("--include=/state.vscdb-wal");
          copyFileSync(source, path.join(command, "state.vscdb"));
          copyFileSync(source + "-wal", path.join(command, "state.vscdb-wal"));
          copied += 1;
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      expect(copied).toBe(2);
      const mirror = new DatabaseSync(files[0]!, { readOnly: true });
      try {
        expect(mirror.prepare("SELECT id FROM test").get()?.id).toBe(1);
      } finally {
        mirror.close();
      }
    } finally {
      original.close();
    }
  });

  it("serves the persisted mirror across a process restart while SSH is still pending", async () => {
    home();
    let now = 100;
    const first = new RemoteEnvironmentHub({ runner: runner([]), now: () => now, freshMs: 10 });
    const source = await first.prepare("192.168.1.102");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const calls = vi.fn(async () => {
      await pending;
      return { code: 255, stdout: "", stderr: "offline" };
    });
    const restarted = new RemoteEnvironmentHub({ runner: calls, now: () => now, freshMs: 10 });
    const cached = await restarted.prepare("192.168.1.102");
    expect(cached.list()).toEqual(source.list());
    expect(calls).not.toHaveBeenCalled();
    now += 20;
    try {
      expect(await restarted.prepare("192.168.1.102")).toBe(cached);
      expect(restarted.status("192.168.1.102")).toEqual({ syncedAt: 100, refreshing: true, failed: false });
    } finally {
      release();
    }
    await vi.waitFor(() => expect(restarted.status("192.168.1.102")).toEqual({ syncedAt: 100, failed: true }));
    expect(cached.get("s-poll")?.cost).toEqual(source.get("s-poll")?.cost);
  });

  it("refuses an unknown environment before opening a connection", async () => {
    home();
    const hub = new RemoteEnvironmentHub({
      runner: async () => {
        throw new Error("ssh should not run");
      },
    });
    await expect(hub.prepare("other-host")).rejects.toMatchObject({
      status: 400,
      code: "invalid_environment",
    });
  });

  it("reports a failed ssh connection", async () => {
    home();
    const hub = new RemoteEnvironmentHub({
      runner: async () => ({ code: 255, stdout: "", stderr: "Connection refused" }),
    });
    await expect(hub.prepare("192.168.1.102")).rejects.toThrow(/Connection refused/);
  });

  it("keeps a remote environment out of the local session list", async () => {
    const dir = home();
    const local = new SessionStore({ cacheDir: path.join(dir, "local-cache") });
    const remote = new SessionStore({ cacheDir: path.join(dir, "remote-cache") });
    const file = path.join(dir, "remote.jsonl");
    writeFileSync(file, readFileSync(fixture));
    remote.refresh([file]);
    const server = await startServer({
      port: 0,
      store: local,
      environmentHub: {
        prepare: async (id: string) => {
          if (id !== "192.168.1.102") throw new EnvironmentRequestError(400, "invalid_environment");
          return remote;
        },
      },
    });
    try {
      const localList = await fetch(`${server.url}/sessions`);
      expect(localList.status).toBe(200);
      expect(((await localList.json()) as { sessions: unknown[] }).sessions).toEqual([]);
      const remoteList = await fetch(`${server.url}/sessions?env=192.168.1.102`);
      expect(remoteList.status).toBe(200);
      const body = (await remoteList.json()) as { sessions: { id: string }[] };
      expect(body.sessions.map((item) => item.id)).toContain("s-poll");
      const rejected = await fetch(`${server.url}/sessions?env=10.0.0.8`);
      expect(rejected.status).toBe(400);
      const envs = await fetch(`${server.url}/environments`);
      expect(await envs.json()).toMatchObject({
        environments: [{ id: "local", label: "本机" }, { id: "192.168.1.102", label: "192.168.1.102" }],
      });
    } finally {
      await server.close();
    }
  });
});
