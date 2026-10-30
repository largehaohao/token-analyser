import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/store.ts";
import {
  fileFingerprint,
  fingerprintsMatch,
  readStoreDump,
  storeDbPath,
  storeDumpPath,
  writeStoreDump,
  STORE_DUMP_VERSION,
} from "../src/store-dump.ts";
import { closeStoreDb } from "../src/store-db.ts";
import { pricingCacheContext } from "../src/ingest.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

function ageFile(filePath: string): void {
  const aged = (Date.now() - 600_000) / 1000;
  utimesSync(filePath, aged, aged);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionStore dump", () => {
  it("restores unchanged historical sessions without re-reading the jsonl", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-"));
    const cacheDir = path.join(dir, "cache");
    const rollout = path.join(dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(path.join(fixtures, "wait-poll.jsonl")));
    ageFile(rollout);

    const first = new SessionStore({ cacheDir });
    first.refresh([rollout]);
    expect(first.list()).toHaveLength(1);
    const before = first.get(first.list()[0]!.id)!;
    first.dump();
    expect(storeDumpPath(dir)).toBe(path.join(dir, "store-dump.json"));
    expect(existsSync(storeDbPath(dir))).toBe(true);

    // Make the source unreadable so a re-parse would fail; reuse must skip I/O.
    chmodSync(rollout, 0o000);
    try {
      const second = new SessionStore({ cacheDir });
      expect(second.loadDump()).toBe(1);
      second.refresh([rollout]);
      const after = second.get(before.id)!;
      expect(after.cost.raw).toBe(before.cost.raw);
      expect(after.turns.length).toBe(before.turns.length);
    } finally {
      chmodSync(rollout, 0o600);
    }
  });

  it("re-ingests when the session file changes after a dump", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-change-"));
    const cacheDir = path.join(dir, "cache");
    const rollout = path.join(dir, "rollout.jsonl");
    const original = readFileSync(path.join(fixtures, "wait-poll.jsonl"), "utf8");
    writeFileSync(rollout, original);
    ageFile(rollout);

    const first = new SessionStore({ cacheDir });
    first.refresh([rollout]);
    first.dump();
    const id = first.list()[0]!.id;

    writeFileSync(
      rollout,
      original.replace('"s-poll"', '"s-poll-2"').replace('"s-poll"', '"s-poll-2"'),
    );
    const second = new SessionStore({ cacheDir });
    second.loadDump();
    second.refresh([rollout]);
    expect(second.list().map((item) => item.id)).toEqual(["s-poll-2"]);
    expect(second.get(id)).toBeUndefined();
  });

  it("keeps dump-restored imports when refresh only covers watch paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-retain-"));
    const cacheDir = path.join(dir, "cache");
    const watched = path.join(dir, "watched.jsonl");
    const imported = path.join(dir, "imported.jsonl");
    const body = readFileSync(path.join(fixtures, "wait-poll.jsonl"), "utf8");
    writeFileSync(watched, body);
    writeFileSync(
      imported,
      body.replace(/"s-poll"/g, '"s-import"'),
    );
    ageFile(watched);
    ageFile(imported);

    const first = new SessionStore({ cacheDir });
    first.refresh([watched, imported]);
    first.dump();
    expect(first.list().map((item) => item.id).sort()).toEqual([
      "s-import",
      "s-poll",
    ]);

    const second = new SessionStore({ cacheDir });
    second.loadDump();
    second.refresh([watched]);
    expect(second.list().map((item) => item.id).sort()).toEqual([
      "s-import",
      "s-poll",
    ]);
  });

  it("keeps dump sessions when stat fails for a refreshed path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-stat-"));
    const cacheDir = path.join(dir, "cache");
    const rollout = path.join(dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(path.join(fixtures, "wait-poll.jsonl")));
    ageFile(rollout);

    const first = new SessionStore({ cacheDir });
    first.refresh([rollout]);
    const id = first.list()[0]!.id;
    first.dump();

    const second = new SessionStore({ cacheDir });
    expect(second.loadDump()).toBe(1);
    unlinkSync(rollout);
    const errors: string[] = [];
    second.refresh([rollout], {
      onError: (filePath) => errors.push(filePath),
    });
    expect(errors).toEqual([rollout]);
    expect(second.get(id)).toBeDefined();
  });

  it("deletes the on-disk dump when pricing context no longer matches", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-price-"));
    writeStoreDump(
      {
        version: STORE_DUMP_VERSION,
        pricingContext: "stale-pricing",
        sources: [],
        toggles: {},
        fingerprints: {},
      },
      dir,
    );
    expect(existsSync(storeDbPath(dir))).toBe(true);
    expect(readStoreDump(dir, pricingCacheContext())).toBeUndefined();
    closeStoreDb(dir);
    expect(existsSync(storeDbPath(dir))).toBe(false);
  });

  it("treats .vscdb WAL growth as a fingerprint change", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-wal-"));
    const db = path.join(dir, "state.vscdb");
    writeFileSync(db, "main");
    ageFile(db);
    const before = fileFingerprint(db);
    writeFileSync(`${db}-wal`, "wal-bytes");
    const after = fileFingerprint(db);
    expect(fingerprintsMatch(before, after)).toBe(false);
    expect(after.walSize).toBeGreaterThan(0);
  });

  it("schedules a dump after ingestPath", () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-schedule-"));
    const cacheDir = path.join(dir, "cache");
    const rollout = path.join(dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(path.join(fixtures, "wait-poll.jsonl")));
    ageFile(rollout);

    const store = new SessionStore({ cacheDir });
    store.ingestPath(rollout);
    // Per-file cache may create store.db immediately; the dump meta lands later.
    expect(readStoreDump(dir)?.sources.length ?? 0).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(readStoreDump(dir)?.sources.length).toBe(1);
  });

  it("skips re-ingest for fingerprint-matched paths that contribute no sources", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-empty-fp-"));
    const cacheDir = path.join(dir, "cache");
    const canonical = path.join(dir, "canonical.jsonl");
    const duplicate = path.join(dir, "duplicate.jsonl");
    const body = readFileSync(path.join(fixtures, "wait-poll.jsonl"), "utf8");
    writeFileSync(canonical, body);
    writeFileSync(duplicate, body);
    ageFile(canonical);
    ageFile(duplicate);

    const first = new SessionStore({ cacheDir });
    first.refresh([canonical, duplicate]);
    expect(first.list()).toHaveLength(1);
    // Only canonical keeps a source; duplicate is fingerprint-only (same session id).
    first.dump({ force: true });

    chmodSync(duplicate, 0o000);
    try {
      const second = new SessionStore({ cacheDir });
      expect(second.loadDump()).toBe(1);
      second.refresh([canonical, duplicate]);
      expect(second.list()).toHaveLength(1);
      expect(second.list()[0]!.id).toBe("s-poll");
    } finally {
      chmodSync(duplicate, 0o600);
    }
  });

  it("does not let JSONL replace a dump-restored .vscdb session during light refresh", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-vscdb-prefer-"));
    const cacheDir = path.join(dir, "cache");
    const rollout = path.join(dir, "agent.jsonl");
    const vscdb = path.join(dir, "state.vscdb");
    writeFileSync(rollout, readFileSync(path.join(fixtures, "wait-poll.jsonl")));
    writeFileSync(vscdb, "placeholder");
    ageFile(rollout);
    ageFile(vscdb);

    const seed = new SessionStore({ cacheDir });
    seed.refresh([rollout]);
    const fromJsonl = seed.get("s-poll")!;
    writeStoreDump(
      {
        version: STORE_DUMP_VERSION,
        pricingContext: pricingCacheContext(),
        sources: [
          {
            ...fromJsonl,
            path: vscdb,
            parentId: "cursor:parent",
            children: [],
          },
        ],
        toggles: {},
        fingerprints: {
          [path.resolve(vscdb)]: fileFingerprint(vscdb),
        },
      },
      dir,
    );

    const store = new SessionStore({ cacheDir });
    expect(store.loadDump()).toBe(1);
    // Light refresh: JSONL only (vscdb deferred). Must keep the dump row.
    store.refresh([rollout]);
    const kept = store.get("s-poll")!;
    expect(kept.path).toBe(vscdb);
    expect(kept.parentId).toBe("cursor:parent");
  });

  it("keeps fingerprint-only paths across a partial refresh", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-fp-partial-"));
    const cacheDir = path.join(dir, "cache");
    const canonical = path.join(dir, "canonical.jsonl");
    const duplicate = path.join(dir, "duplicate.jsonl");
    const body = readFileSync(path.join(fixtures, "wait-poll.jsonl"), "utf8");
    writeFileSync(canonical, body);
    writeFileSync(duplicate, body);
    ageFile(canonical);
    ageFile(duplicate);

    const first = new SessionStore({ cacheDir });
    // Ingest duplicate first so canonical wins the source path; duplicate is
    // fingerprint-only and used to be dropped on a partial refresh.
    first.refresh([duplicate, canonical]);
    first.dump({ force: true });
    expect(first.get("s-poll")?.path).toBe(canonical);
    expect(
      readStoreDump(dir, pricingCacheContext())!.fingerprints[path.resolve(duplicate)],
    ).toBeDefined();

    const mid = new SessionStore({ cacheDir });
    mid.loadDump();
    mid.refresh([canonical]); // partial — must not drop duplicate fingerprint
    mid.dump({ force: true });
    expect(
      readStoreDump(dir, pricingCacheContext())!.fingerprints[path.resolve(duplicate)],
    ).toBeDefined();

    chmodSync(duplicate, 0o000);
    try {
      const cold = new SessionStore({ cacheDir });
      cold.loadDump();
      cold.refresh([canonical, duplicate]);
      expect(cold.list()).toHaveLength(1);
    } finally {
      chmodSync(duplicate, 0o600);
    }
  });

  it("persists new fingerprints when refresh membership is unchanged", () => {
    // Simulates a dump that already has the session but lacks a duplicate-path
    // fingerprint (e.g. Cursor JSONL covered by state.vscdb). After refresh the
    // fingerprint must land on disk even though no source id was added.
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-fp-persist-"));
    const cacheDir = path.join(dir, "cache");
    const canonical = path.join(dir, "canonical.jsonl");
    const duplicate = path.join(dir, "duplicate.jsonl");
    const body = readFileSync(path.join(fixtures, "wait-poll.jsonl"), "utf8");
    writeFileSync(canonical, body);
    writeFileSync(duplicate, body);
    ageFile(canonical);
    ageFile(duplicate);

    const seed = new SessionStore({ cacheDir });
    seed.refresh([canonical]);
    seed.dump({ force: true });
    expect(Object.keys(readStoreDump(dir, pricingCacheContext())!.fingerprints)).toEqual([
      path.resolve(canonical),
    ]);

    const mid = new SessionStore({ cacheDir });
    expect(mid.loadDump()).toBe(1);
    mid.refresh([canonical, duplicate]);
    mid.dump(); // must flush fingerprint-only dirty state
    const dumped = readStoreDump(dir, pricingCacheContext())!;
    expect(dumped.fingerprints[path.resolve(duplicate)]).toBeDefined();

    chmodSync(duplicate, 0o000);
    try {
      const cold = new SessionStore({ cacheDir });
      expect(cold.loadDump()).toBe(1);
      cold.refresh([canonical, duplicate]);
      expect(cold.list()).toHaveLength(1);
    } finally {
      chmodSync(duplicate, 0o600);
    }
  });

  it("does not rewrite the dump when refresh only reuses fingerprints", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-clean-"));
    const cacheDir = path.join(dir, "cache");
    const rollout = path.join(dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(path.join(fixtures, "wait-poll.jsonl")));
    ageFile(rollout);

    const first = new SessionStore({ cacheDir });
    first.refresh([rollout]);
    first.dump({ force: true });
    closeStoreDb(dir);
    const before = readFileSync(storeDbPath(dir));

    const second = new SessionStore({ cacheDir });
    second.loadDump();
    second.refresh([rollout]);
    second.dump();
    closeStoreDb(dir);
    expect(readFileSync(storeDbPath(dir)).equals(before)).toBe(true);
  });

  it("reuses fingerprint-matched files even inside the isLive window", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-dump-live-reuse-"));
    const cacheDir = path.join(dir, "cache");
    const rollout = path.join(dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(path.join(fixtures, "wait-poll.jsonl")));
    // mtime=now → isLive, but fingerprint still matches the dump.
    utimesSync(rollout, Date.now() / 1000, Date.now() / 1000);

    const first = new SessionStore({ cacheDir });
    first.refresh([rollout]);
    first.dump({ force: true });
    // Touch mtime again without changing size so a naive live check would
    // re-ingest; keep size identical and update the dump fingerprint instead.
    const body = readFileSync(rollout);
    writeFileSync(rollout, body);
    const second = new SessionStore({ cacheDir });
    second.loadDump();
    // Refresh once to record the new mtime fingerprint, then dump.
    second.refresh([rollout]);
    second.dump({ force: true });

    chmodSync(rollout, 0o000);
    try {
      const third = new SessionStore({ cacheDir });
      third.loadDump();
      third.refresh([rollout]);
      expect(third.list()).toHaveLength(1);
    } finally {
      chmodSync(rollout, 0o600);
    }
  });
});
