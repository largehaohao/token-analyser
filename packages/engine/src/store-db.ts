import {
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { prepareSource, encodeIndex, type PreparedSource, type SessionIndex } from "./session-index.ts";
import { sha256 } from "./hash.ts";
import { assertSupportedNode } from "./node-guard.ts";
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort tightening of a pre-existing directory.
  }
  assertSupportedNode();
  const { DatabaseSync } = createRequire(import.meta.url)(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  const db = new DatabaseSync(storeDbPath(dir));
  db.exec("PRAGMA busy_timeout=15000");
  try {
    // Session snapshots and prompts must not be readable by other local users.
    chmodSync(storeDbPath(dir), 0o600);
  } catch {
    // Best-effort on filesystems without permission support.
  }
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
    CREATE TABLE IF NOT EXISTS source_index (
      id TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      format INTEGER NOT NULL,
      data BLOB NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS invalidate_source_index AFTER UPDATE OF snapshot_json ON sources
    BEGIN DELETE FROM source_index WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS remove_source_index AFTER DELETE ON sources
    BEGIN DELETE FROM source_index WHERE id = OLD.id; END;
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
    CREATE TABLE IF NOT EXISTS linked_imports (
      path TEXT PRIMARY KEY
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

type DumpIdentity = { version: number; pricingContext?: string };
type SourceReader<T> = (db: DatabaseSync) => T[] | undefined;

function decodeSource(id: string, json: string): SessionSnapshot | undefined {
  try {
    const snapshot = JSON.parse(json) as SessionSnapshot;
    if (snapshot?.id === id && typeof snapshot.path === "string" &&
        Array.isArray(snapshot.turns) && Array.isArray(snapshot.parse_errors)) return snapshot;
  } catch {
    // Rebuild the derived generation when evidence and file fingerprints disagree.
  }
  return undefined;
}

function readFullSources(db: DatabaseSync): SessionSnapshot[] | undefined {
  const result: SessionSnapshot[] = [];
  for (const row of db.prepare("SELECT id, snapshot_json FROM sources ORDER BY rowid").iterate()) {
    const snapshot = decodeSource(String(row.id), String(row.snapshot_json));
    if (!snapshot) return undefined;
    result.push(snapshot);
  }
  return result;
}

const INDEX_FORMAT = 1;
const SAVE_INDEX = "INSERT OR REPLACE INTO source_index(id,revision,format,data) VALUES(?,?,?,?)";

function readIndexes(db: DatabaseSync): SessionIndex[] | undefined {
  const result: SessionIndex[] = [];
  const readDetail = db.prepare("SELECT snapshot_json FROM sources WHERE id = ?");
  const writeIndex = db.prepare(SAVE_INDEX);
  // Read the smaller table independently. Iteration over source IDs touches
  // only row headers, including when the old installation has no indexes yet.
  const rows = db.prepare(`SELECT s.id, i.revision, i.data FROM sources s
    LEFT JOIN source_index i ON i.id = s.id AND i.format = ? ORDER BY s.rowid`).all(INDEX_FORMAT);
  for (const row of rows) {
    if (row.data instanceof Uint8Array) {
      try {
        const item = JSON.parse(zstdDecompressSync(row.data).toString()) as SessionIndex;
        if (item.id === row.id && item.revision === row.revision && Array.isArray(item.turns) &&
            Array.isArray(item.parse_errors) && typeof item.path === "string") {
          result.push(item);
          continue;
        }
      } catch {
        // Recover just this index from its full source row.
      }
    }
    const json = readDetail.get(row.id)?.snapshot_json;
    if (typeof json !== "string") return undefined;
    const detail = decodeSource(String(row.id), json);
    if (!detail) return undefined;
    const { index } = prepareSource(detail, json);
    writeIndex.run(index.id, index.revision, INDEX_FORMAT, encodeIndex(index));
    result.push(index);
  }
  return result;
}

export function readSourceDetail(home: string | undefined, index: SessionIndex): SessionSnapshot | undefined {
  const row = openDb(home).prepare(`SELECT s.snapshot_json, i.revision FROM sources s
    LEFT JOIN source_index i ON s.id = i.id WHERE s.id = ?`).get(index.id);
  if (typeof row?.snapshot_json !== "string") return undefined;
  const revision = row.revision ?? sha256(row.snapshot_json);
  return revision === index.revision ? decodeSource(index.id, row.snapshot_json) : undefined;
}

function readDumpFromDb<T>(db: DatabaseSync, readSources: SourceReader<T>, expected?: DumpIdentity): StoreDump<T> | undefined {
  db.exec("BEGIN");
  try {
    const dump = readDumpTables(db, readSources, expected);
    db.exec("COMMIT");
    return dump;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* Already closed. */ }
    throw err;
  }
}

function readDumpTables<T>(db: DatabaseSync, readSources: SourceReader<T>, expected?: DumpIdentity): StoreDump<T> | undefined {
  const schemaRaw = metaGet(db, "schema_version");
  if (schemaRaw == null || Number(schemaRaw) !== STORE_DB_SCHEMA_VERSION) return undefined;
  const version = Number(metaGet(db, "dump_version") ?? NaN);
  const pricingContext = metaGet(db, "pricing_context") ?? "";
  // Reject old parsers / prices without decoding hundreds of MB first.
  if (expected && (version !== expected.version ||
      (expected.pricingContext != null && pricingContext !== expected.pricingContext))) {
    return { version, pricingContext, sources: [], fingerprints: {}, toggles: {} };
  }
  const sources = readSources(db);
  if (!sources) return undefined;

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
    version,
    pricingContext,
    sources,
    toggles,
    fingerprints,
  };
}

export function readStoreDumpDb(home?: string, expected?: DumpIdentity): StoreDump | undefined {
  return loadDumpTables(home, readFullSources, expected);
}

export function needsIndexBackfill(home: string | undefined, expected: DumpIdentity): boolean {
  if (!existsSync(storeDbPath(home))) return false;
  const db = openDb(home);
  const version = metaGet(db, "dump_version");
  if (version == null) return false;
  if (Number(version) !== expected.version || metaGet(db, "pricing_context") !== expected.pricingContext) return true;
  return db.prepare(`SELECT 1 FROM sources s LEFT JOIN source_index i
    ON i.id=s.id AND i.format=? WHERE i.id IS NULL LIMIT 1`).get(INDEX_FORMAT) != null;
}

export function readStoreIndexesDb(home?: string, expected?: DumpIdentity): StoreDump<SessionIndex> | undefined {
  return loadDumpTables(home, readIndexes, expected);
}

function loadDumpTables<T>(home: string | undefined, readSources: SourceReader<T>, expected?: DumpIdentity): StoreDump<T> | undefined {
  const dbPath = storeDbPath(home);
  if (!existsSync(dbPath)) return undefined;
  try {
    const db = openDb(home);
    const schemaRaw = metaGet(db, "schema_version");
    if (schemaRaw == null) return undefined;
    if (Number(schemaRaw) !== STORE_DB_SCHEMA_VERSION) {
      clearDerivedStoreData(home);
      return undefined;
    }
    const dump = readDumpFromDb(db, readSources, expected);
    if (!dump || !Number.isFinite(dump.version)) {
      clearDerivedStoreData(home);
      return undefined;
    }
    return dump;
  } catch (err) {
    // Only genuine corruption justifies destroying the file. Transient lock
    // or I/O failures must not delete cached state or saved preferences.
    const errcode = (err as { errcode?: number }).errcode;
    if (errcode === 11 /* SQLITE_CORRUPT */ || errcode === 26 /* SQLITE_NOTADB */) {
      invalidateStoreDb(home);
    }
    return undefined;
  }
}

/**
 * Drop derived snapshots/fingerprints/meta while keeping the toggles table:
 * waste preferences are user data that session logs cannot reconstruct.
 */
export function clearDerivedStoreData(home?: string): void {
  const db = openDb(home);
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM sources");
    db.exec("DELETE FROM fingerprints");
    db.exec("DELETE FROM meta");
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

export function readRemoteSyncState(home: string): string | undefined {
  return metaGet(openDb(home), "remote_sync");
}

export function writeRemoteSyncState(home: string, json: string): void {
  metaSet(openDb(home), "remote_sync", json);
}

export function cachePruneDue(home?: string): boolean {
  const last = Number(metaGet(openDb(home), "cache_pruned_at"));
  return !Number.isFinite(last) || Date.now() - last >= 86_400_000 || last > Date.now();
}

export function recordCachePrune(home?: string): void {
  metaSet(openDb(home), "cache_pruned_at", String(Date.now()));
}

export function readLinkedImports(home?: string): string[] {
  const rows = openDb(home).prepare("SELECT path FROM linked_imports").all() as { path: string }[];
  return rows.map((row) => row.path);
}

export function registerLinkedImport(filePath: string, home?: string): void {
  openDb(home).prepare("INSERT OR IGNORE INTO linked_imports (path) VALUES (?)").run(filePath);
}

export function readStoredToggles(
  home?: string,
): Record<string, Record<WasteToggleId, boolean>> {
  const toggles: Record<string, Record<WasteToggleId, boolean>> = {};
  try {
    const db = openDb(home);
    for (const row of db
      .prepare("SELECT session_id, toggles_json FROM toggles")
      .all() as { session_id: string; toggles_json: string }[]) {
      try {
        toggles[row.session_id] = JSON.parse(row.toggles_json) as Record<
          WasteToggleId,
          boolean
        >;
      } catch {
        // Skip corrupt toggle rows.
      }
    }
  } catch {
    // Preferences are best-effort on read; never destroy the store for them.
  }
  return toggles;
}

export function writeStoredToggle(
  home: string | undefined,
  id: string,
  toggles: Record<WasteToggleId, boolean>,
): void {
  const db = openDb(home);
  db.prepare(
    `INSERT INTO toggles(session_id, toggles_json) VALUES(?, ?)
     ON CONFLICT(session_id) DO UPDATE SET toggles_json = excluded.toggles_json`,
  ).run(id, JSON.stringify(toggles));
}

export function deleteStoredToggles(home: string | undefined, ids: string[]): void {
  if (ids.length === 0) return;
  const db = openDb(home);
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM toggles WHERE session_id IN (${placeholders})`).run(...ids);
}

export function writeStoreDumpDb(dump: StoreDump, home?: string): void {
  writeStoreChanges(home, {
    version: dump.version,
    pricingContext: dump.pricingContext,
    replace: true,
    sources: dump.sources.map((snapshot) => prepareSource(snapshot)),
    fingerprints: Object.entries(dump.fingerprints),
    removedIds: [],
    removedPaths: [],
  });
}

/** Publish changed evidence, compact indexes and their fingerprints as one generation. */
export function writeStoreChanges(home: string | undefined, changes: {
  version: number;
  pricingContext: string;
  replace: boolean;
  sources: PreparedSource[];
  fingerprints: [string, FileFingerprint][];
  removedIds: string[];
  removedPaths: string[];
}): void {
  const db = openDb(home);
  db.exec("BEGIN IMMEDIATE");
  try {
    metaSet(db, "schema_version", String(STORE_DB_SCHEMA_VERSION));
    metaSet(db, "dump_version", String(changes.version));
    metaSet(db, "pricing_context", changes.pricingContext);
    if (changes.replace) {
      db.exec("DELETE FROM sources; DELETE FROM fingerprints;");
    } else {
      const deleteSource = db.prepare("DELETE FROM sources WHERE id = ?");
      for (const id of changes.removedIds) deleteSource.run(id);
      const deleteFingerprint = db.prepare("DELETE FROM fingerprints WHERE path = ?");
      for (const file of changes.removedPaths) deleteFingerprint.run(file);
    }
    const source = db.prepare(`INSERT INTO sources(id, snapshot_json) VALUES(?, ?)
      ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json`);
    const index = db.prepare(SAVE_INDEX);
    for (const item of changes.sources) {
      source.run(item.index.id, item.json);
      index.run(item.index.id, item.index.revision, INDEX_FORMAT, item.packedIndex ?? encodeIndex(item.index));
    }
    const insertFp = db.prepare(`INSERT OR REPLACE INTO fingerprints(
        path, inode, size, mtime_ms, wal_size, wal_mtime_ms, shm_size, shm_mtime_ms
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [file, fp] of changes.fingerprints) {
      insertFp.run(file, fp.inode, fp.size, fp.mtimeMs, fp.walSize ?? 0, fp.walMtimeMs ?? 0, fp.shmSize ?? 0, fp.shmMtimeMs ?? 0);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Already closed. */ }
    throw error;
  }
}

export type FileCacheRow = {
  cache_key: string;
  version: number;
  path: string;
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
      .prepare("SELECT cache_key, version, path FROM file_cache")
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
