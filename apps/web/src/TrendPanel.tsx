import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Overview } from "./api";
import {
  barHeightPct,
  chartMax,
  dayHasMixedUnpriced,
  dayMetricValue,
  dayUnpricedRaw,
  flaggedValue,
  formatChartDay,
  isWeekendDate,
  localDateString,
  niceChartTicks,
  shouldLabelChartDay,
  trendColumnAriaLabel,
  trendContentMinWidth,
  type ChartMetric,
} from "./chart-metric";
import { formatChartNumber } from "./format";
import { ModelFilterSelect } from "./ModelFilterSelect";
import { useModelFilteredOverview } from "./useModelFilteredOverview";
import { useFlashOnChange } from "./motion";
import { Panel, SegmentedControl, srTable } from "./ui";
import {
  heatCalendar,
  metricSeries,
  trendOverlay,
  type TrendMode,
} from "./visual-metrics";

type Props = {
  overview: Overview;
  chartMetric: ChartMetric;
  onChartMetric: (metric: ChartMetric) => void;
  filterScope: string;
  fetchOverviewForModel: (model: string) => Promise<Overview>;
  onFocusSlice: (key: string | null) => void;
};

const METRICS: { id: ChartMetric; label: string }[] = [
  { id: "tokens", label: "tokens" },
  { id: "credits", label: "credits" },
  { id: "usd", label: "USD" },
];

const MODES: Array<{ id: TrendMode; label: string }> = [
  { id: "daily", label: "每日" },
  { id: "cumulative", label: "累计" },
  { id: "moving", label: "7 日均" },
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
  onFocusSlice,
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
  const [mode, setMode] = useState<TrendMode>("daily");
  const metric = chartMetric;
  const max = chartMax(overview.days.map((day) => dayMetricValue(day, metric)));
  const ticks = niceChartTicks(max);
  const knownValues = overview.days
    .map((day) => dayMetricValue(day, metric))
    .filter((value): value is number => value != null);
  const average =
    knownValues.length >= 2
      ? knownValues.reduce((sum, value) => sum + value, 0) / knownValues.length
      : null;
  const today = localDateString(new Date());
  const todayValue =
    overview.days.find((day) => day.date === today) != null
      ? dayMetricValue(
          overview.days.find((day) => day.date === today)!,
          metric,
        )
      : null;
  const todayFlash = useFlashOnChange(todayValue);
  const selectedMetric = metric;
  const points = metricSeries(overview.days, metric);
  const overlay = mode === "daily" ? null : trendOverlay(points, mode);
  const calendar = heatCalendar(overview.days, metric);
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
    <Panel role="region" className="chart-card trend-panel" data-testid="trend-chart" aria-label="每日支出趋势">
      <div className="chart-head">
        <div>
          <h3 className="chart-title">每日支出趋势</h3>
          <p className="chart-desc">
            柱高为已记录用量，橙色表示含账本警告或解析错误的用量；斜纹表示该日有未定价 Token。
            虚线为窗口均值，圆点标记今天，周末列有底色。聚焦任意一天可读出当日明细，Esc 关闭。
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
          <SegmentedControl
            className="chart-metric-tabs"
            label="趋势图单位"
            value={selectedMetric}
            options={METRICS}
            onChange={onChartMetric}
          />
          <div className="trend-modes" role="group" aria-label="趋势叠加方式">
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="trend-mode"
                aria-pressed={mode === item.id}
                onClick={() => setMode(item.id)}
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
              {overlay && (
                <svg
                  className="trend-overlay"
                  viewBox={`0 0 ${Math.max(1, overlay.length)} 100`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polyline
                    pathLength={1}
                    points={overlay
                      .map((value, index) =>
                        value == null ? null : `${index + 0.5},${Math.max(0, 100 - (100 * value) / Math.max(...overlay.filter((v): v is number => v != null), 1))}`,
                      )
                      .filter((point): point is string => point != null)
                      .join(" ")}
                  />
                </svg>
              )}
              <div className="grid">
                {ticks.map((value) => (
                  <span
                    key={value}
                    className="gl"
                    title={label(value)}
                    style={{ bottom: `calc(${(100 * value) / max}% - 1px)` }}
                  />
                ))}
                {ticks.map((value) => (
                  <span
                    key={`label-${value}`}
                    className="ylab"
                    style={{ bottom: `calc(${(100 * value) / max}% - 7px)` }}
                  >
                    {label(value)}
                  </span>
                ))}
                {average != null && (
                  <span
                    className="trend-avg"
                    style={{ bottom: `calc(${(100 * average) / max}% - 1px)` }}
                  >
                    <b>均值 {label(average)}</b>
                  </span>
                )}
              </div>
              <div
                className={`bars${hovered != null ? " has-hover" : ""}`}
                role="group"
                aria-label={`每日${metric}用量柱状图`}
              >
                {overview.days.map((day, index) => {
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
                      } ${dayHasMixedUnpriced(day, metric) ? "unpriced" : ""} ${
                        isWeekendDate(day.date) ? "weekend" : ""
                      } ${day.date === today ? "today" : ""} ${
                        day.date === today && todayFlash ? "today-flash" : ""
                      }`}
                      style={{ "--i": Math.min(index, 14) } as CSSProperties}
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
                    } ${day.date === today ? "today-tick" : ""}`}
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
            {average != null && (
              <span>
                <i
                  style={{
                    display: "inline-block",
                    width: 14,
                    height: 0,
                    borderTop: "1px dashed var(--accent)",
                    marginRight: 4,
                    verticalAlign: "3px",
                  }}
                />
                窗口均值 {label(average)}
              </span>
            )}
            {mode !== "daily" && (
              <span>
                <i style={{ display: "inline-block", width: 14, height: 0, borderTop: "2px solid var(--chart-violet)", marginRight: 4, verticalAlign: "3px" }} />
                {mode === "cumulative" ? "累计用量" : "7 日移动均值"}
              </span>
            )}
          </div>
          {calendar.length > 0 && (
            <div className="heat-calendar">
              <p className="heat-title">用量日历（按日强度）</p>
              <div className="heat-grid" role="group" aria-label="每日用量强度日历">
                {calendar.map((cell, index) => (
                  <span
                    key={cell.date ?? `blank-${index}`}
                    className={`heat-cell${cell.date ? "" : " empty"}`}
                    data-level={cell.level}
                    data-date={cell.date ?? undefined}
                    title={cell.date ? `${cell.date} · ${label(cell.value)}` : undefined}
                  />
                ))}
              </div>
              <div className="heat-scale">
                <span>低</span>
                {[0, 1, 2, 3, 4].map((level) => (
                  <i key={level} className={`heat-cell`} data-level={level} style={{ border: 0 }} />
                ))}
                <span>高</span>
              </div>
            </div>
          )}
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
    </Panel>
  );
}
