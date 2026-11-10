import type {
  PerformanceBasis,
  PerformanceSummary,
  RequestPerformance,
  RolloutLine,
  SessionSnapshot,
  TaskTiming,
  Turn,
} from "./types.ts";

export type DurationClocks = {
  requestDurationMs: number | null;
  requestDurationCount: number;
  taskDurationMs: number | null;
  taskDurationCount: number;
};

const EMPTY_DURATION_CLOCKS: DurationClocks = {
  requestDurationMs: null,
  requestDurationCount: 0,
  taskDurationMs: null,
  taskDurationCount: 0,
};

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Read only metadata belonging to this request; never infer timing from a
 * ledger window or task_complete, which can also include tools and other calls. */
export function requestPerformance(
  outputTokens: number | null,
  ...metadata: unknown[]
): RequestPerformance {
  const containers = metadata.flatMap((value) => {
    const item = record(value);
    return item ? [record(item.request_performance), record(item.performance),
      record(item.timing), record(item.metrics), item].filter((item) => item != null) : [];
  });
  function field(...names: string[]): number | null {
    for (const item of containers) for (const name of names) {
      if (item[name] !== undefined) return nonnegative(item[name]);
    }
    return null;
  }
  const duration = field("request_duration_ms", "duration_ms", "durationMs");
  const durationMs = duration != null && duration > 0 ? duration : null;
  const ttftMs = field("time_to_first_token_ms", "ttft_ms", "ttftMs");
  const recordedSpeed = field("output_tokens_per_second", "tokens_per_second", "outputTokensPerSecond");
  const output = nonnegative(outputTokens);
  // Decode rate: the first-token wait is not generation, so a request that
  // records TTFT divides its output by (duration − TTFT). See
  // `requestGenerationMs` for the windows that are not a decode interval.
  const generationMs = requestGenerationMs(durationMs, ttftMs, output);
  const calculatedSpeed =
    generationMs != null && generationMs > 0 && output != null
      ? output * 1000 / generationMs
      : null;
  const outputTokensPerSecond = recordedSpeed ??
    (calculatedSpeed != null && Number.isFinite(calculatedSpeed) ? calculatedSpeed : null);
  return {
    ttftMs, durationMs, outputTokensPerSecond,
    speedSource: recordedSpeed != null
      ? "recorded"
      : outputTokensPerSecond == null
        ? null
        : generationMs != null && ttftMs != null
          ? "decode"
          : "duration",
  };
}

/** Codex task timestamps can be ISO strings or Unix seconds. */
function timestampIso(value: unknown): string | null {
  const ms = typeof value === "number"
    ? value * 1000
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
    ? new Date(ms).toISOString()
    : null;
}

type PendingTask = {
  startedAt: string | null;
  countedOutput: number;
  recordedOutput: number | null;
  hasUsage: boolean;
};

