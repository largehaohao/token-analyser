import type { PerformanceSummary, Turn } from "./api";
import { formatPerformanceNumber } from "./format";
import { performanceCopy } from "./performance-copy";
import { turnDistributions } from "./perf-buckets";
import { HistogramPair } from "./Histogram";

type Props = {
  performance?: PerformanceSummary;
  /** When the turn records are in scope, the fixed-bucket distributions are shown. */
  turns?: Turn[];
};

export function PerformanceMetrics({ performance, turns }: Props) {
  const ttft = performance?.avgTtftMs;
  const speed = performance?.outputTokensPerSecond;
  const text = performanceCopy(performance);
  const distributions = turnDistributions(turns ?? []);
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
      {turns && turns.length > 0 && (
        <HistogramPair ttft={distributions.ttft} speed={distributions.speed} />
      )}
      <p className="performance-note" data-testid="performance-basis">
        {text.basisNote}
        {text.note}
      </p>
    </section>
  );
}
