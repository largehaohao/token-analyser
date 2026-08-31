import { useState } from "react";
import type { TreeNode } from "./api";
import { treeAppearance } from "./buckets";
import { useUnit } from "./UnitContext";
import {
  allocatePercents,
  formatCompactTokens,
  formatCost,
  formatCostTitle,
} from "./format";

export function siblingDisplayPercents(
  children: Array<{ cost: { raw: number } }>,
): number[] {
  return allocatePercents(children.map((child) => child.cost.raw));
}

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
  showEmpty,
  onSelect,
}: {
  node: TreeNode;
  prefix: string;
  isLast: boolean;
  depth: number;
  selectedNodeId: string | null;
  displayPercent: number;
  showEmpty: boolean;
  onSelect: (id: string) => void;
}) {
  const { unit } = useUnit();
  const branch = depth === 0 ? "" : isLast ? "└─" : "├─";
  const isRootChild = depth === 1;
  const appearance = treeAppearance(node.label, node.kind, node.bucket);
  const muted = node.cost.raw === 0 && depth > 0;
  const selected =
    selectedNodeId === node.id || (selectedNodeId == null && depth === 0);
  const children = node.children.filter(
    (child) =>
      showEmpty ||
      child.cost.raw !== 0 ||
      (selectedNodeId != null && findNodeById(child, selectedNodeId) != null),
  );
  const childPercents = siblingDisplayPercents(children);

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
        <span
          className="tree-swatch"
          style={{ background: appearance.color }}
        />
        <span className="tree-label" title={appearance.label}>
          {appearance.label}
        </span>
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
        <span className="tree-cost" title={formatCostTitle(node.cost, unit)}>
          {unit === "tokens"
            ? formatCompactTokens(node.cost.raw)
            : formatCost(node.cost, unit)}
        </span>
      </button>
      {children.map((child, i) => (
        <TreeRow
          key={child.id}
          node={child}
          prefix={depth === 0 ? "" : prefix + (isLast ? "  " : "│ ")}
          isLast={i === children.length - 1}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          displayPercent={childPercents[i] ?? 0}
          showEmpty={showEmpty}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function CostTree({ tree, selectedNodeId, onSelect }: Props) {
  const [showEmpty, setShowEmpty] = useState(false);

  function hasEmptyBranches(node: TreeNode): boolean {
    return node.children.some(
      (child) => child.cost.raw === 0 || hasEmptyBranches(child),
    );
  }

  return (
    <div className="cost-tree chart-card">
      <h3>成本树</h3>
      <p className="chart-desc">按 Token 占比分组，点选分类筛选轮次。</p>
      <TreeRow
        node={tree}
        prefix=""
        isLast
        depth={0}
        selectedNodeId={selectedNodeId}
        displayPercent={100}
        showEmpty={showEmpty}
        onSelect={onSelect}
      />
      {hasEmptyBranches(tree) && (
        <button
          type="button"
          className="secondary-action tree-empty-toggle"
          aria-pressed={showEmpty}
          onClick={() => setShowEmpty((current) => !current)}
        >
          {showEmpty ? "隐藏零用量分类" : "显示零用量分类"}
        </button>
      )}
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

export function findNodeForTurnId(
  root: TreeNode,
  turnId: string,
): TreeNode | null {
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
