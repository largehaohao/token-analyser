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
  isWeekendDate,
  localDateString,
  niceChartTicks,
  shouldLabelChartDay,
  TREND_COLUMN_GAP_PX,
  TREND_COLUMN_MIN_WIDTH_PX,
  TREND_COLUMN_SLOT_PX,
  trendContentMinWidth,
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

  it("reserves a column wide enough for a full MM/DD tick", () => {
    expect(formatChartDay("2026-10-30")).toBe("10/30");
    // Slot must include CSS min-width and the flex gap between columns.
    expect(TREND_COLUMN_MIN_WIDTH_PX).toBe(34);
    expect(TREND_COLUMN_GAP_PX).toBe(3);
    expect(TREND_COLUMN_SLOT_PX).toBe(
      TREND_COLUMN_MIN_WIDTH_PX + TREND_COLUMN_GAP_PX,
    );
    expect(trendContentMinWidth(8)).toBe(
      44 + 8 * TREND_COLUMN_SLOT_PX - TREND_COLUMN_GAP_PX,
    );
  });
});

describe("niceChartTicks", () => {
  it("produces round steps that cover the max", () => {
    expect(niceChartTicks(100)).toEqual([0, 50, 100]);
    expect(niceChartTicks(80)).toEqual([0, 20, 40, 60, 80]);
    expect(niceChartTicks(400)).toEqual([0, 100, 200, 300, 400]);
  });

  it("appends the exact max when the step overshoots it", () => {
    expect(niceChartTicks(90)).toEqual([0, 50, 90]);
  });

  it("handles tiny and invalid maxima", () => {
    expect(niceChartTicks(0)).toEqual([0]);
    expect(niceChartTicks(-5)).toEqual([0]);
    expect(niceChartTicks(Number.NaN)).toEqual([0]);
    expect(niceChartTicks(4)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("localDateString / isWeekendDate", () => {
  it("formats the local calendar date", () => {
    expect(localDateString(new Date(2026, 10, 16))).toBe("2026-11-16");
    expect(localDateString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("flags Saturday and Sunday only", () => {
    expect(isWeekendDate("2026-11-14")).toBe(true);
    expect(isWeekendDate("2026-11-15")).toBe(true);
    expect(isWeekendDate("2026-11-16")).toBe(false);
    expect(isWeekendDate("2026-11-13")).toBe(false);
  });
});
