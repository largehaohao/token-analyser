import { describe, expect, it } from "vitest";
import type { OverviewDay } from "./api";
import {
  barHeightPct,
  chartDayTooltip,
  chartMax,
  trendColumnAriaLabel,
  dayHasMixedUnpriced,
  dayMetricValue,
  flaggedValue,
  formatChartDay,
  shouldLabelChartDay,
  unitToChartMetric,
} from "./chart-metric";

function day(partial: {
  date: string;
  raw: number;
  credits?: number | null;
  usd?: number | null;
  unpricedRaw?: number;
  flaggedRaw?: number;
  flaggedCredits?: number | null;
  flaggedUsd?: number | null;
}): OverviewDay {
  return {
    date: partial.date,
    cost: {
      raw: partial.raw,
      uncached_input: 0,
      cached_input: 0,
      output: 0,
      credits: partial.credits === undefined ? partial.raw / 100 : partial.credits,
      usd: partial.usd === undefined ? partial.raw / 1000 : partial.usd,
    },
    flaggedCost: {
      raw: partial.flaggedRaw ?? 0,
      uncached_input: 0,
      cached_input: 0,
      output: 0,
      credits:
        partial.flaggedCredits === undefined
          ? (partial.flaggedRaw ?? 0) === 0
            ? 0
            : (partial.flaggedRaw ?? 0) / 100
          : partial.flaggedCredits,
      usd:
        partial.flaggedUsd === undefined
          ? (partial.flaggedRaw ?? 0) === 0
            ? 0
            : (partial.flaggedRaw ?? 0) / 1000
          : partial.flaggedUsd,
    },
    unpricedRaw: partial.unpricedRaw ?? 0,
  };
}

describe("dayMetricValue", () => {
  it("does not coerce unknown money to zero", () => {
    const unknown = day({ date: "2026-08-28", raw: 7653600, credits: null, usd: null });
    expect(dayMetricValue(unknown, "tokens")).toBe(7653600);
    expect(dayMetricValue(unknown, "usd")).toBeNull();
    expect(dayMetricValue(unknown, "credits")).toBeNull();
  });
});

describe("flaggedValue", () => {
  it("does not coerce unknown flagged money to zero", () => {
    const mixed = day({
      date: "2026-08-28",
      raw: 10_050,
      credits: 100,
      usd: 4,
      flaggedRaw: 50,
      flaggedCredits: null,
      flaggedUsd: null,
    });
    expect(flaggedValue(mixed, "tokens")).toBe(50);
    expect(flaggedValue(mixed, "credits")).toBeNull();
    expect(flaggedValue(mixed, "usd")).toBeNull();
  });
});

describe("dayHasMixedUnpriced", () => {
  it("marks a priced day that still has unpriced leftover tokens", () => {
    const mixed = day({
      date: "2026-08-28",
      raw: 10_050,
      credits: 100,
      usd: 4,
      unpricedRaw: 50,
    });
    expect(dayHasMixedUnpriced(mixed, "credits")).toBe(true);
    expect(dayHasMixedUnpriced(mixed, "tokens")).toBe(true);
    const fullyUnknown = day({
      date: "2026-08-27",
      raw: 5100,
      credits: null,
      usd: null,
      unpricedRaw: 5100,
    });
    expect(dayHasMixedUnpriced(fullyUnknown, "credits")).toBe(false);
  });
});

describe("barHeightPct", () => {
  it("keeps an unpriced busy day visible instead of flattening it", () => {
    const max = chartMax([2.53, null]);
    expect(max).toBe(2.53);
    const unpriced = barHeightPct(null, 7_653_600, max);
    expect(unpriced.unpriced).toBe(true);
    expect(unpriced.height).toBeGreaterThan(0);
    const priced = barHeightPct(2.53, 501_000, max);
    expect(priced.height).toBe(100);
  });
});

describe("chart labels", () => {
  it("always labels overflow buckets and does not shift date ticks", () => {
    const dates = ["earlier", "2026-08-21", "2026-08-22", "later"];
    expect(shouldLabelChartDay("earlier", dates)).toBe(true);
    expect(shouldLabelChartDay("later", dates)).toBe(true);
    expect(shouldLabelChartDay("2026-08-21", dates)).toBe(true);
    expect(formatChartDay("earlier")).toBe("更早");
    expect(formatChartDay("later")).toBe("之后");
    expect(chartDayTooltip("later")).toBe("窗口之后");
  });

  it("names a focused trend column for assistive tech", () => {
    const labeled = day({ date: "2026-08-28", raw: 1000, credits: 10, usd: 0.4 });
    expect(trendColumnAriaLabel(labeled, "credits")).toMatch(/2026-08-28/);
    expect(trendColumnAriaLabel(labeled, "credits")).toMatch(/10/);
  });

  it("follows the page unit instead of a second chart unit", () => {
    expect(unitToChartMetric("tokens")).toBe("tokens");
    expect(unitToChartMetric("usd")).toBe("usd");
  });
});
