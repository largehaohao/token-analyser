import type { Overview } from "./api";
import {
  cacheHitRatio,
  disclaimer,
  formatCompactTokens,
  formatCost,
  formatCostTitle,
  formatExactTokens,
  formatPercent,
  formatUnitSuffix,
  companionMoneyUnit,
  tokenIdentity,
  unpricedNote,
  wasteShare,
} from "./format";
import { MixBar } from "./MixBar";
import { DonutChart, ModelMix, TrendChart } from "./OverviewCharts";
import { useUnit } from "./UnitContext";
import { DetailSection } from "./DetailSection";
import { Button, Icon, Notice } from "./ui";

type Props = {
  overview: Overview;
  onOpenSessions: () => void;
  rangeLabel: string;
  refreshError?: boolean;
  onRetry: () => void;
};

function IconDiamond() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path fill="var(--accent)" d="M7 1.2 12.8 7 7 12.8 1.2 7Z" />
    </svg>
  );
}

function IconHash() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.4"
        d="M5 2v10M9 2v10M2 5h10M2 9h10"
      />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path fill="var(--warn)" d="M8.2 1 3 8h3.2L5.8 13 12 6H8.6L8.2 1Z" />
    </svg>
  );
}

function IconDoc() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.3"
        d="M4 2.2h4.2L11 5v6.8H4z"
      />
      <path
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.3"
        d="M8.2 2.2V5H11"
      />
    </svg>
  );
}

export function OverviewPage({
  overview,
  onOpenSessions,
  rangeLabel,
  refreshError,
  onRetry,
}: Props) {
  const { unit } = useUnit();
  const hit = cacheHitRatio(overview.cost);
  const wastePct = wasteShare(overview.waste, overview.cost, unit);
  const moneyUnit = companionMoneyUnit(unit);
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
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";

  return (
    <main className="overview" data-testid="overview-page">
      <header className="page-heading">
        <div className="page-heading-copy">
          <span className="page-eyebrow">本地账本 · 总览</span>
          <h1 tabIndex={-1}>成本总览</h1>
          <p>从总量到每轮调用，看清用量花在哪里。</p>
        </div>
        <span className="page-range">
          <Icon name="clock" />
          {rangeLabel}
        </span>
      </header>
      {refreshError && (
        <Notice tone="error" action={<Button onClick={onRetry}>重试</Button>}>
          总览更新失败，当前显示上次成功读取的数据。
        </Notice>
      )}
      <div className="kpi-grid">
        <article className="kpi-card">
          <div className="kpi-label">
            <IconDiamond /> {unit === "tokens" ? "总用量" : "预估总费用"}
          </div>
          <div
            className="kpi-value"
            title={formatCostTitle(overview.cost, unit)}
          >
            {unit === "tokens"
              ? formatCompactTokens(overview.cost.raw)
              : formatCost(overview.cost, unit)}{" "}
            <small>{formatUnitSuffix(unit)}</small>
          </div>
          <div className="kpi-sub">
            {hit != null
              ? `缓存命中 ${formatPercent(100 * hit)}`
              : "当前时间范围内的累计消耗"}
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
            {unit === "tokens" && <small> {formatUnitSuffix(moneyUnit)}</small>}
          </div>
          <div className="kpi-sub">
            {unit === "tokens"
              ? "按本地费率估算"
              : `${overview.turnCount.toLocaleString("en-US")} 次模型调用`}
          </div>
        </article>
        <article className="kpi-card warn">
          <div className="kpi-label">
            <IconBolt />{" "}
            {unit === "tokens" ? "疑似可优化用量" : "疑似可优化费用"}
          </div>
          <div
            className="kpi-value"
            title={formatCostTitle(overview.waste, unit)}
          >
            {unit === "tokens"
              ? formatCompactTokens(overview.waste.raw)
              : formatCost(overview.waste, unit)}{" "}
            <small>{formatUnitSuffix(unit)}</small>
          </div>
          <div className="kpi-sub">
            {wastePct === "—"
              ? "部分用量未定价，无法按费用比"
              : `占总${unit === "tokens" ? "用量" : "费用"} ${wastePct} · 按会话规则`}
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
          <div className="kpi-sub kpi-session-meta">
            <span>{overview.turnCount.toLocaleString("en-US")} 次调用</span>
            <span className="kpi-session-action">查看明细 →</span>
          </div>
        </button>
      </div>

      <p className="disclaimer">{disclaimer(overview.rateCardAsOf)}</p>
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

      {overview.sessionCount === 0 && (
        <div className="empty-overview">
          <div>
            <strong>该时间范围内没有会话</strong>
            <p>切换时间范围，或导入已有的 Codex 记录。</p>
          </div>
          <Button onClick={onOpenSessions}>
            <Icon name="upload" />
            前往会话导入
          </Button>
        </div>
      )}

      <TrendChart days={overview.days} rangeLabel={rangeLabel} />

      <div className="detail-stack">
        <DetailSection
          title="Token 构成与行为分类"
          description="查看输入、缓存、输出，以及各类行为的用量占比"
        >
          <section className="chart-card token-mix-card">
            <div className="chart-head">
              <div>
                <h2 className="chart-title">Token 构成</h2>
                <p className="chart-desc">
                  未缓存输入 / 缓存命中 / 输出。input 已含 cached，不再把
                  reasoning 加进总量。
                </p>
              </div>
              {hit != null && (
                <span className="cache-pill">
                  缓存命中 {formatPercent(100 * hit)}
                </span>
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
                {identity.ok
                  ? " = raw"
                  : ` ≠ raw ${formatExactTokens(overview.cost.raw)}`}
              </span>
            </div>
          </section>

          <DonutChart slices={overview.slices} totalRaw={overview.cost.raw} />
        </DetailSection>
        <DetailSection
          title="模型用量"
          description={`${models.length} 个模型 · 查看各模型的消耗与调用次数`}
        >
          {models.length > 0 ? (
            <ModelMix models={models} />
          ) : (
            <p className="empty-copy">暂无模型用量。</p>
          )}
        </DetailSection>
        <DetailSection
          title="数据质量与统计口径"
          description={`定价覆盖 ${pricedCoverage} · ${issueCount > 0 ? `${issueCount} 项异常需核对` : "账本校验通过"}`}
        >
          <div className="quality-strip" aria-label="数据质量">
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
                  : "所有模型均已匹配费率"}
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
              <strong>{timezone}</strong>
              <small>按每轮结束时刻归入本地日期</small>
            </div>
          </div>
          <p className="chart-desc">
            跨日会话按每轮结束时间拆分；窗口外用量记在「更早 /
            之后」。趋势不是逐 token 实时扣费。
          </p>
          <p className="source-path">采集目录：{overview.watchPath}</p>
        </DetailSection>
      </div>
    </main>
  );
}
