import { describe, expect, it } from "vitest";
import type { OverviewDay } from "./api";
import {
  cumulativeSeries,
  donutArc,
  donutSegments,
  heatCalendar,
  metricSeries,
  movingAverage,
  trendOverlay,
} from "./visual-metrics";

const cost = (raw: number) => ({
  raw,
  uncached_input: 0,
  cached_input: 0,
  output: raw,
  credits: raw,
  usd: raw,
});

const days: OverviewDay[] = [
  { date: "2026-11-01", cost: cost(10), flaggedCost: cost(0), unpricedRaw: 0 },
  { date: "2026-11-02", cost: cost(20), flaggedCost: cost(0), unpricedRaw: 0 },
  { date: "2026-11-03", cost: cost(30), flaggedCost: cost(0), unpricedRaw: 0 },
  { date: "2026-11-04", cost: cost(40), flaggedCost: cost(0), unpricedRaw: 0 },
];

describe("metric series", () => {
  it("maps the active unit through the shared day metric", () => {
    expect(metricSeries(days, "tokens").map((p) => p.value)).toEqual([10, 20, 30, 40]);
    expect(metricSeries(days, "usd").map((p) => p.value)).toEqual([10, 20, 30, 40]);
  });

  it("keeps missing readings missing", () => {
    expect(cumulativeSeries([{ date: "a", value: 3 }, { date: "b", value: null }])).toEqual([3, 3]);
  });
});

describe("trend overlays", () => {
  it("cumulates recorded values", () => {
    expect(trendOverlay(metricSeries(days, "tokens"), "cumulative")).toEqual([10, 30, 60, 100]);
  });

  it("averages a trailing window without crossing a gap", () => {
    expect(movingAverage([2, null, 4, 6], 2)).toEqual([2, null, null, 5]);
  });

  it("masks the cumulative value where the day is unpriced", () => {
    const points = [{ date: "a", value: 5 }, { date: "b", value: null }];
    expect(trendOverlay(points, "cumulative")).toEqual([5, null]);
  });
});

describe("donut geometry", () => {
  it("drops empty segments", () => {
    expect(donutSegments([
      { key: "in", label: "输入", value: 8, color: "blue" },
      { key: "out", label: "输出", value: 0, color: "green" },
    ])).toHaveLength(1);
  });

  it("scales the arc to the share and guards a zero total", () => {
    const arc = donutArc(8, 2, 10);
    expect(arc.dash).toBeCloseTo((2 / 8) * 2 * Math.PI * 10);
    expect(donutArc(0, 2, 10).dash).toBe(0);
  });
});

describe("heat calendar", () => {
  it("aligns the first date to its Monday-first weekday slot", () => {
    const cells = heatCalendar(days, "tokens");
    // 2026-11-01 is a Sunday => six leading blanks.
    expect(cells.slice(0, 6).every((cell) => cell.date === null)).toBe(true);
    expect(cells[6]?.date).toBe("2026-11-01");
    expect(cells.length % 7).toBe(0);
  });

  it("grades the peak day at the highest level", () => {
    const cells = heatCalendar(days, "tokens");
    expect(cells.find((cell) => cell.date === "2026-11-04")?.level).toBe(4);
  });

  it("ignores overflow buckets", () => {
    const withOverflow: OverviewDay[] = [
      { date: "earlier", cost: cost(999), flaggedCost: cost(0), unpricedRaw: 0 },
      ...days,
    ];
    expect(heatCalendar(withOverflow, "tokens").some((cell) => cell.date === "earlier")).toBe(false);
  });
});