/** Task metrics are separate from the per-model-call token ledger. */
export function extractTaskTimings(
  events: RolloutLine[],
  opts: { isSubagent: boolean },
): TaskTiming[] {
  const pending = new Map<string, PendingTask>();
  const completed = new Map<string, TaskTiming>();
  let activeId: string | null = null;
  let armed = !opts.isSubagent;
  let previousUsage: string | null = null;

  for (const event of events) {
    const payload = event.payload ?? {};
    const id = typeof payload.turn_id === "string" ? payload.turn_id : null;
    if (event.type === "event_msg" && payload.type === "task_started") {
      armed = true;
      activeId = id ?? `${event.timestamp}:${event.ordinal ?? pending.size}`;
      pending.set(activeId, {
        startedAt: timestampIso(payload.started_at) ?? timestampIso(event.timestamp),
        countedOutput: 0,
        recordedOutput: null,
        hasUsage: false,
      });
      continue;
    }
    if (!armed) continue;

    const task = pending.get(id ?? activeId ?? "");
    if (event.type === "token_usage_record" && task) {
      const usage = record(payload.turn_token_usage);
      const output = nonnegative(usage?.output_tokens);
      if (output != null) {
        task.recordedOutput = output;
        task.hasUsage = true;
      }
      continue;
    }
    if (event.type !== "event_msg") continue;
    if (payload.type === "token_count") {
      const info = record(payload.info);
      const last = record(info?.last_token_usage);
      const total = record(info?.total_token_usage);
      const output = nonnegative(last?.output_tokens);
      if (!last || !total || output == null) continue;
      const key = JSON.stringify([last, total]);
      if (key === previousUsage) continue;
      previousUsage = key;
      if (task) {
        task.countedOutput += output;
        task.hasUsage = true;
      }
      continue;
    }
    if (payload.type !== "task_complete") continue;

    const taskId = id ?? activeId ?? event.timestamp;
    if (completed.has(taskId)) continue;
    const endedAt = timestampIso(event.timestamp) ?? timestampIso(payload.completed_at);
    if (!endedAt) continue;
    const startedAt = task?.startedAt ?? timestampIso(payload.started_at);
    const elapsed = startedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null;
    const durationMs = payload.duration_ms !== undefined
      ? nonnegative(payload.duration_ms)
      : elapsed != null && elapsed > 0 ? elapsed : null;
    const ttft = nonnegative(payload.time_to_first_token_ms);
    completed.set(taskId, {
      id: taskId,
      startedAt,
      endedAt,
      durationMs: durationMs != null && durationMs > 0 ? durationMs : null,
      ttftMs: ttft != null && (durationMs == null || ttft <= durationMs) ? ttft : null,
      outputTokens: task?.hasUsage
        ? task.recordedOutput ?? task.countedOutput
        : null,
    });
    pending.delete(taskId);
    if (activeId === taskId) activeId = null;
  }
  return [...completed.values()];
}

export function collectTaskTimings(session: SessionSnapshot): TaskTiming[] {
  return [
    ...(session.taskTimings ?? []),
    ...session.children.flatMap(collectTaskTimings),
  ];
}

/**
 * One sample per recorded model request, from the timing the log recorded for
 * that request. Sources without task windows (pi, Cursor, Claude) report here.
 */
export function requestTimings(turns: Turn[]): TimedSample[] {
  return turns.map((turn) => {
    const performance = turn.requestPerformance;
    return {
      id: turn.id,
      startedAt: turn.startedAt ?? null,
      endedAt: turn.endedAt ?? null,
      durationMs: performance?.durationMs ?? null,
      ttftMs: performance?.ttftMs ?? null,
      outputTokensPerSecond: performance?.outputTokensPerSecond ?? null,
      outputTokens: turn.usageRecorded ? turn.usage.output_tokens : null,
    };
  });
}

/**
 * Timing samples for a set of sessions. Agent-task windows are the primary
 * record; sessions that never record them fall back to per-request timing, so
 * the summary always states what it measured.
 */
export function performanceSamples(
  sessions: SessionSnapshot[],
): { basis: PerformanceBasis | null; samples: TimedSample[] } {
  const samples: TimedSample[] = [];
  for (const session of sessions) {
    const own = session.taskTimings ?? [];
    if (own.length > 0) samples.push(...own.map((sample) => ({ ...sample, basis: "task" as const })),
      ...session.children.flatMap(collectTaskTimings));
    else samples.push(
      ...requestTimings(session.turns).map((sample) => ({ ...sample, basis: "request" as const })),
      ...session.children.flatMap((child) => requestTimings(child.turns).map((sample) => ({ ...sample, basis: "request" as const }))),
    );
  }
  return { basis: summarizePerformance(samples).basis, samples };
}

export function summarizeSessions(sessions: SessionSnapshot[]): PerformanceSummary {
  const { basis, samples } = performanceSamples(sessions);
  return { ...summarizePerformance(samples), ...durationClocks(sessions), basis };
}

function positiveMs(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function spanMs(
  starts: Array<string | null | undefined>,
  ends: Array<string | null | undefined>,
): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const iso of starts) {
    const ms = parseIsoMs(iso);
    if (ms != null) first = first == null ? ms : Math.min(first, ms);
  }
  for (const iso of ends) {
    const ms = parseIsoMs(iso);
    if (ms != null) last = last == null ? ms : Math.max(last, ms);
  }
  return first != null && last != null && last > first ? last - first : null;
}

