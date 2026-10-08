import type {
  PerformanceSummary,
  RolloutLine,
  SessionSnapshot,
  TaskTiming,
} from "./types.ts";

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

export function summarizePerformance(samples: TaskTiming[]): PerformanceSummary {
  let ttftSum = 0;
  let ttftSampleCount = 0;
  let durationSum = 0;
  let outputSum = 0;
  let speedSampleCount = 0;
  for (const sample of samples) {
    if (sample.ttftMs != null) {
      ttftSum += sample.ttftMs;
      ttftSampleCount += 1;
    }
    if (sample.durationMs != null && sample.durationMs > 0 && sample.outputTokens != null) {
      durationSum += sample.durationMs;
      outputSum += sample.outputTokens;
      speedSampleCount += 1;
    }
  }
  return {
    taskCount: samples.length,
    ttftSampleCount,
    speedSampleCount,
    avgTtftMs: ttftSampleCount > 0 ? ttftSum / ttftSampleCount : null,
    outputTokensPerSecond: speedSampleCount > 0 ? outputSum * 1000 / durationSum : null,
  };
}
