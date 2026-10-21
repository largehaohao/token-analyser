import { describe, expect, it } from "vitest";
import {
  arrayHistogram,
  distributionSummary,
  TPS_EDGES,
  TPS_LABELS,
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
    expect(speed.counts).toEqual([1, 0, 1, 0, 0]);
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
  });

  it("says so when a histogram has no measurements at all", () => {
    const empty = arrayHistogram(TTFT_LABELS, [0, 0, 0, 0, 0], "s", 5);
    expect(distributionSummary(empty)).toContain("没有来源记录的耗时");
    expect(distributionSummary(empty)).not.toContain("NaN");
  });

  it("names the modal bucket and the measured share", () => {
    const dist = arrayHistogram(TPS_LABELS, [0, 3, 6, 1, 0], " tok/s", 10);
    const summary = distributionSummary(dist);
    expect(summary).toContain("10/10");
    expect(summary).toContain(TPS_LABELS[2]);
  });
});
