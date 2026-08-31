import { describe, expect, it } from "vitest";
import type { OverviewSlice } from "./api";
import { buildDonutSeries, donutPercents } from "./donut-series";

function slice(key: OverviewSlice["key"], raw: number): OverviewSlice {
  return { key, raw, credits: raw / 100, usd: raw / 1000 };
}

describe("buildDonutSeries", () => {
  it("uses labels and colors for fine-grained behavior slices", () => {
    const series = buildDonutSeries(
      [
        slice("reading", 40),
        slice("verification", 30),
        slice("tooling", 20),
        slice("communication", 10),
      ],
      100,
    );

    expect(series.map((item) => item.label)).toEqual([
      "读取与搜索",
      "测试与验证",
      "工具与环境",
      "消息沟通",
    ]);
    expect(series.every((item) => item.color !== "#7dffb3")).toBe(true);
  });

  it("keeps legend percents and ring weights on the same allocated scale", () => {
    const series = buildDonutSeries(
      [
        slice("planning", 200),
        slice("code", 0),
        slice("reread", 0),
        slice("subagents", 0),
        slice("waiting", 100),
        slice("other", 0),
      ],
      300,
    );
    const percents = donutPercents(series);
    expect(percents.reduce((sum, n) => sum + n, 0)).toBeCloseTo(100, 5);
    expect(percents[0]).toBe(66.7);
    expect(percents[4]).toBe(33.3);
    expect(series.some((item) => item.key === "unattributed")).toBe(false);
  });

  it("adds an unattributed slice when buckets do not cover total raw", () => {
    const series = buildDonutSeries([slice("code", 80)], 100);
    expect(series.at(-1)).toMatchObject({ key: "unattributed", raw: 20 });
    const percents = donutPercents(series);
    expect(percents.reduce((sum, n) => sum + n, 0)).toBeCloseTo(100, 5);
    expect(percents.at(-1)).toBe(20);
  });
});
