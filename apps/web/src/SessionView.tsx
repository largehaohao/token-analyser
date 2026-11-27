import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot, TaskTiming, Turn } from "./api";
import { useUnit } from "./UnitContext";
import {
  cacheHitRatio,
  formatCompactTokens,
  formatCostTokens,
  formatExactTokens,
  formatPerformanceDuration,
  formatPerformanceNumber,
  sourceLabel,
  usageNote,
  formatCost,
  formatCostTitle,
  formatPercent,
  formatUnitSuffix,
  tokenIdentity,
  unpricedNote,
  unpricedRawFromTurns,
  wasteShare,
} from "./format";
import { ContextProfileCard } from "./ContextProfile";
import {
  CostTree,
  collectTurnIds,
  resolveSelectedNode,
  suggestionTarget,
} from "./CostTree";
import { MixBar } from "./MixBar";
import { ContextMeter } from "./ContextMeter";
import { RateLimits } from "./RateLimits";
import { WasteToggles } from "./WasteToggles";
import { TurnTable } from "./TurnTable";
import { treeAppearance } from "./buckets";
import { DetailSection } from "./DetailSection";
import { PerformanceMetrics, resolvePerformance } from "./PerformanceMetrics";
import { performanceCopy } from "./performance-copy";
import { formatAnimatedCost } from "./LedgerStrip";
import { useAnimatedNumber, useFlashOnChange } from "./motion";
import { LegacyBadge as Badge } from "@/components/ui/legacy-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sourceColor } from "./session-source";
import { Icon, Panel } from "./ui";

type Props = {
  snapshot: SessionSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onUpdate: (snap: SessionSnapshot) => void;
  onNotify?: (message: string) => void;
  contextOpen: "tools" | "skills" | null;
  onContextOpen: (id: "tools" | "skills" | null) => void;
};

function flattenTurns(snap: SessionSnapshot): Turn[] {
  return [...snap.turns, ...(snap.children ?? []).flatMap(flattenTurns)];
}

/** 会话与其子代理记录的任务窗口；与 flattenTurns 同口径。 */
function flattenTaskTimings(snap: SessionSnapshot): TaskTiming[] {
  return [
    ...(snap.taskTimings ?? []),
    ...(snap.children ?? []).flatMap(flattenTaskTimings),
  ];
}

