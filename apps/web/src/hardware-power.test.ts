import { describe, expect, it } from "vitest";
import {
  POWER_DEMO_ANCHOR_MS,
  POWER_RANGES,
  demoPowerAdapter,
  demoSampleAt,
  energyCostCny,
  formatCny,
  formatKwh,
  integrateSeries,
  parseLocalDateTime,
  resolveQuickWindow,
  toLocalDateTimeInput,
  trendStepMs,
  validateCustomRange,
  type SeriesPoint,
} from "./hardware-power";

const HOUR = 3_600_000;
const MINUTE = 60_000;

function constant(t0: number, hours: number, watts: number | null, step = MINUTE): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let t = t0; t <= t0 + hours * HOUR; t += step)
    out.push({ t, v: watts });
  return out;
}

describe("integrateSeries", () => {
  it("integrates a constant 1000 W load over one hour to exactly 1 kWh", () => {
    const t0 = Date.UTC(2026, 9, 20, 0, 0);
    const result = integrateSeries(constant(t0, 1, 1000), t0, t0 + HOUR);
    expect(result.kwh).toBeCloseTo(1, 6);
    expect(result.complete).toBe(true);
    expect(result.avgW).toBeCloseTo(1000, 6);
    expect(result.peakW).toBe(1000);
  });

  it("uses trapezoids for a linear ramp 0→2000 W (avg 1000 W = 1 kWh)", () => {
    const t0 = 0;
    const points: SeriesPoint[] = [];
    for (let i = 0; i <= 60; i += 1)
      points.push({ t: t0 + i * MINUTE, v: (2000 * i) / 60 });
    const result = integrateSeries(points, t0, t0 + HOUR);
    expect(result.kwh).toBeCloseTo(1, 6);
  });

  it("keeps the same total when halving the step (convergent trapezoid)", () => {
    const t0 = Date.UTC(2026, 9, 20);
    const coarse = integrateSeries(constant(t0, 1, 500, 30 * MINUTE), t0, t0 + HOUR);
    const fine = integrateSeries(constant(t0, 1, 500, MINUTE), t0, t0 + HOUR);
    expect(coarse.kwh).toBeCloseTo(fine.kwh!, 6);
  });

  it("marks a series with a null gap as incomplete and smaller, not zero-filled", () => {
    const t0 = Date.UTC(2026, 9, 20);
    const points = constant(t0, 2, 600);
    // 挖掉中间 30 分钟（两个采样点），积分只能覆盖剩余部分。
    for (const p of points) if (p.t === t0 + HOUR || p.t === t0 + HOUR + MINUTE) p.v = null;
    const result = integrateSeries(points, t0, t0 + 2 * HOUR);
    expect(result.complete).toBe(false);
    // 挖掉 2 个采样点会打断 3 个积分区间（117 分钟有效覆盖）。
    expect(result.coveredMs).toBe(117 * MINUTE);
    // 600 W × 1.95 h = 1.17 kWh
    expect(result.kwh).toBeCloseTo(1.17, 6);
    // 平均功率按有覆盖的时间计算，不受缺失影响。
    expect(result.avgW).toBeCloseTo(600, 6);
  });

  it("returns null (—) for an all-null series instead of 0", () => {
    const t0 = Date.UTC(2026, 9, 20);
    const result = integrateSeries(constant(t0, 1, null), t0, t0 + HOUR);
    expect(result.kwh).toBeNull();
    expect(result.avgW).toBeNull();
    expect(result.peakW).toBeNull();
  });

  it("returns null for an empty sample list", () => {
    expect(integrateSeries([], 0, HOUR).kwh).toBeNull();
  });

  it("preserves a measured zero as zero energy, distinct from missing", () => {
    const result = integrateSeries([{ t: 0, v: 0 }, { t: HOUR, v: 0 }], 0, HOUR);
    expect(result.kwh).toBe(0);
    expect(result.avgW).toBe(0);
    expect(result.complete).toBe(true);
    expect(energyCostCny(result.kwh, 0.55)).toBe(0);
  });

  it("clips a linear ramp to the requested window with interpolation", () => {
    const result = integrateSeries([{ t: 0, v: 0 }, { t: 2 * HOUR, v: 2000 }], HOUR / 2, 1.5 * HOUR);
    expect(result.kwh).toBeCloseTo(1, 8);
    expect(result.coveredMs).toBe(HOUR);
    expect(result.peakW).toBe(1500);
    expect(result.complete).toBe(true);
  });

  it("does not bridge missing intervals or count out-of-window energy", () => {
    const points = [{ t: 0, v: 1000 }, { t: HOUR, v: null },
      { t: 2 * HOUR, v: 1000 }, { t: 3 * HOUR, v: 1000 }];
    const result = integrateSeries(points, HOUR, 2.5 * HOUR);
    expect(result.kwh).toBeCloseTo(0.5, 8);
    expect(result.coveredMs).toBe(HOUR / 2);
    expect(result.complete).toBe(false);
  });

  it("ignores non-monotonic timestamps", () => {
    const points: SeriesPoint[] = [
      { t: 10 * MINUTE, v: 100 },
      { t: 0, v: 100 },
      { t: 20 * MINUTE, v: 100 },
    ];
    const result = integrateSeries(points, 0, 20 * MINUTE);
    // The backwards point at 0 is discarded; only 10 → 20 minutes is covered.
    expect(result.coveredMs).toBe(10 * MINUTE);
  });
});

