import type { Cost, Overview, OverviewRateLimits } from "./api";
import { SLICE_META } from "./buckets";
import {
  allocatePercents,
  cacheHitRatio,
  formatCompactTokens,
  formatCostTokens,
  formatCost,
  formatExactTokens,
  formatPercent,
  formatCostTitle,
  formatUnitSuffix,
  tokenIdentity,
  type CostUnit,
} from "./format";
import { ModelFilterSelect } from "./ModelFilterSelect";
import { PerformanceMetrics } from "./PerformanceMetrics";
import { RateLimits } from "./RateLimits";
import { arrayHistogram, TPS_LABELS, TTFT_LABELS } from "./perf-buckets";
import { HistogramPair } from "./Histogram";
import { sourceLabel } from "./format";
import { useModelFilteredOverview } from "./useModelFilteredOverview";
import { srTable } from "./ui";

function InspectButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="inspect"
      onClick={onClick}
      title={`查看「${label}」相关会话`}
    >
      查看会话 ›
    </button>
  );
}

/**
 * Where the tokens in the window came from. Cache is a sub-line of input, so the
 * main rows' percentages describe the whole window and never double-count.
 */
export function CompositionPanel({ overview }: { overview: Overview }) {
  const cost = overview.cost;
  const unpriced = overview.unpricedRaw ?? 0;
  const input = cost.uncached_input + cost.cached_input;
  const total = cost.raw;
  const pct = (value: number) => (total > 0 ? (100 * value) / total : 0);
  const hit = cacheHitRatio(cost);
  const identity = tokenIdentity(cost);
  const rows = [
    {
      key: "input",
      label: "输入 Token",
      value: input,
      fill: "var(--chart-blue)",
      sub: `其中 ${formatExactTokens(cost.cached_input)} 已缓存${
        hit == null ? "" : `（占输入 ${formatPercent(100 * hit)}）`
      }`,
      subWidth: input > 0 ? (100 * cost.cached_input) / input : 0,
      subFill: "var(--chart-cyan)",
    },
    {
      key: "output",
      label: "输出 Token",
      value: cost.output,
      fill: "var(--accent)",
      sub: "模型生成与思考输出，单价高于输入",
      subWidth: 0,
      subFill: "transparent",
    },
  ];

  return (
    <section className="chart-card" data-testid="composition-panel" aria-label="Token 构成">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">Token 构成</h2>
          <p className="chart-desc">
            输入含已缓存部分；输入与输出合计为已记录 Token 总量。
          </p>
        </div>
        {hit != null && (
          <span className="cache-pill">缓存命中 {formatPercent(100 * hit)}</span>
        )}
      </div>
      <div className="comp-rows">
        {rows.map((row) => (
          <div className="comp-row" key={row.key}>
            <span className="sw" style={{ background: row.fill }} />
            <div className="comp-main">
              <div className="comp-top">
                <span className="comp-name">{row.label}</span>
                <span
                  className="comp-val num"
                  title={`${row.label}：${formatExactTokens(row.value)} tokens`}
                >
                  {formatCompactTokens(row.value)}
                </span>
              </div>
              <div className="comp-bar">
                <i
                  style={{
                    width: `${Math.min(100, pct(row.value))}%`,
                    background: row.fill,
                  }}
                />
                {row.subWidth > 0 && (
                  <i
                    className="sub"
                    style={{ width: `${row.subWidth}%`, background: row.subFill }}
                  />
                )}
              </div>
              <div className="comp-sub">{row.sub}</div>
            </div>
            <span className="comp-pct num">
              {total > 0 ? formatPercent(pct(row.value)) : "—"}
            </span>
          </div>
        ))}
      </div>
      <p className="chart-desc">
        其中 {formatExactTokens(unpriced)} 未定价 Token 已包含在输入和输出中，未计入费用。
      </p>
      <div className="mix-legend">
        <span className={identity.ok ? "identity-ok" : "identity-warn"}>
          构成合计 {formatExactTokens(identity.parts)}
          {identity.ok
            ? " = raw"
            : ` ≠ raw ${formatExactTokens(cost.raw)}`}
        </span>
      </div>
      {srTable(
        "Token 构成",
        ["构成", "Token", "占比"],
        rows.map((row) => [
          row.label,
          formatExactTokens(row.value),
          total > 0 ? formatPercent(pct(row.value)) : "—",
        ]),
      )}
    </section>
  );
}

