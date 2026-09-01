import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot, Turn } from "./api";
import { useUnit } from "./UnitContext";
import {
  cacheHitRatio,
  disclaimer,
  formatCompactTokens,
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
import { RateLimits } from "./RateLimits";
import { WasteToggles } from "./WasteToggles";
import { TurnTable } from "./TurnTable";
import { RelativeTime } from "./RelativeTime";
import { treeAppearance } from "./buckets";
import { DetailSection } from "./DetailSection";

type Props = {
  snapshot: SessionSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onUpdate: (snap: SessionSnapshot) => void;
  contextOpen: "tools" | "skills" | null;
  onContextOpen: (id: "tools" | "skills" | null) => void;
};

function flattenTurns(snap: SessionSnapshot): Turn[] {
  return [...snap.turns, ...(snap.children ?? []).flatMap(flattenTurns)];
}

export function SessionView({
  snapshot,
  selectedNodeId,
  onSelectNode,
  onUpdate,
  contextOpen,
  onContextOpen,
}: Props) {
  const { unit } = useUnit();
  const [highlightTurnId, setHighlightTurnId] = useState<string | null>(null);
  const [highlightNonce, setHighlightNonce] = useState(0);
  const [contextExpanded, setContextExpanded] = useState(false);
  const contextRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHighlightTurnId(null);
    setContextExpanded(false);
  }, [snapshot.id]);

  useEffect(() => {
    if (contextOpen) contextRef.current?.scrollIntoView({ block: "start" });
  }, [contextOpen, snapshot.id]);

  const turns = useMemo(() => flattenTurns(snapshot), [snapshot]);
  const selectedNode = resolveSelectedNode(snapshot.tree, selectedNodeId);
  const turnIds = useMemo(() => collectTurnIds(selectedNode), [selectedNode]);
  const hit = cacheHitRatio(snapshot.cost);
  const tokenWaste = wasteShare(snapshot.waste, snapshot.cost, "tokens");
  const unitWaste = wasteShare(snapshot.waste, snapshot.cost, unit);
  const suggestions = snapshot.suggestions.slice(0, 3);
  const unpriced = unpricedNote(unpricedRawFromTurns(turns));
  const identity = tokenIdentity(snapshot.cost);
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
      : "100.0%";

  function handleSuggestionClick(ids: string[]) {
    const target = suggestionTarget(snapshot.tree, ids);
    if (!target) return;
    setHighlightTurnId(target.turnId);
    setHighlightNonce((n) => n + 1);
    onSelectNode(target.nodeId);
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

      <header className="page-heading session-page-heading">
        <div className="page-heading-copy">
          <span className="page-eyebrow">会话证据 · 当前选中</span>
          <h1 tabIndex={-1}>{snapshot.nickname ?? "会话明细"}</h1>
          <p className="source-path" title={snapshot.cwd ?? undefined}>
            {snapshot.cwd ?? "本地会话"}
          </p>
        </div>
        <span className="session-reference" title={snapshot.id}>
          {snapshot.id.slice(0, 8)}
        </span>
      </header>
      <p className="session-kicker">
        {snapshot.live && <span className="badge live">LIVE</span>}
        {snapshot.fastMode && (
          <span
            className="badge fast"
            title="最新 turn_context 使用 Fast；费用倍率按该轮模型的费率计算"
          >
            Fast
          </span>
        )}
        <span>{snapshot.model ?? "未知模型"}</span>
        {snapshot.effort && <span>· {snapshot.effort}</span>}
        <span>
          · 最近活动{" "}
          <RelativeTime iso={snapshot.lastEventAt ?? snapshot.startedAt} />
        </span>
      </p>

      <header className="session-headline">
        <div className="chart-card headline-main">
          <div className="session-metrics">
            <div className="headline-row">
              <span className="headline-label">
                {unit === "tokens" ? "总用量" : "预估总费用"}
              </span>
              <span
                className="headline-value"
                title={formatCostTitle(snapshot.cost, unit)}
              >
                {unit === "tokens"
                  ? formatCompactTokens(snapshot.cost.raw)
                  : formatCost(snapshot.cost, unit)}
              </span>
              <small>
                {formatUnitSuffix(unit)} ·{" "}
                {turns.length.toLocaleString("en-US")} 轮调用
              </small>
            </div>
            <div className="headline-row">
              <span className="headline-label">疑似可优化</span>
              <span
                className="headline-value waste"
                data-testid="waste-headline"
                title={formatCostTitle(snapshot.waste, unit)}
              >
                {unit === "tokens"
                  ? formatCompactTokens(snapshot.waste.raw)
                  : formatCost(snapshot.waste, unit)}
              </span>
              <small>
                {formatUnitSuffix(unit)} · 占比 {unitWaste}
              </small>
            </div>
            <div className="headline-row">
              <span className="headline-label">缓存命中</span>
              <span className="headline-value">
                {hit != null ? formatPercent(100 * hit) : "—"}
              </span>
              <small>按输入 token 计算</small>
            </div>
          </div>
          {unpriced ? (
            <p className="headline-note identity-warn">{unpriced}</p>
          ) : null}
          {!identity.ok && (
            <p className="headline-note identity-warn">
              构成合计 {identity.parts.toLocaleString("en-US")} ≠ raw{" "}
              {snapshot.cost.raw.toLocaleString("en-US")}
            </p>
          )}
          <MixBar
            className="headline-mix"
            testId="headline-mix"
            label={`浪费 ${tokenWaste}（按 token）`}
            segments={[
              {
                key: "useful",
                label: "有效",
                value: Math.max(0, snapshot.cost.raw - snapshot.waste.raw),
                className: "useful",
              },
              {
                key: "waste",
                label: "浪费",
                value: snapshot.waste.raw,
                className: "waste",
              },
            ]}
          />
          <div className="headline-legend">
            <span className="swatch useful" /> 有效
            <span className="swatch waste" /> 浪费 {unitWaste}
            {unit !== "tokens" && unitWaste !== tokenWaste && (
              <span className="legend-note">token {tokenWaste}</span>
            )}
          </div>
        </div>
      </header>
      <p className="disclaimer">{disclaimer(snapshot.rateCardAsOf)}</p>

      <div className="session-body">
        <div className="session-left">
          <CostTree
            key={snapshot.id}
            tree={snapshot.tree}
            selectedNodeId={selectedNodeId}
            onSelect={onSelectNode}
          />
        </div>
        <TurnTable
          turns={turns}
          turnIds={turnIds}
          highlightTurnId={highlightTurnId}
          highlightNonce={highlightNonce}
          resetKey={`${snapshot.id}:${selectedNodeId ?? ""}`}
          scopeLabel={selectedAppearance.label}
        />
      </div>
      <div className="detail-stack">
        <DetailSection
          key={`rules-${snapshot.id}`}
          title="优化建议与浪费规则"
          description={`${suggestions.length} 条建议 · 按需调整哪些行为计为浪费`}
        >
          <WasteToggles snapshot={snapshot} onUpdate={onUpdate} />
          {suggestions.length > 0 && (
            <div className="suggestions chart-card">
              <h3>建议</h3>
              <ul>
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => handleSuggestionClick(s.turnIds)}
                    >
                      <strong>{s.title}</strong>
                      <span>{s.body}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </DetailSection>
        <div ref={contextRef} className="detail-anchor">
          <DetailSection
            title="上下文与会话信息"
            description={`${snapshot.context?.tools.items.length ?? 0} 个工具 · ${snapshot.context?.skills.items.length ?? 0} 项技能 · 用量限额与账本校验`}
            open={contextExpanded || contextOpen != null}
            onToggle={(open) => {
              setContextExpanded(open);
              if (!open) onContextOpen(null);
            }}
          >
            <div className="context-support">
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
              {snapshot.rate_limits != null && (
                <RateLimits raw={snapshot.rate_limits} />
              )}
            </div>
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
                <strong>{snapshot.ledger_warning ? "需复核" : "通过"}</strong>
              </span>
            </div>
            <p className="source-path">会话 ID：{snapshot.id}</p>
          </DetailSection>
        </div>
      </div>
    </div>
  );
}
