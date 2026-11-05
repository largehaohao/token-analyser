import type { PerformanceSummary, SessionSource, TaskTiming, Turn } from "./api";
import { formatPerformanceNumber } from "./format";
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

export function PerformanceMetrics({ performance, turns, tasks, source }: Props) {
  const ttft = performance?.avgTtftMs;
  const speed = performance?.outputTokensPerSecond;
  const text = performanceCopy(performance, source);
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
