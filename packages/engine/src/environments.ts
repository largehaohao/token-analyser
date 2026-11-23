import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { withPricingLock } from "./pricing-lock.ts";
import { tokenAnalyserHome } from "./config.ts";
import { collectSessionFiles } from "./session-files.ts";
import { SessionStore } from "./store.ts";
import { fileFingerprint, fingerprintsMatch, type FileFingerprint } from "./store-dump.ts";
import { readRemoteSyncState, writeRemoteSyncState } from "./store-db.ts";

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

type RemoteRoot = { remote: string; local: string; kind: "dir" | "file" | "sqlite" };

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
  { remote: ".config/Cursor/User/globalStorage/state.vscdb", local: "cursor/global/state.vscdb", kind: "sqlite" },
  { remote: ".local/share/opencode/opencode.db", local: "opencode/opencode.db", kind: "sqlite" },
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

export type EnvironmentSync = { syncedAt: number | null; failed: boolean; refreshing?: boolean };

export type SessionEnvironmentSource = {
  prepare(id: string, opts?: { force?: boolean }): Promise<SessionStore>;
  status?(id: string): EnvironmentSync | undefined;
};

export class EnvironmentRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const FRESH_MS = 15_000;

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

async function discoverRemoteRoots(runner: CommandRunner): Promise<{ home: string; roots: Set<RemoteRoot> }> {
  const checks = SSH_SESSION_ROOTS.map((root) =>
    `if test ${root.kind === "dir" ? "-d" : "-f"} "$HOME/${root.remote}"; then printf 1; else printf 0; fi`);
  const result = await runner(ssh(`printf '%s\\n' "$HOME"; ${checks.join("; ")}; printf '\\n'`));
  if (result.code !== 0) throw new Error(result.stderr.trim().slice(0, 500) || "ssh failed");
  const [home, mask] = result.stdout.trim().split(/\r?\n/);
  if (mask?.length !== SSH_SESSION_ROOTS.length || !/^[01]+$/.test(mask)) {
    throw new Error("incomplete remote session directory listing");
  }
  return { home: assertHome(home ?? ""), roots: new Set(SSH_SESSION_ROOTS.filter((_, i) => mask[i] === "1")) };
}

async function sqliteGeneration(runner: CommandRunner, root: RemoteRoot): Promise<string> {
  const result = await runner(ssh(
    `db="$HOME/${root.remote}"; for f in "$db" "$db-wal"; do ` +
    'if test -f "$f"; then stat -c "%i %s %y %z" "$f" || stat -f "%i %z %m %c" "$f" || exit 2; ' +
    'else printf "missing\\n"; fi; done',
  ));
  if (result.code !== 0) throw new Error(`could not verify SQLite generation: ${root.remote}`);
  return result.stdout;
}

