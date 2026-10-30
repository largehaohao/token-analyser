import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { tokenAnalyserHome } from "./config.ts";
import {
  invalidateStoreDb,
  readStoreDumpDb,
  storeDbPath,
  writeStoreDumpDb,
} from "./store-db.ts";
import type { SessionSnapshot, WasteToggleId } from "./types.ts";

/** Bump when the dump shape or rebuild assumptions change. */
export const STORE_DUMP_VERSION = 1;

export type FileFingerprint = {
  inode: number;
  size: number;
  mtimeMs: number;
  /** SQLite WAL sidecar — Cursor often commits here without touching .vscdb mtime. */
  walSize: number;
  walMtimeMs: number;
  shmSize: number;
  shmMtimeMs: number;
};

export type StoreDump = {
  version: number;
  pricingContext: string;
  /** Per-file source snapshots with `children` cleared. */
  sources: SessionSnapshot[];
  toggles: Record<string, Record<WasteToggleId, boolean>>;
  /** Fingerprints keyed by resolved absolute path. */
  fingerprints: Record<string, FileFingerprint>;
};

/** Legacy JSON dump path — migrated into `store.db` on read. */
export function storeDumpPath(home?: string): string {
  return path.join(home ?? tokenAnalyserHome(), "store-dump.json");
}

export { storeDbPath };

function sidecarStat(filePath: string): { size: number; mtimeMs: number } {
  try {
    const st = statSync(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

/** Identity of a session file, including SQLite WAL/SHM for `.vscdb`. */
export function fileFingerprint(filePath: string): FileFingerprint {
  const st = statSync(filePath);
  const wal =
    filePath.endsWith(".vscdb")
      ? sidecarStat(`${filePath}-wal`)
      : { size: 0, mtimeMs: 0 };
  const shm =
    filePath.endsWith(".vscdb")
      ? sidecarStat(`${filePath}-shm`)
      : { size: 0, mtimeMs: 0 };
  return {
    inode: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    walSize: wal.size,
    walMtimeMs: wal.mtimeMs,
    shmSize: shm.size,
    shmMtimeMs: shm.mtimeMs,
  };
}

function migrateLegacyDump(home?: string): StoreDump | undefined {
  const file = storeDumpPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreDump>;
    if (value.version !== STORE_DUMP_VERSION) {
      unlinkSync(file);
      return undefined;
    }
    if (!Array.isArray(value.sources) || value.fingerprints == null) {
      unlinkSync(file);
      return undefined;
    }
    const dump: StoreDump = {
      version: STORE_DUMP_VERSION,
      pricingContext:
        typeof value.pricingContext === "string" ? value.pricingContext : "",
      sources: value.sources as SessionSnapshot[],
      toggles:
        value.toggles && typeof value.toggles === "object"
          ? (value.toggles as Record<string, Record<WasteToggleId, boolean>>)
          : {},
      fingerprints: value.fingerprints as Record<string, FileFingerprint>,
    };
    writeStoreDumpDb(dump, home);
    try {
      renameSync(file, `${file}.migrated`);
    } catch {
      // DB is authoritative even if the rename fails.
    }
    return dump;
  } catch {
    try {
      unlinkSync(file);
    } catch {
      // Concurrent delete.
    }
    return undefined;
  }
}

export function readStoreDump(
  home?: string,
  pricingContext?: string,
): StoreDump | undefined {
  let dump = readStoreDumpDb(home);
  if (dump && dump.version !== STORE_DUMP_VERSION) {
    invalidateStoreDb(home);
    dump = undefined;
  }
  if (!dump) dump = migrateLegacyDump(home);
  if (!dump) return undefined;
  if (pricingContext != null && dump.pricingContext !== pricingContext) {
    invalidateStoreDb(home);
    const legacy = storeDumpPath(home);
    for (const file of [legacy, `${legacy}.migrated`]) {
      if (!existsSync(file)) continue;
      try {
        unlinkSync(file);
      } catch {
        // ignore
      }
    }
    return undefined;
  }
  return dump;
}

export function writeStoreDump(dump: StoreDump, home?: string): void {
  writeStoreDumpDb(dump, home);
}

export function fingerprintsMatch(
  recorded: FileFingerprint | undefined,
  current: FileFingerprint,
): boolean {
  if (!recorded) return false;
  return (
    recorded.inode === current.inode &&
    recorded.size === current.size &&
    recorded.mtimeMs === current.mtimeMs &&
    (recorded.walSize ?? 0) === current.walSize &&
    (recorded.walMtimeMs ?? 0) === current.walMtimeMs &&
    (recorded.shmSize ?? 0) === current.shmSize &&
    (recorded.shmMtimeMs ?? 0) === current.shmMtimeMs
  );
}
