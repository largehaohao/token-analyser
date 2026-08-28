import { describe, expect, it } from "vitest";
import type { Bucket, Cost, SessionSnapshot, Turn } from "../src/types.ts";
import { DEFAULT_WASTE_TOGGLES } from "../src/types.ts";
import { buildTree, sumTurns } from "../src/tree.ts";
import { buildOverview } from "../src/overview.ts";

function cost(raw: number): Cost {
  return {
    raw,
    uncached_input: 0,
    cached_input: 0,
    output: 0,
    credits: raw / 100,
    usd: raw / 1000,
  };
}

function turn(partial: {
  id: string;
  bucket: Bucket;
  raw: number;
  startedAt?: string;
}): Turn {
  return {
    id: partial.id,
    sessionId: "s",
    startedAt: partial.startedAt ?? "2026-08-27T10:00:00.000Z",
    endedAt: "2026-08-27T10:00:01.000Z",
    model: "gpt-5.6-luna",
    effort: "max",
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
    labels: [],
    hasPatchApply: false,
    collaborationMode: null,
  };
}

function session(partial: {
  id: string;
  startedAt: string;
  turns: Turn[];
  children?: SessionSnapshot[];
  ledger_warning?: boolean;
  live?: boolean;
  wasteRaw?: number;
}): SessionSnapshot {
  const children = partial.children ?? [];
  const tree = buildTree({
    sessionId: partial.id,
    label: partial.id,
    turns: partial.turns,
    children,
  });
  return {
    id: partial.id,
    parentId: null,
    nickname: partial.id,
    cwd: "/repo",
    live: partial.live ?? false,
    path: `/tmp/${partial.id}.jsonl`,
    startedAt: partial.startedAt,
    lastEventAt: partial.startedAt,
    model: "gpt-5.6-luna",
    effort: "max",
    ledger_warning: partial.ledger_warning ?? false,
    parse_errors: [],
    rate_limits: null,
    rateCardAsOf: "2026-08-27",
    fastMode: false,
    cost: tree.cost,
    waste: cost(partial.wasteRaw ?? 0),
    toggles: { ...DEFAULT_WASTE_TOGGLES },
    tree,
    turns: partial.turns,
    children,
    suggestions: [],
  };
}

describe("buildOverview", () => {
  it("sums root costs, turns, waste, and tree slices", () => {
    const overview = buildOverview(
      [
        session({
          id: "a",
          startedAt: "2026-08-27T10:00:00.000Z",
          turns: [turn({ id: "t1", bucket: "code", raw: 1000 })],
          wasteRaw: 100,
        }),
        session({
          id: "b",
          startedAt: "2026-08-28T10:00:00.000Z",
          turns: [turn({ id: "t2", bucket: "planning", raw: 500 })],
        }),
      ],
      { watchPath: "/Users/zhanghao/.codex", now: "2026-08-28T12:00:00.000Z" },
    );

    expect(overview.sessionCount).toBe(2);
    expect(overview.turnCount).toBe(2);
    expect(overview.cost.raw).toBe(1500);
    expect(overview.waste.raw).toBe(100);
    expect(overview.watchPath).toBe("/Users/zhanghao/.codex");
    expect(overview.slices.find((s) => s.key === "code")?.raw).toBe(1000);
    expect(overview.slices.find((s) => s.key === "planning")?.raw).toBe(500);
  });

  it("fills eight UTC days ending at now and marks flagged days", () => {
    const overview = buildOverview(
      [
        session({
          id: "ok",
          startedAt: "2026-08-27T10:00:00.000Z",
          turns: [turn({ id: "t1", bucket: "code", raw: 200 })],
        }),
        session({
          id: "bad",
          startedAt: "2026-08-27T18:00:00.000Z",
          turns: [turn({ id: "t2", bucket: "other", raw: 50 })],
          ledger_warning: true,
        }),
      ],
      { watchPath: "/tmp", now: "2026-08-28T12:00:00.000Z" },
    );

    expect(overview.days.map((d) => d.date)).toEqual([
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
    ]);
    const day = overview.days.find((d) => d.date === "2026-08-27")!;
    expect(day.cost.raw).toBe(250);
    expect(day.flaggedCost.raw).toBe(50);
  });

  it("counts nested child turns without listing child sessions", () => {
    const child = session({
      id: "child",
      startedAt: "2026-08-27T11:00:00.000Z",
      turns: [turn({ id: "c1", bucket: "code", raw: 80 })],
    });
    child.parentId = "parent";
    const overview = buildOverview(
      [
        session({
          id: "parent",
          startedAt: "2026-08-27T10:00:00.000Z",
          turns: [turn({ id: "p1", bucket: "planning", raw: 20 })],
          children: [child],
        }),
      ],
      { watchPath: "/tmp", now: "2026-08-28T12:00:00.000Z" },
    );
    expect(overview.sessionCount).toBe(1);
    expect(overview.turnCount).toBe(2);
    expect(overview.slices.find((s) => s.key === "subagents")?.raw).toBe(80);
  });

  it("drops sessions older than sinceMs from totals and slices", () => {
    const overview = buildOverview(
      [
        session({
          id: "old",
          startedAt: "2026-08-20T10:00:00.000Z",
          turns: [turn({ id: "t1", bucket: "code", raw: 1000 })],
        }),
        session({
          id: "new",
          startedAt: "2026-08-28T10:00:00.000Z",
          turns: [turn({ id: "t2", bucket: "planning", raw: 500 })],
        }),
      ],
      {
        watchPath: "/tmp",
        now: "2026-08-28T12:00:00.000Z",
        sinceMs: Date.parse("2026-08-27T12:00:00.000Z"),
        dayCount: 2,
      },
    );
    expect(overview.sessionCount).toBe(1);
    expect(overview.cost.raw).toBe(500);
    expect(overview.slices.find((s) => s.key === "code")?.raw).toBe(0);
    expect(overview.slices.find((s) => s.key === "planning")?.raw).toBe(500);
    expect(overview.days.map((d) => d.date)).toEqual([
      "2026-08-27",
      "2026-08-28",
    ]);
  });
});
