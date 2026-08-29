import { describe, expect, it } from "vitest";
import type { Cost } from "./api";
import {
  allocatePercents,
  activityTimestamp,
  cacheHitRatio,
  disclaimer,
  formatCost,
  formatCostTitle,
  formatPercent,
  formatRelativeTime,
  headlineCostUnit,
  tokenIdentity,
  unpricedNote,
  unpricedRawFromTurns,
  wasteShare,
} from "./format";

function cost(partial: Partial<Cost> & { raw: number }): Cost {
  return {
    uncached_input: 0,
    cached_input: 0,
    output: 0,
    credits: 0,
    usd: 0,
    ...partial,
  };
}

describe("allocatePercents", () => {
  it("keeps zeros at zero and sums to 100 at 1 decimal", () => {
    const percents = allocatePercents([200, 0, 0, 0, 100, 0], 1);
    expect(percents[1]).toBe(0);
    expect(percents.reduce((sum, n) => sum + n, 0)).toBeCloseTo(100, 5);
  });

  it("does not round a 0.4% slice down to 0% at 1 decimal", () => {
    const percents = allocatePercents([996, 4], 1);
    expect(percents[1]).toBeGreaterThan(0);
    expect(percents.reduce((sum, n) => sum + n, 0)).toBeCloseTo(100, 5);
  });
});

describe("wasteShare", () => {
  it("uses the active unit so credit share can differ from token share", () => {
    const total = cost({ raw: 1000, credits: 100, usd: 4 });
    const waste = cost({ raw: 400, credits: 25, usd: 1 });
    expect(wasteShare(waste, total, "tokens")).toBe("40.0%");
    expect(wasteShare(waste, total, "credits")).toBe("25.0%");
    expect(wasteShare(waste, total, "usd")).toBe("25.0%");
  });

  it("does not pretend a token share is a credit share when money is unknown", () => {
    const total = cost({ raw: 200, credits: null, usd: null });
    const waste = cost({ raw: 50, credits: null, usd: null });
    expect(wasteShare(waste, total, "credits")).toBe("—");
    expect(wasteShare(waste, total, "usd")).toBe("—");
    expect(wasteShare(waste, total, "tokens")).toBe("25.0%");
  });

  it("keeps the active unit on every headline", () => {
    expect(headlineCostUnit("tokens")).toBe("tokens");
    expect(headlineCostUnit("credits")).toBe("credits");
    expect(headlineCostUnit("usd")).toBe("usd");
  });

  it("includes the rate-card date in the billing disclaimer", () => {
    expect(disclaimer("2026-08-27")).toMatch(/Not OpenAI's bill/);
    expect(disclaimer("2026-08-27")).toContain("2026-08-27");
  });

  it("names unpriced leftover tokens instead of hiding them", () => {
    expect(unpricedNote(0)).toBe("");
    expect(unpricedNote(5100)).toBe("另有 5,100 tokens 未定价");
    expect(
      unpricedRawFromTurns([
        { cost: { raw: 10_000, credits: 100 } },
        { cost: { raw: 50, credits: null } },
      ]),
    ).toBe(50);
  });

  it("does not round a non-zero share down to 0.0%", () => {
    const total = cost({ raw: 7_653_030, credits: 1000, usd: 40 });
    const waste = cost({ raw: 2_380, credits: 0.2, usd: 0.01 });
    expect(wasteShare(waste, total, "tokens")).toBe("<0.1%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(wasteShare(cost({ raw: 0 }), cost({ raw: 0 }), "tokens")).toBe("0.0%");
  });
});

describe("formatCost", () => {
  it("does not round a non-zero credit leftover to 0.0", () => {
    expect(formatCost(cost({ raw: 40, credits: 0.04, usd: 0.0016 }), "credits")).toBe(
      "0.04",
    );
    expect(formatCost(cost({ raw: 40, credits: 0.04, usd: 0.0016 }), "usd")).toBe(
      "$0.0016",
    );
  });

  it("keeps ordinary credits at one decimal and dollars at two", () => {
    expect(formatCost(cost({ raw: 1000, credits: 12.5, usd: 0.5 }), "credits")).toBe(
      "12.5",
    );
    expect(formatCost(cost({ raw: 1000, credits: 12.5, usd: 0.5 }), "usd")).toBe(
      "$0.50",
    );
  });

  it("puts the exact ledger value in the tooltip", () => {
    expect(
      formatCostTitle(cost({ raw: 40, credits: 0.041234, usd: 0.001649 }), "credits"),
    ).toContain("0.041234");
  });
});

describe("tokenIdentity", () => {
  it("checks uncached + cached + output against raw, without adding reasoning", () => {
    expect(
      tokenIdentity(
        cost({
          raw: 130,
          uncached_input: 20,
          cached_input: 80,
          output: 30,
        }),
      ),
    ).toEqual({ parts: 130, ok: true });
    expect(
      tokenIdentity(
        cost({
          raw: 100,
          uncached_input: 20,
          cached_input: 80,
          output: 30,
        }),
      ),
    ).toEqual({ parts: 130, ok: false });
  });
});

describe("cacheHitRatio", () => {
  it("is cached input over all input, ignoring output", () => {
    expect(
      cacheHitRatio(
        cost({
          raw: 130,
          uncached_input: 20,
          cached_input: 80,
          output: 30,
        }),
      ),
    ).toBeCloseTo(0.8, 5);
    expect(cacheHitRatio(cost({ raw: 10, output: 10 }))).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  it("uses minutes for recent sessions", () => {
    expect(formatRelativeTime("2026-08-28T11:50:00.000Z", now)).toMatch(
      /10\s*分钟前/,
    );
  });

  it("returns an em dash for missing timestamps", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
  });
});

describe("activityTimestamp", () => {
  it("prefers last activity so range labels match the filter", () => {
    expect(
      activityTimestamp({
        startedAt: "2026-07-19T09:00:00.000Z",
        lastEventAt: "2026-08-28T11:00:00.000Z",
      }),
    ).toBe("2026-08-28T11:00:00.000Z");
  });
});
