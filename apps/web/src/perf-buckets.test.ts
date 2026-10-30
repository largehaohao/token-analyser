import { describe, expect, it } from "vitest";
import {
  arrayHistogram,
  distributionSummary,
  TPS_EDGES,
  TPS_LABELS,
  TPS_TICKS,
  TTFT_EDGES_S,
  TTFT_LABELS,
  turnDistributions,
} from "./perf-buckets";
import type { Turn } from "./api";

function turn(ttftMs: number | null, tokensPerSecond: number | null): Turn {
  return {
    requestPerformance:
      ttftMs == null && tokensPerSecond == null
        ? undefined
        : {
            ttftMs,
            durationMs: null,
            outputTokensPerSecond: tokensPerSecond,
            speedSource: tokensPerSecond == null ? null : "recorded",
          },
  } as Turn;
}

describe("latency buckets", () => {
  it("publishes one bucket more than its edges, the contract the engine keeps", () => {
    expect(TTFT_LABELS).toHaveLength(TTFT_EDGES_S.length + 1);
    expect(TPS_LABELS).toHaveLength(TPS_EDGES.length + 1);
    expect(TTFT_LABELS[0]).toBe("≤ 1s");
    expect(TTFT_LABELS[TTFT_LABELS.length - 1]).toBe("> 5s");
  });

  it("splits output speed below 40, every 10 tok/s to 150, then above 150", () => {
    expect(TPS_EDGES).toEqual([
      40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150,
    ]);
    expect(TPS_LABELS[0]).toBe("≤ 40 tok/s");
    expect(TPS_LABELS[1]).toBe("40–50 tok/s");
    expect(TPS_LABELS[TPS_LABELS.length - 2]).toBe("140–150 tok/s");
    expect(TPS_LABELS[TPS_LABELS.length - 1]).toBe("> 150 tok/s");
    expect(TPS_TICKS).toEqual([
      "≤40", "50", "60", "70", "80", "90", "100", "110", "120", "130", "140", "150", ">150",
    ]);
    expect(TPS_TICKS).toHaveLength(TPS_LABELS.length);
  });

  it("keeps 40 in the first speed bucket, 150 in 140–150, and 151 above it", () => {
    const { speed } = turnDistributions([
      turn(null, 40),
      turn(null, 41),
      turn(null, 150),
      turn(null, 151),
    ]);
    expect(speed.counts).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(speed.labels[11]).toBe("140–150 tok/s");
  });

  it("reads turn TTFT in milliseconds and buckets it on the second scale", () => {
    const { ttft } = turnDistributions([
      turn(500, null),
      turn(1_000, null),
      turn(1_500, null),
      turn(6_000, null),
    ]);
    // 0.5s and 1.0s share "≤ 1s", 1.5s is "1–2s", 6s is "> 5s".
    expect(ttft.counts).toEqual([2, 1, 0, 0, 1]);
    expect(ttft.known).toBe(4);
    expect(ttft.total).toBe(4);
  });

  it("leaves unmeasured turns out of the buckets but inside the denominator", () => {
    const { ttft, speed } = turnDistributions([
      turn(null, null),
      turn(2_500, 30),
      turn(2_500, 5),
    ]);
    expect(ttft.counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(ttft.total).toBe(3);
    expect(ttft.known).toBe(2);
    expect(speed.counts).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("keeps a value that lands exactly on an edge in the lower bucket", () => {
    const { ttft } = turnDistributions([turn(2_000, null), turn(5_000, null)]);
    expect(ttft.counts).toEqual([0, 1, 0, 1, 0]);
  });

  it("retains missing aggregate measurements in the coverage denominator", () => {
    const dist = arrayHistogram(TTFT_LABELS, [2, 5, 1, 0, 0], "s", 12);
    expect(dist.known).toBe(8);
    expect(dist.total).toBe(12);
    expect(distributionSummary(dist)).toContain("8/12");
    expect(dist.labels).toEqual(TTFT_LABELS);
    // 没传 ticks 时退回完整区间名，旧调用点不会拿到 undefined。
    expect(dist.ticks).toEqual(TTFT_LABELS);
  });

  it("says so when a histogram has no measurements at all", () => {
    const empty = arrayHistogram(TTFT_LABELS, [0, 0, 0, 0, 0], "s", 5);
    expect(distributionSummary(empty)).toContain("没有来源记录的耗时");
    expect(distributionSummary(empty)).not.toContain("NaN");
  });

  it("names the modal bucket and the measured share", () => {
    const dist = arrayHistogram(
      TPS_LABELS,
      [0, 3, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      " tok/s",
      10,
      TPS_TICKS,
    );
    const summary = distributionSummary(dist);
    expect(summary).toContain("10/10");
    expect(summary).toContain(TPS_LABELS[2]);
  });
});
