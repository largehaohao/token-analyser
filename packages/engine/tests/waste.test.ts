import { describe, expect, it } from "vitest";
import type { Bucket, Cost, DetectorLabel, SessionSnapshot, Turn } from "../src/types.ts";
import { DEFAULT_WASTE_TOGGLES, emptyCost } from "../src/types.ts";
import { buildTree, sumTurns } from "../src/tree.ts";
import { computeWaste } from "../src/waste.ts";

function cost(raw: number): Cost {
  return { raw, uncached_input: 0, cached_input: 0, output: 0, credits: 0, usd: 0 };
}

function turn(partial: {
  id: string;
  bucket: Bucket;
  raw: number;
  sessionId?: string;
  labels?: DetectorLabel[];
}): Turn {
  return {
    id: partial.id,
    sessionId: partial.sessionId ?? "s1",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    model: null,
    effort: null,
    prompt: "",
    tools: [],
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    },
    cost: cost(partial.raw),
    bucket: partial.bucket,
    labels: partial.labels ?? [],
    hasPatchApply: false,
    collaborationMode: null,
  };
}

function snapshotWithTurns(id: string, nickname: string, turns: Turn[]): SessionSnapshot {
  const childCost = sumTurns(turns);
  const tree = buildTree({ sessionId: id, label: nickname, turns, children: [] });
  return {
    id,
    parentId: "parent",
    nickname,
    cwd: null,
    live: false,
    path: `/tmp/${id}.jsonl`,
    startedAt: null,
    lastEventAt: null,
    model: null,
    effort: null,
    ledger_warning: false,
    parse_errors: [],
    rate_limits: null,
    rateCardAsOf: "2026-01-01",
    fastMode: false,
    cost: childCost,
    waste: emptyCost(),
    toggles: DEFAULT_WASTE_TOGGLES,
    tree,
    turns,
    children: [],
    suggestions: [],
  };
}

describe("computeWaste", () => {
  it("default toggles count poll and hash-reread once even if also compaction_loop", () => {
    const poll = turn({ id: "1", bucket: "waiting.poll", raw: 100 });
    const reread = turn({ id: "2", bucket: "reread", raw: 50, labels: ["compaction_loop"] });
    const { waste, turnIds } = computeWaste({
      turns: [poll, reread],
      children: [],
      toggles: DEFAULT_WASTE_TOGGLES,
    });
    expect(turnIds).toEqual(new Set(["1", "2"]));
    expect(waste.raw).toBe(150);
  });

  it("idle child full raw counts once with poll toggle also on", () => {
    const childTurn = turn({ id: "c1", bucket: "waiting.poll", raw: 80, sessionId: "child" });
    const child = snapshotWithTurns("child", "Plato", [childTurn]);
    const { waste, turnIds } = computeWaste({
      turns: [],
      children: [child],
      toggles: DEFAULT_WASTE_TOGGLES,
    });
    expect(turnIds).toEqual(new Set(["c1"]));
    expect(waste.raw).toBe(80);
  });

  it("different hash reread bucket is not waste by default", () => {
    const t = turn({ id: "3", bucket: "other", raw: 40 });
    const { waste } = computeWaste({
      turns: [t],
      children: [],
      toggles: DEFAULT_WASTE_TOGGLES,
    });
    expect(waste.raw).toBe(0);
  });

  it("counts an idle grandchild even when its parent child is healthy", () => {
    const grandchild = snapshotWithTurns("grandchild", "GC", [
      turn({ id: "gc-poll", bucket: "waiting.poll", raw: 80, sessionId: "grandchild" }),
    ]);
    const child = snapshotWithTurns("child", "Child", [
      turn({ id: "child-code", bucket: "code", raw: 200, sessionId: "child" }),
    ]);
    child.children = [grandchild];
    child.cost = buildTree({
      sessionId: child.id,
      label: child.nickname ?? child.id,
      turns: child.turns,
      children: child.children,
    }).cost;

    const { waste } = computeWaste({
      turns: [],
      children: [child],
      toggles: DEFAULT_WASTE_TOGGLES,
    });
    expect(waste.raw).toBe(80);
  });

  it("default poll toggle counts poll inside a healthy child", () => {
    const parentPoll = turn({ id: "pp", bucket: "waiting.poll", raw: 200 });
    const child = snapshotWithTurns("child", "Worker", [
      turn({ id: "cp", bucket: "waiting.poll", raw: 80, sessionId: "child" }),
      turn({ id: "cc", bucket: "code", raw: 400, sessionId: "child" }),
    ]);
    const { waste, turnIds } = computeWaste({
      turns: [parentPoll],
      children: [child],
      toggles: DEFAULT_WASTE_TOGGLES,
    });
    expect(turnIds).toEqual(new Set(["pp", "cp"]));
    expect(waste.raw).toBe(280);
  });

  it("keeps known credits when one waste turn is unpriced", () => {
    const priced = turn({ id: "1", bucket: "waiting.poll", raw: 100 });
    priced.cost = {
      ...priced.cost,
      credits: 1,
      usd: 0.04,
    };
    const unknown = turn({ id: "2", bucket: "waiting.poll", raw: 200 });
    unknown.cost = { ...unknown.cost, credits: null, usd: null };
    const { waste } = computeWaste({
      turns: [priced, unknown],
      children: [],
      toggles: DEFAULT_WASTE_TOGGLES,
    });
    expect(waste.raw).toBe(300);
    expect(waste.credits).toBeCloseTo(1, 5);
    expect(waste.usd).toBeCloseTo(0.04, 5);
  });
});