describe("电费一致性", () => {
  it("computes cost from the same integral and price", () => {
    const t0 = Date.UTC(2026, 9, 20);
    const integral = integrateSeries(constant(t0, 24, 120), t0, t0 + 24 * HOUR);
    // 120 W × 24 h = 2.88 kWh
    expect(integral.kwh).toBeCloseTo(2.88, 6);
    expect(energyCostCny(integral.kwh, 0.55)).toBeCloseTo(1.584, 6);
    // 电价变化时电费按同一积分重新换算。
    expect(energyCostCny(integral.kwh, 1.0)).toBeCloseTo(2.88, 6);
  });

  it("refuses a non-positive price instead of showing a wrong fee", () => {
    expect(energyCostCny(1.2, 0)).toBeNull();
    expect(energyCostCny(1.2, -0.5)).toBeNull();
    expect(energyCostCny(null, 0.55)).toBeNull();
  });

  it("formats partial coverage as a lower bound with ≥", () => {
    expect(formatKwh({ kwh: 1.234, complete: true })).toBe("1.234");
    expect(formatKwh({ kwh: 1.234, complete: false })).toBe("≥ 1.234");
    expect(formatKwh({ kwh: null, complete: false })).toBe("—");
    expect(formatCny(1.2, false)).toBe("≥ ¥1.20");
    expect(formatCny(null)).toBe("—");
  });
});

describe("范围解析与边界", () => {
  it("resolves quick windows as rolling windows ending at now", () => {
    const now = Date.UTC(2026, 9, 23, 8, 0);
    const w = resolveQuickWindow("1h", now);
    expect(w.startMs).toBe(now - HOUR);
    expect(w.endMs).toBe(now);
    expect(w.label).toBe("近1小时");
    expect(resolveQuickWindow("7d", now).startMs).toBe(now - 7 * 86_400_000);
    expect(POWER_RANGES.map((r) => r.id)).toEqual(["1h", "24h", "7d"]);
  });

  it("accepts a valid custom range", () => {
    const now = Date.UTC(2026, 9, 23, 12, 0);
    const start = "2026-10-22T08:30";
    const end = "2026-10-23T08:30";
    const result = validateCustomRange(start, end, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.window.startMs).toBe(Date.parse("2026-10-22T08:30:00"));
      expect(result.window.endMs).toBe(Date.parse("2026-10-23T08:30:00"));
    }
  });

  it("rejects end <= start, future end and malformed input with field errors", () => {
    const now = Date.UTC(2026, 9, 23, 12, 0);
    expect(validateCustomRange("2026-10-23T09:00", "2026-10-23T09:00", now).ok).toBe(false);
    expect(validateCustomRange("2026-10-23T09:00", "2026-10-23T08:00", now).ok).toBe(false);
    const future = validateCustomRange("2026-10-23T09:00", "2026-10-24T09:00", now);
    expect(future.ok).toBe(false);
    if (!future.ok)
      expect(future.errors.some((e) => e.field === "end" && e.message.includes("当前时间"))).toBe(true);
    const bad = validateCustomRange("不是时间", "2026-10-23T10:00", now);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0].field).toBe("start");
  });

  it("round-trips local datetime inputs", () => {
    const ms = Date.UTC(2026, 9, 23, 4, 5) - new Date().getTimezoneOffset() * MINUTE;
    const parsed = parseLocalDateTime(toLocalDateTimeInput(ms));
    expect(parsed).toBe(ms);
    expect(parseLocalDateTime("2026-13-99T25:00")).toBeNull();
    expect(parseLocalDateTime("2026-02-30T12:00")).toBeNull();
    expect(parseLocalDateTime("2026-10-23T12:00junk")).toBeNull();
    expect(parseLocalDateTime("")).toBeNull();
  });

  it("rejects ranges longer than 31 days before generating samples", () => {
    expect(validateCustomRange("2026-01-01T00:00", "2026-10-22T00:00", Date.UTC(2026, 9, 23)).ok).toBe(false);
  });

  it("picks a coarser trend step for longer spans", () => {
    expect(trendStepMs(HOUR)).toBe(2 * MINUTE);
    expect(trendStepMs(24 * HOUR)).toBe(15 * MINUTE);
    expect(trendStepMs(7 * 86_400_000)).toBe(HOUR);
    expect(trendStepMs(40 * 86_400_000)).toBe(2 * HOUR);
  });
});

