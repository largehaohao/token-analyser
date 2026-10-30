import { useEffect, useRef, useState } from "react";
import type { Overview } from "./api";
import {
  barHeightPct,
  chartMax,
  dayHasMixedUnpriced,
  dayMetricValue,
  dayUnpricedRaw,
  flaggedValue,
  formatChartDay,
  shouldLabelChartDay,
  trendColumnAriaLabel,
  trendContentMinWidth,
  type ChartMetric,
} from "./chart-metric";
import { formatChartNumber } from "./format";
import { ModelFilterSelect } from "./ModelFilterSelect";
import { useModelFilteredOverview } from "./useModelFilteredOverview";
import { srTable } from "./ui";

type Props = {
  overview: Overview;
  chartMetric: ChartMetric;
  onChartMetric: (metric: ChartMetric) => void;
  filterScope: string;
  fetchOverviewForModel: (model: string) => Promise<Overview>;
};

const METRICS: { id: ChartMetric; label: string }[] = [
  { id: "tokens", label: "tokens" },
  { id: "credits", label: "credits" },
  { id: "usd", label: "USD" },
];

/**
 * The daily ledger. Bar height is the selected metric; the darker segment is the
 * usage associated with ledger/parse anomalies. A striped base marks tokens that
 * have no price, which is a data-quality signal, not a zero-cost day.
 */
