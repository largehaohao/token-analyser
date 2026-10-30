import {
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { sha256 } from "./hash.ts";
import { tokenAnalyserHome } from "./config.ts";
import type { SessionSnapshot } from "./types.ts";
import {
  deleteCacheRow,
  legacyCacheDir,
  listCacheRows,
  readCacheRow,
  writeCacheRow,
} from "./store-db.ts";

// v14 preserves quota event timestamps for comparisons across sessions/windows.
export const CACHE_VERSION = 14;

export function cacheDir(home?: string): string {
  return legacyCacheDir(home ?? tokenAnalyserHome());
}

export function cacheKey(filePath: string, context = ""): string {
  const st = statSync(filePath);
  return sha256(
    JSON.stringify({
      version: CACHE_VERSION,
      filePath,
      inode: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      context,
    }),
  );
}

export function isLive(mtimeMs: number): boolean {
  return mtimeMs > Date.now() - 120_000;
}

function migrateLegacyCacheFile(
  key: string,
  home?: string,
): SessionSnapshot | undefined {
  const file = path.join(cacheDir(home), `${key}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as {
      version?: unknown;
      snapshot?: unknown;
    };
    if (
      value.version !== CACHE_VERSION ||
      !value.snapshot ||
      typeof value.snapshot !== "object"
    ) {
      unlinkSync(file);
      return undefined;
    }
    const snapshot = value.snapshot as SessionSnapshot;
    writeCacheRow(key, snapshot, CACHE_VERSION, home);
    try {
      unlinkSync(file);
    } catch {
      // DB row is enough.
    }
    return snapshot;
  } catch {
    try {
      unlinkSync(file);
    } catch {
      // Concurrent delete.
    }
    return undefined;
  }
}

export function readCache(
  key: string,
  home?: string,
): SessionSnapshot | undefined {
  const cached = readCacheRow(key, CACHE_VERSION, home);
  if (cached) return cached;
  return migrateLegacyCacheFile(key, home);
}

export function pruneStaleCache(home?: string, context = ""): number {
  let removed = 0;
  for (const row of listCacheRows(home)) {
    if (row.version !== CACHE_VERSION) {
      deleteCacheRow(row.cache_key, home);
      removed += 1;
      continue;
    }
    if (!row.path || !existsSync(row.path)) {
      deleteCacheRow(row.cache_key, home);
      removed += 1;
      continue;
    }
    try {
      if (cacheKey(row.path, context) !== row.cache_key) {
        deleteCacheRow(row.cache_key, home);
        removed += 1;
      }
    } catch {
      deleteCacheRow(row.cache_key, home);
      removed += 1;
    }
  }

  const dir = cacheDir(home);
  if (!existsSync(dir)) return removed;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as {
        version?: unknown;
        snapshot?: { path?: unknown };
      };
      if (value.version !== CACHE_VERSION) {
        unlinkSync(file);
        removed += 1;
        continue;
      }
      const filePath =
        typeof value.snapshot?.path === "string" ? value.snapshot.path : "";
      if (!filePath || !existsSync(filePath)) {
        unlinkSync(file);
        removed += 1;
        continue;
      }
      try {
        if (`${cacheKey(filePath, context)}.json` !== name) {
          unlinkSync(file);
          removed += 1;
        }
      } catch {
        try {
          unlinkSync(file);
          removed += 1;
        } catch {
          // ignore concurrent deletes
        }
      }
    } catch {
      try {
        unlinkSync(file);
        removed += 1;
      } catch {
        // ignore concurrent deletes
      }
    }
  }
  return removed;
}

export function writeCache(
  key: string,
  snapshot: SessionSnapshot,
  home?: string,
): void {
  writeCacheRow(key, snapshot, CACHE_VERSION, home);
}
