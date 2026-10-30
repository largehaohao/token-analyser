import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  pruneStaleCache,
  writeCache,
  readCache,
  cacheKey,
  cacheDir,
  CACHE_VERSION,
} from "../src/cache.ts";
import { storeDbPath } from "../src/store-db.ts";
import { emptyCost } from "../src/types.ts";
import type { SessionSnapshot } from "../src/types.ts";
import { DEFAULT_WASTE_TOGGLES } from "../src/types.ts";

function snap(filePath = "/tmp/s.jsonl"): SessionSnapshot {
  return {
    id: "s",
    parentId: null,
    nickname: "s",
    cwd: "/repo",
    live: false,
    path: filePath,
    startedAt: null,
    lastEventAt: null,
    model: null,
    effort: null,
    ledger_warning: false,
    parse_errors: [],
    rate_limits: null,
    rateCardAsOf: "2026-08-27",
    fastMode: false,
    cost: emptyCost(),
    waste: emptyCost(),
    toggles: { ...DEFAULT_WASTE_TOGGLES },
    tree: {
      id: "s",
      kind: "root",
      label: "s",
      cost: emptyCost(),
      percentOfParent: 100,
      children: [],
      turnIds: [],
    },
    turns: [],
    children: [],
    suggestions: [],
  };
}

describe("SQLite session cache", () => {
  it("round-trips snapshots through store.db", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cache-db-"));
    const jsonl = path.join(home, "keep.jsonl");
    writeFileSync(jsonl, "keep\n");
    const key = cacheKey(jsonl);
    writeCache(key, snap(jsonl), home);
    expect(existsSync(storeDbPath(home))).toBe(true);
    expect(readCache(key, home)?.id).toBe("s");
  });

  it("migrates legacy cache/*.json into store.db on read", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cache-migrate-"));
    const jsonl = path.join(home, "keep.jsonl");
    writeFileSync(jsonl, "keep\n");
    const key = cacheKey(jsonl);
    mkdirSync(cacheDir(home), { recursive: true });
    writeFileSync(
      path.join(cacheDir(home), `${key}.json`),
      JSON.stringify({ version: CACHE_VERSION, snapshot: snap(jsonl) }),
    );
    expect(readCache(key, home)?.path).toBe(jsonl);
    expect(existsSync(storeDbPath(home))).toBe(true);
  });
});

describe("pruneStaleCache", () => {
  it("removes cache entries whose stored version is not current", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cache-home-"));
    const jsonl = path.join(home, "keep.jsonl");
    writeFileSync(jsonl, "keep\n");
    const key = cacheKey(jsonl);
    writeCache(key, snap(jsonl), home);
    // Legacy stale file still gets cleaned when prune scans cache/.
    mkdirSync(cacheDir(home), { recursive: true });
    writeFileSync(
      path.join(home, "cache", "old.json"),
      JSON.stringify({ version: CACHE_VERSION - 1, snapshot: {} }),
    );
    const removed = pruneStaleCache(home);
    expect(removed).toBeGreaterThan(0);
    expect(readCache(key, home)?.id).toBe("s");
    expect(readdirSync(path.join(home, "cache")).includes("old.json")).toBe(false);
  });

  it("removes superseded current-version entries after the source changes", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cache-home-"));
    const jsonl = path.join(home, "rollout.jsonl");
    writeFileSync(jsonl, "line-1\n");
    const first = cacheKey(jsonl);
    writeCache(first, { ...snap(jsonl) }, home);
    writeFileSync(jsonl, "line-1\nline-2\n");
    const second = cacheKey(jsonl);
    expect(second).not.toBe(first);
    writeCache(second, { ...snap(jsonl) }, home);
    pruneStaleCache(home);
    expect(readCache(first, home)).toBeUndefined();
    expect(readCache(second, home)?.path).toBe(jsonl);
  });
});