export function TrendPanel({
  overview: baseOverview,
  chartMetric,
  onChartMetric,
  filterScope,
  fetchOverviewForModel,
}: Props) {
  const {
    model,
    setModel,
    overview,
    loading,
    error,
  } = useModelFilteredOverview(baseOverview, filterScope, fetchOverviewForModel);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 8, top: 8 });
  const metric = chartMetric;
  const max = chartMax(overview.days.map((day) => dayMetricValue(day, metric)));
  const selectedMetric = metric;
  const label = (value: number | null) =>
    value == null ? "未定价" : formatChartNumber(value, metric);
  const unfocusTimer = useRef<number | null>(null);
  const tooltipTarget = useRef<HTMLButtonElement | null>(null);

  function positionTooltip() {
    const target = tooltipTarget.current;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    setTooltipPosition({
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - 100, window.innerWidth - 208)),
      top: Math.max(8, Math.min(rect.top + 8, window.innerHeight - 180)),
    });
  }

  useEffect(() => {
    window.addEventListener("scroll", positionTooltip, { passive: true });
    window.addEventListener("resize", positionTooltip);
    return () => {
      window.removeEventListener("scroll", positionTooltip);
      window.removeEventListener("resize", positionTooltip);
      if (unfocusTimer.current != null) window.clearTimeout(unfocusTimer.current);
    };
  }, []);

  function show(date: string, target: HTMLButtonElement) {
    if (unfocusTimer.current != null) window.clearTimeout(unfocusTimer.current);
    tooltipTarget.current = target;
    positionTooltip();
    setHovered(date);
  }

  function scheduleHide() {
    if (unfocusTimer.current != null) window.clearTimeout(unfocusTimer.current);
    unfocusTimer.current = window.setTimeout(() => setHovered(null), 150);
  }

  return (
    <section className="chart-card" data-testid="trend-chart" aria-label="每日支出趋势">
      <div className="chart-head">
        <div>
          <h3 className="chart-title">每日支出趋势</h3>
          <p className="chart-desc">
            柱高为已记录用量，橙色表示含账本警告或解析错误的用量；斜纹表示该日有未定价 Token。
            聚焦任意一天可读出当日明细，Esc 关闭。
          </p>
        </div>
        <div className="chart-head-controls">
          <ModelFilterSelect
            id="trend-model-filter"
            models={baseOverview.models}
            value={model}
            onChange={setModel}
            disabled={loading}
          />
          <div
            className="chart-metric-tabs"
            role="group"
            aria-label="趋势图单位"
          >
            {METRICS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={selectedMetric === item.id ? "on" : ""}
                aria-pressed={selectedMetric === item.id}
                onClick={() => onChartMetric(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error ? (
        <p className="empty-inline" role="alert">
          按模型筛选失败：{error}
        </p>
      ) : null}
      {overview.days.length === 0 ? (
        <p className="empty-inline">该时间范围内没有每日用量。</p>
      ) : (
        <>
          <div className="chart-body trend" onScroll={positionTooltip}>
            <div className="trend-content" style={{ minWidth: trendContentMinWidth(overview.days.length) }}>
              <div className="grid">
                {[1, 0.5, 0].map((ratio) => (
                  <span
                    key={ratio}
                    className="gl"
                    title={label(max * ratio)}
                    style={{ bottom: `calc(${ratio * 100}% - 1px)` }}
                  />
                ))}
                {[1, 0.5, 0].map((ratio) => (
                  <span
                    key={`label-${ratio}`}
                    className="ylab"
                    style={{ bottom: `calc(${ratio * 100}% - 7px)` }}
                  >
                    {label(max * ratio)}
                  </span>
                ))}
              </div>
              <div
                className="bars"
                role="group"
                aria-label={`每日${metric}用量柱状图`}
              >
                {overview.days.map((day) => {
                  const value = dayMetricValue(day, metric);
                  const bar = barHeightPct(value, day.cost.raw, max);
                  const flagged = flaggedValue(day, metric);
                  const flaggedHeight =
                    flagged == null || value == null || value <= 0
                      ? 0
                      : Math.min(100, Math.max(0, (100 * flagged) / value));
                  return (
                    <button
                      key={day.date}
                      type="button"
                      className={`trend-col ${
                        hovered === day.date ? "hover" : ""
                      } ${dayHasMixedUnpriced(day, metric) ? "unpriced" : ""}`}
                      onMouseEnter={(e) => show(day.date, e.currentTarget)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={(e) => show(day.date, e.currentTarget)}
                      onBlur={scheduleHide}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setHovered(null);
                      }}
                      onClick={(e) => show(day.date, e.currentTarget)}
                      aria-label={trendColumnAriaLabel(day, metric)}
                    >
                      <i
                        className="fill"
                        style={{ height: `${Math.max(bar.height, bar.unpriced || (value ?? 0) > 0 ? 2 : 0)}%` }}
                      >
                        {bar.unpriced && <span className="unp" />}
                        <span
                          className="flag"
                          style={{ height: `${flaggedHeight}%` }}
                        />
                      </i>
                      {hovered === day.date && (
                        <span className="chart-tooltip" style={tooltipPosition}>
                          <b>{day.date}</b>
                          <span>总计 {label(value)}</span>
                          {value != null && (
                            <span>
                              {day.cost.raw.toLocaleString()} tokens
                            </span>
                          )}
                          <span className="sep">
                            账本 / 解析异常 {label(flagged)}
                          </span>
                          {day.unpricedRaw != null && day.unpricedRaw > 0 && (
                            <span className="sep">
                              {formatChartNumber(day.unpricedRaw, "tokens")}{" "}
                              未定价 Token
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="labels">
                {overview.days.map((day) => (
                  <span
                    key={day.date}
                    className={`tick ${
                      shouldLabelChartDay(day.date, overview.days.map((d) => d.date))
                        ? ""
                        : "muted-tick"
                    }`}
                    title={formatChartDay(day.date)}
                  >
                    {formatChartDay(day.date)}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="chart-legend">
            <span>
              <i className="pt" style={{ background: "var(--chart-cyan)" }} />
              已记录用量
            </span>
            <span>
              <i className="pt" style={{ background: "var(--chart-orange)" }} />
              账本 / 解析异常
            </span>
            <span>
              <i
                className="pt"
                style={{
                  background:
                    "repeating-linear-gradient(90deg,var(--warn),var(--warn) 3px,var(--bg-raised) 3px,var(--bg-raised) 6px)",
                }}
              />
              未定价 Token
            </span>
          </div>
          {srTable(
            "每日支出趋势",
            ["日期", metric, "账本 / 解析异常", "未定价 Token"],
            overview.days.map((day) => [
              day.date,
              label(dayMetricValue(day, metric)),
              label(flaggedValue(day, metric)),
              formatChartNumber(dayUnpricedRaw(day), "tokens"),
            ]),
          )}
        </>
      )}
    </section>
  );
}
