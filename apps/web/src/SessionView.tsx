import type { SessionSnapshot } from "./api";
import { useUnit } from "./UnitContext";
import { formatCost, disclaimer } from "./format";
import { CostTree, collectTurnIds, findNodeById } from "./CostTree";
import { WasteToggles } from "./WasteToggles";
import { TurnTable } from "./TurnTable";

type Props = {
  snapshot: SessionSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onUpdate: (snap: SessionSnapshot) => void;
};

export function SessionView({
  snapshot,
  selectedNodeId,
  onSelectNode,
  onUpdate,
}: Props) {
  const { unit } = useUnit();

  const selectedNode = selectedNodeId
    ? findNodeById(snapshot.tree, selectedNodeId)
    : null;
  const turnIds = selectedNode
    ? collectTurnIds(selectedNode)
    : new Set<string>();

  const suggestions = snapshot.suggestions.slice(0, 3);

  function handleSuggestionClick(turnIds: string[]) {
    const first = turnIds[0];
    if (!first) return;
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
          Ledger warning: token usage may not reconcile with recorded costs.
        </div>
      )}

      <header className="session-headline">
        <div className="headline-row">
          <span className="headline-label">Total</span>
          <span className="headline-value">
            {formatCost(snapshot.cost, unit)}
          </span>
        </div>
        <div className="headline-row">
          <span className="headline-label">Waste</span>
          <span className="headline-value waste" data-testid="waste-headline">
            {formatCost(snapshot.waste, unit)}
          </span>
        </div>
        <p className="disclaimer">{disclaimer(snapshot.rateCardAsOf)}</p>
      </header>

      <div className="session-body">
        <div className="session-left">
          <CostTree
            tree={snapshot.tree}
            selectedNodeId={selectedNodeId}
            onSelect={onSelectNode}
          />
          <WasteToggles snapshot={snapshot} onUpdate={onUpdate} />
          {suggestions.length > 0 && (
            <div className="suggestions">
              <h3>Suggestions</h3>
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
        <TurnTable turns={snapshot.turns} turnIds={turnIds} />
      </div>
    </div>
  );
}