type RankProps = {
  overview: Overview;
  unit: CostUnit;
  onInspectSlice: (key: string, label: string) => void;
};

/**
 * The same window ranked by behaviour bucket. A ranking list keeps small buckets
 * readable, unlike a ring chart of ten slices.
 */
export function BehaviorRankPanel({
  overview,
  unit,
  onInspectSlice,
}: RankProps) {
  const rows = rankRows(overview);
  const max = Math.max(...rows.map((row) => row.raw), 1);

  return (
    <section className="chart-card" data-testid="behavior-rank" aria-label="行为排行">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">行为排行</h2>
          <p className="chart-desc">
            按行为分类的 Token 排行，含未归因用量；点击查看该分类的会话。
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="empty-copy">该时间范围内没有可分类的用量。</p>
      ) : (
        <>
          <div className="rank-list">
            {rows.map((row, index) => (
              <div className="rank-row" key={row.key}>
                <span className="rk">{index + 1}</span>
                <span className="sw" style={{ background: row.color }} />
                <div className="rank-main">
                  <div className="rank-top">
                    <span className="rank-name">{row.label}</span>
                    <span
                      className="rank-val num"
                      title={`${row.label}：${formatExactTokens(row.raw)} tokens · ${formatCost(
                        row.cost,
                        unit,
                      )} ${formatUnitSuffix(unit)}`}
                    >
                      {formatCompactTokens(row.raw)}
                    </span>
                  </div>
                  <div className="rank-bar">
                    <i
                      style={{
                        width: `${(100 * row.raw) / max}%`,
                        background: row.color,
                      }}
                    />
                  </div>
                </div>
                <span className="rank-pct num">
                  {formatPercent(row.percent)}
                </span>
                {row.key !== "unattributed" && (
                  <InspectButton
                    label={row.label}
                    onClick={() => onInspectSlice(row.key, row.label)}
                  />
                )}
              </div>
            ))}
          </div>
          {srTable(
            "行为排行",
            ["行为分类", "Token", "占比", `费用（${unit}）`],
            rows.map((row) => [
              row.label,
              formatExactTokens(row.raw),
              formatPercent(row.percent),
              formatCost(row.cost, unit),
            ]),
          )}
        </>
      )}
    </section>
  );
}

/**
 * Behaviour buckets plus the volume the buckets could not explain, so the rank
 * always accounts for the whole window.
 */
type RankRow = {
  key: string;
  raw: number;
  cost: Cost;
  label: string;
  color: string;
};

/** A bucket total with no input/output split; only its money value is shown. */
function bucketCost(raw: number, credits: number | null, usd: number | null): Cost {
  return {
    raw,
    uncached_input: 0,
    cached_input: 0,
    output: 0,
    credits,
    usd,
  };
}

function rankRows(overview: Overview) {
  const sliceSum = overview.slices.reduce((sum, slice) => sum + slice.raw, 0);
  const unexplained = Math.max(0, overview.cost.raw - sliceSum);
  const rows: RankRow[] = overview.slices.map((slice) => {
    const meta = SLICE_META[slice.key];
    return {
      key: slice.key,
      raw: slice.raw,
      cost: bucketCost(slice.raw, slice.credits, slice.usd),
      label: meta.label,
      color: meta.color,
    };
  });
  if (unexplained > 0) {
    rows.push({
      key: "unattributed",
      raw: unexplained,
      cost: bucketCost(unexplained, null, null),
      label: "未归因",
      color: "var(--chart-neutral)",
    });
  }
  const percents = allocatePercents(rows.map((row) => row.raw));
  return rows
    .map((row, index) => ({ ...row, percent: percents[index] }))
    .filter((row) => row.raw > 0)
    .sort((a, b) => b.raw - a.raw);
}

