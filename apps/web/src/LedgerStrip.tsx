import type { Cost, Overview } from "./api";
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
import { useAnimatedNumber, useFlashOnChange } from "./motion";
import { BareButton, Panel } from "./ui";

type Props = {
  overview: Overview;
  unit: CostUnit;
  onOpenSessions: () => void;
};

function share(part: number, total: number): number | null {
  if (!(total > 0) || !Number.isFinite(part)) return null;
  return (100 * part) / total;
}

/** Keeps the unit's exact rounding rules while the headline count rolls. */
export function formatAnimatedCost(
  cost: Cost,
  unit: CostUnit,
  animated: number | null,
): string {
  if (animated == null) return formatCost(cost, unit);
  if (unit === "tokens") {
    return `${cost.unmeasured ? "≥ " : ""}${Math.round(animated).toLocaleString("en-US")}`;
  }
  return formatCost(
    unit === "credits" ? { ...cost, credits: animated } : { ...cost, usd: animated },
    unit,
  );
}

export function LedgerStrip({
  overview,
  unit,
  onOpenSessions,
}: Props) {
  const cache = cacheHitRatio(overview.cost);
  const moneyUnit = unit === "tokens" && overview.cost.credits == null && overview.cost.usd != null
    ? "usd" : companionMoneyUnit(unit);

  const animatedMoney = useAnimatedNumber(costValue(overview.cost, moneyUnit));
  const animatedSessions = useAnimatedNumber(overview.sessionCount);
  const animatedTurns = useAnimatedNumber(overview.turnCount);
  const animatedCache = useAnimatedNumber(cache == null ? null : 100 * cache);
  const animatedUnpriced = useAnimatedNumber(overview.unpricedRaw);
  const animatedWaste = useAnimatedNumber(costValue(overview.waste, unit));
  const cacheFlash = useFlashOnChange(cache);
  const unpricedFlash = useFlashOnChange(overview.unpricedRaw);
  const wasteFlash = useFlashOnChange(overview.waste.raw);

  return (
    <Panel role="region" className={`ledger overview-metrics${unit === "tokens" ? "" : " compact"}`} data-testid="ledger-strip" aria-label="当前统计范围概览">
      {unit === "tokens" && (
        <div className="ledger-item">
          <span className="ledger-label">预估费用（{moneyUnit}）</span>
          <span
            className="ledger-value"
            title={formatCostTitle(overview.cost, moneyUnit)}
          >
            {formatAnimatedCost(overview.cost, moneyUnit, animatedMoney)}
            <span className="ledger-unit"> {formatUnitSuffix(moneyUnit)}</span>
          </span>
          <span className="ledger-delta">
            价格表推算，不代表厂商账单
          </span>
        </div>
      )}
      <BareButton
        type="button"
        className="ledger-item ledger-action"
        onClick={onOpenSessions}
      >
        <span className="ledger-label">已分析会话 / 请求轮次</span>
        <span className="ledger-value">
          {Math.round(animatedSessions ?? 0).toLocaleString()}
          <span className="ledger-unit">
            {" / "}
            {Math.round(animatedTurns ?? 0).toLocaleString()}
          </span>
        </span>
        <span className="ledger-delta">
          {overview.live ? "有实时会话" : "静态账本"} ·{" "}
          {overview.collecting ? "采集中" : "未开启采集"}
        </span>
      </BareButton>
      <div className="ledger-item">
        <span className="ledger-label">缓存命中</span>
        <span className={`ledger-value${cacheFlash ? " value-flash" : ""}`}>
          {animatedCache == null ? "—" : formatPercent(animatedCache)}
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
          className={`ledger-value ${overview.unpricedRaw > 0 ? "warn" : ""}${unpricedFlash ? " value-flash" : ""}`}
        >
          {overview.cost.raw === 0 && overview.cost.unmeasured ? "—" : formatCompactTokens(Math.round(animatedUnpriced ?? 0))}
        </span>
        <span className="ledger-delta">
          {overview.unpricedRaw > 0
            ? "这些 Token 已用量，未计入费用"
            : overview.cost.raw > 0 ? "已记录用量已计价" : "无可计算用量"}
        </span>
      </div>
      <div className="ledger-item">
        <span className="ledger-label">疑似可优化</span>
        <span className={`ledger-value${wasteFlash ? " value-flash" : ""}`} title={formatCostTitle(overview.waste, unit)}>
          {formatAnimatedCost(overview.waste, unit, animatedWaste)}
        </span>
        <span className="ledger-delta">
          {share(overview.waste.raw, overview.cost.raw) == null
            ? "该范围没有用量"
            : `占 token 用量 ${formatPercent(share(overview.waste.raw, overview.cost.raw)!)}`}
        </span>
      </div>
    </Panel>
  );
}
