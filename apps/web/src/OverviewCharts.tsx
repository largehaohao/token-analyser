import { useState } from "react";
import type { OverviewDay, OverviewModel, OverviewSlice } from "./api";
import {
  barHeightPct,
  chartDayTooltip,
  chartMax,
  dayHasMixedUnpriced,
  dayMetricValue,
  dayUnpricedRaw,
  flaggedValue,
  formatChartDay,
  isOverflowDate,
  shouldLabelChartDay,
  trendColumnAriaLabel,
  unitToChartMetric,
  type ChartMetric,
} from "./chart-metric";
import { buildDonutSeries, donutPercents } from "./donut-series";
import {
  formatChartNumber,
  formatCost,
  formatCostTitle,
  formatExactTokens,
  formatPercent,
  unpricedNote,
} from "./format";
import { MixBar } from "./MixBar";
import { useUnit } from "./UnitContext";

function flaggedLabel(day: OverviewDay, metric: ChartMetric): string {
  const flagged = flaggedValue(day, metric);
  if (flagged == null) return "未定价";
  return formatChartNumber(flagged, metric);
}

type TrendProps = {
  days: OverviewDay[];
  rangeLabel?: string;
};

export function TrendChart({ days, rangeLabel }: TrendProps) {
  const [inspectedDay, setInspectedDay] = useState<string | null>(null);
  const { unit } = useUnit();
  const metric = unitToChartMetric(unit);
  const values = days.map((day) => dayMetricValue(day, metric));
  const max = chartMax(values);
  const ticks = [max, max / 2, 0];
  const dates = days.map((day) => day.date);
  const hasUnpriced = days.some(
    (day) =>
      (dayMetricValue(day, metric) == null && day.cost.raw > 0) ||
      dayHasMixedUnpriced(day, metric),
  );

  return (
    <section className="chart-card">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">消耗趋势</h2>
          <p className="chart-desc">
            {rangeLabel ?? "当前范围"} · 按本地日期汇总，单位跟随页顶选择。
          </p>
        </div>
      </div>
      <div className="trend" data-testid="trend-chart">
        <div className="trend-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick}>{formatChartNumber(tick, metric)}</span>
          ))}
        </div>
        <div className="trend-plot">
          {days.map((day, index) => {
            const total = dayMetricValue(day, metric);
            const flagged = flaggedValue(day, metric);
            const bar = barHeightPct(total, day.cost.raw, max);
            const mixed = dayHasMixedUnpriced(day, metric);
            const unpricedRaw = dayUnpricedRaw(day);
            const flagShare =
              total != null && total > 0 && flagged != null
                ? (100 * flagged) / total
                : 0;
            return (
              <button
                type="button"
                key={day.date}
                className={`trend-col${isOverflowDate(day.date) ? " overflow" : ""}${inspectedDay === day.date ? " inspected" : ""}${index < days.length / 3 ? " tooltip-start" : index >= (days.length * 2) / 3 ? " tooltip-end" : ""}`}
                aria-label={trendColumnAriaLabel(day, metric)}
                onMouseEnter={() => setInspectedDay(day.date)}
                onMouseLeave={() => setInspectedDay(null)}
                onFocus={() => setInspectedDay(day.date)}
                onBlur={() => setInspectedDay(null)}
                onClick={() => setInspectedDay(day.date)}
                onKeyDown={(event) => {
                  if (!event.nativeEvent.isComposing && event.key === "Escape")
                    setInspectedDay(null);
                }}
              >
                <div
                  className={`trend-stack${bar.unpriced ? " unpriced" : ""}${mixed ? " mixed-unpriced" : ""}`}
                  style={{
                    height: `${Math.max(bar.height, bar.unpriced || (total ?? 0) > 0 ? 2 : 0)}%`,
                  }}
                >
                  {mixed && <span className="trend-unpriced-mix" />}
                  {!bar.unpriced && flagged != null && flagged > 0 && (
                    <span
                      className="trend-flag"
                      style={{ height: `${flagShare}%` }}
                    />
                  )}
                  <span
                    className="trend-fill"
                    style={{
                      height: bar.unpriced ? "100%" : `${100 - flagShare}%`,
                    }}
                  />
                </div>
                <span className="chart-tooltip" aria-hidden="true">
                  <strong>
                    {chartDayTooltip(day.date)}
                    {" · "}
                    {total == null
                      ? "未定价"
                      : formatChartNumber(total, metric)}
                  </strong>
                  <span>账本警告 / 解析错误 {flaggedLabel(day, metric)}</span>
                  <span>{formatExactTokens(day.cost.raw)} tokens</span>
                  {unpricedRaw > 0 && total != null && (
                    <span>
                      另有 {formatExactTokens(unpricedRaw)} tokens 未定价
                    </span>
                  )}
                </span>
                <span className="trend-label">
                  {shouldLabelChartDay(day.date, dates)
                    ? formatChartDay(day.date)
                    : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="trend-legend">
        <span>
          <i className="swatch useful" /> 已记录用量
        </span>
        <span>
          <i className="swatch flagged" /> 含账本或解析异常
        </span>
        {hasUnpriced && (
          <span>
            <i className="swatch unpriced" /> 未定价模型（柱高仅作标记）
          </span>
        )}
      </div>
    </section>
  );
}

export function DonutChart({
  slices,
  totalRaw,
}: {
  slices: OverviewSlice[];
  totalRaw: number;
}) {
  const radius = 62;
  const circ = 2 * Math.PI * radius;
  let offset = circ * 0.25;
  const series = buildDonutSeries(slices, totalRaw);
  const percents = donutPercents(series);
  const sliceSum = slices.reduce((sum, s) => sum + s.raw, 0);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const hovered = series.find((slice) => slice.key === hoverKey);

  return (
    <section className="chart-card">
      <h2 className="chart-title">Token 花在哪里?</h2>
      <p className="chart-desc">
        按行为归因的原始 token
        划分，不是服务商账单分类。环与图例共用最大余数百分比。
      </p>
      <div className="donut-wrap" data-testid="donut-chart">
        <svg
          className="donut"
          viewBox="0 0 200 200"
          role="img"
          aria-label="Token 花在哪里"
        >
          <circle
            cx="100"
            cy="100"
            r={radius}
            fill="none"
            stroke="var(--border)"
            strokeWidth="22"
          />
          {series.map((slice, i) => {
            const dash = totalRaw > 0 ? (percents[i] / 100) * circ : 0;
            if (dash <= 0) return null;
            const circle = (
              <circle
                key={slice.key}
                cx="100"
                cy="100"
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth={hoverKey === slice.key ? 26 : 22}
                strokeDasharray={`${dash} ${circ - dash}`}
                strokeDashoffset={offset}
                strokeLinecap="butt"
                onMouseEnter={() => setHoverKey(slice.key)}
                onMouseLeave={() => setHoverKey(null)}
              />
            );
            offset -= dash;
            return circle;
          })}
          <text
            x="100"
            y="94"
            textAnchor="middle"
            className="donut-center-label"
          >
            {hovered ? hovered.label : "总用量"}
          </text>
          <text
            x="100"
            y="114"
            textAnchor="middle"
            className="donut-center-value"
          >
            {hovered
              ? `${formatExactTokens(hovered.raw)} · ${formatPercent(
                  percents[series.findIndex((s) => s.key === hovered.key)] ?? 0,
                )}`
              : totalRaw >= 1_000_000
                ? `${(totalRaw / 1_000_000).toFixed(1)}M tokens`
                : `${totalRaw.toLocaleString("en-US")} tokens`}
          </text>
        </svg>
        <ul className="donut-legend">
          {series.map((slice, i) => (
            <li key={slice.key} className={hoverKey === slice.key ? "hot" : ""}>
              <button
                type="button"
                onMouseEnter={() => setHoverKey(slice.key)}
                onMouseLeave={() => setHoverKey(null)}
                onFocus={() => setHoverKey(slice.key)}
                onBlur={() => setHoverKey(null)}
                onClick={() => setHoverKey(slice.key)}
              >
                <i className="legend-dot" style={{ background: slice.color }} />
                <span>{slice.label}</span>
                <em>{formatExactTokens(slice.raw)}</em>
                <strong>{formatPercent(percents[i] ?? 0)}</strong>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="chart-foot">
        {sliceSum === totalRaw
          ? "兄弟节点合计 100%。百分比用最大余数法显示，避免四舍五入加总偏差。"
          : `切片合计 ${formatExactTokens(sliceSum)}，与总量 ${formatExactTokens(totalRaw)} 不一致；差额记为未归因。`}
      </p>
    </section>
  );
}

const MODEL_COLORS = [
  "var(--accent)",
  "var(--chart-blue)",
  "var(--chart-violet)",
  "var(--chart-cyan)",
  "var(--chart-orange)",
  "var(--warn)",
];

export function ModelMix({ models }: { models: OverviewModel[] }) {
  const { unit } = useUnit();
  if (models.length === 0) return null;
  const percents = donutPercents(
    models.map((row, i) => ({
      key: row.model,
      raw: row.cost.raw,
      label: row.model,
      color: MODEL_COLORS[i % MODEL_COLORS.length],
    })),
  );

  return (
    <section className="chart-card model-mix" data-testid="model-mix">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">按模型</h2>
          <p className="chart-desc">
            按 turn_context 记录的模型拆分原始 token。费用跟随页顶单位。
          </p>
        </div>
      </div>
      <MixBar
        className="headline-mix"
        label="按模型"
        segments={models.map((row, i) => ({
          key: row.model,
          label: row.model === "(unknown)" ? "未记录模型" : row.model,
          value: row.cost.raw,
          className: "model",
          color: MODEL_COLORS[i % MODEL_COLORS.length],
        }))}
      />
      <ul className="model-list">
        {models.map((row, i) => (
          <li key={row.model}>
            <span
              className="legend-dot"
              style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
            />
            <span className="model-name" title={row.model}>
              {row.model === "(unknown)" ? "未记录模型" : row.model}
            </span>
            <span className="model-turns">
              {row.turnCount.toLocaleString("en-US")} 轮
            </span>
            <strong title={formatCostTitle(row.cost, unit)}>
              {formatCost(row.cost, unit)}
            </strong>
            <em>{formatPercent(percents[i] ?? 0)}</em>
            {row.unpricedRaw > 0 && (
              <span className="model-note">
                {unpricedNote(row.unpricedRaw)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
