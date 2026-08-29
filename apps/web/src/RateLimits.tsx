import { formatResetAt, formatWindow, parseRateLimits } from "./rate-limits";

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
        <pre>{JSON.stringify(raw, null, 2)}</pre>
      </aside>
    );
  }

  return (
    <aside className="rate-limits chart-card">
      <h3>用量限额</h3>
      {gauges.map((gauge) => {
        const width = Math.min(100, Math.max(0, gauge.usedPercent));
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
            {(gauge.windowMinutes != null || gauge.resetsAt != null) && (
              <div className="rate-gauge-meta">
                {gauge.windowMinutes != null
                  ? `${formatWindow(gauge.windowMinutes)} window`
                  : null}
                {gauge.windowMinutes != null && gauge.resetsAt != null
                  ? " · "
                  : null}
                {gauge.resetsAt != null
                  ? `reset ${formatResetAt(gauge.resetsAt)}`
                  : null}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
