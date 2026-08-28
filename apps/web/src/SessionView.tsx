import { useMemo, useState } from "react";
import type { SessionSnapshot, Turn } from "./api";
import { useUnit } from "./UnitContext";
import {
  cacheHitRatio,
  disclaimer,
  formatAbsoluteTime,
  formatCost,
  formatPercent,
  formatRelativeTime,
  wasteShare,
} from "./format";
import { ContextProfileCard } from "./ContextProfile";
import { CostTree, collectTurnIds, findNodeById } from "./CostTree";
import { MixBar } from "./MixBar";
import { RateLimits } from "./RateLimits";
import { WasteToggles } from "./WasteToggles";
import { TurnTable } from "./TurnTable";

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

  const selectedNode = selectedNodeId
    ? findNodeById(snapshot.tree, selectedNodeId)
    : snapshot.tree;
  const turnIds = useMemo(
    () => (selectedNode ? collectTurnIds(selectedNode) : new Set<string>()),
    [selectedNode],
  );
  const hit = cacheHitRatio(snapshot.cost);
  const tokenWaste = wasteShare(snapshot.waste, snapshot.cost, "tokens");
  const unitWaste = wasteShare(snapshot.waste, snapshot.cost, unit);
  const suggestions = snapshot.suggestions.slice(0, 3);

  function handleSuggestionClick(ids: string[]) {
    const first = ids[0];
    if (!first) return;
    setHighlightTurnId(first);
    function findNode(node: typeof snapshot.tree): string | null {
      if (node.turnIds.includes(first)) return node.id;
      for (const child of node.children) {
        const found = findNode(child);
        if (found) return found;
      }
      return null;
    }
    for (const child of snapshot.tree.children) {
      const id = findNode(child);
      if (id) {
        onSelectNode(id);
        return;
      }
    }
  }

  return (
    <div className="session-view">
      {snapshot.ledger_warning && (
        <div className="banner ledger-warning">
          账本警告：各轮 last_token_usage 之和与 cumulative total 对不上（允许 ±1）。数字仍按原始记录显示，没有改写。
        </div>
      )}
      {(snapshot.parse_errors ?? []).length > 0 && (
        <div className="banner parse-errors">
          {snapshot.parse_errors.map((err, i) => (
            <div key={`${err.offset}-${i}`}>
              Parse error in {snapshot.path} at byte {err.offset}: {err.message}
            </div>
          ))}
        </div>
      )}

      <p className="session-kicker">
        {snapshot.live && <span className="badge live">LIVE</span>}
        {snapshot.fastMode && (
          <span className="badge fast" title="Fast multiplier 2.5 from session telemetry">
            Fast ×2.5
          </span>
        )}
        <span>{snapshot.model ?? "未知模型"}</span>
        {snapshot.effort && <span>· {snapshot.effort}</span>}
        {snapshot.cwd && (
          <span className="session-kicker-cwd" title={snapshot.cwd}>
            · {snapshot.cwd}
          </span>
        )}
        <span
          title={formatAbsoluteTime(snapshot.startedAt ?? snapshot.lastEventAt)}
        >
          · {formatRelativeTime(snapshot.startedAt ?? snapshot.lastEventAt)}
        </span>
        {hit != null && <span>· 缓存命中 {formatPercent(100 * hit)}</span>}
      </p>

      <header className="session-headline">
        <div className="chart-card headline-main">
          <div className="headline-row">
            <span className="headline-label">总量</span>
            <span className="headline-value">
              {formatCost(snapshot.cost, unit)}
            </span>
          </div>
          <div className="headline-row">
            <span className="headline-label">浪费</span>
            <span className="headline-value waste" data-testid="waste-headline">
              {formatCost(snapshot.waste, unit)}
            </span>
          </div>
          <MixBar
            className="headline-mix"
            testId="headline-mix"
            label={`Waste ${tokenWaste} of tokens`}
            segments={[
              {
                key: "useful",
                value: Math.max(0, snapshot.cost.raw - snapshot.waste.raw),
                className: "useful",
              },
              { key: "waste", value: snapshot.waste.raw, className: "waste" },
            ]}
          />
          <div className="headline-legend">
            <span className="swatch useful" /> 有效
            <span className="swatch waste" /> 浪费 {unitWaste}
            {unit !== "tokens" && unitWaste !== tokenWaste && (
              <span className="legend-note">token {tokenWaste}</span>
            )}
          </div>
          <p className="disclaimer">{disclaimer(snapshot.rateCardAsOf)}</p>
        </div>
        {snapshot.rate_limits != null && <RateLimits raw={snapshot.rate_limits} />}
      </header>
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

      <div className="session-body">
        <div className="session-left">
          <CostTree
            tree={snapshot.tree}
            selectedNodeId={selectedNodeId}
            onSelect={onSelectNode}
          />
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
        </div>
        <TurnTable
          turns={flattenTurns(snapshot)}
          turnIds={turnIds}
          highlightTurnId={highlightTurnId}
        />
      </div>
    </div>
  );
}