async function syncSqlite(
  runner: CommandRunner,
  home: string,
  root: RemoteRoot,
  local: string,
  transport: string,
  generations?: Map<string, string>,
): Promise<void> {
  const liveDir = path.dirname(local);
  const parent = path.dirname(liveDir);
  const name = path.basename(local);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // The live directory is only replaced after both files have been read from
  // one remote generation. SQLite rebuilds its local shared-memory index.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await sqliteGeneration(runner, root);
    if (generations?.get(local) === before && existsSync(local)) return;
    const staging = mkdtempSync(path.join(parent, `.${path.basename(liveDir)}-`));
    const next = path.join(staging, "next");
    const previous = path.join(staging, "previous");
    mkdirSync(next, { mode: 0o700 });
    try {
      const result = await runner([
        "rsync", "-a", "--checksum",
        ...(existsSync(liveDir) ? [`--link-dest=${liveDir}`] : []),
        `--include=/${name}`, `--include=/${name}-wal`, "--exclude=*",
        "-e", transport, `${SSH_TARGET}:${home}/${path.posix.dirname(root.remote)}/`, `${next}/`,
      ]);
      const after = await sqliteGeneration(runner, root);
      if (before !== after || result.code === 24) continue;
      if (result.code !== 0) throw new Error(result.stderr.trim().slice(0, 500) || "SQLite rsync failed");
      if (!existsSync(path.join(next, name))) continue;
      if (existsSync(liveDir)) renameSync(liveDir, previous);
      try {
        renameSync(next, liveDir);
      } catch (error) {
        if (existsSync(previous)) renameSync(previous, liveDir);
        throw error;
      }
      generations?.set(local, after);
      return;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  throw new Error(`SQLite changed while copying ${root.remote}`);
}

/**
 * Copy one remote session root into the local mirror. Missing roots are removed
 * locally so a deleted remote directory does not keep showing old sessions.
 * The remote files themselves are only read.
 */
export async function syncSshMirror(opts: {
  runner?: CommandRunner;
  mirror: string;
  sqliteGenerations?: Map<string, string>;
}): Promise<string[]> {
  const runner = opts.runner ?? spawnCommand;
  const { home, roots } = await discoverRemoteRoots(runner);
  const sshTransport = ["ssh", ...SSH_OPTS].join(" ");
  const copied: string[] = [];
  mkdirSync(opts.mirror, { recursive: true, mode: 0o700 });
  for (const root of SSH_SESSION_ROOTS) {
    const local = path.join(opts.mirror, root.local);
    if (!roots.has(root)) {
      rmSync(local, { recursive: true, force: true });
      if (root.kind === "sqlite") {
        opts.sqliteGenerations?.delete(local);
        for (const suffix of ["-wal", "-shm"]) rmSync(local + suffix, { force: true });
      }
      continue;
    }
    if (root.kind === "sqlite") {
      await syncSqlite(runner, home, root, local, sshTransport, opts.sqliteGenerations);
      copied.push(local);
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

type RemoteEntry = {
  store: SessionStore;
  syncedAt: number | null;
  failedAt: number | null;
  hasSnapshot: boolean;
  home: string;
  mirror: string;
  sqliteGenerations: Map<string, string>;
};

/**
 * One local store per remote machine. A short fresh window lets the overview
 * and the session list share a single sync.
 */
export class RemoteEnvironmentHub {
  private readonly entries = new Map<string, RemoteEntry>();
  private readonly restoring = new Map<string, Promise<RemoteEntry>>();
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
    if (sessionEnvironment(id)?.kind !== "ssh") throw new EnvironmentRequestError(400, "invalid_environment");
    const entry = this.entries.get(id) ?? await this.openEntry(id);
    const age = entry.syncedAt == null ? Infinity : this.now() - entry.syncedAt;
    if (!opts?.force && age >= 0 && age < this.freshMs) return entry.store;
    if (!opts?.force && entry.hasSnapshot) {
      if (!this.flights.has(id) && (entry.failedAt == null || this.now() - entry.failedAt >= this.freshMs)) {
        void this.synchronize(id, entry).catch((error) => {
          console.error(`environment ${id}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return entry.store;
    }
    return this.synchronize(id, entry);
  }

  private openEntry(id: string): Promise<RemoteEntry> {
    const active = this.restoring.get(id);
    if (active) return active;
    const task = this.restore(id).then((entry) => {
      this.entries.set(id, entry);
      return entry;
    }).finally(() => this.restoring.delete(id));
    this.restoring.set(id, task);
    return task;
  }

  private async restore(id: string): Promise<RemoteEntry> {
    const home = path.join(tokenAnalyserHome(), "remotes", id);
    const mirror = path.join(home, "mirror");
    const store = new SessionStore({ cacheDir: path.join(home, "cache") });
    const entry: RemoteEntry = {
      home, mirror, store, hasSnapshot: false, syncedAt: null, failedAt: null, sqliteGenerations: new Map(),
    };
    await store.restoreForStartup();
    entry.hasSnapshot = store.restoredIndex;
    if (!entry.hasSnapshot && existsSync(mirror)) {
      const files = collectSessionFiles([mirror]);
      if (files.length) {
        await this.readMirror(entry, files);
        entry.hasSnapshot = store.peekRootIds().length > 0;
        store.dump();
      }
    }
    if (entry.hasSnapshot) {
      try {
        const state = JSON.parse(readRemoteSyncState(home) ?? "null") as {
          syncedAt: number; databases: Record<string, { remote: string; local: FileFingerprint }>;
        } | null;
        if (state && Number.isFinite(state.syncedAt)) entry.syncedAt = state.syncedAt;
        for (const root of SSH_SESSION_ROOTS.filter((root) => root.kind === "sqlite")) {
          const saved = state?.databases?.[root.local];
          const local = path.join(mirror, root.local);
          if (saved && existsSync(local) && fingerprintsMatch(saved.local, fileFingerprint(local))) {
            entry.sqliteGenerations.set(local, saved.remote);
          }
        }
      } catch { /* Older mirrors have no recorded sync time or generation stamps. */ }
    }
    return entry;
  }

  private synchronize(id: string, entry: RemoteEntry): Promise<SessionStore> {
    const active = this.flights.get(id);
    if (active) return active;
    const run = this.sync(entry).catch((error: unknown) => {
      entry.failedAt = this.now();
      throw error;
    }).finally(() => this.flights.delete(id));
    this.flights.set(id, run);
    return run;
  }

  status(id: string): EnvironmentSync | undefined {
    const entry = this.entries.get(id);
    return entry && {
      syncedAt: entry.syncedAt, failed: entry.failedAt != null,
      ...(this.flights.has(id) ? { refreshing: true } : {}),
    };
  }

  private async readMirror(entry: RemoteEntry, files: string[]): Promise<void> {
    entry.store.refresh([], { retainPaths: files });
    for (const file of files) {
      if (entry.store.needsStartupIngest(file)) await entry.store.ingestPathBatched(file, { reparse: true });
    }
  }

  private async sync(entry: RemoteEntry): Promise<SessionStore> {
    await syncSshMirror({
      runner: this.runner, mirror: entry.mirror, sqliteGenerations: entry.sqliteGenerations,
    });
    await this.readMirror(entry, collectSessionFiles([entry.mirror]));
    await withPricingLock(() => entry.store.repriceInBackground());
    entry.store.dump({ force: !entry.store.restoredIndex });
    const databases: Record<string, { remote: string; local: FileFingerprint }> = {};
    for (const [local, remote] of entry.sqliteGenerations) {
      databases[path.relative(entry.mirror, local)] = { remote, local: fileFingerprint(local) };
    }
    const syncedAt = this.now();
    writeRemoteSyncState(entry.home, JSON.stringify({ syncedAt, databases }));
    entry.syncedAt = syncedAt;
    entry.failedAt = null;
    entry.hasSnapshot = true;
    void entry.store.pruneCache().catch((error) => console.error("remote cache cleanup failed", error));
    return entry.store;
  }
}
