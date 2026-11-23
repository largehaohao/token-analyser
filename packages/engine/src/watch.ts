import { watch, existsSync, readdirSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { loadUserConfig } from "./config.ts";
import type { SessionStore } from "./store.ts";
import { isDiscoveredSessionFile, isSessionFile } from "./session-files.ts";

export type WatchOptions = {
  watchPaths?: string[];
  /** When false, use per-subdirectory watchers instead of recursive fs.watch. */
  recursive?: boolean;
  onError?: (id: string, reason: string) => void;
  /** Files whose initial generation is already queued by the startup scan. */
  startupFiles?: readonly string[];
};

function sessionPath(name: string): string {
  const stem = name.endsWith("-wal") ? name.slice(0, -4) : name;
  return isSessionFile(stem) ? stem : name;
}

export function watchSessions(
  store: SessionStore,
  onChange: (id: string) => void,
  opts?: WatchOptions,
): () => void {
  const watchPaths = (opts?.watchPaths ?? loadUserConfig().watch_paths)
    .map((file) => path.resolve(file));
  const watchers: ReturnType<typeof watch>[] = [];
  const watchedDirs = new Set<string>();
  const directoryRoots = new Set<string>();
  const explicitFiles = new Set(watchPaths);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const observedFiles = new Map<string, string>();
  // fs.watch can miss a create event when a directory is watched immediately
  // before the writer creates its first file.  A short startup rescan closes
  // that race without turning every append into a full directory traversal.
  let startupScan: ReturnType<typeof setTimeout> | undefined;
  let directoryScan: ReturnType<typeof setInterval> | undefined;
  const useRecursive = opts?.recursive ?? true;
  let needsDirectoryScan = !useRecursive;
  let primed = false;

  function ensureDirectoryScan(): void {
    needsDirectoryScan = true;
    if (directoryScan == null) {
      directoryScan = setInterval(scanForSessions, 1_000);
    }
  }

  function errorIdFromPath(filePath: string): string {
    const base = path.basename(filePath);
    return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  }

  async function ingestIfSession(fullPath: string): Promise<void> {
    if (!isDiscoveredSessionFile(fullPath)) return;
    if (!existsSync(fullPath)) {
      observedFiles.delete(fullPath);
      const removed = store.removePath(fullPath);
      if (removed) onChange(removed.id);
      return;
    }
    try {
      const id = await store.ingestPathBatched(fullPath, { allowAppend: true });
      rememberFile(fullPath);
      if (id) onChange(id);
      // The store may have deferred a WAL-only SQLite change to protect the
      // first UI paint. If the WAL then stops changing, that change would be
      // lost forever, so queue one recheck after the cooldown expires.
      const deferredMs = store.sqliteWalReparseDelayMs(fullPath);
      if (deferredMs !== undefined) {
        scheduleIngest(fullPath, deferredMs + 250);
      }
    } catch (err) {
      observedFiles.delete(fullPath);
      opts?.onError?.(
        errorIdFromPath(fullPath),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function ingestDelayMs(fullPath: string): number {
    // Cursor rewrites state.vscdb WAL continuously while the app is open. A
    // 50ms debounce turns every keystroke into a multi-second SQLite reparse
    // that blocks /sessions and freezes the UI.
    if (fullPath.endsWith(".vscdb") || path.basename(fullPath) === "opencode.db") {
      return 5_000;
    }
    try {
      if (statSync(fullPath).size >= 1024 * 1024) return 5_000;
    } catch {
      // Missing files still go through remove handling promptly.
    }
    return 50;
  }

  function scheduleIngest(fullPath: string, delayMs?: number): void {
    fullPath = sessionPath(fullPath);
    if (!isDiscoveredSessionFile(fullPath)) return;
    // A continuously appended file still gets a turn once per window.
    if (pending.has(fullPath)) return;
    const timer = setTimeout(() => {
      pending.delete(fullPath);
      void ingestIfSession(fullPath);
    }, delayMs ?? ingestDelayMs(fullPath));
    pending.set(fullPath, timer);
  }

  function fileSignature(fullPath: string, entry?: Stats): string | undefined {
    try {
      const stat = entry ?? statSync(fullPath);
      let wal = "";
      if (fullPath.endsWith(".vscdb") || path.basename(fullPath) === "opencode.db") {
        try { const st = statSync(`${fullPath}-wal`); wal = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`; } catch { /* No active WAL. */ }
      }
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, wal].join(":");
    } catch {
      return undefined;
    }
  }

  function scheduleIfChanged(fullPath: string, entry?: Stats): void {
    const signature = fileSignature(fullPath, entry);
    if (!signature || observedFiles.get(fullPath) === signature) return;
    observedFiles.set(fullPath, signature);
    // First scan would otherwise re-parse every GB-scale SQLite/JSONL the dump
    // already restored, blocking /sessions for tens of seconds after listen.
    if (!primed && store.canSkipStartupIngest(fullPath)) {
      // Exact matches need nothing. A WAL-only change, however, was deferred
      // rather than ingested: queue the reparse that the cooldown promises.
      const deferredMs = store.sqliteWalReparseDelayMs(fullPath);
      if (deferredMs !== undefined) {
        scheduleIngest(fullPath, deferredMs + 250);
      }
      return;
    }
    scheduleIngest(fullPath);
  }

  function rememberFile(fullPath: string): void {
    const signature = fileSignature(fullPath);
    if (signature) observedFiles.set(fullPath, signature);
    else observedFiles.delete(fullPath);
  }

  function watchDirectory(dir: string): void {
    if (watchedDirs.has(dir)) return;
    watchedDirs.add(dir);
    try {
      const w = watch(dir, (_event, filename) => {
        if (!filename) return;
        const file = sessionPath(path.join(dir, filename));
        if (explicitFiles.has(file) ||
            [...directoryRoots].some((root) => file.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) {
          scheduleIngest(file);
        }
      });
      // An async watcher failure (deleted root, EMFILE) must not become an
      // unhandled 'error' event that kills the engine; fall back to scanning.
      w.on("error", () => {
        watchedDirs.delete(dir);
        try {
          w.close();
        } catch {
          // Already closed.
        }
        ensureDirectoryScan();
      });
      watchers.push(w);
    } catch {
      watchedDirs.delete(dir);
      // An inaccessible directory should not prevent other roots from being watched.
    }
  }

  function scanForSessions(): void {
    const found = new Set<string>();
    const visited = new Set<string>();
    function scanDirectory(dir: string): void {
      if (visited.has(dir)) return;
      visited.add(dir);
      if (needsDirectoryScan) watchDirectory(dir);
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDirectory(file);
          } else if ((entry.isFile() || entry.isSymbolicLink()) && isDiscoveredSessionFile(file)) {
            found.add(file);
            scheduleIfChanged(file);
          }
        }
      } catch {
        // An unreadable directory may return on the next scan.
      }
    }

    for (const root of watchPaths) {
      try {
        const stat = statSync(root);
        if (stat.isDirectory()) {
          directoryRoots.add(root);
          explicitFiles.delete(root);
          scanDirectory(root);
        } else if (stat.isFile() && isDiscoveredSessionFile(root)) {
          explicitFiles.add(root);
          directoryRoots.delete(root);
          found.add(root);
          scheduleIfChanged(root, stat);
        }
      } catch {
        // A log root may be created after startup.
      }
    }
    for (const fullPath of observedFiles.keys()) {
      if (!found.has(fullPath) && !existsSync(fullPath)) ingestIfSession(fullPath);
    }
  }

  for (const root of watchPaths) {
    let stat: Stats;
    try {
      stat = statSync(root);
    } catch {
      needsDirectoryScan = true;
      continue;
    }
    if (stat.isFile()) {
      needsDirectoryScan = true;
      watchDirectory(path.dirname(root));
      continue;
    }
    if (!stat.isDirectory()) continue;
    directoryRoots.add(root);
    explicitFiles.delete(root);
    if (!useRecursive) continue;
    try {
      const w = watch(root, { recursive: true }, (_event, filename) => {
        if (filename) scheduleIngest(path.join(root, filename));
      });
      w.on("error", () => {
        try {
          w.close();
        } catch {
          // Already closed.
        }
        ensureDirectoryScan();
      });
      watchers.push(w);
    } catch {
      needsDirectoryScan = true;
    }
  }

  for (const file of opts?.startupFiles ?? []) rememberFile(file);
  startupScan = setTimeout(() => {
    scanForSessions();
    primed = true;
  }, 25);
  if (needsDirectoryScan) {
    directoryScan = setInterval(scanForSessions, 1_000);
  }

  return () => {
    if (startupScan) clearTimeout(startupScan);
    if (directoryScan) clearInterval(directoryScan);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const w of watchers) w.close();
  };
}
