import type { PerformanceSummary, SessionSource, TaskTiming, Turn } from "./api";
import { formatPerformanceDuration, formatPerformanceNumber } from "./format";
import { performanceCopy } from "./performance-copy";
import { taskDistributions, turnDistributions } from "./perf-buckets";
import { HistogramPair } from "./Histogram";

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

/** Older engine payloads omit the two clocks; session view still has the samples. */
function clocksFrom(
  performance: PerformanceSummary | undefined,
  turns: Turn[] | undefined,
  tasks: TaskTiming[] | undefined,
): Pick<PerformanceSummary, "requestDurationMs" | "requestDurationCount" | "taskDurationMs" | "taskDurationCount"> {
  if (performance != null && "requestDurationMs" in performance) {
    return {
      requestDurationMs: performance.requestDurationMs ?? null,
      requestDurationCount: performance.requestDurationCount ?? 0,
      taskDurationMs: performance.taskDurationMs ?? null,
      taskDurationCount: performance.taskDurationCount ?? 0,
    };
  }
  let requestSum = 0;
  let requestCount = 0;
  for (const turn of turns ?? []) {
    const ms = positiveMs(turn.requestPerformance?.durationMs);
    if (ms == null) continue;
    requestSum += ms;
    requestCount += 1;
  }
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
    requestDurationMs: requestCount > 0 ? requestSum : null,
    requestDurationCount: requestCount,
    taskDurationMs: taskCount > 0 ? taskSum : null,
    taskDurationCount: taskCount,
  };
}

export function PerformanceMetrics({ performance, turns, tasks, source }: Props) {
  const ttft = performance?.avgTtftMs;
  const speed = performance?.outputTokensPerSecond;
  const clocks = clocksFrom(performance, turns, tasks);
  const requestDuration = formatPerformanceDuration(clocks.requestDurationMs);
  const taskDuration = formatPerformanceDuration(clocks.taskDurationMs);
  const text = performanceCopy(
    performance == null ? undefined : { ...performance, ...clocks },
    source,
  );
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
        <article className="performance-card">
          <h2>平均 TTFT</h2>
          <div className="performance-value" data-testid="ttft-value">
            {formatPerformanceNumber(ttft == null ? null : ttft / 1000)} <small>s</small>
          </div>
          <p>{text.ttftNote}</p>
        </article>
        <article className="performance-card">
          <h2>{text.speedLabel}</h2>
          <div className="performance-value" data-testid="token-speed-value">
            {formatPerformanceNumber(speed)} <small>tok/s</small>
          </div>
          <p>{text.speedNote}</p>
        </article>
        <article className="performance-card performance-card-duration">
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
        </article>
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