export function SessionView({
  snapshot,
  selectedNodeId,
  onSelectNode,
  onUpdate,
  onNotify,
  contextOpen,
  onContextOpen,
}: Props) {
  const { unit } = useUnit();
  const [highlightTurnId, setHighlightTurnId] = useState<string | null>(null);
  const [highlightNonce, setHighlightNonce] = useState(0);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"perf" | "turns" | "tree">("perf");
  const contextRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHighlightTurnId(null);
    setContextExpanded(false);
    setActiveTab("perf");
  }, [snapshot.id]);

  useEffect(() => {
    if (!contextOpen) return;
    if (window.matchMedia("(max-width: 780px)").matches) {
      contextRef.current?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
    contextRef.current?.scrollIntoView({ block: "start" });
  }, [contextOpen, snapshot.id]);

  const turns = useMemo(() => flattenTurns(snapshot), [snapshot]);
  const taskTimings = useMemo(
    () => flattenTaskTimings(snapshot),
    [snapshot],
  );
  const selectedNode = resolveSelectedNode(snapshot.tree, selectedNodeId);
  const turnIds = useMemo(() => collectTurnIds(selectedNode), [selectedNode]);
  const hit = cacheHitRatio(snapshot.cost);
  const tokenWaste = wasteShare(snapshot.waste, snapshot.cost, "tokens");
  const unitWaste = wasteShare(snapshot.waste, snapshot.cost, unit);
  const suggestions = snapshot.suggestions.slice(0, 3);
  const unpriced = unpricedNote(unpricedRawFromTurns(turns));
  const identity = tokenIdentity(snapshot.cost);
  // 输入含已缓存部分，与总览「Token 构成」同口径；未记录用量的轮次是下界。
  const inputTokens = snapshot.cost.uncached_input + snapshot.cost.cached_input;
  const outputTokens = snapshot.cost.output;
  const noRecordedUsage =
    Boolean(snapshot.cost.unmeasured) && snapshot.cost.raw === 0;
  const usagePrefix = snapshot.cost.unmeasured ? "≥ " : "";
  const usageShare = (value: number) =>
    snapshot.cost.raw > 0
      ? formatPercent((100 * value) / snapshot.cost.raw)
      : "—";
  const inputDisplay = noRecordedUsage
    ? "—"
    : `${usagePrefix}${formatCompactTokens(inputTokens)}`;
  const outputDisplay = noRecordedUsage
    ? "—"
    : `${usagePrefix}${formatCompactTokens(outputTokens)}`;
  const usageDetail =
    snapshot.cost.raw <= 0
      ? "无用量记录"
      : // 金额/积分视图里「总用量」是钱，占比会被误读成费用占比。
        unit === "tokens"
        ? `占总量 ${usageShare(inputTokens)} / ${usageShare(outputTokens)}`
        : "按 token 计量";
  const unmeasuredSuffix = snapshot.cost.unmeasured
    ? `，另有 ${snapshot.cost.unmeasured.toLocaleString("en-US")} 次调用用量未记录`
    : "";
  const inputTitle = `输入 ${formatExactTokens(inputTokens)} tokens · 未缓存 ${formatExactTokens(snapshot.cost.uncached_input)} + 已缓存 ${formatExactTokens(snapshot.cost.cached_input)}${unmeasuredSuffix}`;
  const outputTitle = `输出 ${formatExactTokens(outputTokens)} tokens · 模型生成与思考${unmeasuredSuffix}`;
  const selectedAppearance = treeAppearance(
    selectedNode.label,
    selectedNode.kind,
    selectedNode.bucket,
  );
  const pricedRaw = Math.max(
    0,
    snapshot.cost.raw - unpricedRawFromTurns(turns),
  );
  const pricingCoverage =
    snapshot.cost.raw > 0
      ? formatPercent((100 * pricedRaw) / snapshot.cost.raw)
      : "—";
  const animatedTotal = useAnimatedNumber(snapshot.cost.raw === 0 && snapshot.cost.unmeasured ? null : (
    unit === "tokens" ? snapshot.cost.raw : unit === "credits" ? snapshot.cost.credits : snapshot.cost.usd
  ));
  const animatedWaste = useAnimatedNumber(
    unit === "tokens" ? snapshot.waste.raw : unit === "credits" ? snapshot.waste.credits : snapshot.waste.usd,
  );
  const animatedHit = useAnimatedNumber(hit == null ? null : 100 * hit);
  const totalFlash = useFlashOnChange(snapshot.cost.raw);
  const wasteFlash = useFlashOnChange(snapshot.waste.raw);

  const resolvedPerf = resolvePerformance(snapshot.performance, turns, taskTimings);
  const perfCopy = performanceCopy(resolvedPerf, snapshot.source);
  const requestDuration = formatPerformanceDuration(resolvedPerf.requestDurationMs);
  const taskDuration = formatPerformanceDuration(resolvedPerf.taskDurationMs);
  const resolvedTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
    } catch {
      return "Local";
    }
  }, []);

  function handleSuggestionClick(ids: string[]) {
    const target = suggestionTarget(snapshot.tree, ids);
    if (!target) return;
    setHighlightTurnId(target.turnId);
    setHighlightNonce((n) => n + 1);
    onSelectNode(target.nodeId);
    setActiveTab("turns");
  }

  return (
    <div className="session-view">
      {snapshot.ledger_warning && (
        <div className="banner ledger-warning">
          账本警告：各轮 last_token_usage 之和与 cumulative total 对不上（允许
          ±1）。数字仍按原始记录显示，没有改写。
        </div>
      )}
      {(snapshot.parse_errors ?? []).length > 0 && (
        <details className="banner parse-errors">
          <summary>
            发现 {snapshot.parse_errors.length} 条解析错误，展开核对原始记录
          </summary>
          {snapshot.parse_errors.map((err, i) => (
            <div key={`${err.offset}-${i}`}>
              Parse error in {snapshot.path} at byte {err.offset}: {err.message}
            </div>
          ))}
        </details>
      )}

      <section className="detail-hero sess-head">
        <div className="detail-hero-top">
          <div className="od-fill sess-title">
            <h2 className="detail-title" tabIndex={-1}>{snapshot.nickname ?? "会话明细"}</h2>
            <div className="detail-meta-row">
              <Badge
                variant="outline"
                className="badge session-source-badge"
              >
                <span
                  className="source-dot"
                  style={{ background: sourceColor(snapshot.source ?? "codex") }}
                  aria-hidden="true"
                />
                {sourceLabel(snapshot.source)}
              </Badge>
              <span className="cs-tag cs-tag--blue mono">{snapshot.model ?? "未知模型"}</span>
              {snapshot.live && <Badge variant="outline" className="badge live">LIVE</Badge>}
              {snapshot.fastMode && (
                <Badge
                  variant="outline"
                  className="badge fast"
                  title="最新日志记录使用 Fast；展开轮次可查看该轮倍率与 token 单价"
                >
                  Fast
                </Badge>
              )}
              {snapshot.parentId && <Badge variant="outline" className="badge child">子会话</Badge>}
              {snapshot.effort && <span className="cs-tag">{snapshot.effort}</span>}
              {snapshot.cwd && (
                <button
                  type="button"
                  className="session-project-path"
                  title={`点击拷贝项目路径：${snapshot.cwd}`}
                  onClick={() => {
                    if (navigator.clipboard?.writeText) {
                      void navigator.clipboard.writeText(snapshot.cwd!).catch(() => {});
                    }
                    onNotify?.(`已拷贝项目路径：${snapshot.cwd}`);
                  }}
                >
                  <Icon name="folder" />
                  <span className="mono session-project-value">{snapshot.cwd}</span>
                  <Icon name="copy" className="session-project-copy" />
                </button>
              )}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm session-reference"
            title={snapshot.id}
            onClick={() => {
              if (navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(snapshot.id).catch(() => {});
              }
              onNotify?.(`已复制会话 ID：${snapshot.id}`);
            }}
          >
            <Icon name="copy" />
            <span className="mono od-truncate">{snapshot.id}</span>
          </button>
        </div>

        {snapshot.cost.unmeasured ? (
          <p className="banner" role="status" style={{ margin: 0 }}>
            {usageNote(snapshot.cost)}对话和工具调用仍可展开查看。
          </p>
        ) : null}
        {snapshot.forkedFrom ? (
          <p className="source-path" style={{ margin: 0 }}>
            分叉自：{snapshot.forkedFrom} · 已识别的继承记录不重复计费。
          </p>
        ) : null}

        <div className="cs-kpi-grid headline-main">
          <div className="cs-kpi-card headline-row">
            <span className="cs-kpi-label">
              {unit === "tokens" ? "总用量" : "预估总费用"}
            </span>
            <span
              className={`cs-kpi-value headline-value${totalFlash ? " value-flash" : ""}`}
              title={formatCostTitle(snapshot.cost, unit)}
            >
              {unit === "tokens"
                ? formatCostTokens(
                    animatedTotal == null
                      ? snapshot.cost
                      : { ...snapshot.cost, raw: Math.round(animatedTotal) },
                  )
                : formatAnimatedCost(snapshot.cost, unit, animatedTotal)}
            </span>
            <span className="cs-kpi-sub mono" data-testid="usage-breakdown">
              <span data-testid="input-headline" title={inputTitle}>输入 <b>{inputDisplay}</b></span>
              <span>·</span>
              <span data-testid="output-headline" title={outputTitle}>输出 <b>{outputDisplay}</b></span>
              <span className="visually-hidden"> · {usageDetail}</span>
            </span>
          </div>
          <div className="cs-kpi-card headline-row">
            <span className="cs-kpi-label">调用与定价</span>
            <span className="cs-kpi-value">{turns.length.toLocaleString("en-US")} 轮</span>
            <span className="cs-kpi-sub">
              定价覆盖 {pricingCoverage} · {(snapshot.children ?? []).length > 0 ? `${(snapshot.children ?? []).length} 个子会话` : "无子 Agent"}
            </span>
          </div>
          <div className="cs-kpi-card headline-row cs-kpi-card--emerald">
            <span className="cs-kpi-label">缓存命中</span>
            <span className="cs-kpi-value">
              {animatedHit == null ? "—" : formatPercent(animatedHit)}
            </span>
            <span className="cs-kpi-sub">{usageDetail}</span>
          </div>
          <div className={`cs-kpi-card headline-row${snapshot.waste.raw > 0 ? " cs-kpi-card--amber" : ""}`}>
            <span className="cs-kpi-label">疑似可优化</span>
            <span
              className={`cs-kpi-value headline-value waste${wasteFlash ? " value-flash" : ""}`}
              data-testid="waste-headline"
              title={formatCostTitle(snapshot.waste, unit)}
            >
              {unit === "tokens"
                ? formatCostTokens(
                    animatedWaste == null
                      ? snapshot.waste
                      : { ...snapshot.waste, raw: Math.round(animatedWaste) },
                  )
                : formatAnimatedCost(snapshot.waste, unit, animatedWaste)}
            </span>
            <span className="cs-kpi-sub">{formatUnitSuffix(unit)} · 占比 {unitWaste}</span>
          </div>
        </div>

        {unpriced ? (
          <p className="headline-note identity-warn" style={{ margin: 0 }}>{unpriced}</p>
        ) : null}
        {!identity.ok && (
          <p className="headline-note identity-warn" style={{ margin: 0 }}>
            构成合计 {identity.parts.toLocaleString("en-US")} ≠ raw{" "}
            {snapshot.cost.raw.toLocaleString("en-US")}
          </p>
        )}
        <MixBar
          className="headline-mix"
          testId="headline-mix"
          label={`疑似可优化 ${tokenWaste}（按 token）`}
          segments={[
            {
              key: "useful",
              label: "其余",
              value: Math.max(0, snapshot.cost.raw - snapshot.waste.raw),
              className: "useful",
            },
            {
              key: "waste",
              label: "疑似可优化",
              value: snapshot.waste.raw,
              className: "waste",
            },
          ]}
        />
        <div className="hero-mix-foot">
          <div className="headline-legend">
            <span><span className="swatch useful" /> 有效消耗 {formatPercent(Math.max(0, 100 - (snapshot.cost.raw > 0 ? (100 * snapshot.waste.raw) / snapshot.cost.raw : 0)))}</span>
            <span><span className="swatch waste" /> 疑似可优化 {unitWaste}</span>
            {unit !== "tokens" && unitWaste !== tokenWaste && (
              <span className="legend-note">token {tokenWaste}</span>
            )}
          </div>
          <div className="hero-perf-inline mono" aria-label="响应性能摘要">
            <span title={perfCopy.ttftNote}>
              TTFT <strong>{formatPerformanceNumber(resolvedPerf.avgTtftMs == null ? null : resolvedPerf.avgTtftMs / 1000)} s</strong>
            </span>
            <span title={perfCopy.speedNote}>
              <strong>{formatPerformanceNumber(resolvedPerf.outputTokensPerSecond)} tok/s</strong>
            </span>
            <span title={perfCopy.requestDurationNote}>
              请求 <strong>{requestDuration.value} {requestDuration.unit}</strong>
            </span>
            <span title={perfCopy.taskDurationNote} className="hero-perf-muted">
              总耗时 <strong>{taskDuration.value} {taskDuration.unit}</strong>
            </span>
          </div>
        </div>
      </section>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as "perf" | "turns" | "tree")}
        className="session-data-tabs"
      >
        <div className="session-tabs-bar">
          <TabsList className="session-tabs-list" aria-label="会话数据展示">
            <TabsTrigger value="perf" className="session-tab-trigger">
              性能
            </TabsTrigger>
            <TabsTrigger value="turns" className="session-tab-trigger">
              轮次详情 ({turnIds ? turnIds.size : turns.length})
            </TabsTrigger>
            <TabsTrigger value="tree" className="session-tab-trigger">
              成本树
            </TabsTrigger>
          </TabsList>
          {selectedNodeId && selectedNodeId !== snapshot.tree.id && (
            <div className="session-tab-filter-pill">
              <span>
                已选节点：<strong>{selectedAppearance.label}</strong>
              </span>
              {activeTab === "tree" && (
                <button
                  type="button"
                  className="session-tab-filter-action"
                  onClick={() => setActiveTab("turns")}
                >
                  查看轮次详情
                </button>
              )}
              <button
                type="button"
                className="session-tab-filter-action"
                onClick={() => onSelectNode(snapshot.tree.id)}
              >
                清除筛选
              </button>
            </div>
          )}
        </div>

        <TabsContent value="perf" className="session-tab-panel">
          <Panel className="chart-card perf-card session-perf-panel">
            <div className="chart-head">
              <div>
                <h3 className="chart-title">响应性能与延迟分布</h3>
              </div>
            </div>
            <PerformanceMetrics
              performance={resolvedPerf}
              turns={turns}
              tasks={taskTimings}
              source={snapshot.source}
              alwaysShowDistributions
            />
          </Panel>
        </TabsContent>

        <TabsContent value="turns" className="session-tab-panel">
          <TurnTable
            turns={turns}
            turnIds={turnIds}
            highlightTurnId={highlightTurnId}
            highlightNonce={highlightNonce}
            resetKey={`${snapshot.id}:${selectedNodeId ?? ""}`}
            scopeLabel={selectedAppearance.label}
            source={snapshot.source}
          />
        </TabsContent>

        <TabsContent value="tree" className="session-tab-panel">
          <div className="session-tree-pane">
            <CostTree
              key={snapshot.id}
              tree={snapshot.tree}
              selectedNodeId={selectedNodeId}
              onSelect={onSelectNode}
            />
            <div className="session-tree-actions">
              <span className="session-tree-hint">
                {selectedAppearance.label} · {turnIds ? turnIds.size : turns.length} 轮
              </span>
              <button
                type="button"
                className="btn btn-sm session-tree-jump"
                onClick={() => setActiveTab("turns")}
              >
                查看轮次详情
                <Icon name="arrow" />
              </button>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <div className="detail-stack">
        <DetailSection
          key={`rules-${snapshot.id}`}
          icon="sliders"
          iconTone="brand"
          title="优化建议与浪费规则"
          description={`${suggestions.length} 条建议`}
        >
          <WasteToggles snapshot={snapshot} onUpdate={onUpdate} />
          {suggestions.length > 0 && (
            <Panel className="suggestions chart-card">
              <ul>
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="suggestion-banner-btn"
                      onClick={() => handleSuggestionClick(s.turnIds)}
                    >
                      <div className="suggestion-banner-copy">
                        <strong>{s.title}</strong>
                        <span>{s.body}</span>
                      </div>
                      <span className="suggestion-locate-pill">
                        <span>定位轮次</span>
                        <Icon name="chevron" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </DetailSection>
        <div ref={contextRef} className="detail-anchor">
          <DetailSection
            icon="shield"
            iconTone="emerald"
            title="上下文与会话信息"
            description={`${snapshot.context?.tools.items.length ?? 0} 工具 · ${snapshot.context?.skills.items.length ?? 0} 技能 · ${snapshot.ledger_warning ? "需复核" : "已校验"}`}
            open={contextExpanded || contextOpen != null}
            onToggle={(open) => {
              setContextExpanded(open);
              if (!open) onContextOpen(null);
            }}
          >
            <div className="context-support">
              <div className="context-support-main">
                <ContextProfileCard
                  profile={
                    snapshot.context ?? {
                      tools: { chars: 0, items: [] },
                      skills: { chars: 0, items: [] },
                    }
                  }
                  open={contextOpen}
                  onOpen={onContextOpen}
                />
                <div className="session-audit" aria-label="当前会话数据口径">
                  <span>
                    <i className={unpriced ? "audit-dot warn" : "audit-dot good"} />
                    定价覆盖 <strong>{pricingCoverage}</strong>
                  </span>
                  <span>
                    <i
                      className={
                        snapshot.ledger_warning
                          ? "audit-dot warn"
                          : "audit-dot good"
                      }
                    />
                    账本校验{" "}
                    <strong>{snapshot.source && snapshot.source !== "codex" ? "按原始消息用量统计" : snapshot.ledger_warning ? "需复核" : "通过"}</strong>
                  </span>
                </div>
              </div>
              <div className="context-support-side">
                {snapshot.contextMeasurement != null && (
                  <ContextMeter measurement={snapshot.contextMeasurement} />
                )}
                {snapshot.rate_limits != null && (
                  <RateLimits raw={snapshot.rate_limits} />
                )}
                <div className="context-tz-foot">
                  <span>本地时区归日</span>
                  <span className="mono">{resolvedTz}</span>
                </div>
              </div>
            </div>
            {snapshot.cwd && <p className="source-path">项目路径：{snapshot.cwd}</p>}
            <p className="source-path">会话 ID：{snapshot.id}</p>
          </DetailSection>
        </div>
      </div>
    </div>
  );
}
