import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { sha256 } from "./hash.ts";
import { tokenAnalyserHome } from "./config.ts";
import type { SessionSnapshot } from "./types.ts";

// v8 invalidates snapshots created before the fine-grained behavior buckets.
export const CACHE_VERSION = 8;

export function cacheDir(home?: string): string {
  return path.join(home ?? tokenAnalyserHome(), "cache");
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

export function readCache(
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
    if (value.version !== CACHE_VERSION || !value.snapshot || typeof value.snapshot !== "object") {
      unlinkSync(file);
      return undefined;
    }
    return value.snapshot as SessionSnapshot;
  } catch {
    try {
      unlinkSync(file);
    } catch {
      // Another process may have removed a corrupt cache concurrently.
    }
    return undefined;
  }
}

export function pruneStaleCache(home?: string, context = ""): number {
  const dir = cacheDir(home);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as {
        version?: unknown;
      };
      if (value.version !== CACHE_VERSION) {
        unlinkSync(file);
        removed += 1;
        continue;
      }
      const snapshot = (value as { snapshot?: { path?: unknown } }).snapshot;
      const filePath = typeof snapshot?.path === "string" ? snapshot.path : "";
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
  const dir = cacheDir(home);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({ version: CACHE_VERSION, snapshot }),
  );
  renameSync(temporary, file);
}