function endedAtInRange(
  endedAt: string | null | undefined,
  sinceMs?: number,
  untilMs?: number,
): boolean {
  if (sinceMs == null && untilMs == null) return true;
  const ms = parseIsoMs(endedAt);
  if (ms == null) return false;
  if (sinceMs != null && ms < sinceMs) return false;
  if (untilMs != null && ms >= untilMs) return false;
  return true;
}

function turnInClockRange(
  turn: Turn,
  sinceMs?: number,
  untilMs?: number,
): boolean {
  return endedAtInRange(turn.endedAt || turn.startedAt, sinceMs, untilMs);
}

/**
 * Two clocks distinct from the tok/s denominator:
 * requestDurationMs sums each request's full durationMs;
 * taskDurationMs sums completed agent-task windows, or a request-only
 * session's first-request-start → last-request-end (else startedAt→lastEventAt).
 */
export function durationClocks(
  sessions: SessionSnapshot[],
  opts?: {
    sinceMs?: number;
    untilMs?: number;
    turnFilter?: (turn: Turn) => boolean;
    requestOnly?: boolean;
  },
): DurationClocks {
  let requestSum = 0;
  let requestCount = 0;
  let taskSum = 0;
  let taskCount = 0;
  const sinceMs = opts?.sinceMs;
  const untilMs = opts?.untilMs;
  const ranged = sinceMs != null || untilMs != null;

  function visit(session: SessionSnapshot): void {
    const turns = session.turns.filter((turn) => {
      if (!turnInClockRange(turn, sinceMs, untilMs)) return false;
      return opts?.turnFilter == null || opts.turnFilter(turn);
    });
    for (const sample of requestTimings(turns)) {
      const ms = positiveMs(sample.durationMs);
      if (ms == null) continue;
      requestSum += ms;
      requestCount += 1;
    }

    const ownTasks = session.taskTimings ?? [];
    if (!opts?.requestOnly && ownTasks.length > 0) {
      for (const task of ownTasks) {
        if (!endedAtInRange(task.endedAt, sinceMs, untilMs)) continue;
        const ms = positiveMs(task.durationMs);
        if (ms == null) continue;
        taskSum += ms;
        taskCount += 1;
      }
    } else {
      const span = spanMs(
        turns.map((turn) => turn.startedAt),
        turns.map((turn) => turn.endedAt),
      ) ?? (!ranged && !opts?.requestOnly
        ? spanMs([session.startedAt], [session.lastEventAt])
        : null);
      if (span != null) {
        taskSum += span;
        taskCount += 1;
      }
    }
    for (const child of session.children) visit(child);
  }

  for (const session of sessions) visit(session);
  return {
    requestDurationMs: requestCount > 0 ? requestSum : null,
    requestDurationCount: requestCount,
    taskDurationMs: taskCount > 0 ? taskSum : null,
    taskDurationCount: taskCount,
  };
}

/** A timing sample plus the unit it measured: an agent task or one request. */
export type TimedSample = TaskTiming & {
  basis?: PerformanceBasis;
  /** Request-level speed, including sources that do not record a duration. */
  outputTokensPerSecond?: number | null;
};

/** Fixed display buckets for the response-performance histograms. The upper
 * edge of each bucket is the axis label; the last bucket is open-ended.
 * 输出速度在 40 tok/s 以上细分：≤ 40，随后 40–50 … 290–300 每 10 tok/s 一档，
 * 最后 > 300；快模型的分布不再挤在一个桶里。UI 的 TPS_EDGES 必须与此一致。 */
export const TTFT_EDGES_MS = [1_000, 2_000, 3_000, 5_000] as const;
export const TPS_EDGES = [
  40,
  50,
  60,
  70,
  80,
  90,
  100,
  110,
  120,
  130,
  140,
  150,
  160,
  170,
  180,
  190,
  200,
  210,
  220,
  230,
  240,
  250,
  260,
  270,
  280,
  290,
  300,
] as const;

export type PerformanceDistribution = {
  /** Sample counts per TTFT bucket, in ms; length is `TTFT_EDGES_MS.length + 1`. */
  ttft: number[];
  /** Sample counts per output-speed bucket, in tok/s. */
  tps: number[];
  /** All samples in scope, including those with no recorded measurements. */
  sampleCount: number;
};

