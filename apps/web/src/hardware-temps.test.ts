import { describe, expect, it } from "vitest";
import {
  MAX_TEMP_PERIOD_SEC,
  TEMP_DISPLAY_LIMITS,
  TEMP_PERIODS,
  filterSamplesByWindow,
  formatSampleTime,
  formatTemp,
  isStale,
  mergeTempSamples,
  meterPercent,
  readSeries,
  readingTone,
  worstGpuStatus,
} from "./hardware-temps";

describe("TEMP_PERIODS", () => {
  it("offers minute windows plus 12 hours, 1 day and 7 days", () => {
    expect(TEMP_PERIODS.map((period) => period.id)).toEqual([
      300, 600, 1800, 3600, 43200, 86400, 604800,
    ]);
    expect(TEMP_PERIODS.map((period) => period.label)).toEqual([
      "最近 5 分钟",
      "最近 10 分钟",
      "最近 30 分钟",
      "最近 60 分钟",
      "最近 12 小时",
      "最近 1 天",
      "最近 7 天",
    ]);
    expect(Math.max(...TEMP_PERIODS.map((period) => period.id))).toBe(
      MAX_TEMP_PERIOD_SEC,
    );
  });
});

describe("formatTemp", () => {
  it("renders finite numbers and an em dash for missing values", () => {
    expect(formatTemp(49)).toBe("49");
    expect(formatTemp(36.64, 1)).toBe("36.6");
    expect(formatTemp(0, 1)).toBe("0.0");
    expect(formatTemp(null)).toBe("—");
    expect(formatTemp(Number.NaN)).toBe("—");
    expect(formatTemp(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatSampleTime", () => {
  it("prints local month, day, and clock with seconds", () => {
    const timestampSec = 1_700_000_000;
    const date = new Date(timestampSec * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(formatSampleTime(timestampSec)).toBe(
      `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    );
  });
});

describe("meterPercent", () => {
  it("scales against the limit and clamps to 0–100", () => {
    expect(meterPercent(50, 100)).toBe(50);
    expect(meterPercent(200, TEMP_DISPLAY_LIMITS.edge)).toBe(100);
    expect(meterPercent(-5, 85)).toBe(0);
    expect(meterPercent(null, 85)).toBe(0);
    expect(meterPercent(Number.NaN, 85)).toBe(0);
    expect(meterPercent(40, 0)).toBe(0);
    expect(meterPercent(40, -1)).toBe(0);
  });
});

describe("filterSamplesByWindow", () => {
  const samples = [
    { timestamp: 90 },
    { timestamp: 100 },
    { timestamp: 150 },
    { timestamp: 200 },
    { timestamp: 201 },
  ];

  it("keeps samples inside the inclusive window and does not mutate the source", () => {
    const filtered = filterSamplesByWindow(samples, 200, 100);
    expect(filtered.map((sample) => sample.timestamp)).toEqual([100, 150, 200]);
    expect(samples).toHaveLength(5);
  });
});

describe("isStale", () => {
  it("is stale only after the sample is more than 8 seconds old", () => {
    expect(isStale(1_000, 1_008_000)).toBe(false);
    expect(isStale(1_000, 1_008_001)).toBe(true);
    expect(isStale(1_010, 1_000_000)).toBe(false);
  });
});

describe("readingTone", () => {
  it("matches shutdown margin: over above the limit, warm within 8°C", () => {
    expect(readingTone(null, 85)).toBe("missing");
    expect(readingTone(70, 85)).toBe("normal");
    expect(readingTone(77, 85)).toBe("warm");
    expect(readingTone(85, 85)).toBe("warm");
    expect(readingTone(85.1, 85)).toBe("over");
    expect(readingTone(10, Number.NaN)).toBe("missing");
  });
});

describe("worstGpuStatus", () => {
  it("ranks over above warm, and treats a missing slot as missing", () => {
    expect(worstGpuStatus(["normal", "warm"])).toBe("warm");
    expect(worstGpuStatus(["warm", "over"])).toBe("over");
    expect(worstGpuStatus(["normal", null])).toBe("missing");
    expect(worstGpuStatus(["normal", "normal"])).toBe("normal");
    expect(worstGpuStatus([])).toBe("missing");
  });
});

describe("mergeTempSamples", () => {
  it("sorts, dedupes by timestamp, and lets the incoming sample replace the old one", () => {
    const base = [
      { timestamp: 20, v: "old" },
      { timestamp: 10, v: "a" },
    ];
    const merged = mergeTempSamples(base, [
      { timestamp: 20, v: "new" },
      { timestamp: 15, v: "b" },
    ]);
    expect(merged).toEqual([
      { timestamp: 10, v: "a" },
      { timestamp: 15, v: "b" },
      { timestamp: 20, v: "new" },
    ]);
    expect(base[0]).toEqual({ timestamp: 20, v: "old" });
  });

  it("returns the same array when nothing arrives", () => {
    const base = [{ timestamp: 1 }];
    expect(mergeTempSamples(base, [])).toBe(base);
  });
});

describe("readSeries", () => {
  it("keeps nulls instead of inventing a zero", () => {
    const series = readSeries(
      [
        { timestamp: 1, edge: 48 },
        { timestamp: 2, edge: null },
        { timestamp: 3, edge: Number.NaN },
      ],
      (sample) => sample.edge,
    );
    expect(series).toEqual([
      { t: 1, v: 48 },
      { t: 2, v: null },
      { t: 3, v: null },
    ]);
  });
});
