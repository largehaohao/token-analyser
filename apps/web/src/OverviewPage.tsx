import type { Overview } from "./api";
import {
  companionMoneyUnit,
  disclaimer,
  formatCompactTokens,
  formatCost,
  formatCostTokens,
  formatCostTitle,
  formatExactTokens,
  formatPercent,
  formatUnitSuffix,
  tokenIdentity,
  unpricedNote,
  usageNote,
  wasteShare,
} from "./format";
import { useUnit } from "./UnitContext";
import { DetailSection } from "./DetailSection";
import { Button, Icon, Notice } from "./ui";
import {
  BehaviorRankPanel,
  CompositionPanel,
  ModelPanel,
  PerformancePanel,
  RateLimitSummary,
} from "./OverviewPanels";
import { LedgerStrip } from "./LedgerStrip";
import { TrendPanel } from "./TrendPanel";

type Props = {
  overview: Overview;
  /** Equal-length window right before the current one, for the ledger strip. */
  previous: Overview | null;
  previousLabel: string | null;
  onOpenSessions: () => void;
  onUpdateModelPrices: () => void;
  updatingModelPrices: boolean;
  pricingUpdateNotice: {
    tone: "info" | "warning" | "error" | "success";
    message: string;
  } | null;
  rangeLabel: string;
  refreshError?: boolean;
  onRetry: () => void;
  onInspectSlice: (key: string, label: string) => void;
  /** Changes when range/source/now window changes so panel model filters re-query. */
  filterScope: string;
  fetchOverviewForModel: (model: string) => Promise<Overview>;
};

