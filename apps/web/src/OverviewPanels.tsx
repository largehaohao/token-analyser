import { useState } from "react";
import type { Cost, Overview, OverviewRateLimits } from "./api";
import { SLICE_META, type SliceKey } from "./buckets";
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
import { arrayHistogram, TPS_LABELS, TPS_TICKS, TTFT_LABELS, TTFT_TICKS } from "./perf-buckets";
import { HistogramPair } from "./Histogram";
import { sourceLabel } from "./format";
import { useModelFilteredOverview } from "./useModelFilteredOverview";
import { BareButton, Panel, StatePanel, srTable } from "./ui";
import { Button } from "./components/ui/button";
import { LegacyBadge as Badge } from "@/components/ui/legacy-badge";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { donutArc, donutSegments } from "./visual-metrics";


function InspectButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <BareButton
      type="button"
      className="inspect"
      onClick={onClick}
      title={`查看「${label}」相关会话`}
    >
      查看会话 ›
    </BareButton>
  );
}

/**
 * Where the tokens in the window came from. Cache is a sub-line of input, so the
 * main rows' percentages describe the whole window and never double-count.
 */
export function CompositionPanel({
  overview,
  focusedSlice,
}: {
  overview: Overview;
  focusedSlice: string | null;
}) {
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
      fill: "var(--color-input)",
      sub: `已缓存 ${formatCompactTokens(cost.cached_input)}${
        hit == null ? "" : `（${formatPercent(100 * hit)}）`
      }`,
      subWidth: input > 0 ? (100 * cost.cached_input) / input : 0,
      subFill: "var(--color-cache)",
    },
    {
      key: "output",
      label: "输出 Token",
      value: cost.output,
      fill: "var(--color-output)",
      sub: "生成与思考输出",
      subWidth: 0,
      subFill: "transparent",
    },
  ];

  const parts = [
    { key: "cached", label: "已缓存输入", value: cost.cached_input, color: "var(--color-cache)" },
    { key: "input", label: "未缓存输入", value: cost.uncached_input, color: "var(--color-input)" },
    { key: "output", label: "生成与思考输出", value: cost.output, color: "var(--color-output)" },
  ];
  const segments = donutSegments(parts);
  const donutTotal = Math.max(0, cost.raw);
  const radius = 48;
  let offset = 0;
  const [hotKey, setHotKey] = useState<string | null>(null);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const activeKey = hotKey ?? pickedKey;
  const activePart = parts.find((part) => part.key === activeKey) ?? null;
  const togglePick = (key: string) =>
    setPickedKey((current) => (current === key ? null : key));

  return (
    <Panel role="region" className="chart-card composition-panel" data-testid="composition-panel" aria-label="Token 构成">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">Token 构成</h2>
        </div>
        {hit != null && (
          <Badge variant="outline" className="cache-pill">缓存命中 {formatPercent(100 * hit)}</Badge>
        )}
      </div>
      {donutTotal > 0 && (
        <div className="donut-wrap">
          <svg
            className={`donut${activeKey != null ? " has-hot" : ""}`}
            viewBox="0 0 128 128"
            role="group"
            aria-label={`Token 构成环图：${segments.map((seg) => `${seg.label} ${formatExactTokens(seg.value)}`).join("，")}`}
          >
            <circle className="donut-track" cx="64" cy="64" r={radius} />
            <g transform="rotate(-90 64 64)">
              {segments.map((seg) => {
                const arc = donutArc(donutTotal, seg.value, radius);
                const dashOffset = -offset;
                offset += arc.dash;
                return (
                  <circle
                    key={seg.key}
                    className={`donut-seg${activeKey === seg.key ? " hot" : ""}${activeKey != null && activeKey !== seg.key ? " dim" : ""}`}
                    cx="64"
                    cy="64"
                    r={radius}
                    stroke={seg.color}
                    strokeDasharray={`${arc.dash} ${arc.gap}`}
                    strokeDashoffset={dashOffset}
                    tabIndex={0}
                    role="button"
                    aria-pressed={pickedKey === seg.key}
                    aria-label={`${seg.label} ${formatExactTokens(seg.value)} tokens，占 ${formatPercent(pct(seg.value))}，回车锁定`}
                    onMouseEnter={() => setHotKey(seg.key)}
                    onMouseLeave={() => setHotKey(null)}
                    onFocus={() => setHotKey(seg.key)}
                    onBlur={() => setHotKey(null)}
                    onClick={() => togglePick(seg.key)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        togglePick(seg.key);
                      }
                    }}
                  />
                );
              })}
            </g>
            <text className="donut-center-value" x="64" y="62">
              {formatCompactTokens(activePart ? activePart.value : donutTotal)}
            </text>
            <text className="donut-center-label" x="64" y="78">
              {activePart
                ? `${activePart.label} · ${formatPercent(pct(activePart.value))}`
                : "tokens"}
            </text>
          </svg>
          <div className="donut-legend">
            {parts.map((part) => (
              <button
                key={part.key}
                type="button"
                className={activeKey === part.key ? "hot" : ""}
                aria-pressed={pickedKey === part.key}
                onMouseEnter={() => setHotKey(part.key)}
                onMouseLeave={() => setHotKey(null)}
                onFocus={() => setHotKey(part.key)}
                onBlur={() => setHotKey(null)}
                onClick={() => togglePick(part.key)}
              >
                <i style={{ background: part.color }} />
                <span className="donut-legend-label">{part.label}</span>
                <b>{formatCompactTokens(part.value)}</b>
                <span className="donut-legend-pct num">{total > 0 ? formatPercent(pct(part.value)) : "—"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {pickedKey && (
        <p className="focus-hint" role="status">
          已锁定「{parts.find((part) => part.key === pickedKey)?.label}」的中心读数；再次点选该段或图例取消。
        </p>
      )}
      {focusedSlice && (
        <p className="focus-hint" role="status">
          {(() => {
            const slice = overview.slices.find((item) => item.key === focusedSlice);
            const label = SLICE_META[focusedSlice as keyof typeof SLICE_META]?.label ?? focusedSlice;
            const share = total > 0 && slice ? formatPercent((100 * slice.raw) / total) : null;
            return share
              ? `行为「${label}」${formatExactTokens(slice!.raw)} tokens，占总量 ${share}。环图仍是全部 Token 构成，不受该分类筛选。`
              : `行为排行正在聚焦「${label}」；当前环图显示 Token 构成，不受分类筛选影响。`;
          })()}
        </p>
      )}
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
      {unpriced > 0 && (
        <p className="chart-desc">
          其中 {formatCompactTokens(unpriced)} 未定价 Token，已包含在输入和输出中（未计入费用）。
        </p>
      )}
      {!identity.ok && (
        <div className="mix-legend">
          <span className="identity-warn">
            构成合计 {formatExactTokens(identity.parts)}（与已记录总量 {formatExactTokens(cost.raw)} 不一致）
          </span>
        </div>
      )}
      {srTable(
        "Token 构成",
        ["构成", "Token", "占比"],
        rows.map((row) => [
          row.label,
          formatExactTokens(row.value),
          total > 0 ? formatPercent(pct(row.value)) : "—",
        ]),
      )}
    </Panel>
  );
}

type RankProps = {
  overview: Overview;
  unit: CostUnit;
  onInspectSlice: (key: SliceKey) => void;
  focusedSlice: string | null;
  onFocusSlice: (key: string | null) => void;
};

/**
 * The same window ranked by behaviour bucket. A ranking list keeps small buckets
 * readable, unlike a ring chart of ten slices.
 */
export function BehaviorRankPanel({
  overview,
  unit,
  onInspectSlice,
  focusedSlice,
  onFocusSlice,
}: RankProps) {
  const rows = rankRows(overview);
  const max = Math.max(...rows.map((row) => row.raw), 1);

  return (
    <Panel role="region" className="chart-card" data-testid="behavior-rank" aria-label="行为排行">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">行为排行</h2>
          <p className="chart-subtitle">按窗口内轮次归类，点击右侧可直接下钻筛选对应会话</p>
        </div>
        <span className="rank-total-turns mono">共 {overview.turnCount.toLocaleString("en-US")} 轮</span>
      </div>
      {rows.length === 0 ? (
        <p className="empty-copy">该时间范围内没有可分类的用量。</p>
      ) : (
        <>
          <div className="rank-list">
            {rows.map((row, index) => (
              <div
                className={`rank-row${row.key === "reread" ? " is-reread" : ""}${focusedSlice === row.key ? " focused" : ""}`}
                key={row.key}
                onMouseEnter={() => onFocusSlice(row.key)}
                onMouseLeave={() => onFocusSlice(null)}
              >
                <span className="rk">{index + 1}</span>
                <span className="sw" style={{ background: row.color }} />
                <div className="rank-main">
                  <div className="rank-top">
                    <span className="rank-name">
                      {row.key === "reread" ? "重复读取（可优化）" : row.label}
                    </span>
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
                    onClick={() => {
                      onFocusSlice(row.key);
                      if (row.key !== "unattributed") onInspectSlice(row.key);
                    }}
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
    </Panel>
  );
}

/**
 * Behaviour buckets plus the volume the buckets could not explain, so the rank
 * always accounts for the whole window.
 */
type RankRow = {
  key: SliceKey | "unattributed";
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
            <TableHeader>
              <TableRow>
                <TableHead scope="col">模型</TableHead>
                <TableHead scope="col">Token 占比</TableHead>
                <TableHead scope="col" className="right">
                  Token
                </TableHead>
                <TableHead scope="col" className="right">
                  轮次
                </TableHead>
                <TableHead scope="col" className="right">
                  费用（{unit}）
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.model}>
                  <TableHead scope="row" className="mt-model">
                    {entry.model}
                    {entry.cost.unmeasured ? (
                      <small className="model-usage-note">{entry.cost.unmeasured} 次调用用量未记录</small>
                    ) : null}
                  </TableHead>
                  <TableCell>
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
                  </TableCell>
                  <TableCell className="right num" title={formatCostTitle(entry.cost, "tokens")}>
                    {formatCostTokens(entry.cost)}
                  </TableCell>
                  <TableCell className="right num">{entry.turnCount.toLocaleString()}</TableCell>
                  <TableCell className="right num" title={formatCostTitle(entry.cost, unit)}>
                    {entry.unpricedRaw > 0 && entry.cost.credits == null && entry.cost.usd == null
                      ? "未定价"
                      : formatCost(entry.cost, unit)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
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
    retry,
  } = useModelFilteredOverview(baseOverview, filterScope, fetchOverviewForModel);
  const dist = overview?.performanceDistribution;
  return (
    <Panel role="region" className="chart-card perf-card" data-testid="performance-panel" aria-label="响应性能分布">
      <div className="chart-head">
        <div>
          <h2 className="chart-title">性能表现</h2>
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
      {overview == null ? (
        <StatePanel
          compact
          kind={error ? "error" : "loading"}
          title={error ? "按模型筛选失败" : "正在加载所选模型数据"}
          description={error ?? "数据就绪后自动显示，不会展示其他模型的数字。"}
        >
          {error ? (
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              重试
            </Button>
          ) : null}
        </StatePanel>
      ) : (
        <>
          <PerformanceMetrics performance={overview.performance} />
          {dist ? (
            <HistogramPair
              ttft={arrayHistogram(TTFT_LABELS, dist.ttft, "s", dist.sampleCount ?? overview.performance?.taskCount ?? overview.turnCount, TTFT_TICKS)}
              speed={arrayHistogram(TPS_LABELS, dist.tps, " tok/s", dist.sampleCount ?? overview.performance?.taskCount ?? overview.turnCount, TPS_TICKS)}
            />
          ) : (
            <p className="chart-desc">
              耗时直方图需要引擎开启请求性能统计
              <code> TOKEN_ANALYSER_ENABLE_REQUEST_PERFORMANCE=1</code>。
            </p>
          )}
        </>
      )}
    </Panel>
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
