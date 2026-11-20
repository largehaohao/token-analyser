import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EnvironmentRequestError,
  RemoteEnvironmentHub,
  isSessionEnvironment,
  type CommandResult,
  type CommandRunner,
} from "../src/environments.ts";
import { startServer } from "../src/server.ts";
import { SessionStore } from "../src/store.ts";

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

function runner(copied: string[]): CommandRunner {
  return async (argv): Promise<CommandResult> => {
    if (argv[0] === "ssh") {
      const command = argv.at(-1) ?? "";
      if (command.includes("printf")) return { code: 0, stdout: "/home/john", stderr: "" };
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
