import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tokenAnalyserHome } from "./config.ts";
import { collectSessionFiles } from "./session-files.ts";
import { SessionStore } from "./store.ts";

/** Machines the dashboard can read sessions from. Ids are stable query values. */
export const LOCAL_ENVIRONMENT_ID = "local";
export const REMOTE_ENVIRONMENT_ID = "192.168.1.102";

export type SessionEnvironmentInfo = {
  id: string;
  label: string;
  kind: "local" | "ssh";
};

const SSH_TARGET = "john@192.168.1.102";
const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=yes",
];

type RemoteRoot = { remote: string; local: string; kind: "dir" | "file" };

/** Session roots on the remote home, mirrored under the local cache. */
export const SSH_SESSION_ROOTS: RemoteRoot[] = [
  { remote: ".codex/sessions", local: "codex/sessions", kind: "dir" },
  { remote: ".claude/projects", local: "claude/projects", kind: "dir" },
  { remote: ".pi/agent/sessions", local: "pi/sessions", kind: "dir" },
  { remote: ".gemini/antigravity/brain", local: "antigravity/brain", kind: "dir" },
  { remote: ".gemini/antigravity/annotations", local: "antigravity/annotations", kind: "dir" },
  { remote: ".gemini/antigravity/conversation_summaries.db", local: "antigravity/conversation_summaries.db", kind: "file" },
  { remote: ".gemini/antigravity-cli/brain", local: "antigravity-cli/brain", kind: "dir" },
  { remote: ".gemini/antigravity-cli/annotations", local: "antigravity-cli/annotations", kind: "dir" },
  { remote: ".gemini/antigravity-cli/conversation_summaries.db", local: "antigravity-cli/conversation_summaries.db", kind: "file" },
  { remote: ".gemini/antigravity-ide/brain", local: "antigravity-ide/brain", kind: "dir" },
  { remote: ".gemini/antigravity-ide/annotations", local: "antigravity-ide/annotations", kind: "dir" },
  { remote: ".gemini/antigravity-ide/conversation_summaries.db", local: "antigravity-ide/conversation_summaries.db", kind: "file" },
  { remote: ".dsh/sessions", local: "dsh/sessions", kind: "dir" },
  { remote: ".cursor/projects", local: "cursor/projects", kind: "dir" },
  { remote: ".cursor/chats", local: "cursor/chats", kind: "dir" },
  { remote: ".config/Cursor/User/workspaceStorage", local: "cursor/workspaceStorage", kind: "dir" },
  { remote: ".config/Cursor/User/globalStorage/state.vscdb", local: "cursor/global/state.vscdb", kind: "file" },
  { remote: ".local/share/opencode/opencode.db", local: "opencode/opencode.db", kind: "file" },
  { remote: ".local/share/opencode/opencode.db-wal", local: "opencode/opencode.db-wal", kind: "file" },
  { remote: ".local/share/opencode/opencode.db-shm", local: "opencode/opencode.db-shm", kind: "file" },
];

export const SESSION_ENVIRONMENTS: SessionEnvironmentInfo[] = [
  { id: LOCAL_ENVIRONMENT_ID, label: "本机", kind: "local" },
  { id: REMOTE_ENVIRONMENT_ID, label: "192.168.1.102", kind: "ssh" },
];

export function isSessionEnvironment(id: string): boolean {
  return SESSION_ENVIRONMENTS.some((item) => item.id === id);
}

