import { describe, expect, it } from "vitest";
import { extractTaskTimings, summarizePerformance } from "../src/performance.ts";
import { analyseSession } from "../src/snapshot.ts";
import { buildOverview } from "../src/overview.ts";
import type { RolloutLine } from "../src/types.ts";

const base = Date.parse("2026-10-08T00:00:00Z");
function event(seconds: number, type: string, payload: Record<string, unknown>): RolloutLine {
  return { timestamp: new Date(base + seconds * 1000).toISOString(), type, payload };
}
function usage(output: number, input = 1000) {
  return {
    input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
  };
}
function count(seconds: number, output: number, total = output): RolloutLine {
  return event(seconds, "event_msg", {
    type: "token_count", info: { last_token_usage: usage(output), total_token_usage: usage(total) },
  });
}
function start(seconds: number, id = "t1"): RolloutLine {
  return event(seconds, "event_msg", { type: "task_started", turn_id: id, started_at: base / 1000 + seconds });
}
function complete(seconds: number, id = "t1", extra: Record<string, unknown> = {}): RolloutLine {
  return event(seconds, "event_msg", { type: "task_complete", turn_id: id, ...extra });
}

describe("task performance", () => {
  it("uses measured task TTFT and cumulative task usage without double-counting ledger events", () => {
    const record = (seconds: number, output: number) => event(seconds, "token_usage_record", {
      turn_id: "t1", turn_token_usage: usage(output),
    });
    const source = [
      start(0), count(2, 100), record(2, 100), count(8, 400, 500),
      count(9, 400, 500), record(9, 500),
      complete(10, "t1", { duration_ms: 10_000, time_to_first_token_ms: 1200 }),
      complete(11, "t1", { duration_ms: 10_000, time_to_first_token_ms: 1200 }),
    ];
    const samples = extractTaskTimings(source, { isSubagent: false });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      startedAt: "2026-10-08T00:00:00.000Z", durationMs: 10_000,
      ttftMs: 1200, outputTokens: 500,
    });
    expect(summarizePerformance(samples)).toEqual({
      taskCount: 1, ttftSampleCount: 1, speedSampleCount: 1,
      avgTtftMs: 1200, outputTokensPerSecond: 50,
    });
  });

  it("supports older token counts and duration timestamps without inventing TTFT", () => {
    const source = [start(0), count(5, 100), count(6, 100), complete(10),
      start(20, "t2"), count(21, 50, 150), complete(22, "t2")];
    const samples = extractTaskTimings(source, { isSubagent: false });
    expect(samples.map((sample) => sample.outputTokens)).toEqual([100, 50]);
    expect(samples.map((sample) => sample.durationMs)).toEqual([10_000, 2000]);
    expect(summarizePerformance(samples)).toMatchObject({
      taskCount: 2, ttftSampleCount: 0, avgTtftMs: null,
      speedSampleCount: 2, outputTokensPerSecond: 12.5,
    });
  });

  it("excludes unfinished tasks and copied subagent history", () => {
    const source = [complete(-10, "parent", { duration_ms: 5000, time_to_first_token_ms: 800 }),
      start(0), count(1, 100), complete(5, "t1", { time_to_first_token_ms: 500 }),
      start(10, "pending"), count(11, 200, 300)];
    const samples = extractTaskTimings(source, { isSubagent: true });
    expect(samples).toHaveLength(1);
    expect(samples[0]?.id).toBe("t1");
  });

  it("keeps absent, invalid, and zero-duration measurements out of speed averages", () => {
    const source = [
      start(0), count(1, 100), complete(2, "t1", { duration_ms: 1000, time_to_first_token_ms: 2000 }),
      start(3, "t2"), complete(4, "t2", { duration_ms: 0, time_to_first_token_ms: 0 }),
      complete(5, "t3", { duration_ms: -10, time_to_first_token_ms: -1 }),
    ];
    const samples = extractTaskTimings(source, { isSubagent: false });
    expect(samples[0]?.ttftMs).toBeNull();
    expect(samples[1]).toMatchObject({ durationMs: null, outputTokens: null, ttftMs: 0 });
    expect(samples[2]).toMatchObject({ durationMs: null, ttftMs: null });
    expect(summarizePerformance(samples)).toMatchObject({
      ttftSampleCount: 1, avgTtftMs: 0, speedSampleCount: 1, outputTokensPerSecond: 100,
    });
    expect(summarizePerformance([])).toMatchObject({ avgTtftMs: null, outputTokensPerSecond: null });
  });

  it("aggregates child tasks once and filters overview measurements by completion time", () => {
    const child = analyseSession({
      events: [start(20), count(21, 400), complete(40, "t1", { duration_ms: 20_000, time_to_first_token_ms: 2000 })],
      path: "/tmp/child.jsonl", sessionId: "child",
    });
    const root = analyseSession({
      events: [start(0), count(1, 100), complete(10, "t1", { duration_ms: 10_000, time_to_first_token_ms: 1000 })],
      path: "/tmp/root.jsonl", sessionId: "root", children: [child],
    });
    expect(root.performance).toMatchObject({ taskCount: 2, avgTtftMs: 1500, outputTokensPerSecond: 500 / 30 });
    const overview = buildOverview([root], { watchPath: "/tmp", sinceMs: base + 15_000, now: "2026-10-08T00:01:00Z" });
    expect(overview.performance).toEqual({
      taskCount: 1, ttftSampleCount: 1, speedSampleCount: 1,
      avgTtftMs: 2000, outputTokensPerSecond: 20,
    });
  });
});