export function ModelPanel({
  overview,
  unit,
}: {
  overview: Overview;
  unit: CostUnit;
}) {
  const entries = [...(overview.models ?? [])].sort(
    (a, b) => b.cost.raw - a.cost.raw,
  );
  const max = Math.max(...entries.map((entry) => entry.cost.raw), 1);
  return (
    <div className="model-table" data-testid="model-table">
      {entries.length === 0 ? (
        <p className="empty-copy">该时间范围内没有模型用量。</p>
      ) : (
        <div className="model-table-scroll" role="region" aria-label="模型用量表，可横向滚动" tabIndex={0}>
          <table className="mt">
            <thead>
              <tr>
                <th scope="col">模型</th>
                <th scope="col">Token 占比</th>
                <th scope="col" className="right">
                  Token
                </th>
                <th scope="col" className="right">
                  轮次
                </th>
                <th scope="col" className="right">
                  费用（{unit}）
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.model}>
                  <th scope="row" className="mt-model">
                    {entry.model}
                    {entry.cost.unmeasured ? (
                      <small className="model-usage-note">{entry.cost.unmeasured} 次调用用量未记录</small>
                    ) : null}
                  </th>
                  <td>
                    <div
                      className="mt-bar"
                      title={formatCostTitle(entry.cost, "tokens")}
                    >
                      <i
                        style={{
                          width: `${(100 * entry.cost.raw) / max}%`,
                          background:
                            entry.unpricedRaw > 0
                              ? "var(--chart-orange)"
                              : "var(--chart-violet)",
                        }}
                      />
                    </div>
                  </td>
                  <td className="right num" title={formatCostTitle(entry.cost, "tokens")}>
                    {formatCostTokens(entry.cost)}
                  </td>
                  <td className="right num">{entry.turnCount.toLocaleString()}</td>
                  <td className="right num" title={formatCostTitle(entry.cost, unit)}>
                    {entry.unpricedRaw > 0 && entry.cost.credits == null && entry.cost.usd == null
                      ? "未定价"
                      : formatCost(entry.cost, unit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="models-legend">
        <span>
          <i style={{ background: "var(--chart-violet)" }} /> 已定价
        </span>
        <span>
          <i style={{ background: "var(--chart-orange)" }} /> 含未定价用量
        </span>
      </div>
    </div>
  );
}

/**
 * Latency and output speed. The averages come from the source records; the
 * histograms use fixed buckets so any two windows can be compared on one scale.
 */
export function PerformancePanel({
  overview: baseOverview,
  filterScope,
  fetchOverviewForModel,
}: {
  overview: Overview;
  filterScope: string;
  fetchOverviewForModel: (model: string) => Promise<Overview>;
}) {
  const {
    model,
    setModel,
    overview,
    loading,
    error,
  } = useModelFilteredOverview(baseOverview, filterScope, fetchOverviewForModel);
  const dist = overview.performanceDistribution;
  return (
    <section className="chart-card perf-card" data-testid="performance-panel" aria-label="响应性能分布">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">性能表现</h2>
          <p className="chart-desc">
            首 token 延迟与输出速度，来自来源记录的完整请求样本。
          </p>
        </div>
        <div className="chart-head-controls">
          <ModelFilterSelect
            id="performance-model-filter"
            models={baseOverview.models}
            value={model}
            onChange={setModel}
            disabled={loading}
          />
        </div>
      </div>
      {error ? (
        <p className="empty-inline" role="alert">
          按模型筛选失败：{error}
        </p>
      ) : null}
      <PerformanceMetrics performance={overview.performance} />
      {dist ? (
        <HistogramPair
          ttft={arrayHistogram(TTFT_LABELS, dist.ttft, "s", dist.sampleCount ?? overview.performance?.taskCount ?? overview.turnCount)}
          speed={arrayHistogram(TPS_LABELS, dist.tps, " tok/s", dist.sampleCount ?? overview.performance?.taskCount ?? overview.turnCount)}
        />
      ) : (
        <p className="chart-desc">
          耗时直方图需要引擎开启请求性能统计
          <code> TOKEN_ANALYSER_ENABLE_REQUEST_PERFORMANCE=1</code>。
        </p>
      )}
    </section>
  );
}

/**
 * The newest quota snapshot a source recorded inside the window. It is a source
 * measurement, never derived from token volume.
 */
export function RateLimitSummary({
  rateLimits,
}: {
  rateLimits: OverviewRateLimits;
}) {
  return (
    <div className="rate-limit-summary">
      <p className="chart-desc">
        {sourceLabel(rateLimits.source)} 会话 {rateLimits.sessionId.slice(0, 8)}
        ，快照时间 {rateLimits.capturedAt ?? "未记录"}。数值来自来源本地状态，
        不从 Token 用量推算。
      </p>
      <RateLimits raw={rateLimits.raw} />
    </div>
  );
}
