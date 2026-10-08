import type { PerformanceSummary } from "./api";
import { formatPerformanceNumber } from "./format";

type Props = { performance?: PerformanceSummary };

export function PerformanceMetrics({ performance }: Props) {
  const ttft = performance?.avgTtftMs;
  const speed = performance?.outputTokensPerSecond;
  return (
    <section className="performance-metrics" aria-label="响应性能">
      <div className="performance-grid">
        <article className="performance-card">
          <h2>平均 TTFT</h2>
          <div className="performance-value" data-testid="ttft-value">
            {formatPerformanceNumber(ttft == null ? null : ttft / 1000)} <small>s</small>
          </div>
          <p>
            {ttft == null
              ? "日志未记录首 token 时间"
              : `首 token 等待 · ${performance?.ttftSampleCount} 次已完成任务`}
          </p>
        </article>
        <article className="performance-card">
          <h2>任务平均 tok/s</h2>
          <div className="performance-value" data-testid="token-speed-value">
            {formatPerformanceNumber(speed)} <small>tok/s</small>
          </div>
          <p>
            {speed == null
              ? "暂无完整的任务耗时与输出记录"
              : `总输出 ÷ 总耗时 · ${performance?.speedSampleCount} 次已完成任务`}
          </p>
        </article>
      </div>
      <p className="performance-note">
        TTFT 为任务开始到首 token 的等待时间；tok/s 按整次任务计算，包含思考、工具执行与等待。
      </p>
    </section>
  );
}