function bucketCount(value: number, edges: readonly number[]): number {
  for (let i = 0; i < edges.length; i++) if (value <= edges[i]) return i;
  return edges.length;
}

/**
 * Where the recorded timings concentrate, using the same samples as the
 * summary. Only recorded measurements count: a missing measurement never
 * lands in the first bucket.
 */
export function performanceDistribution(
  samples: TimedSample[],
): PerformanceDistribution {
  const ttft = Array<number>(TTFT_EDGES_MS.length + 1).fill(0);
  const tps = Array<number>(TPS_EDGES.length + 1).fill(0);
  for (const sample of samples) {
    if (sample.ttftMs != null) ttft[bucketCount(sample.ttftMs, TTFT_EDGES_MS)] += 1;
    const speed = sampleSpeed(sample);
    if (speed != null) tps[bucketCount(speed, TPS_EDGES)] += 1;
  }
  return { ttft, tps, sampleCount: samples.length };
}

/**
 * Generation window for one model request, in ms.
 *
 * No TTFT: the whole duration (a log that never recorded the first token).
 * TTFT at or past the end: the measurement stands, but there is no decode
 * interval. A tail of 20ms or less that contains more tokens than
 * milliseconds is one buffered flush — the body arrived already formed, so
 * dividing by that tail reports a drain rate, not a decode rate. Zero output
 * and no first token means the request never generated anything (auth failure,
 * connection error, engine crash); its duration is not decode time.
 */
export function requestGenerationMs(
  durationMs: number | null,
  ttftMs: number | null,
  outputTokens: number | null,
): number | null {
  if (durationMs == null || durationMs <= 0) return null;
  if (ttftMs == null) return outputTokens === 0 ? null : durationMs;
  if (ttftMs >= durationMs) return null;
  const window = durationMs - ttftMs;
  if (window <= 20 && outputTokens != null && outputTokens > window) return null;
  return window;
}

/** Generation/decode window for tok/s. Request samples use `requestGenerationMs`.
 * Task samples keep the full window (tools and waits stay in the denominator). */
function sampleGenerationMs(sample: TimedSample): number | null {
  if (sample.basis === "request") {
    return requestGenerationMs(sample.durationMs, sample.ttftMs, sample.outputTokens ?? null);
  }
  if (sample.durationMs == null || sample.durationMs <= 0) return null;
  return sample.durationMs;
}

function sampleSpeed(sample: TimedSample): number | null {
  if (sample.outputTokensPerSecond != null) return nonnegative(sample.outputTokensPerSecond);
  const generationMs = sampleGenerationMs(sample);
  if (generationMs == null || sample.outputTokens == null) return null;
  const speed = (sample.outputTokens * 1000) / generationMs;
  return Number.isFinite(speed) ? speed : null;
}

export function summarizePerformance(samples: TimedSample[]): PerformanceSummary {
  let ttftSum = 0;
  let ttftSampleCount = 0;
  let generationSum = 0;
  let outputSum = 0;
  let speedSampleCount = 0;
  for (const sample of samples) {
    if (sample.ttftMs != null) {
      ttftSum += sample.ttftMs;
      ttftSampleCount += 1;
    }
    const generationMs = sampleGenerationMs(sample);
    if (generationMs != null && sample.outputTokens != null) {
      generationSum += generationMs;
      outputSum += sample.outputTokens;
      speedSampleCount += 1;
    }
  }
  return {
    taskCount: samples.length,
    ttftSampleCount,
    speedSampleCount,
    avgTtftMs: ttftSampleCount > 0 ? ttftSum / ttftSampleCount : null,
    outputTokensPerSecond: speedSampleCount > 0 ? outputSum * 1000 / generationSum : null,
    totalDurationMs: speedSampleCount > 0 ? generationSum : null,
    ...EMPTY_DURATION_CLOCKS,
    basis: samples.length === 0 ? null
      : samples.some((sample) => sample.basis == null || sample.basis === "task") ? "task" : "request",
  };
}
