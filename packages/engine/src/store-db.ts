import {
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tokenAnalyserHome } from "./config.ts";
import type { FileFingerprint, StoreDump } from "./store-dump.ts";
import type { SessionSnapshot, WasteToggleId } from "./types.ts";

/** Bump when the SQLite schema or snapshot rebuild assumptions change. */
export const STORE_DB_SCHEMA_VERSION = 1;

type DatabaseSync = import("node:sqlite").DatabaseSync;

const connections = new Map<string, DatabaseSync>();

export function storeDbPath(home?: string): string {
  return path.join(home ?? tokenAnalyserHome(), "store.db");
}

export function legacyCacheDir(home?: string): string {
  return path.join(home ?? tokenAnalyserHome(), "cache");
}

function openDb(home?: string): DatabaseSync {
  const dir = home ?? tokenAnalyserHome();
  const existing = connections.get(dir);
  if (existing) return existing;
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  const db = new DatabaseSync(storeDbPath(dir));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fingerprints (
      path TEXT PRIMARY KEY,
      inode INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      wal_size INTEGER NOT NULL,
      wal_mtime_ms REAL NOT NULL,
      shm_size INTEGER NOT NULL,
      shm_mtime_ms REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS toggles (
      session_id TEXT PRIMARY KEY,
      toggles_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_cache (
      cache_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      path TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
  `);
  connections.set(dir, db);
  return db;
}

export function closeStoreDb(home?: string): void {
  const dir = home ?? tokenAnalyserHome();
  const db = connections.get(dir);
  if (!db) return;
  connections.delete(dir);
  try {
    db.close();
  } catch {
    // Best-effort close for tests that delete the temp home.
  }
}

function metaGet(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value?: unknown }
    | undefined;
  return typeof row?.value === "string" ? row.value : undefined;
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function invalidateStoreDb(home?: string): void {
  const dir = home ?? tokenAnalyserHome();
  closeStoreDb(dir);
  const file = storeDbPath(dir);
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${file}${suffix}`;
    if (!existsSync(target)) continue;
    try {
      unlinkSync(target);
    } catch {
      // Concurrent delete is fine.
    }
  }
}

function readDumpFromDb(db: DatabaseSync): StoreDump | undefined {
  const schemaRaw = metaGet(db, "schema_version");
  // Cache rows may exist before the first dump writes meta — not an error.
  if (schemaRaw == null) return undefined;
  const schema = Number(schemaRaw);
  if (schema !== STORE_DB_SCHEMA_VERSION) return undefined;

  const sources: SessionSnapshot[] = [];
  for (const row of db.prepare("SELECT snapshot_json FROM sources").all() as {
    snapshot_json: string;
  }[]) {
    try {
      const snap = JSON.parse(row.snapshot_json) as SessionSnapshot;
      if (snap?.id && typeof snap.path === "string") sources.push(snap);
    } catch {
      // Skip corrupt rows; a later dump rewrites the table.
    }
  }

  const fingerprints: Record<string, FileFingerprint> = {};
  for (const row of db
    .prepare(
      "SELECT path, inode, size, mtime_ms, wal_size, wal_mtime_ms, shm_size, shm_mtime_ms FROM fingerprints",
    )
    .all() as {
    path: string;
    inode: number;
    size: number;
    mtime_ms: number;
    wal_size: number;
    wal_mtime_ms: number;
    shm_size: number;
    shm_mtime_ms: number;
  }[]) {
    fingerprints[row.path] = {
      inode: row.inode,
      size: row.size,
      mtimeMs: row.mtime_ms,
      walSize: row.wal_size,
      walMtimeMs: row.wal_mtime_ms,
      shmSize: row.shm_size,
      shmMtimeMs: row.shm_mtime_ms,
    };
  }

  const toggles: Record<string, Record<WasteToggleId, boolean>> = {};
  for (const row of db.prepare("SELECT session_id, toggles_json FROM toggles").all() as {
    session_id: string;
    toggles_json: string;
  }[]) {
    try {
      toggles[row.session_id] = JSON.parse(row.toggles_json) as Record<
        WasteToggleId,
        boolean
      >;
    } catch {
      // Skip corrupt toggle rows.
    }
  }

  return {
    version: Number(metaGet(db, "dump_version") ?? NaN),
    pricingContext: metaGet(db, "pricing_context") ?? "",
    sources,
    toggles,
    fingerprints,
  };
}

export function readStoreDumpDb(home?: string): StoreDump | undefined {
  const dbPath = storeDbPath(home);
  if (!existsSync(dbPath)) return undefined;
  try {
    const db = openDb(home);
    const schemaRaw = metaGet(db, "schema_version");
    if (schemaRaw == null) return undefined;
    if (Number(schemaRaw) !== STORE_DB_SCHEMA_VERSION) {
      invalidateStoreDb(home);
      return undefined;
    }
    const dump = readDumpFromDb(db);
    if (!dump || !Number.isFinite(dump.version)) {
      invalidateStoreDb(home);
      return undefined;
    }
    return dump;
  } catch {
    invalidateStoreDb(home);
    return undefined;
  }
}

export function writeStoreDumpDb(dump: StoreDump, home?: string): void {
  const db = openDb(home);
  db.exec("BEGIN");
  try {
    metaSet(db, "schema_version", String(STORE_DB_SCHEMA_VERSION));
    metaSet(db, "dump_version", String(dump.version));
    metaSet(db, "pricing_context", dump.pricingContext);

    db.exec("DELETE FROM sources");
    db.exec("DELETE FROM fingerprints");
    db.exec("DELETE FROM toggles");

    const insertSource = db.prepare(
      "INSERT INTO sources(id, snapshot_json) VALUES(?, ?)",
    );
    for (const snap of dump.sources) {
      insertSource.run(snap.id, JSON.stringify({ ...snap, children: [] }));
    }

    const insertFp = db.prepare(
      `INSERT INTO fingerprints(
        path, inode, size, mtime_ms, wal_size, wal_mtime_ms, shm_size, shm_mtime_ms
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [filePath, fp] of Object.entries(dump.fingerprints)) {
      insertFp.run(
        filePath,
        fp.inode,
        fp.size,
        fp.mtimeMs,
        fp.walSize ?? 0,
        fp.walMtimeMs ?? 0,
        fp.shmSize ?? 0,
        fp.shmMtimeMs ?? 0,
      );
    }

    const insertToggle = db.prepare(
      "INSERT INTO toggles(session_id, toggles_json) VALUES(?, ?)",
    );
    for (const [id, value] of Object.entries(dump.toggles)) {
      insertToggle.run(id, JSON.stringify(value));
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Connection may already be closed.
    }
    throw err;
  }
}

export type FileCacheRow = {
  cache_key: string;
  version: number;
  path: string;
  snapshot_json: string;
};

export function readCacheRow(
  key: string,
  cacheVersion: number,
  home?: string,
): SessionSnapshot | undefined {
  try {
    const db = openDb(home);
    const row = db
      .prepare(
        "SELECT version, snapshot_json FROM file_cache WHERE cache_key = ?",
      )
      .get(key) as { version?: number; snapshot_json?: string } | undefined;
    if (!row) return undefined;
    if (row.version !== cacheVersion || typeof row.snapshot_json !== "string") {
      db.prepare("DELETE FROM file_cache WHERE cache_key = ?").run(key);
      return undefined;
    }
    try {
      const snapshot = JSON.parse(row.snapshot_json) as SessionSnapshot;
      if (snapshot && typeof snapshot === "object") return snapshot;
    } catch {
      db.prepare("DELETE FROM file_cache WHERE cache_key = ?").run(key);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function writeCacheRow(
  key: string,
  snapshot: SessionSnapshot,
  cacheVersion: number,
  home?: string,
): void {
  const db = openDb(home);
  db.prepare(
    `INSERT INTO file_cache(cache_key, version, path, snapshot_json)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       version = excluded.version,
       path = excluded.path,
       snapshot_json = excluded.snapshot_json`,
  ).run(key, cacheVersion, snapshot.path, JSON.stringify(snapshot));
}

export function listCacheRows(home?: string): FileCacheRow[] {
  try {
    return openDb(home)
      .prepare("SELECT cache_key, version, path, snapshot_json FROM file_cache")
      .all() as FileCacheRow[];
  } catch {
    return [];
  }
}

export function deleteCacheRow(key: string, home?: string): void {
  try {
    openDb(home).prepare("DELETE FROM file_cache WHERE cache_key = ?").run(key);
  } catch {
    // ignore
  }
}
