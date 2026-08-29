import type { Overview } from "./api";
import {
  cacheHitRatio,
  type CostUnit,
  disclaimer,
  formatCompactTokens,
  formatCost,
  formatCostTitle,
  formatExactTokens,
  formatPercent,
  formatUnitSuffix,
  tokenIdentity,
  unpricedNote,
  wasteShare,
} from "./format";
import { MixBar } from "./MixBar";
import { DonutChart, ModelMix, TrendChart } from "./OverviewCharts";
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
  // Tokens headlines keep a credits companion; money units already show tokens in KPI 2.
  const moneyUnit: CostUnit = "credits";
  const unpriced = unpricedNote(overview.unpricedRaw ?? 0);
  const identity = tokenIdentity(overview.cost);
  const models = overview.models ?? [];

  return (
    <div className="overview" data-testid="overview-page">
      <div className="kpi-grid">
        <article className="kpi-card">
          <div className="kpi-label">
            <IconDiamond /> {unit === "tokens" ? "总用量" : "预估总费用"}
          </div>
          <div className="kpi-value" title={formatCostTitle(overview.cost, unit)}>
            {formatCost(overview.cost, unit)}{" "}
            <small>{formatUnitSuffix(unit)}</small>
          </div>
          <div className="kpi-sub">
            {unit === "tokens"
              ? `本地费率估算 · ${formatCost(overview.cost, moneyUnit)} ${formatUnitSuffix(moneyUnit)}`
              : `${formatExactTokens(overview.cost.raw)} tokens`}
            {hit != null ? ` · 缓存命中 ${formatPercent(100 * hit)}` : ""}
            {unpriced ? ` · ${unpriced}` : ""}
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">
            <IconHash /> {unit === "tokens" ? "预估总费用" : "总 Token 用量"}
          </div>
          <div
            className="kpi-value"
            title={
              unit === "tokens"
                ? formatCostTitle(overview.cost, moneyUnit)
                : formatExactTokens(overview.cost.raw)
            }
          >
            {unit === "tokens"
              ? formatCost(overview.cost, moneyUnit)
              : formatCompactTokens(overview.cost.raw)}
            {unit === "tokens" && (
              <small> {formatUnitSuffix(moneyUnit)}</small>
            )}
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
          <div className="kpi-value" title={formatCostTitle(overview.waste, unit)}>
            {formatCost(overview.waste, unit)}{" "}
            <small>{formatUnitSuffix(unit)}</small>
          </div>
          <div className="kpi-sub">
            {wastePct === "—"
              ? "部分用量未定价，无法按费用比"
              : `${wastePct} 的已知${unit === "tokens" ? " token" : "费用"}（随各会话浪费开关变化）`}
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

      <p className="disclaimer">{disclaimer(overview.rateCardAsOf)}</p>

      {overview.sessionCount === 0 && (
        <p className="empty-overview">
          该时间范围内没有会话。试试 7 天或全部，或把 JSONL 拖到会话列表导入。
        </p>
      )}

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
          label="未缓存 / 缓存 / 输出"
          segments={[
            {
              key: "uncached",
              label: "未缓存",
              value: overview.cost.uncached_input,
              className: "uncached",
            },
            {
              key: "cached",
              label: "缓存",
              value: overview.cost.cached_input,
              className: "cached",
            },
            {
              key: "output",
              label: "输出",
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
          <span className={identity.ok ? "identity-ok" : "identity-warn"}>
            合计 {formatExactTokens(identity.parts)}
            {identity.ok ? " = raw" : ` ≠ raw ${formatExactTokens(overview.cost.raw)}`}
          </span>
        </div>
      </section>

      <div className="charts-grid">
        <TrendChart days={overview.days} rangeLabel={rangeLabel} />
        <DonutChart slices={overview.slices} totalRaw={overview.cost.raw} />
      </div>
      <ModelMix models={models} />
    </div>
  );
}
