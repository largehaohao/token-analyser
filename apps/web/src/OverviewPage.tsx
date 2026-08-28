import type { Overview } from "./api";
import {
  formatCompactTokens,
  formatCreditsLabel,
  wasteShare,
} from "./format";
import { DonutChart, TrendChart } from "./OverviewCharts";

type Props = {
  overview: Overview;
  onOpenSessions: () => void;
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

export function OverviewPage({ overview, onOpenSessions }: Props) {
  const wastePct = wasteShare(overview.waste, overview.cost);
  const wasteOfKnown =
    overview.cost.credits && overview.cost.credits > 0
      ? `${((100 * (overview.waste.credits ?? 0)) / overview.cost.credits).toFixed(0)}%`
      : wastePct;

  return (
    <div className="overview" data-testid="overview-page">
      <div className="kpi-grid">
        <article className="kpi-card">
          <div className="kpi-label">
            <IconDiamond /> 预估总费用
          </div>
          <div className="kpi-value">
            {formatCreditsLabel(overview.cost.credits)}{" "}
            <small>credits</small>
          </div>
          <div className="kpi-sub">已知小计 · 仍有缺口</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">
            <IconHash /> 总 Token 用量
          </div>
          <div className="kpi-value">
            {formatCompactTokens(overview.cost.raw)}
          </div>
          <div className="kpi-sub">
            {overview.turnCount.toLocaleString("en-US")} 个可辨识模型调用
          </div>
        </article>
        <article className="kpi-card warn">
          <div className="kpi-label">
            <IconBolt /> 疑似可优化费用
          </div>
          <div className="kpi-value">
            {formatCreditsLabel(overview.waste.credits)}{" "}
            <small>credits</small>
          </div>
          <div className="kpi-sub">{wasteOfKnown} 的已知费用值得检查</div>
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
          <div className="kpi-sub">
            部分数据 · 实时目录 · {overview.watchPath}
          </div>
        </button>
      </div>

      <div className="charts-grid">
        <TrendChart days={overview.days} />
        <DonutChart slices={overview.slices} totalRaw={overview.cost.raw} />
      </div>
    </div>
  );
}
