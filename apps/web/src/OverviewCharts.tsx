import { useState } from "react";
import type { OverviewDay, OverviewSlice } from "./api";
import { SLICE_META, type SliceKey } from "./buckets";
import {
  allocatePercents,
  formatChartNumber,
  formatExactTokens,
  formatPercent,
} from "./format";

export type ChartMetric = "usd" | "tokens" | "credits";

function dayValue(day: OverviewDay, metric: ChartMetric): number {
  if (metric === "tokens") return day.cost.raw;
  if (metric === "credits") return day.cost.credits ?? 0;
  return day.cost.usd ?? 0;
}

function flaggedValue(day: OverviewDay, metric: ChartMetric): number {
  if (metric === "tokens") return day.flaggedCost.raw;
  if (metric === "credits") return day.flaggedCost.credits ?? 0;
  return day.flaggedCost.usd ?? 0;
}

function formatDay(date: string): string {
  if (date === "earlier") return "更早";
  const parts = date.split("-");
  return `${parts[1]}/${parts[2]}`;
}

type TrendProps = {
  days: OverviewDay[];
  rangeLabel?: string;
};

export function TrendChart({ days, rangeLabel }: TrendProps) {
  const [metric, setMetric] = useState<ChartMetric>("usd");
  const values = days.map((day) => dayValue(day, metric));
  const max = Math.max(...values, 1);
  const ticks = [max, max / 2, 0];

  return (
    <section className="chart-card">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">消耗趋势</h2>
          <p className="chart-desc">
            按 UTC 日期归桶（跨日会话按每轮结束时间拆分）
            {rangeLabel ? ` · ${rangeLabel}` : ""}
            。窗口外的用量记在「更早」。不是逐 token 实时扣费。
          </p>
        </div>
        <div className="metric-switch" role="group" aria-label="趋势单位">
          {(
            [
              ["usd", "费用"],
              ["tokens", "Tokens"],
              ["credits", "Credits"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={metric === id ? "active" : ""}
              aria-pressed={metric === id}
              onClick={() => setMetric(id)}
            >
              {label}
            </button>
          ))}
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
            const total = dayValue(day, metric);
            const flagged = flaggedValue(day, metric);
            const height = (100 * total) / max;
            const flagShare = total > 0 ? (100 * flagged) / total : 0;
            const labelEvery = days.length > 14 ? Math.ceil(days.length / 10) : 1;
            return (
              <div key={day.date} className="trend-col">
                <div
                  className="trend-stack"
                  style={{ height: `${Math.max(height, total > 0 ? 2 : 0)}%` }}
                >
                  {flagged > 0 && (
                    <span
                      className="trend-flag"
                      style={{ height: `${flagShare}%` }}
                    />
                  )}
                  <span
                    className="trend-fill"
                    style={{ height: `${100 - flagShare}%` }}
                  />
                </div>
                <div className="chart-tooltip">
                  <strong>
                    {day.date === "earlier"
                      ? "窗口之前"
                      : `${day.date} UTC`}{" "}
                    · {formatChartNumber(total, metric)}
                  </strong>
                  <span>
                    账本警告 / 解析错误 {formatChartNumber(flagged, metric)}
                  </span>
                  <span>{formatExactTokens(day.cost.raw)} tokens</span>
                </div>
                <span className="trend-label">
                  {index % labelEvery === 0 ? formatDay(day.date) : ""}
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
          aria-label="Token allocation"
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
            <li
              key={slice.key}
              className={hoverKey === slice.key ? "hot" : ""}
              onMouseEnter={() => setHoverKey(slice.key)}
              onMouseLeave={() => setHoverKey(null)}
              title={`${formatExactTokens(slice.raw)} tokens`}
            >
              <i
                className="legend-dot"
                style={{ background: SLICE_META[slice.key].color }}
              />
              <span>{SLICE_META[slice.key].label}</span>
              <em>{formatExactTokens(slice.raw)}</em>
              <strong>{formatPercent(percents[i])}</strong>
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
