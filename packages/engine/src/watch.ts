import { watch, existsSync } from "node:fs";
import path from "node:path";
import { loadUserConfig } from "./config.ts";
import type { SessionStore } from "./store.ts";

export type WatchOptions = {
  watchPaths?: string[];
};

function isRolloutJsonl(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

export function watchSessions(
  store: SessionStore,
  onChange: (id: string) => void,
  opts?: WatchOptions,
): () => void {
  const watchPaths =
    opts?.watchPaths ?? loadUserConfig().watch_paths;
  const watchers: ReturnType<typeof watch>[] = [];

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

  for (const root of watchPaths) {
    if (!existsSync(root)) continue;
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
    } catch {
      const w = watch(root, (_event, filename) => {
        if (!filename) return;
        const base = path.basename(filename);
        if (!isRolloutJsonl(base)) return;
        ingestIfRollout(path.join(root, filename));
      });
      watchers.push(w);
    }
  }

  return () => {
    for (const w of watchers) w.close();
  };
}
