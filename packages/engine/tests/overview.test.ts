import { describe, expect, it } from "vitest";
import type { Bucket, Cost, SessionSnapshot, Turn } from "../src/types.ts";
import { DEFAULT_WASTE_TOGGLES } from "../src/types.ts";
import { buildTree } from "../src/tree.ts";
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
  endedAt?: string;
  priced?: boolean;
}): Turn {
  const priced = cost(partial.raw);
  return {
    id: partial.id,
    sessionId: "s",
    startedAt: partial.startedAt ?? "2026-08-27T10:00:00.000Z",
    endedAt: partial.endedAt ?? partial.startedAt ?? "2026-08-27T10:00:01.000Z",
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
    cost:
      partial.priced === false
        ? { ...priced, credits: null, usd: null }
        : priced,
    bucket: partial.bucket,
    labels: [],
    hasPatchApply: false,
    collaborationMode: null,
  };
}

function session(partial: {
  id: string;
  startedAt: string;
  lastEventAt?: string;
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
    lastEventAt: partial.lastEventAt ?? partial.startedAt,
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
          turns: [
            turn({ id: "t1", bucket: "code", raw: 1000 }),
            turn({
              id: "w1",
              bucket: "waiting.poll",
              raw: 100,
              startedAt: "2026-08-27T10:00:00.000Z",
            }),
          ],
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
    expect(overview.turnCount).toBe(3);
    expect(overview.cost.raw).toBe(1600);
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
          turns: [
            turn({
              id: "t2",
              bucket: "planning",
              raw: 500,
              startedAt: "2026-08-28T10:00:00.000Z",
            }),
          ],
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

  it("splits a session across UTC days by turn endedAt, not startedAt", () => {
    const overview = buildOverview(
      [
        session({
          id: "overnight",
          startedAt: "2026-08-27T23:00:00.000Z",
          turns: [
            turn({
              id: "late",
              bucket: "code",
              raw: 100,
              startedAt: "2026-08-27T23:10:00.000Z",
              endedAt: "2026-08-27T23:50:00.000Z",
            }),
            turn({
              id: "early",
              bucket: "code",
              raw: 200,
              startedAt: "2026-08-27T23:55:00.000Z",
              endedAt: "2026-08-28T00:20:00.000Z",
            }),
          ],
        }),
      ],
      {
        watchPath: "/tmp",
        now: "2026-08-28T12:00:00.000Z",
        dayCount: 2,
      },
    );
    expect(overview.cost.raw).toBe(300);
    expect(overview.days.find((d) => d.date === "2026-08-27")?.cost.raw).toBe(100);
    expect(overview.days.find((d) => d.date === "2026-08-28")?.cost.raw).toBe(200);
  });

  it("puts spend outside the chart window into an earlier bucket so bars match the KPI", () => {
    const overview = buildOverview(
      [
        session({
          id: "old",
          startedAt: "2026-06-20T10:00:00.000Z",
          turns: [
            turn({
              id: "t-old",
              bucket: "code",
              raw: 500,
              startedAt: "2026-06-20T10:00:00.000Z",
              endedAt: "2026-06-20T10:01:00.000Z",
            }),
          ],
        }),
        session({
          id: "new",
          startedAt: "2026-08-28T10:00:00.000Z",
          turns: [turn({ id: "t-new", bucket: "planning", raw: 40 })],
        }),
      ],
      {
        watchPath: "/tmp",
        now: "2026-08-28T12:00:00.000Z",
        dayCount: 8,
      },
    );
    expect(overview.cost.raw).toBe(540);
    expect(overview.days[0]?.date).toBe("earlier");
    expect(overview.days[0]?.cost.raw).toBe(500);
    const barSum = overview.days.reduce((sum, day) => sum + day.cost.raw, 0);
    expect(barSum).toBe(overview.cost.raw);
  });

  it("drops undated sessions from bounded windows", () => {
    const undated = session({
      id: "ghost",
      startedAt: "",
      turns: [turn({ id: "g1", bucket: "other", raw: 999 })],
    });
    undated.startedAt = null;
    undated.lastEventAt = null;
    const overview = buildOverview(
      [
        undated,
        session({
          id: "new",
          startedAt: "2026-08-28T10:00:00.000Z",
          turns: [
            turn({
              id: "t2",
              bucket: "planning",
              raw: 40,
              startedAt: "2026-08-28T10:00:00.000Z",
            }),
          ],
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
    expect(overview.cost.raw).toBe(40);
  });

  it("keeps a long-running session whose last event is inside the window", () => {
    const overview = buildOverview(
      [
        session({
          id: "long",
          startedAt: "2026-07-19T09:00:00.000Z",
          lastEventAt: "2026-08-28T11:00:00.000Z",
          turns: [
            turn({
              id: "old",
              bucket: "code",
              raw: 100,
              startedAt: "2026-07-19T09:00:00.000Z",
            }),
            turn({
              id: "today",
              bucket: "code",
              raw: 9000,
              startedAt: "2026-08-28T11:00:00.000Z",
            }),
          ],
        }),
      ],
      {
        watchPath: "/tmp",
        now: "2026-08-28T12:00:00.000Z",
        sinceMs: Date.parse("2026-08-21T12:00:00.000Z"),
        dayCount: 8,
      },
    );
    expect(overview.sessionCount).toBe(1);
    expect(overview.cost.raw).toBe(9000);
    expect(overview.days.find((d) => d.date === "2026-08-28")?.cost.raw).toBe(
      9000,
    );
    expect(overview.days.find((d) => d.date === "earlier")).toBeUndefined();
  });

  it("does not let one unpriced turn wipe a day's known credits", () => {
    const overview = buildOverview(
      [
        session({
          id: "mix",
          startedAt: "2026-08-28T10:00:00.000Z",
          turns: [
            turn({
              id: "priced",
              bucket: "code",
              raw: 10_000,
              startedAt: "2026-08-28T10:00:00.000Z",
            }),
            turn({
              id: "mystery",
              bucket: "code",
              raw: 50,
              startedAt: "2026-08-28T11:00:00.000Z",
              priced: false,
            }),
          ],
        }),
      ],
      { watchPath: "/tmp", now: "2026-08-28T12:00:00.000Z", dayCount: 2 },
    );
    expect(overview.cost.raw).toBe(10_050);
    expect(overview.cost.credits).toBeCloseTo(100, 5);
    expect(overview.unpricedRaw).toBe(50);
    const today = overview.days.find((d) => d.date === "2026-08-28")!;
    expect(today.cost.raw).toBe(10_050);
    expect(today.cost.credits).toBeCloseTo(100, 5);
    expect(today.cost.usd).not.toBeNull();
    expect(today.unpricedRaw).toBe(50);
    expect(overview.slices.find((s) => s.key === "code")?.credits).toBeCloseTo(
      100,
      5,
    );
  });

  it("keeps a fully unpriced day as null money instead of zero", () => {
    const overview = buildOverview(
      [
        session({
          id: "mystery",
          startedAt: "2026-08-28T10:00:00.000Z",
          turns: [
            turn({
              id: "u",
              bucket: "other",
              raw: 5100,
              startedAt: "2026-08-28T10:00:00.000Z",
              priced: false,
            }),
          ],
        }),
      ],
      { watchPath: "/tmp", now: "2026-08-28T12:00:00.000Z", dayCount: 2 },
    );
    expect(overview.cost.credits).toBeNull();
    expect(overview.unpricedRaw).toBe(5100);
    const today = overview.days.find((d) => d.date === "2026-08-28")!;
    expect(today.cost.raw).toBe(5100);
    expect(today.cost.credits).toBeNull();
    expect(today.cost.usd).toBeNull();
  });

  it("puts future-dated turns in a later bucket, not earlier", () => {
    const overview = buildOverview(
      [
        session({
          id: "clock",
          startedAt: "2026-08-28T10:00:00.000Z",
          turns: [
            turn({
              id: "future",
              bucket: "code",
              raw: 500,
              startedAt: "2026-09-30T10:00:00.000Z",
            }),
          ],
        }),
      ],
      { watchPath: "/tmp", now: "2026-08-28T12:00:00.000Z", dayCount: 8 },
    );
    expect(overview.days.map((d) => d.date)).toContain("later");
    expect(overview.days[0]?.date).not.toBe("later");
    expect(overview.days.at(-1)?.date).toBe("later");
    expect(overview.days.at(-1)?.cost.raw).toBe(500);
    expect(overview.days.find((d) => d.date === "earlier")).toBeUndefined();
  });

  it("counts only in-window waste and keeps known waste credits", () => {
    const overview = buildOverview(
      [
        session({
          id: "mix-waste",
          startedAt: "2026-07-19T09:00:00.000Z",
          lastEventAt: "2026-08-28T11:00:00.000Z",
          wasteRaw: 0,
          turns: [
            turn({
              id: "old-poll",
              bucket: "waiting.poll",
              raw: 80,
              startedAt: "2026-07-19T09:00:00.000Z",
            }),
            turn({
              id: "today-poll",
              bucket: "waiting.poll",
              raw: 20,
              startedAt: "2026-08-28T11:00:00.000Z",
            }),
            turn({
              id: "today-unknown",
              bucket: "waiting.poll",
              raw: 40,
              startedAt: "2026-08-28T11:30:00.000Z",
              priced: false,
            }),
          ],
        }),
      ],
      {
        watchPath: "/tmp",
        now: "2026-08-28T12:00:00.000Z",
        sinceMs: Date.parse("2026-08-21T12:00:00.000Z"),
        dayCount: 8,
      },
    );
    expect(overview.cost.raw).toBe(60);
    expect(overview.waste.raw).toBe(60);
    expect(overview.waste.credits).toBeCloseTo(0.2, 5);
  });

  it("uses zero money, not null, on empty chart days", () => {
    const overview = buildOverview([], {
      watchPath: "/tmp",
      now: "2026-08-28T12:00:00.000Z",
      dayCount: 2,
    });
    expect(overview.cost.credits).toBe(0);
    expect(overview.days[0]?.cost.credits).toBe(0);
    expect(overview.days[0]?.unpricedRaw).toBe(0);
  });

  it("keeps a parent whose child is still active in the window", () => {
    const child = session({
      id: "child",
      startedAt: "2026-08-28T11:00:00.000Z",
      lastEventAt: "2026-08-28T11:00:00.000Z",
      turns: [
        turn({
          id: "c1",
          bucket: "code",
          raw: 80,
          startedAt: "2026-08-28T11:00:00.000Z",
        }),
      ],
    });
    child.parentId = "parent";
    const overview = buildOverview(
      [
        session({
          id: "parent",
          startedAt: "2026-07-01T10:00:00.000Z",
          lastEventAt: "2026-07-01T10:00:00.000Z",
          turns: [
            turn({
              id: "p1",
              bucket: "planning",
              raw: 20,
              startedAt: "2026-07-01T10:00:00.000Z",
            }),
          ],
          children: [child],
        }),
      ],
      {
        watchPath: "/tmp",
        now: "2026-08-28T12:00:00.000Z",
        sinceMs: Date.parse("2026-08-21T12:00:00.000Z"),
        dayCount: 8,
      },
    );
    expect(overview.sessionCount).toBe(1);
    expect(overview.cost.raw).toBe(80);
    expect(overview.days.find((d) => d.date === "earlier")).toBeUndefined();
  });

  it("classifies idle subagents from the full session, then keeps in-window waste", () => {
    const child = session({
      id: "child",
      startedAt: "2026-07-19T09:00:00.000Z",
      lastEventAt: "2026-08-28T11:00:00.000Z",
      turns: [
        turn({
          id: "old-code",
          bucket: "code",
          raw: 200,
          startedAt: "2026-07-19T09:00:00.000Z",
        }),
        turn({
          id: "today-poll",
          bucket: "waiting.poll",
          raw: 80,
          startedAt: "2026-08-28T11:00:00.000Z",
        }),
      ],
    });
    child.parentId = "parent";
    const overview = buildOverview(
      [
        session({
          id: "parent",
          startedAt: "2026-07-19T09:00:00.000Z",
          lastEventAt: "2026-08-28T11:00:00.000Z",
          turns: [],
          children: [child],
        }),
      ],
      {
        watchPath: "/tmp",
        now: "2026-08-28T12:00:00.000Z",
        sinceMs: Date.parse("2026-08-21T12:00:00.000Z"),
        dayCount: 8,
      },
    );
    expect(overview.cost.raw).toBe(80);
    expect(overview.waste.raw).toBe(0);
  });
});
