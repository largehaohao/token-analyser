import type { PerformanceSummary, SessionSource, TaskTiming, Turn } from "./api";
import { formatPerformanceDuration, formatPerformanceNumber } from "./format";
import { performanceCopy } from "./performance-copy";
import { taskDistributions, turnDistributions } from "./perf-buckets";
import { HistogramPair } from "./Histogram";
import { Panel } from "./ui";

type Props = {
  performance?: PerformanceSummary;
  /** When the turn records are in scope, the fixed-bucket distributions are shown. */
  turns?: Turn[];
  /** Agent-task windows (Codex). Preferred: they are the averages' own samples. */
  tasks?: TaskTiming[];
  /** Sharpens the copy where one source can record more than another. */
  source?: SessionSource;
};

function positiveMs(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function turnSpanMs(turns: Turn[]): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const turn of turns) {
    const start = Date.parse(turn.startedAt);
    const end = Date.parse(turn.endedAt);
    if (Number.isFinite(start)) first = first == null ? start : Math.min(first, start);
    if (Number.isFinite(end)) last = last == null ? end : Math.max(last, end);
  }
  return first != null && last != null && last > first ? last - first : null;
}

function requestClocksFromTurns(turns: Turn[] | undefined): {
  requestDurationMs: number | null;
  requestDurationCount: number;
} {
  let requestSum = 0;
  let requestCount = 0;
  for (const turn of turns ?? []) {
    const ms = positiveMs(turn.requestPerformance?.durationMs);
    if (ms == null) continue;
    requestSum += ms;
    requestCount += 1;
  }
  return {
    requestDurationMs: requestCount > 0 ? requestSum : null,
    requestDurationCount: requestCount,
  };
}

function taskClocksFrom(
  turns: Turn[] | undefined,
  tasks: TaskTiming[] | undefined,
): { taskDurationMs: number | null; taskDurationCount: number } {
  let taskSum = 0;
  let taskCount = 0;
  if (tasks != null && tasks.length > 0) {
    for (const task of tasks) {
      const ms = positiveMs(task.durationMs);
      if (ms == null) continue;
      taskSum += ms;
      taskCount += 1;
    }
  } else {
    const span = turnSpanMs(turns ?? []);
    if (span != null) {
      taskSum = span;
      taskCount = 1;
    }
  }
  return {
    taskDurationMs: taskCount > 0 ? taskSum : null,
    taskDurationCount: taskCount,
  };
}

/** Prefer the summary; if a dump left TTFT/speed/duration empty, rebuild from turns. */
export function resolvePerformance(
  performance: PerformanceSummary | undefined,
  turns: Turn[] | undefined,
  tasks?: TaskTiming[],
): PerformanceSummary {
  const fromTurns = requestClocksFromTurns(turns);
  const taskClocks = taskClocksFrom(turns, tasks);
  let ttftSum = 0;
  let ttftSampleCount = 0;
  let outputSum = 0;
  let generationSum = 0;
  let speedSampleCount = 0;
  for (const turn of turns ?? []) {
    const sample = turn.requestPerformance;
    if (sample?.ttftMs != null) {
      ttftSum += sample.ttftMs;
      ttftSampleCount += 1;
    }
    const duration = positiveMs(sample?.durationMs);
    const output = turn.usage?.output_tokens;
    if (duration == null || output == null || !Number.isFinite(output)) continue;
    const ttft = sample?.ttftMs;
    const generation = ttft != null && ttft < duration ? duration - ttft : duration;
    if (generation <= 0) continue;
    outputSum += output;
    generationSum += generation;
    speedSampleCount += 1;
  }
  const requestDurationMs = performance?.requestDurationMs ?? fromTurns.requestDurationMs;
  const requestDurationCount = performance?.requestDurationCount
    || (requestDurationMs == null ? 0 : fromTurns.requestDurationCount);
  return {
    taskCount: performance?.taskCount ?? turns?.length ?? 0,
    ttftSampleCount: performance?.ttftSampleCount || ttftSampleCount,
    speedSampleCount: performance?.speedSampleCount || speedSampleCount,
    avgTtftMs: performance?.avgTtftMs ?? (ttftSampleCount > 0 ? ttftSum / ttftSampleCount : null),
    outputTokensPerSecond: performance?.outputTokensPerSecond
      ?? (generationSum > 0 ? outputSum * 1000 / generationSum : null),
    totalDurationMs: performance?.totalDurationMs ?? (generationSum > 0 ? generationSum : null),
    requestDurationMs,
    requestDurationCount: performance?.requestDurationMs != null
      ? (performance.requestDurationCount ?? 0)
      : requestDurationCount,
    taskDurationMs: performance?.taskDurationMs ?? taskClocks.taskDurationMs,
    taskDurationCount: performance?.taskDurationMs != null
      ? (performance.taskDurationCount ?? 0)
      : taskClocks.taskDurationCount,
    basis: performance?.basis ?? (ttftSampleCount > 0 || speedSampleCount > 0 ? "request" : null),
  };
}

export function PerformanceMetrics({ performance, turns, tasks, source }: Props) {
  const resolved = resolvePerformance(performance, turns, tasks);
  const ttft = resolved.avgTtftMs;
  const speed = resolved.outputTokensPerSecond;
  const requestDuration = formatPerformanceDuration(resolved.requestDurationMs);
  const taskDuration = formatPerformanceDuration(resolved.taskDurationMs);
  const text = performanceCopy(resolved, source);
  // 口径一致：会话平均用任务计时时，直方图也分桶任务计时；否则退回轮次请求计时。
  const taskBased = tasks != null && tasks.length > 0;
  const distributions = taskBased
    ? taskDistributions(tasks)
    : turnDistributions(turns ?? []);
  const hasSamples =
    distributions.ttft.known > 0 || distributions.speed.known > 0;
  return (
    <section className="performance-metrics" aria-label="响应性能">
      <div className="performance-grid">
        <Panel role="article" className="performance-card">
          <h2>平均 TTFT</h2>
          <div className="performance-value" data-testid="ttft-value">
            {formatPerformanceNumber(ttft == null ? null : ttft / 1000)} <small>s</small>
          </div>
          <p>{text.ttftNote}</p>
        </Panel>
        <Panel role="article" className="performance-card">
          <h2>{text.speedLabel}</h2>
          <div className="performance-value" data-testid="token-speed-value">
            {formatPerformanceNumber(speed)} <small>tok/s</small>
          </div>
          <p>{text.speedNote}</p>
        </Panel>
        <Panel role="article" className="performance-card performance-card-duration">
          <h2>{text.durationLabel}</h2>
          <div className="performance-duration-list">
            <div className="performance-duration-row">
              <h3>{text.requestDurationLabel}</h3>
              <div className="performance-value" data-testid="request-duration-value">
                {requestDuration.value} <small>{requestDuration.unit}</small>
              </div>
              <p>{text.requestDurationNote}</p>
            </div>
            <div className="performance-duration-row">
              <h3>{text.taskDurationLabel}</h3>
              <div className="performance-value" data-testid="task-duration-value">
                {taskDuration.value} <small>{taskDuration.unit}</small>
              </div>
              <p>{text.taskDurationNote}</p>
            </div>
          </div>
        </Panel>
      </div>
      {hasSamples && (
        <HistogramPair
          ttft={distributions.ttft}
          speed={distributions.speed}
          noun={taskBased ? "次任务" : "轮"}
        />
      )}
      <p className="performance-note" data-testid="performance-basis">
        {text.basisNote}
        {text.note}
      </p>
    </section>
  );
}
