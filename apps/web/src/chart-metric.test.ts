import { describe, expect, it } from "vitest";
import type { OverviewDay } from "./api";
import {
  barHeightPct,
  chartDayTooltip,
  chartMax,
  dayMetricValue,
  formatChartDay,
  shouldLabelChartDay,
  unitToChartMetric,
} from "./chart-metric";

function day(partial: {
  date: string;
  raw: number;
  credits?: number | null;
  usd?: number | null;
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
      raw: 0,
      uncached_input: 0,
      cached_input: 0,
      output: 0,
      credits: 0,
      usd: 0,
    },
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

  it("follows the page unit instead of a second chart unit", () => {
    expect(unitToChartMetric("tokens")).toBe("tokens");
    expect(unitToChartMetric("usd")).toBe("usd");
  });
});
