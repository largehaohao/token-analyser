import { useState } from "react";
import type { Overview, OverviewDay, OverviewSlice } from "./api";
import { formatChartNumber } from "./format";

const SLICE_META: Record<
  OverviewSlice["key"],
  { label: string; color: string }
> = {
  code: { label: "代码与执行", color: "#7dffb3" },
  subagents: { label: "子 Agent", color: "#9b7dff" },
  reread: { label: "读取", color: "#ff9f5a" },
  waiting: { label: "等待 / 轮询", color: "#7dc8ff" },
  planning: { label: "规划与思考", color: "#4d6bff" },
  other: { label: "其他 / 未知", color: "#e89b8c" },
};

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
  const parts = date.split("-");
  return `${parts[1]}/${parts[2]}`;
}

export function TrendChart({ days }: { days: OverviewDay[] }) {
  const [metric, setMetric] = useState<ChartMetric>("usd");
  const values = days.map((day) => dayValue(day, metric));
  const max = Math.max(...values, 1);
  const ticks = [max, max / 2, 0];

  return (
    <section className="chart-card">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">消耗趋势</h2>
          <p className="chart-desc">基于已记录用量，不代表逐 Token 实时扣费</p>
        </div>
        <div className="metric-switch">
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
                  title={`${formatDay(day.date)} ${formatChartNumber(total, metric)}`}
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
          <i className="swatch waste" /> 包含异常关联
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

  return (
    <section className="chart-card">
      <h2 className="chart-title">Token 花在哪里?</h2>
      <p className="chart-desc">按行为归因，不等同于服务商账单分类</p>
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
                strokeWidth="22"
                strokeDasharray={`${dash} ${circ - dash}`}
                strokeDashoffset={offset}
                strokeLinecap="butt"
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
            总用量
          </text>
          <text
            x="100"
            y="114"
            textAnchor="middle"
            className="donut-center-value"
          >
            {totalRaw >= 1_000_000
              ? `${(totalRaw / 1_000_000).toFixed(1)}M tokens`
              : `${totalRaw.toLocaleString("en-US")} tokens`}
          </text>
        </svg>
        <ul className="donut-legend">
          {slices.map((slice) => {
            const pct =
              totalRaw > 0 ? Math.round((100 * slice.raw) / totalRaw) : 0;
            return (
              <li key={slice.key}>
                <i
                  className="legend-dot"
                  style={{ background: SLICE_META[slice.key].color }}
                />
                <span>{SLICE_META[slice.key].label}</span>
                <strong>{pct}%</strong>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="chart-foot">部分记录缺失，百分比可能不完整</p>
    </section>
  );
}
