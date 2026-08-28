import { describe, expect, it } from "vitest";
import type { Bucket, Cost, DetectorLabel, SessionSnapshot, Turn } from "../src/types.ts";
import { DEFAULT_WASTE_TOGGLES, emptyCost } from "../src/types.ts";
import { buildTree, isIdleChild, sumTurns } from "../src/tree.ts";

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
    sessionId: partial.sessionId ?? "parent",
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

function stubSnapshot(
  id: string,
  nickname: string,
  turns: Turn[],
  children: SessionSnapshot[] = [],
): SessionSnapshot {
  const childCost = sumTurns(turns);
  const tree = buildTree({ sessionId: id, label: nickname, turns, children });
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
    toggles: { ...DEFAULT_WASTE_TOGGLES },
    tree,
    turns,
    children,
    suggestions: [],
  };
}

describe("sumTurns", () => {
  it("sums turn costs", () => {
    const turns = [
      turn({ id: "1", bucket: "code", raw: 100 }),
      turn({ id: "2", bucket: "waiting.poll", raw: 50 }),
    ];
    expect(sumTurns(turns).raw).toBe(150);
  });

  it("keeps known credits when one turn is unpriced", () => {
    const priced = turn({ id: "1", bucket: "code", raw: 100 });
    priced.cost = { ...priced.cost, credits: 1, usd: 0.04 };
    const unknown = turn({ id: "2", bucket: "code", raw: 50 });
    unknown.cost = { ...unknown.cost, credits: null, usd: null };
    const summed = sumTurns([priced, unknown]);
    expect(summed.raw).toBe(150);
    expect(summed.credits).toBe(1);
  });
});

describe("buildTree", () => {
  it("rolls up parent turns and child snapshots", () => {
    const pollTurn = turn({ id: "p1", bucket: "waiting.poll", raw: 100 });
    const codeTurn = turn({ id: "p2", bucket: "code", raw: 300 });
    const childCodeTurn = turn({ id: "c1", bucket: "code", raw: 200, sessionId: "child" });
    const child = stubSnapshot("child", "Plato", [childCodeTurn]);

    const root = buildTree({
      sessionId: "parent",
      label: "parent",
      turns: [pollTurn, codeTurn],
      children: [child],
    });

    expect(root.cost.raw).toBe(600);
    const names = root.children.map((c) => c.label);
    expect(names).toEqual(["planning", "code", "reread", "subagents", "waiting", "other"]);
    const code = root.children.find((c) => c.label === "code")!;
    expect(code.cost.raw).toBe(300);
    expect(code.percentOfParent).toBeCloseTo(50, 5);
    const subs = root.children.find((c) => c.label === "subagents")!;
    expect(subs.cost.raw).toBe(200);
    expect(subs.children[0].label).toBe("Plato");
    const waiting = root.children.find((c) => c.label === "waiting")!;
    expect(waiting.children.find((c) => c.bucket === "waiting.poll")!.cost.raw).toBe(100);
  });

  it("poll and coord percents sum to ~100 of waiting, not of the root", () => {
    const root = buildTree({
      sessionId: "parent",
      label: "parent",
      turns: [
        turn({ id: "p1", bucket: "waiting.poll", raw: 80 }),
        turn({ id: "p2", bucket: "waiting.coord", raw: 20 }),
        turn({ id: "p3", bucket: "code", raw: 100 }),
      ],
      children: [],
    });

    const waiting = root.children.find((c) => c.label === "waiting")!;
    const poll = waiting.children.find((c) => c.bucket === "waiting.poll")!;
    const coord = waiting.children.find((c) => c.bucket === "waiting.coord")!;
    expect(poll.percentOfParent + coord.percentOfParent).toBeCloseTo(100, 5);
    expect(poll.percentOfParent).toBeCloseTo(80, 5);
    expect(coord.percentOfParent).toBeCloseTo(20, 5);
    expect(waiting.percentOfParent).toBeCloseTo(50, 5);
  });

  it("root child percents sum to ~100", () => {
    const root = buildTree({
      sessionId: "s1",
      label: "s1",
      turns: [turn({ id: "1", bucket: "code", raw: 300 }), turn({ id: "2", bucket: "planning", raw: 100 })],
      children: [],
    });
    const sum = root.children.reduce((acc, c) => acc + c.percentOfParent, 0);
    expect(sum).toBeCloseTo(100, 5);
  });
});

describe("isIdleChild", () => {
  it("detects idle child with poll-heavy cost and no code", () => {
    const childTurn = turn({ id: "c1", bucket: "waiting.poll", raw: 80, sessionId: "child" });
    const child = stubSnapshot("child", "Plato", [childTurn]);
    expect(isIdleChild(child)).toBe(true);
  });

  it("returns false when child has code cost", () => {
    const childTurn = turn({ id: "c1", bucket: "code", raw: 200, sessionId: "child" });
    const child = stubSnapshot("child", "Plato", [childTurn]);
    expect(isIdleChild(child)).toBe(false);
  });

  it("returns false when cost.raw is 0", () => {
    const child = stubSnapshot("child", "Plato", []);
    expect(isIdleChild(child)).toBe(false);
  });

  it("uses own-turn raw as the idle denominator, not rolled-up descendants", () => {
    const grandchild = stubSnapshot("gc", "gc", [
      turn({ id: "g1", bucket: "code", raw: 1000, sessionId: "gc" }),
    ]);
    const childTurns = [
      turn({ id: "c1", bucket: "waiting.poll", raw: 80, sessionId: "child" }),
    ];
    const child = stubSnapshot("child", "Plato", childTurns, [grandchild]);
    child.cost = buildTree({
      sessionId: child.id,
      label: child.nickname ?? child.id,
      turns: child.turns,
      children: child.children,
    }).cost;
    expect(child.cost.raw).toBe(1080);
    expect(isIdleChild(child)).toBe(true);
  });
});
