import { watch, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadUserConfig } from "./config.ts";
import type { SessionStore } from "./store.ts";

export type WatchOptions = {
  watchPaths?: string[];
  /** When false, use per-subdirectory watchers instead of recursive fs.watch. */
  recursive?: boolean;
};

function isRolloutJsonl(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

function listDirectories(root: string): string[] {
  const dirs = [root];
  for (const entry of readdirSync(root)) {
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
  const useRecursive = opts?.recursive ?? true;

  function ingestIfRollout(fullPath: string): void {
    const base = path.basename(fullPath);
    if (!isRolloutJsonl(base) || !existsSync(fullPath)) return;
    try {
      const id = store.ingestPath(fullPath);
      if (id) onChange(id);
    } catch {
      // skip unreadable or partial files until next change
    }
  }

  function watchDirectory(dir: string): void {
    const w = watch(dir, (_event, filename) => {
      if (!filename) return;
      const base = path.basename(filename);
      if (!isRolloutJsonl(base)) return;
      ingestIfRollout(path.join(dir, filename));
    });
    watchers.push(w);
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
            ingestIfRollout(path.join(root, filename));
          },
        );
        watchers.push(w);
        continue;
      } catch {
        // fall through to per-directory watchers
      }
    }

    for (const dir of listDirectories(root)) {
      watchDirectory(dir);
    }
  }

  return () => {
    for (const w of watchers) w.close();
  };
}