export function OverviewPage({
  overview,
  previous,
  previousLabel,
  onOpenSessions,
  onUpdateModelPrices,
  updatingModelPrices,
  pricingUpdateNotice,
  rangeLabel,
  refreshError,
  onRetry,
  onInspectSlice,
  filterScope,
  fetchOverviewForModel,
}: Props) {
  const { unit, setUnit } = useUnit();
  const wastePct = wasteShare(overview.waste, overview.cost, unit);
  const unpriced = unpricedNote(overview.unpricedRaw ?? 0);
  const identity = tokenIdentity(overview.cost);
  const models = overview.models ?? [];
  const quality = overview.quality ?? {
    pricedRaw: Math.max(0, overview.cost.raw - (overview.unpricedRaw ?? 0)),
    unpricedRaw: overview.unpricedRaw ?? 0,
    ledgerWarningSessions: 0,
    parseErrors: 0,
  };
  const pricedCoverage =
    overview.cost.raw > 0
      ? formatPercent((100 * quality.pricedRaw) / overview.cost.raw)
      : "100.0%";
  const issueCount = quality.ledgerWarningSessions + quality.parseErrors;
  const money = companionMoneyUnit(unit);

  return (
    <main className="overview" data-testid="overview-page">
      <header className="page-heading">
        <div className="page-heading-copy">
          <div className="heading-title-row">
            <h1 tabIndex={-1}>成本总览</h1>
            <span className="page-range">
              <Icon name="clock" />
              {rangeLabel}
            </span>
          </div>
          <p>从总量到每轮调用，看清用量花在哪里。</p>
        </div>
        <div className="page-heading-actions">
          <Button onClick={onUpdateModelPrices} busy={updatingModelPrices}>
            <Icon name="refresh" />
            更新模型价格
          </Button>
          <Button emphasis="solid" intent="brand" onClick={onOpenSessions}>
            查看会话 <Icon name="arrow" />
          </Button>
        </div>
      </header>

      {pricingUpdateNotice && (
        <div className="app-notice">
          <Notice tone={pricingUpdateNotice.tone}>{pricingUpdateNotice.message}</Notice>
        </div>
      )}
      {refreshError && (
        <div className="list-error">
          <p role="alert">总览更新失败，当前显示上次成功读取的数据。</p>
          <Button onClick={onRetry}>重试</Button>
        </div>
      )}

      {overview.cost.unmeasured ? (
        <p className="data-notice" role="status">
          {usageNote(overview.cost)}
        </p>
      ) : null}
      {(unpriced || issueCount > 0 || !identity.ok) && (
        <p className="data-notice" role="status">
          {[
            unpriced,
            issueCount > 0 ? `${issueCount} 项账本或解析异常` : "",
            !identity.ok ? "Token 构成与总量不一致" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          。可展开「数据质量与统计口径」核对。
        </p>
      )}

      <LedgerStrip
        overview={overview}
        previous={previous}
        previousLabel={previousLabel}
        unit={unit}
        onOpenSessions={onOpenSessions}
      />

      {overview.sessionCount === 0 && (
        <div className="empty-overview">
          <div>
            <strong>该时间范围内没有会话</strong>
            <p>切换时间范围，或导入已有的会话记录。</p>
          </div>
          <Button onClick={onOpenSessions}>
            <Icon name="upload" />
            前往会话导入
          </Button>
        </div>
      )}

      <div className="panel-grid">
        <TrendPanel
          overview={overview}
          chartMetric={unit}
          onChartMetric={setUnit}
          filterScope={filterScope}
          fetchOverviewForModel={fetchOverviewForModel}
        />
        <CompositionPanel overview={overview} />
      </div>

      <div className="panel-grid">
        <PerformancePanel
          overview={overview}
          filterScope={filterScope}
          fetchOverviewForModel={fetchOverviewForModel}
        />
        <BehaviorRankPanel
          overview={overview}
          unit={unit}
          onInspectSlice={onInspectSlice}
        />
      </div>

      <div className="detail-stack">
        <DetailSection
          title="模型用量"
          description={`${models.length} 个模型 · 各模型 Token、轮次与费用`}
        >
          <ModelPanel overview={overview} unit={unit} />
        </DetailSection>
        {overview.rateLimits && (
          <DetailSection
            title="速率限制（来源记录）"
            description="来源本地状态里最近一次配额快照，不从用量推算"
          >
            <RateLimitSummary rateLimits={overview.rateLimits} />
          </DetailSection>
        )}
        <DetailSection
          title="数据质量与统计口径"
          description={`定价覆盖 ${pricedCoverage} · ${
            issueCount > 0 ? `${issueCount} 项异常需核对` : "账本校验通过"
          }`}
        >
          {overview.fastMultiplier != null && (
            <p className="pricing-mode-note">
              Codex 按每轮模式计价：Standard / Fast ×{overview.fastMultiplier}
              （购入 credits）。其他来源使用 USD；无遥测的调用显示用量未记录。
            </p>
          )}
          <div className="quality-strip" role="group" aria-label="数据质量">
            <div
              className={
                quality.unpricedRaw > 0
                  ? "quality-item warn"
                  : "quality-item good"
              }
            >
              <span>定价覆盖</span>
              <strong>{pricedCoverage}</strong>
              <small>
                {quality.unpricedRaw > 0
                  ? `${formatExactTokens(quality.unpricedRaw)} tokens 未定价`
                  : overview.cost.unmeasured
                    ? "已记录用量已计价；另有调用用量缺失"
                    : "已记录用量已计价"}
              </small>
            </div>
            <div
              className={
                issueCount > 0 ? "quality-item warn" : "quality-item good"
              }
            >
              <span>账本健康</span>
              <strong>
                {issueCount === 0 ? "通过" : `${issueCount} 项异常`}
              </strong>
              <small>
                {issueCount === 0
                  ? "累计值与逐轮增量一致"
                  : `${quality.ledgerWarningSessions} 个账本警告 · ${quality.parseErrors} 个解析错误`}
              </small>
            </div>
            <div className="quality-item neutral">
              <span>趋势口径</span>
              <strong>
                {Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区"}
              </strong>
              <small>按每轮结束时刻归入本地日期</small>
            </div>
          </div>
          <p className="chart-desc">
            跨日会话按每轮结束时间拆分；窗口外用量记在「更早 /
            之后」。趋势不是逐 token 实时扣费。
          </p>
          <p className="source-path">采集目录：{overview.watchPath}</p>
          {overview.unpricedRaw > 0 && (
            <p className="source-path">
              未定价用量 {formatCompactTokens(overview.unpricedRaw)} tokens ·
              费用口径仅统计已定价部分
            </p>
          )}
          <p className="source-path">
            费用口径：{formatCostTitle(overview.cost, unit)}（{unit}）
            {overview.cost.credits != null && overview.cost.usd != null
              ? ` · credits ${formatCost(overview.cost, "credits")} · USD ${formatCost(
                  overview.cost,
                  "usd",
                )}`
              : ""}
            {unit === "tokens" && overview.cost.raw > 0
              ? ` · 疑似可优化 ${formatCostTokens(overview.waste)} tokens（${wastePct}）`
              : money != null && overview.waste.raw > 0
                ? ` · 疑似可优化 ${formatCost(overview.waste, money)} ${formatUnitSuffix(money)}`
                : ""}
          </p>
        </DetailSection>
      </div>

      <p className="disclaimer">
        {disclaimer(overview.rateCardAsOf, overview.apiPricesAsOf)}
      </p>
    </main>
  );
}
