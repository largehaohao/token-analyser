import type { PerformanceSummary } from "./api";
import { formatPerformanceNumber } from "./format";
import { performanceCopy } from "./performance-copy";

type Props = { performance?: PerformanceSummary };

export function PerformanceMetrics({ performance }: Props) {
  const ttft = performance?.avgTtftMs;
  const speed = performance?.outputTokensPerSecond;
  const requestBasis = performance?.basis === "request";
  const text = performanceCopy(performance);
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
      <p className="performance-note" data-testid="performance-basis">
        {text.basisNote}
        {text.note}
      </p>
    </section>
  );
}
