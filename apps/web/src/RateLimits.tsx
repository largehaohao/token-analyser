import { formatWindow, parseRateLimits, resetIso } from "./rate-limits";
import { RelativeTime } from "./RelativeTime";

function level(percent: number): "ok" | "warn" | "hot" {
  if (percent >= 80) return "hot";
  if (percent >= 50) return "warn";
  return "ok";
}

function formatPercent(percent: number): string {
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

export function RateLimits({ raw }: { raw: unknown }) {
  const gauges = parseRateLimits(raw);
  if (gauges.length === 0) {
    return (
      <aside className="rate-limits chart-card">
        <h3>用量限额</h3>
        <p className="chart-desc">未识别到 used_percent 结构，原始快照可展开核对。</p>
        <details>
          <summary>查看原始数据</summary>
          <pre>{JSON.stringify(raw, null, 2)}</pre>
        </details>
      </aside>
    );
  }

  return (
    <aside className="rate-limits chart-card">
      <h3>用量限额</h3>
      <p className="chart-desc">来自最近一次 token_count 快照，不覆盖分轮账本。</p>
      {gauges.map((gauge) => {
        const width = Math.min(100, Math.max(0, gauge.usedPercent));
        const reset = gauge.resetsAt != null ? resetIso(gauge.resetsAt) : null;
        return (
          <div
            key={gauge.id}
            className="rate-gauge"
            data-testid={`rate-gauge-${gauge.id}`}
          >
            <div className="rate-gauge-head">
              <span className="rate-gauge-label">
                {gauge.group ? `${gauge.group} · ${gauge.label}` : gauge.label}
              </span>
              <span className="rate-gauge-pct">
                {formatPercent(gauge.usedPercent)}
              </span>
            </div>
            <div className="rate-gauge-track">
              <span
                className={`rate-gauge-fill ${level(gauge.usedPercent)}`}
                style={{ width: `${width}%` }}
              />
            </div>
            {(gauge.windowMinutes != null || reset) && (
              <div className="rate-gauge-meta">
                {gauge.windowMinutes != null && (
                  <span>{formatWindow(gauge.windowMinutes)} 窗口</span>
                )}
                {reset && (
                  <span>
                    重置 <RelativeTime iso={reset} />
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
