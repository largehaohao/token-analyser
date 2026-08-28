import type { Overview } from "./api";
import {
  cacheHitRatio,
  formatCompactTokens,
  formatCost,
  formatExactTokens,
  formatPercent,
  formatUnitSuffix,
  wasteShare,
} from "./format";
import { MixBar } from "./MixBar";
import { DonutChart, TrendChart } from "./OverviewCharts";
import { useUnit } from "./UnitContext";

type Props = {
  overview: Overview;
  onOpenSessions: () => void;
  rangeLabel: string;
};

function IconDiamond() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path fill="#7dffb3" d="M7 1.2 12.8 7 7 12.8 1.2 7Z" />
    </svg>
  );
}

function IconHash() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        fill="none"
        stroke="#7dffb3"
        strokeWidth="1.4"
        d="M5 2v10M9 2v10M2 5h10M2 9h10"
      />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path fill="#f5c542" d="M8.2 1 3 8h3.2L5.8 13 12 6H8.6L8.2 1Z" />
    </svg>
  );
}

function IconDoc() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        fill="none"
        stroke="#7dffb3"
        strokeWidth="1.3"
        d="M4 2.2h4.2L11 5v6.8H4z"
      />
      <path fill="none" stroke="#7dffb3" strokeWidth="1.3" d="M8.2 2.2V5H11" />
    </svg>
  );
}

export function OverviewPage({ overview, onOpenSessions, rangeLabel }: Props) {
  const { unit } = useUnit();
  const hit = cacheHitRatio(overview.cost);
  const wastePct = wasteShare(overview.waste, overview.cost, unit);

  return (
    <div className="overview" data-testid="overview-page">
      <div className="kpi-grid">
        <article className="kpi-card">
          <div className="kpi-label">
            <IconDiamond /> 预估总费用
          </div>
          <div className="kpi-value">
            {formatCost(overview.cost, unit)}{" "}
            <small>{formatUnitSuffix(unit)}</small>
          </div>
          <div className="kpi-sub">
            本地费率估算
            {unit !== "tokens"
              ? ` · ${formatExactTokens(overview.cost.raw)} tokens`
              : hit != null
                ? ` · 缓存命中 ${formatPercent(100 * hit)}`
                : ""}
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">
            <IconHash /> 总 Token 用量
          </div>
          <div className="kpi-value">
            {formatCompactTokens(overview.cost.raw)}
          </div>
          <div className="kpi-sub">
            {formatExactTokens(overview.cost.raw)} ·{" "}
            {overview.turnCount.toLocaleString("en-US")} 次模型调用
          </div>
        </article>
        <article className="kpi-card warn">
          <div className="kpi-label">
            <IconBolt /> 疑似可优化费用
          </div>
          <div className="kpi-value">
            {formatCost(overview.waste, unit)}{" "}
            <small>{formatUnitSuffix(unit)}</small>
          </div>
          <div className="kpi-sub">
            {wastePct} 的已知{unit === "tokens" ? " token" : "费用"}（默认浪费开关）
          </div>
        </article>
        <button
          type="button"
          className="kpi-card kpi-button"
          onClick={onOpenSessions}
        >
          <div className="kpi-label">
            <IconDoc /> 已分析会话
          </div>
          <div className="kpi-value">{overview.sessionCount}</div>
          <div className="kpi-sub" title={overview.watchPath}>
            点击查看明细 · {overview.watchPath}
          </div>
        </button>
      </div>

      <section className="chart-card token-mix-card">
        <div className="chart-head">
          <div>
            <h2 className="chart-title">Token 构成</h2>
            <p className="chart-desc">
              未缓存输入 / 缓存命中 / 输出。input 已含 cached，不再把 reasoning 加进总量。
            </p>
          </div>
          {hit != null && (
            <span className="cache-pill">缓存命中 {formatPercent(100 * hit)}</span>
          )}
        </div>
        <MixBar
          className="headline-mix"
          label="uncached / cached / output"
          segments={[
            {
              key: "uncached",
              value: overview.cost.uncached_input,
              className: "uncached",
            },
            {
              key: "cached",
              value: overview.cost.cached_input,
              className: "cached",
            },
            {
              key: "output",
              value: overview.cost.output,
              className: "output",
            },
          ]}
        />
        <div className="mix-legend token-mix-legend">
          <span>
            <i className="swatch uncached" /> 未缓存{" "}
            {formatExactTokens(overview.cost.uncached_input)}
          </span>
          <span>
            <i className="swatch cached" /> 缓存{" "}
            {formatExactTokens(overview.cost.cached_input)}
          </span>
          <span>
            <i className="swatch output" /> 输出{" "}
            {formatExactTokens(overview.cost.output)}
          </span>
        </div>
      </section>

      <div className="charts-grid">
        <TrendChart days={overview.days} rangeLabel={rangeLabel} />
        <DonutChart slices={overview.slices} totalRaw={overview.cost.raw} />
      </div>
    </div>
  );
}