describe("演示数据（确定性 / 缺失 / 分项语义）", () => {
  it("is deterministic: the same timestamp yields identical samples", () => {
    const t = Date.UTC(2026, 9, 22, 14, 7);
    expect(demoSampleAt(t)).toEqual(demoSampleAt(t));
    const a = demoPowerAdapter.series(t, t + HOUR, 5 * MINUTE);
    const b = demoPowerAdapter.series(t, t + HOUR, 5 * MINUTE);
    expect(a).toEqual(b);
    // 网格点之外保留精确起止端点，避免完整数据被误判为覆盖不足。
    expect(a.length).toBe(14);
  });

  it("includes exact window boundaries around the aligned sample grid", () => {
    const t0 = Date.UTC(2026, 9, 22, 0, 3);
    const s = demoPowerAdapter.series(t0, t0 + 10 * MINUTE, 5 * MINUTE);
    expect(s.map((p) => p.t)).toEqual([t0, t0 + 2 * MINUTE, t0 + 7 * MINUTE, t0 + 10 * MINUTE]);
    const cpu = integrateSeries(s.map((p) => ({ t: p.t, v: p.cpu })), t0, t0 + 10 * MINUTE);
    expect(cpu.complete).toBe(true);
    expect(cpu.coveredMs).toBe(10 * MINUTE);
    expect(demoPowerAdapter.series(t0, t0 - 1, MINUTE)).toEqual([]);
  });

  it("reports no data before the fixed anchor instead of zeros", () => {
    const before = demoSampleAt(POWER_DEMO_ANCHOR_MS - 1);
    expect(before.cpu).toBeNull();
    expect(before.gpu).toBeNull();
    expect(before.machine).toBeNull();
  });

  it("keeps machine ≥ cpu + gpu (整机是总量，CPU/GPU 是分项) across a sweep", () => {
    for (let t = POWER_DEMO_ANCHOR_MS; t < POWER_DEMO_ANCHOR_MS + 30 * 86_400_000; t += 37 * MINUTE) {
      const s = demoSampleAt(t);
      if (s.cpu != null && s.gpu != null && s.machine != null)
        expect(s.machine).toBeGreaterThanOrEqual(s.cpu + s.gpu);
    }
  });

  it("contains deterministic gaps: GPU daily 02:30–03:10 UTC, machine Wednesdays 01:00–03:00 UTC", () => {
    const gpuGap = demoSampleAt(Date.UTC(2026, 9, 22, 2, 45)); // 周四
    expect(gpuGap.gpu).toBeNull();
    expect(gpuGap.cpu).not.toBeNull();
    const outsideGap = demoSampleAt(Date.UTC(2026, 9, 22, 4, 45));
    expect(outsideGap.gpu).not.toBeNull();
    const wednesday = new Date(Date.UTC(2026, 9, 22));
    // 2026-10-22 是周四，找上一个周三。
    const wed = Date.UTC(2026, 9, 21);
    expect(new Date(wed).getUTCDay()).toBe(3);
    expect(wednesday.getUTCDay()).toBe(4);
    const machineOutage = demoSampleAt(Date.UTC(2026, 9, 21, 2, 0));
    expect(machineOutage.machine).toBeNull();
    expect(machineOutage.cpu).not.toBeNull();
    const thursday = demoSampleAt(Date.UTC(2026, 9, 22, 2, 0));
    expect(thursday.machine).not.toBeNull();
  });

  it("keeps every value inside sane watt bounds", () => {
    for (let t = POWER_DEMO_ANCHOR_MS; t < POWER_DEMO_ANCHOR_MS + 14 * 86_400_000; t += 11 * MINUTE) {
      const s = demoSampleAt(t);
      if (s.cpu != null) expect(s.cpu).toBeGreaterThan(0), expect(s.cpu).toBeLessThan(200);
      if (s.gpu != null) expect(s.gpu).toBeGreaterThan(0), expect(s.gpu).toBeLessThan(350);
      if (s.machine != null) expect(s.machine).toBeGreaterThan(0), expect(s.machine).toBeLessThan(650);
    }
  });

  it("marks the adapter as not connected (演示数据，尚未接入)", () => {
    expect(demoPowerAdapter.connected).toBe(false);
    expect(demoPowerAdapter.id).toBe("demo");
  });
});
