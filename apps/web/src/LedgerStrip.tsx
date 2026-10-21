import type { Overview } from "./api";
import {
  cacheHitRatio,
  companionMoneyUnit,
  costValue,
  formatCompactTokens,
  formatCost,
  formatCostTitle,
  formatPercent,
  formatUnitSuffix,
  type CostUnit,
} from "./format";

type Props = {
  overview: Overview;
  /** Equal-length window right before the current one, when one exists. */
  previous: Overview | null;
  previousLabel: string | null;
  unit: CostUnit;
  onOpenSessions: () => void;
};

function share(part: number, total: number): number | null {
  if (!(total > 0) || !Number.isFinite(part)) return null;
  return (100 * part) / total;
}

function deltaText(delta: number, label: string): string {
  const arrow = delta > 0 ? "▲" : "▼";
  return `较${label} ${arrow} ${Math.abs(delta).toFixed(0)}%`;
}

/**
 * The five numbers a cost review starts with, plus how the window compares with
 * the equal-length window before it. No chart is spent on a number that has no
 * comparison to make.
 */
export function LedgerStrip({
  overview,
  previous,
  previousLabel,
  unit,
  onOpenSessions,
}: Props) {
  const current = costValue(overview.cost, unit);
  const prev = previous ? costValue(previous.cost, unit) : null;
  const delta =
    prev != null && prev > 0 && current != null
      ? ((current - prev) / prev) * 100
      : null;
  const cache = cacheHitRatio(overview.cost);
  const comparisonLabel = previousLabel ?? "上一周期";
  const moneyUnit = unit === "tokens" && overview.cost.credits == null && overview.cost.usd != null
    ? "usd" : companionMoneyUnit(unit);

  return (
    <section className="ledger" data-testid="ledger-strip" aria-label="当前统计范围概览">
      <div className="ledger-item">
        <span className="ledger-label">总支出（{unit}）</span>
        <span
          className="ledger-value"
          title={formatCostTitle(overview.cost, unit)}
        >
          {formatCost(overview.cost, unit)}
          <span className="ledger-unit"> {formatUnitSuffix(unit)}</span>
        </span>
        <span
          className={`ledger-delta ${delta == null ? "" : delta > 0 ? "up" : "down"}`}
          title={
            prev == null
              ? "该统计范围没有可比较的上一周期"
              : `上一周期 ${
                  unit === "tokens"
                    ? `${prev.toLocaleString()} tokens`
                    : formatCost(
                        { ...overview.cost, credits: prev, usd: prev },
                        unit,
                      )
                }`
          }
        >
          {delta == null
            ? `较${comparisonLabel} —`
            : deltaText(delta, comparisonLabel)}
        </span>
      </div>
      {unit === "tokens" && (
        <div className="ledger-item">
          <span className="ledger-label">预估费用（{moneyUnit}）</span>
          <span
            className="ledger-value"
            title={formatCostTitle(overview.cost, moneyUnit)}
          >
            {formatCost(overview.cost, moneyUnit)}
            <span className="ledger-unit"> {formatUnitSuffix(moneyUnit)}</span>
          </span>
          <span className="ledger-delta">
            价格表推算，不代表厂商账单
          </span>
        </div>
      )}
      <button
        type="button"
        className="ledger-item ledger-action"
        onClick={onOpenSessions}
      >
        <span className="ledger-label">已分析会话 / 请求轮次</span>
        <span className="ledger-value">
          {overview.sessionCount.toLocaleString()}
          <span className="ledger-unit">
            {" / "}
            {overview.turnCount.toLocaleString()}
          </span>
        </span>
        <span className="ledger-delta">
          {overview.live ? "有实时会话" : "静态账本"} ·{" "}
          {overview.collecting ? "采集中" : "未开启采集"}
        </span>
      </button>
      <div className="ledger-item">
        <span className="ledger-label">缓存命中</span>
        <span className="ledger-value">
          {cache == null ? "—" : formatPercent(100 * cache)}
        </span>
        <span
          className="ledger-delta"
          title="已缓存输入 ÷ 全部输入；仅来源记录缓存的会话参与计算"
        >
          {formatCompactTokens(overview.cost.cached_input)} /{" "}
          {formatCompactTokens(
            overview.cost.uncached_input + overview.cost.cached_input,
          )}{" "}
          输入
        </span>
      </div>
      <div className="ledger-item">
        <span className="ledger-label">未定价 Token</span>
        <span
          className={`ledger-value ${overview.unpricedRaw > 0 ? "warn" : ""}`}
        >
          {formatCompactTokens(overview.unpricedRaw)}
        </span>
        <span className="ledger-delta">
          {overview.unpricedRaw > 0
            ? "这些 Token 已用量，未计入费用"
            : "全部用量已有价格"}
        </span>
      </div>
      <div className="ledger-item">
        <span className="ledger-label">疑似可优化</span>
        <span className="ledger-value" title={formatCostTitle(overview.waste, unit)}>
          {formatCost(overview.waste, unit)}
        </span>
        <span className="ledger-delta">
          {share(overview.waste.raw, overview.cost.raw) == null
            ? "该范围没有用量"
            : `占 token 用量 ${formatPercent(share(overview.waste.raw, overview.cost.raw)!)}`}
        </span>
      </div>
      <div className="ledger-item">
        <span className="ledger-label">价格快照</span>
        <span className="ledger-value">{overview.rateCardAsOf}</span>
        <span className="ledger-delta">
          {overview.apiPricesAsOf
            ? `API 价格 ${overview.apiPricesAsOf}`
            : "未记录 API 价格更新时间"}
          {overview.fastMultiplier != null
            ? ` · Fast ×${overview.fastMultiplier}`
            : ""}
        </span>
      </div>
    </section>
  );
}
