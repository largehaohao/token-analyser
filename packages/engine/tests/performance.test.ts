import { describe, expect, it } from "vitest";
import {
  extractTaskTimings,
  performanceDistribution,
  requestPerformance,
  requestTimings,
  summarizePerformance,
  summarizeSessions,
} from "../src/performance.ts";
import { analyseSession } from "../src/snapshot.ts";
import { buildOverview } from "../src/overview.ts";
import { emptyCost, type RolloutLine, type SessionSnapshot, type Turn } from "../src/types.ts";

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
      avgTtftMs: 1200, outputTokensPerSecond: 50, basis: "task",
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
      avgTtftMs: 2000, outputTokensPerSecond: 20, basis: "task",
    });
  });
});

describe("session performance basis", () => {
  function snapshot(id: string, overrides: Partial<SessionSnapshot>): SessionSnapshot {
    return {
      id, source: "codex", sourceId: id, parentId: null, nickname: null, cwd: null,
      live: false, path: `/tmp/${id}.jsonl`, startedAt: null, lastEventAt: null, model: null,
      effort: null, ledger_warning: false, parse_errors: [], fastMode: false,
      cost: emptyCost(), waste: emptyCost(), toggles: {}, tree: {} as never, turns: [],
      suggestions: [], children: [], taskTimings: [], ...overrides,
    } as SessionSnapshot;
  }
  function requestTurn(id: string, output: number, durationMs: number, ttftMs: number | null): Turn {
    return {
      id, sessionId: id, startedAt: "2026-10-08T00:00:00.000Z", endedAt: "2026-10-08T00:00:02.000Z",
      model: null, effort: null, fastMode: false, pricing: null, usageRecorded: true,
      requestPerformance: { ttftMs, durationMs, outputTokensPerSecond: output * 1000 / durationMs, speedSource: "duration" },
      prompt: "", response: "", tools: [], usage: usage(output),
      cost: emptyCost(), bucket: "other", labels: [], hasPatchApply: false, collaborationMode: null,
    };
  }

  it("falls back to per-request timing when a session records no agent tasks", () => {
    const pi = snapshot("pi:1", {
      source: "pi",
      turns: [requestTurn("pi:1:r1", 10, 2000, null)],
      taskTimings: [],
    });
    expect(summarizeSessions([pi])).toEqual({
      taskCount: 1, ttftSampleCount: 0, speedSampleCount: 1,
      avgTtftMs: null, outputTokensPerSecond: 5, basis: "request",
    });
  });

  it("prefers agent-task timing and reports nothing when no timing exists", () => {
    const codex = snapshot("codex:1", {
      taskTimings: [{ id: "t1", startedAt: null, endedAt: "2026-10-08T00:00:10.000Z", durationMs: 10_000, ttftMs: 1000, outputTokens: 500 }],
      turns: [requestTurn("codex:1:r1", 10, 1000, 100)],
    });
    const cursor = snapshot("cursor:1", { source: "cursor", turns: [requestTurn("cursor:1:r1", 10, 2000, null)], taskTimings: [] });
    expect(summarizeSessions([codex, cursor]).basis).toBe("task");
    expect(summarizeSessions([codex]).outputTokensPerSecond).toBe(50);
    expect(summarizeSessions([snapshot("pi:empty", { source: "pi", taskTimings: [] })])).toMatchObject({
      taskCount: 0, avgTtftMs: null, outputTokensPerSecond: null, basis: null,
    });
  });
});

describe("per-request performance", () => {
  it("uses inclusive histogram edges and retains requests without measurements", () => {
    const turns = [1000, 2000, 3000, 5000].map((ttftMs, index) => ({
      id: String(index), startedAt: "2026-10-08T00:00:00Z", endedAt: "2026-10-08T00:00:10Z",
      requestPerformance: requestPerformance(null, { ttft_ms: ttftMs, tokens_per_second: [10, 25, 40, 60][index] }),
    } as Turn));
    turns.push({ id: "missing", startedAt: "2026-10-08T00:00:00Z", endedAt: "2026-10-08T00:00:10Z" } as Turn);
    expect(performanceDistribution(requestTimings(turns))).toEqual({
      ttft: [1, 1, 1, 1, 0], tps: [1, 1, 1, 1, 0], sampleCount: 5,
    });
  });

  it("uses the source-recorded speed even when duration is missing or disagrees", () => {
    const turns = [null, 2000].map((durationMs, index) => ({
      id: String(index), startedAt: "2026-10-08T00:00:00Z", endedAt: "2026-10-08T00:00:02Z",
      usageRecorded: true, usage: usage(10),
      requestPerformance: requestPerformance(10, { tokens_per_second: 70, duration_ms: durationMs }),
    } as Turn));
    expect(performanceDistribution(requestTimings(turns))).toEqual({
      ttft: [0, 0, 0, 0, 0], tps: [0, 0, 0, 0, 2], sampleCount: 2,
    });
  });

  it("uses explicit request metadata, prefers recorded speed, and supports nested metrics", () => {
    expect(requestPerformance(100, { request_performance: { time_to_first_token_ms: 250, duration_ms: 2000, tokens_per_second: 70 } })).toEqual({
      ttftMs: 250, durationMs: 2000, outputTokensPerSecond: 70, speedSource: "recorded",
    });
    expect(requestPerformance(100, { timing: { ttftMs: 250, durationMs: 2000 } })).toEqual({
      ttftMs: 250, durationMs: 2000, outputTokensPerSecond: 50, speedSource: "duration",
    });
  });
  it("preserves real zeros and leaves missing or invalid measurements unknown", () => {
    expect(requestPerformance(0, { ttft_ms: 0, duration_ms: 1000 })).toMatchObject({ ttftMs: 0, outputTokensPerSecond: 0 });
    expect(requestPerformance(null, { duration_ms: 1000 })).toMatchObject({ outputTokensPerSecond: null, speedSource: null });
    expect(requestPerformance(100, { ttft_ms: 3000, duration_ms: 1000 })).toMatchObject({ ttftMs: null });
    expect(requestPerformance(100, { duration_ms: 0, ttft_ms: -1, tokens_per_second: Infinity })).toEqual({ ttftMs: null, durationMs: null, outputTokensPerSecond: null, speedSource: null });
    expect(requestPerformance(100)).toEqual({ ttftMs: null, durationMs: null, outputTokensPerSecond: null, speedSource: null });
  });
  it("attaches distinct request metrics to ledger turns without copying task measurements", () => {
    const first = count(2, 100);
    first.payload!.request_performance = { ttft_ms: 200, duration_ms: 2000 };
    const snap = analyseSession({ sessionId: "requests", path: "/tmp/requests.jsonl", events: [start(0), first, count(5, 50, 150), complete(10, "t1", { duration_ms: 10000, time_to_first_token_ms: 1200 })] });
    expect(snap.turns).toHaveLength(2);
    expect(snap.turns[0].requestPerformance).toMatchObject({ ttftMs: 200, outputTokensPerSecond: 50 });
    expect(snap.turns[1].requestPerformance).toMatchObject({ ttftMs: null, outputTokensPerSecond: null });
    expect(snap.performance?.avgTtftMs).toBe(1200);
  });
});
