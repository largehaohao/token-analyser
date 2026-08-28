import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  pruneStaleCache,
  writeCache,
  cacheKey,
  cacheDir,
  CACHE_VERSION,
} from "../src/cache.ts";
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

describe("pruneStaleCache", () => {
  it("removes cache files whose stored version is not current", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cache-home-"));
    const jsonl = path.join(home, "keep.jsonl");
    writeFileSync(jsonl, "keep\n");
    const key = cacheKey(jsonl);
    writeCache(key, snap(jsonl), home);
    writeFileSync(
      path.join(home, "cache", "old.json"),
      JSON.stringify({ version: CACHE_VERSION - 1, snapshot: {} }),
    );
    const removed = pruneStaleCache(home);
    expect(removed).toBeGreaterThan(0);
    const files = readdirSync(path.join(home, "cache"));
    expect(files).toEqual([`${key}.json`]);
  });

  it("removes superseded current-version files after the source changes", () => {
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
    expect(readdirSync(cacheDir(home))).toEqual([`${second}.json`]);
  });
});
