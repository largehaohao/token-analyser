import { useState } from "react";
import type { OverviewDay, OverviewSlice } from "./api";
import { SLICE_META, type SliceKey } from "./buckets";
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
  unitToChartMetric,
  type ChartMetric,
} from "./chart-metric";
import {
  allocatePercents,
  formatChartNumber,
  formatExactTokens,
  formatPercent,
} from "./format";
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
            按 UTC 日期归桶（跨日会话按每轮结束时间拆分）
            {rangeLabel ? ` · ${rangeLabel}` : ""}
            。窗口外的用量记在「更早 / 之后」。单位跟随页顶开关。不是逐 token
            实时扣费。
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
          {days.map((day) => {
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
              <div
                key={day.date}
                className={`trend-col${isOverflowDate(day.date) ? " overflow" : ""}`}
                tabIndex={0}
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
                <div className="chart-tooltip">
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
                    <span>另有 {formatExactTokens(unpricedRaw)} tokens 未定价</span>
                  )}
                </div>
                <span className="trend-label">
                  {shouldLabelChartDay(day.date, dates)
                    ? formatChartDay(day.date)
                    : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="trend-legend">
        <span>
          <i className="swatch useful" /> 已记录用量
        </span>
        <span>
          <i className="swatch waste" /> 含账本警告或解析错误（不是浪费开关）
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
  const visible = slices.filter((s) => s.raw > 0);
  const percents = allocatePercents(slices.map((s) => s.raw));
  const sliceSum = slices.reduce((sum, s) => sum + s.raw, 0);
  const [hoverKey, setHoverKey] = useState<SliceKey | null>(null);

  return (
    <section className="chart-card">
      <h2 className="chart-title">Token 花在哪里?</h2>
      <p className="chart-desc">按行为归因的原始 token 划分，不是服务商账单分类</p>
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
            stroke="#1a221a"
            strokeWidth="22"
          />
          {visible.map((slice) => {
            const dash = totalRaw > 0 ? (slice.raw / totalRaw) * circ : 0;
            const circle = (
              <circle
                key={slice.key}
                cx="100"
                cy="100"
                r={radius}
                fill="none"
                stroke={SLICE_META[slice.key].color}
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
            {hoverKey ? SLICE_META[hoverKey].label : "总用量"}
          </text>
          <text
            x="100"
            y="114"
            textAnchor="middle"
            className="donut-center-value"
          >
            {hoverKey
              ? `${formatExactTokens(slices.find((s) => s.key === hoverKey)?.raw ?? 0)} · ${formatPercent(
                  percents[slices.findIndex((s) => s.key === hoverKey)] ?? 0,
                )}`
              : totalRaw >= 1_000_000
                ? `${(totalRaw / 1_000_000).toFixed(1)}M tokens`
                : `${totalRaw.toLocaleString("en-US")} tokens`}
          </text>
        </svg>
        <ul className="donut-legend">
          {slices.map((slice, i) => (
            <li key={slice.key} className={hoverKey === slice.key ? "hot" : ""}>
              <button
                type="button"
                onMouseEnter={() => setHoverKey(slice.key)}
                onMouseLeave={() => setHoverKey(null)}
                onFocus={() => setHoverKey(slice.key)}
                onBlur={() => setHoverKey(null)}
              >
                <i
                  className="legend-dot"
                  style={{ background: SLICE_META[slice.key].color }}
                />
                <span>{SLICE_META[slice.key].label}</span>
                <em>{formatExactTokens(slice.raw)}</em>
                <strong>{formatPercent(percents[i])}</strong>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="chart-foot">
        {sliceSum === totalRaw
          ? "兄弟节点合计 100%。百分比用最大余数法显示，避免四舍五入加总偏差。"
          : `切片合计 ${formatExactTokens(sliceSum)}，与总量 ${formatExactTokens(totalRaw)} 不一致。`}
      </p>
    </section>
  );
}
