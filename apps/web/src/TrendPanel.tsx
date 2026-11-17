import { useState, type CSSProperties } from "react";
import type { Overview } from "./api";
import { ChartTooltip, useChartTooltip } from "./ChartTooltip";
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
import { BareButton, Icon, Panel, SegmentedControl, srTable } from "./ui";
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
  onDrillDay?: (date: string) => void;
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
  onDrillDay,
}: Props) {
  const {
    model,
    setModel,
    overview,
    loading,
    error,
  } = useModelFilteredOverview(baseOverview, filterScope, fetchOverviewForModel);
  const [mode, setMode] = useState<TrendMode>("daily");
  const barTip = useChartTooltip();
  const heatTip = useChartTooltip();
  const hovered = barTip.active;
  const hoveredHeat = heatTip.active;
  const metric = chartMetric;
  const max = chartMax(overview.days.map((day) => dayMetricValue(day, metric)));
  const ticks = niceChartTicks(max);
  const knownValues = overview.days
    .map((day) => dayMetricValue(day, metric))
    .filter((value): value is number => value != null);
  const hasData = knownValues.some((value) => value > 0);
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
  return (
    <Panel role="region" className="chart-card trend-panel" data-testid="trend-chart" aria-label="每日支出趋势">
      <div className="chart-head">
        <div>
          <h3 className="chart-title">每日支出趋势</h3>
          <ul className="trend-legend" aria-label="趋势图图例">
            <li><i className="swatch uncached" /> 已记录用量</li>
            <li><i className="swatch flag" /> 账本或解析异常</li>
            <li><i className="swatch unpriced" /> 含未定价 Token</li>
            <li><i className="swatch avg" /> 窗口均值</li>
            <li><i className="swatch today" /> 今天</li>
          </ul>
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
          <div className="chart-body trend" onScroll={barTip.reposition}>
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
              {hasData ? (
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
              ) : (
                <p className="chart-empty-note" role="status">
                  该时间范围内没有已记录用量，仅保留可聚焦的日期列；切换范围或导入记录后显示坐标轴。
                </p>
              )}
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
                    <div
                      key={day.date}
                      role="button"
                      tabIndex={0}
                      className={`trend-col ${
                        hovered === day.date ? "hover" : ""
                      } ${dayHasMixedUnpriced(day, metric) ? "unpriced" : ""} ${
                        isWeekendDate(day.date) ? "weekend" : ""
                      } ${day.date === today ? "today" : ""} ${
                        day.date === today && todayFlash ? "today-flash" : ""
                      }`}
                      style={{ "--i": Math.min(index, 14) } as CSSProperties}
                      onMouseEnter={(e) => barTip.show(day.date, e.currentTarget)}
                      onMouseLeave={barTip.scheduleHide}
                      onFocus={(e) => barTip.show(day.date, e.currentTarget)}
                      onBlur={barTip.scheduleHide}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") barTip.hide();
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          barTip.show(day.date, e.currentTarget);
                        }
                      }}
                      onClick={(e) => barTip.show(day.date, e.currentTarget)}
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
                        <ChartTooltip
                          position={barTip.position}
                          onMouseEnter={barTip.cancelHide}
                          onMouseLeave={barTip.scheduleHide}
                        >
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
                          {onDrillDay && (
                            /^\d{4}-\d{2}-\d{2}$/.test(day.date) && (
                            <BareButton
                              type="button"
                              className="tooltip-action"
                              onClick={() => {
                                barTip.hide();
                                onDrillDay(day.date);
                              }}
                            >
                              查看当日会话 <Icon name="arrow" />
                            </BareButton>
                            )
                          )}
                        </ChartTooltip>
                      )}
                    </div>
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
                {calendar.map((cell, index) =>
                  cell.date ? (
                    <div
                      key={cell.date}
                      role="button"
                      tabIndex={0}
                      className={`heat-cell${hoveredHeat === cell.date ? " hot" : ""}`}
                      data-level={cell.level}
                      data-date={cell.date}
                      aria-label={`${cell.date} · ${label(cell.value)}${onDrillDay ? "，回车查看当日会话" : ""}`}
                      onMouseEnter={(e) => heatTip.show(cell.date!, e.currentTarget)}
                      onMouseLeave={heatTip.scheduleHide}
                      onFocus={(e) => heatTip.show(cell.date!, e.currentTarget)}
                      onBlur={heatTip.scheduleHide}
                      onClick={(e) => heatTip.show(cell.date!, e.currentTarget)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") heatTip.hide();
                        if (e.key === "Enter" && onDrillDay) {
                          heatTip.hide();
                          onDrillDay(cell.date!);
                        }
                      }}
                    >
                      {hoveredHeat === cell.date && (
                        <ChartTooltip
                          position={heatTip.position}
                          onMouseEnter={heatTip.cancelHide}
                          onMouseLeave={heatTip.scheduleHide}
                        >
                          <b>{cell.date}</b>
                          <span>{label(cell.value)}</span>
                          {onDrillDay && (
                            <BareButton
                              type="button"
                              className="tooltip-action"
                              onClick={() => {
                                heatTip.hide();
                                onDrillDay(cell.date!);
                              }}
                            >
                              查看当日会话 <Icon name="arrow" />
                            </BareButton>
                          )}
                        </ChartTooltip>
                      )}
                    </div>
                  ) : (
                    <span
                      key={`blank-${index}`}
                      className="heat-cell empty"
                      aria-hidden="true"
                    />
                  ),
                )}
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
