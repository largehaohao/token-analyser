import { describe, expect, it } from "vitest";
import type { PerformanceSummary, Turn } from "./api";
import { resolvePerformance } from "./PerformanceMetrics";

function turn(over: Partial<Turn> & { ttftMs?: number; durationMs?: number; output?: number }): Turn {
  const { ttftMs, durationMs, output, ...rest } = over;
  return {
    id: "t", sessionId: "s", startedAt: "2026-11-12T00:00:00Z", endedAt: "2026-11-12T00:00:01Z",
    model: null, effort: null, fastMode: false, pricing: null, usageRecorded: true,
    prompt: "", response: "", tools: [],
    usage: {
      input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: output ?? 10, reasoning_output_tokens: 0, total_tokens: 11,
    },
    cost: { raw: 11, uncached_input: 1, cached_input: 0, output: output ?? 10, credits: null, usd: null },
    bucket: "other", labels: [],
    requestPerformance: {
      ttftMs: ttftMs ?? null,
      durationMs: durationMs ?? null,
      outputTokensPerSecond: ttftMs != null && durationMs != null && durationMs > ttftMs
        ? (output ?? 10) * 1000 / (durationMs - ttftMs) : null,
      speedSource: ttftMs != null ? "decode" : durationMs != null ? "duration" : null,
    },
    ...rest,
  };
}

describe("resolvePerformance", () => {
  it("fills TTFT, tok/s and request duration from turns when the summary left them empty", () => {
    const stale: PerformanceSummary = {
      taskCount: 2, ttftSampleCount: 0, speedSampleCount: 0,
      avgTtftMs: null, outputTokensPerSecond: null, totalDurationMs: null,
      requestDurationMs: null, requestDurationCount: 0,
      taskDurationMs: 5_000, taskDurationCount: 1, basis: "request",
    };
    const resolved = resolvePerformance(stale, [
      turn({ ttftMs: 500, durationMs: 1_500, output: 20 }),
      turn({ ttftMs: 700, durationMs: 1_700, output: 24 }),
    ]);
    expect(resolved.avgTtftMs).toBe(600);
    expect(resolved.requestDurationMs).toBe(3_200);
    expect(resolved.requestDurationCount).toBe(2);
    expect(resolved.outputTokensPerSecond).toBeCloseTo(44 * 1000 / 2_000, 10);
    expect(resolved.ttftSampleCount).toBe(2);
    expect(resolved.speedSampleCount).toBe(2);
  });
});
