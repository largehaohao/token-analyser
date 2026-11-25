import type { SessionIndex } from "./session-index.ts";
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
  clearDerivedStoreData,
  readStoreDumpDb,
  readStoreIndexesDb,
  storeDbPath,
  writeStoreDumpDb,
  writeStoredToggle,
} from "./store-db.ts";
import type { SessionSnapshot, WasteToggleId } from "./types.ts";

/** Bump when the dump shape or rebuild assumptions change. */
/** Bump when persisted snapshots must be rebuilt (parser / schema changes). */
export const STORE_DUMP_VERSION = 4;

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

export type StoreDump<T = SessionSnapshot> = {
  version: number;
  pricingContext: string;
  /** Per-file source snapshots with `children` cleared. */
  sources: T[];
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

function antigravitySidecar(filePath: string): { size: number; mtimeMs: number } {
  if (path.basename(filePath) !== "transcript.jsonl") return { size: 0, mtimeMs: 0 };
  const logs = path.dirname(filePath);
  const system = path.dirname(logs);
  const conv = path.dirname(system);
  const brain = path.dirname(conv);
  if (path.basename(logs) !== "logs" || path.basename(system) !== ".system_generated" || path.basename(brain) !== "brain") {
    return { size: 0, mtimeMs: 0 };
  }
  const base = path.dirname(brain);
  const id = path.basename(conv);
  const annotation = sidecarStat(path.join(base, "annotations", `${id}.pbtxt`));
  const summaries = sidecarStat(path.join(base, "conversation_summaries.db"));
  // Bump when planner timing changes so an unchanged transcript is parsed again.
  const parseRevision = 3;
  return { size: annotation.size + summaries.size + parseRevision, mtimeMs: Math.max(annotation.mtimeMs, summaries.mtimeMs) };
}

/** Identity of the source and committed WAL or Antigravity metadata it depends on. */
export function fileFingerprint(filePath: string): FileFingerprint {
  const st = statSync(filePath);
  const sqlite = filePath.endsWith(".vscdb") || path.basename(filePath) === "opencode.db";
  const wal = sqlite ? sidecarStat(`${filePath}-wal`) : antigravitySidecar(filePath);
  return {
    inode: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    walSize: wal.size,
    walMtimeMs: wal.mtimeMs,
    // The SHM file is the transient WAL index. Readers can change it without
    // changing committed session data. Keep legacy dump fields compatible.
    shmSize: 0,
    shmMtimeMs: 0,
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
    for (const [id, toggles] of Object.entries(dump.toggles)) {
      writeStoredToggle(home, id, toggles);
    }
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
  return readCompatibleDump(home, pricingContext, readStoreDumpDb);
}

export function readStoreIndex(home?: string, pricingContext?: string): StoreDump<SessionIndex> | undefined {
  return readCompatibleDump(home, pricingContext, readStoreIndexesDb);
}

function readCompatibleDump<T>(
  home: string | undefined,
  pricingContext: string | undefined,
  read: (home: string | undefined, expected: { version: number; pricingContext?: string }) => StoreDump<T> | undefined,
): StoreDump<T> | undefined {
  const expected = { version: STORE_DUMP_VERSION, pricingContext };
  let dump = read(home, expected);
  if (dump && dump.version !== STORE_DUMP_VERSION) {
    clearDerivedStoreData(home);
    dump = undefined;
  }
  if (!dump && migrateLegacyDump(home)) dump = read(home, expected);
  if (!dump) return undefined;
  if (pricingContext != null && dump.pricingContext !== pricingContext) {
    clearDerivedStoreData(home);
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
  // Preferences are persisted on their own lifecycle; a dump rebuild that
  // carries no toggles must not erase them.
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
    (recorded.walMtimeMs ?? 0) === current.walMtimeMs
  );
}

/** Main-file identity only — Cursor/OpenCode WAL sidecars change constantly. */
export function sqliteCoreFingerprintsMatch(
  recorded: FileFingerprint | undefined,
  current: FileFingerprint,
): boolean {
  if (!recorded) return false;
  return (
    recorded.inode === current.inode &&
    recorded.size === current.size &&
    recorded.mtimeMs === current.mtimeMs
  );
}

/** Skip a GB-scale SQLite reparse when only WAL/SHM moved and we just loaded a dump. */
export const SQLITE_WAL_REPARSE_MIN_BYTES = 10 * 1024 * 1024;
export const SQLITE_WAL_REPARSE_COOLDOWN_MS = 5_000;

export function shouldDeferSqliteWalReparse(opts: {
  recorded: FileFingerprint | undefined;
  current: FileFingerprint;
  fileBytes: number;
  lastIngestAt: number | undefined;
  hasSources: boolean;
  now?: number;
}): boolean {
  if (!opts.hasSources || !opts.recorded) return false;
  if (opts.fileBytes < SQLITE_WAL_REPARSE_MIN_BYTES) return false;
  if (!sqliteCoreFingerprintsMatch(opts.recorded, opts.current)) return false;
  if (fingerprintsMatch(opts.recorded, opts.current)) return false;
  const last = opts.lastIngestAt ?? 0;
  return (opts.now ?? Date.now()) - last < SQLITE_WAL_REPARSE_COOLDOWN_MS;
}
