import type { TreeNode } from "./api";
import { useUnit } from "./UnitContext";
import { formatCost } from "./format";

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
  onSelect,
}: {
  node: TreeNode;
  prefix: string;
  isLast: boolean;
  depth: number;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { unit } = useUnit();
  const branch = isLast ? "└─" : "├─";
  const isRootChild = depth === 1;

  return (
    <>
      <button
        type="button"
        className={`tree-row${selectedNodeId === node.id ? " selected" : ""}`}
        onClick={() => onSelect(node.id)}
      >
        <span className="tree-prefix">{prefix}{branch}</span>
        <span className="tree-label">{node.label}</span>
        <span className="tree-bar" aria-hidden="true">
          <span
            className="tree-bar-fill"
            style={{ width: `${Math.min(100, Math.max(0, node.percentOfParent))}%` }}
          />
        </span>
        <span
          className="tree-percent"
          {...(isRootChild ? { "data-percent": true } : {})}
        >
          {node.percentOfParent.toFixed(1)}
        </span>
        <span className="tree-cost">{formatCost(node.cost, unit)}</span>
      </button>
      {node.children.map((child, i) => (
        <TreeRow
          key={child.id}
          node={child}
          prefix={prefix + (isLast ? "  " : "│ ")}
          isLast={i === node.children.length - 1}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function CostTree({ tree, selectedNodeId, onSelect }: Props) {
  return (
    <div className="cost-tree chart-card">
      <h3>成本树</h3>
      {tree.children.map((child, i) => (
        <TreeRow
          key={child.id}
          node={child}
          prefix=""
          isLast={i === tree.children.length - 1}
          depth={1}
          selectedNodeId={selectedNodeId}
          onSelect={onSelect}
        />
      ))}
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

export function findNodeForTurnId(root: TreeNode, turnId: string): TreeNode | null {
  if (root.turnIds.includes(turnId)) return root;
  for (const child of root.children) {
    const found = findNodeForTurnId(child, turnId);
    if (found) return found;
  }
  return null;
}

export function collectTurnIds(node: TreeNode): Set<string> {
  const ids = new Set<string>(node.turnIds);
  if (node.kind === "waiting") {
    for (const child of node.children) {
      for (const id of child.turnIds) ids.add(id);
    }
  } else if (node.kind === "subagents" || node.kind === "child") {
    function walk(n: TreeNode) {
      for (const id of n.turnIds) ids.add(id);
      for (const c of n.children) walk(c);
    }
    walk(node);
  }
  return ids;
}
