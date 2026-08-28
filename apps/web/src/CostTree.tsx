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
  onSelect,
}: {
  node: TreeNode;
  prefix: string;
  isLast: boolean;
  depth: number;
  selectedNodeId: string | null;
  displayPercent: number;
  onSelect: (id: string) => void;
}) {
  const { unit } = useUnit();
  const branch = isLast ? "└─" : "├─";
  const isRootChild = depth === 1;
  const appearance = treeAppearance(node.label, node.kind, node.bucket);
  const muted = node.cost.raw === 0;

  return (
    <>
      <button
        type="button"
        className={`tree-row${selectedNodeId === node.id ? " selected" : ""}${muted ? " muted" : ""}`}
        aria-pressed={selectedNodeId === node.id}
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
          prefix={prefix + (isLast ? "  " : "│ ")}
          isLast={i === node.children.length - 1}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          displayPercent={child.percentOfParent}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function CostTree({ tree, selectedNodeId, onSelect }: Props) {
  const percents = allocatePercents(tree.children.map((child) => child.cost.raw));

  return (
    <div className="cost-tree chart-card">
      <h3>成本树</h3>
      <p className="chart-desc">点选节点过滤右侧轮次。占比按原始 token 划分，合计 100%。</p>
      {tree.children.map((child, i) => (
        <TreeRow
          key={child.id}
          node={child}
          prefix=""
          isLast={i === tree.children.length - 1}
          depth={1}
          selectedNodeId={selectedNodeId}
          displayPercent={percents[i]}
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
  const ids = new Set<string>();
  function walk(n: TreeNode) {
    for (const id of n.turnIds) ids.add(id);
    for (const child of n.children) walk(child);
  }
  walk(node);
  return ids;
}