export function sessionEnvironment(id: string): SessionEnvironmentInfo | undefined {
  return SESSION_ENVIRONMENTS.find((item) => item.id === id);
}

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export function spawnCommand(argv: string[], timeoutMs = 180_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`command timed out: ${argv[0]}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export type SessionEnvironmentSource = {
  prepare(id: string, opts?: { force?: boolean }): Promise<SessionStore>;
};

export class EnvironmentRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const FRESH_MS = 15_000;
const HEAVY_BYTES = 10 * 1024 * 1024;

function ssh(command: string): string[] {
  return ["ssh", ...SSH_OPTS, SSH_TARGET, command];
}

function assertHome(home: string): string {
  const trimmed = home.trim();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(trimmed)) {
    throw new Error("unexpected remote home");
  }
  return trimmed;
}

async function remoteHome(runner: CommandRunner): Promise<string> {
  const result = await runner(ssh('printf %s "$HOME"'));
  if (result.code !== 0) {
    throw new Error(result.stderr.trim().slice(0, 500) || "ssh failed");
  }
  return assertHome(result.stdout);
}

async function remoteExists(runner: CommandRunner, home: string, root: RemoteRoot): Promise<boolean> {
  const flag = root.kind === "dir" ? "-d" : "-f";
  const result = await runner(ssh(`test ${flag} "$HOME/${root.remote}"`));
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(result.stderr.trim().slice(0, 500) || `cannot stat ${home}/${root.remote}`);
}

function isHeavy(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base === "state.vscdb" || base === "opencode.db") return true;
  try {
    return statSync(filePath).size >= HEAVY_BYTES;
  } catch {
    return false;
  }
}

/**
 * Copy one remote session root into the local mirror. Missing roots are removed
 * locally so a deleted remote directory does not keep showing old sessions.
 * The remote files themselves are only read.
 */
export async function syncSshMirror(opts: {
  runner?: CommandRunner;
  mirror: string;
}): Promise<string[]> {
  const runner = opts.runner ?? spawnCommand;
  const home = await remoteHome(runner);
  const sshTransport = ["ssh", ...SSH_OPTS].join(" ");
  const copied: string[] = [];
  mkdirSync(opts.mirror, { recursive: true, mode: 0o700 });
  for (const root of SSH_SESSION_ROOTS) {
    const local = path.join(opts.mirror, root.local);
    if (!await remoteExists(runner, home, root)) {
      rmSync(local, { recursive: true, force: true });
      continue;
    }
    mkdirSync(root.kind === "dir" ? local : path.dirname(local), { recursive: true, mode: 0o700 });
    const remotePath = `${SSH_TARGET}:${home}/${root.remote}${root.kind === "dir" ? "/" : ""}`;
    const localPath = root.kind === "dir" ? `${local}/` : local;
    const argv = ["rsync", "-a", "--exclude", "node_modules", "--exclude", ".git", "--exclude", "transcript_full.jsonl", "--exclude", "chunks"];
    if (root.kind === "dir") argv.push("--delete");
    argv.push("-e", sshTransport, remotePath, localPath);
    const result = await runner(argv);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim().slice(0, 500) || `rsync failed (${result.code})`);
    }
    copied.push(local);
  }
  return copied;
}

type RemoteEntry = { store: SessionStore; syncedAt: number; mirror: string };

/**
 * One local store per remote machine. A short fresh window lets the overview
 * and the session list share a single sync.
 */
export class RemoteEnvironmentHub {
  private readonly entries = new Map<string, RemoteEntry>();
  private readonly flights = new Map<string, Promise<SessionStore>>();
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private readonly freshMs: number;

  constructor(opts?: { runner?: CommandRunner; now?: () => number; freshMs?: number }) {
    this.runner = opts?.runner ?? spawnCommand;
    this.now = opts?.now ?? Date.now;
    this.freshMs = opts?.freshMs ?? FRESH_MS;
  }

  async prepare(id: string, opts?: { force?: boolean }): Promise<SessionStore> {
    const spec = sessionEnvironment(id);
    if (!spec || spec.kind !== "ssh") {
      throw new EnvironmentRequestError(400, "invalid_environment");
    }
    const current = this.entries.get(id);
    const fresh = current != null && this.now() - current.syncedAt < this.freshMs;
    if (!opts?.force && fresh) return current.store;
    const start = () => {
      const flight = this.flights.get(id);
      if (flight) return flight;
      const run = this.sync(id).finally(() => {
        if (this.flights.get(id) === run) this.flights.delete(id);
      });
      this.flights.set(id, run);
      return run;
    };
    // A mirror is already on disk. Answer with it and refresh behind the request
    // so switching machines does not sit on the loading spinner for the rsync.
    if (!opts?.force && current && current.syncedAt > 0) {
      void start();
      return current.store;
    }
    return start();
  }

  private async sync(id: string): Promise<SessionStore> {
    const home = path.join(tokenAnalyserHome(), "remotes", id);
    let entry = this.entries.get(id);
    if (!entry) {
      const store = new SessionStore({ cacheDir: path.join(home, "cache") });
      try {
        store.loadDump();
      } catch {
        // A damaged remote dump must not block a fresh read.
      }
      entry = { store, syncedAt: 0, mirror: path.join(home, "mirror") };
      this.entries.set(id, entry);
    }
    await syncSshMirror({ runner: this.runner, mirror: entry.mirror });
    const files = collectSessionFiles([entry.mirror]);
    const light: string[] = [];
    const heavy: string[] = [];
    for (const file of files) (isHeavy(file) ? heavy : light).push(file);
    entry.store.refresh(light);
    for (const file of heavy) {
      await entry.store.ingestPathBatched(file);
    }
    entry.syncedAt = this.now();
    return entry.store;
  }
}
