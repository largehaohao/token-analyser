import type { TreeNode } from "./api";
import { treeAppearance } from "./buckets";
import { useUnit } from "./UnitContext";
import { allocatePercents, formatCost } from "./format";

type Props = {
  tree: TreeNode;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
};

function TreeRow({
  node,
  prefix,
  isLast,
  depth,
  selectedNodeId,
  displayPercent,
  rootPercents,
  onSelect,
}: {
  node: TreeNode;
  prefix: string;
  isLast: boolean;
  depth: number;
  selectedNodeId: string | null;
  displayPercent: number;
  rootPercents: number[];
  onSelect: (id: string) => void;
}) {
  const { unit } = useUnit();
  const branch = depth === 0 ? "" : isLast ? "└─" : "├─";
  const isRootChild = depth === 1;
  const appearance = treeAppearance(node.label, node.kind, node.bucket);
  const muted = node.cost.raw === 0 && depth > 0;
  const selected =
    selectedNodeId === node.id || (selectedNodeId == null && depth === 0);

  return (
    <>
      <button
        type="button"
        className={`tree-row${selected ? " selected" : ""}${muted ? " muted" : ""}`}
        aria-pressed={selected}
        onClick={() => onSelect(node.id)}
      >
        <span className="tree-prefix">
          {prefix}
          {branch}
        </span>
        <span className="tree-swatch" style={{ background: appearance.color }} />
        <span className="tree-label">{appearance.label}</span>
        <span className="tree-bar" aria-hidden="true">
          <span
            className="tree-bar-fill"
            style={{
              width: `${Math.min(100, Math.max(0, displayPercent))}%`,
              background: appearance.color,
            }}
          />
        </span>
        <span
          className="tree-percent"
          {...(isRootChild ? { "data-percent": true } : {})}
        >
          {displayPercent.toFixed(1)}%
        </span>
        <span className="tree-cost">{formatCost(node.cost, unit)}</span>
      </button>
      {node.children.map((child, i) => (
        <TreeRow
          key={child.id}
          node={child}
          prefix={depth === 0 ? "" : prefix + (isLast ? "  " : "│ ")}
          isLast={i === node.children.length - 1}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          displayPercent={
            depth === 0 ? rootPercents[i] : child.percentOfParent
          }
          rootPercents={rootPercents}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function CostTree({ tree, selectedNodeId, onSelect }: Props) {
  const rootPercents = allocatePercents(
    tree.children.map((child) => child.cost.raw),
  );

  return (
    <div className="cost-tree chart-card">
      <h3>成本树</h3>
      <p className="chart-desc">
        点选节点过滤右侧轮次。根节点为全部轮次。占比按原始 token 划分，合计 100%。
      </p>
      <TreeRow
        node={tree}
        prefix=""
        isLast
        depth={0}
        selectedNodeId={selectedNodeId}
        displayPercent={100}
        rootPercents={rootPercents}
        onSelect={onSelect}
      />
    </div>
  );
}

export function findNodeById(root: TreeNode, id: string): TreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

export function resolveSelectedNode(
  root: TreeNode,
  id: string | null,
): TreeNode {
  if (!id) return root;
  return findNodeById(root, id) ?? root;
}

export function findNodeForTurnId(root: TreeNode, turnId: string): TreeNode | null {
  for (const child of root.children) {
    const found = findNodeForTurnId(child, turnId);
    if (found) return found;
  }
  if (root.turnIds.includes(turnId)) return root;
  return null;
}

export function suggestionTarget(
  tree: TreeNode,
  turnIds: string[],
): { turnId: string; nodeId: string } | null {
  const turnId = turnIds[0];
  if (!turnId) return null;
  const node = findNodeForTurnId(tree, turnId);
  return { turnId, nodeId: node?.id ?? tree.id };
}

export function collectTurnIds(node: TreeNode): Set<string> {
  const ids = new Set<string>();
  function walk(n: TreeNode) {
    for (const id of n.turnIds) ids.add(id);
    for (const child of n.children) walk(child);
  }
  walk(node);
  return ids;
}
