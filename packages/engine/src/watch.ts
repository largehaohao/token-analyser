import { watch, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadUserConfig } from "./config.ts";
import type { SessionStore } from "./store.ts";

export type WatchOptions = {
  watchPaths?: string[];
  /** When false, use per-subdirectory watchers instead of recursive fs.watch. */
  recursive?: boolean;
  onError?: (id: string, reason: string) => void;
};

function isRolloutJsonl(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

function listDirectories(root: string): string[] {
  const dirs = [root];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    const full = path.join(root, entry);
    try {
      if (statSync(full).isDirectory()) {
        dirs.push(...listDirectories(full));
      }
    } catch {
      // skip unreadable entries
    }
  }
  return dirs;
}

export function watchSessions(
  store: SessionStore,
  onChange: (id: string) => void,
  opts?: WatchOptions,
): () => void {
  const watchPaths =
    opts?.watchPaths ?? loadUserConfig().watch_paths;
  const watchers: ReturnType<typeof watch>[] = [];
  const watchedDirs = new Set<string>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const observedFiles = new Map<string, string>();
  // fs.watch can miss a create event when a directory is watched immediately
  // before the writer creates its first file.  A short startup rescan closes
  // that race without turning every append into a full directory traversal.
  let startupScan: ReturnType<typeof setTimeout> | undefined;
  let directoryScan: ReturnType<typeof setInterval> | undefined;
  const useRecursive = opts?.recursive ?? true;
  let needsDirectoryScan = !useRecursive;

  function errorIdFromPath(filePath: string): string {
    const base = path.basename(filePath);
    return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  }

  function ingestIfRollout(fullPath: string): void {
    const base = path.basename(fullPath);
    if (!isRolloutJsonl(base)) return;
    if (!existsSync(fullPath)) {
      observedFiles.delete(fullPath);
      const removed = store.removePath(fullPath);
      if (removed) onChange(removed.id);
      return;
    }
    try {
      const id = store.ingestPath(fullPath, { allowAppend: true });
      rememberFile(fullPath);
      if (id) onChange(id);
    } catch (err) {
      observedFiles.delete(fullPath);
      opts?.onError?.(
        errorIdFromPath(fullPath),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function scheduleIngest(fullPath: string): void {
    const previous = pending.get(fullPath);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      pending.delete(fullPath);
      ingestIfRollout(fullPath);
    }, 50);
    pending.set(fullPath, timer);
  }

  function fileSignature(fullPath: string): string | undefined {
    try {
      const stat = statSync(fullPath);
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    } catch {
      return undefined;
    }
  }

  function scheduleIfChanged(fullPath: string): void {
    const signature = fileSignature(fullPath);
    if (!signature || observedFiles.get(fullPath) === signature) return;
    observedFiles.set(fullPath, signature);
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
        const base = path.basename(filename);
        if (!isRolloutJsonl(base)) return;
        scheduleIngest(path.join(dir, filename));
      });
      watchers.push(w);
    } catch {
      watchedDirs.delete(dir);
      // An inaccessible directory should not prevent other roots from being watched.
    }
  }

  function scanForRollouts(): void {
    for (const root of watchPaths) {
      if (!existsSync(root)) continue;
      for (const dir of listDirectories(root)) {
        if (needsDirectoryScan) watchDirectory(dir);
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (isRolloutJsonl(entry)) scheduleIfChanged(path.join(dir, entry));
        }
      }
    }
  }

  for (const root of watchPaths) {
    if (!existsSync(root)) continue;

    if (useRecursive) {
      try {
        const w = watch(
          root,
          { recursive: true },
          (_event, filename) => {
            if (!filename) return;
            const base = path.basename(filename);
            if (!isRolloutJsonl(base)) return;
            scheduleIngest(path.join(root, filename));
          },
        );
        watchers.push(w);
        continue;
      } catch {
        // fall through to per-directory watchers
        needsDirectoryScan = true;
      }
    }

    for (const dir of listDirectories(root)) {
      watchDirectory(dir);
    }
  }

  startupScan = setTimeout(scanForRollouts, 25);
  if (needsDirectoryScan) {
    directoryScan = setInterval(scanForRollouts, 1_000);
  }

  return () => {
    if (startupScan) clearTimeout(startupScan);
    if (directoryScan) clearInterval(directoryScan);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const w of watchers) w.close();
  };
}
