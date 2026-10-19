import type { ContextMeasurement } from "./api";
import { formatExactTokens, formatPercent } from "./format";

type Props = { measurement: ContextMeasurement };

/**
 * Cursor records how much context a conversation held; it never records the
 * tokens a request billed. This card reports that measurement only.
 */
export function ContextMeter({ measurement }: Props) {
  const { usedTokens, limitTokens, usagePercent, categories } = measurement;
  const share = usedTokens != null && limitTokens != null && limitTokens > 0
    ? (100 * usedTokens) / limitTokens
    : usagePercent;
  const label =
    usedTokens != null
      ? `${formatExactTokens(usedTokens)}${limitTokens != null ? ` / ${formatExactTokens(limitTokens)}` : ""}`
      : "—";
  const top = [...categories].sort((a, b) => b.tokens - a.tokens).slice(0, 4);
  return (
    <section className="context-meter chart-card" aria-label="来源记录的上下文占用">
      <div className="chart-head">
        <h3 className="chart-title">上下文占用（来源记录）</h3>
        <span className="context-meter-value" data-testid="context-meter-value">
          {label}
          {share != null ? ` · ${formatPercent(share)}` : ""}
        </span>
      </div>
      <p className="chart-desc">
        Cursor 记录的上下文计量，非账单 Token 用量；来源未记录请求级 Token 与耗时。
      </p>
      <div
        className="context-meter-bar"
        role="meter"
        aria-label="上下文占用比例"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share != null ? Math.round(share) : undefined}
      >
        <span style={{ width: share != null ? `${Math.min(100, Math.max(0, share))}%` : "0%" }} />
      </div>
      {top.length > 0 && (
        <ul className="context-meter-list">
          {top.map((item) => (
            <li key={item.id}>
              <span>{item.label}</span>
              <strong>{formatExactTokens(item.tokens)}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
