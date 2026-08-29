import { describe, expect, it } from "vitest";
import type { TreeNode } from "./api";
import {
  findNodeForTurnId,
  resolveSelectedNode,
  siblingDisplayPercents,
  suggestionTarget,
} from "./CostTree";

function node(
  partial: Pick<TreeNode, "id" | "kind" | "turnIds"> & {
    children?: TreeNode[];
  },
): TreeNode {
  return {
    id: partial.id,
    kind: partial.kind,
    label: partial.id,
    cost: {
      raw: 0,
      uncached_input: 0,
      cached_input: 0,
      output: 0,
      credits: 0,
      usd: 0,
    },
    percentOfParent: 0,
    children: partial.children ?? [],
    turnIds: partial.turnIds,
  };
}

describe("siblingDisplayPercents", () => {
  it("allocates nested siblings so displayed percents still sum to 100", () => {
    const percents = siblingDisplayPercents([
      { cost: { raw: 1 } },
      { cost: { raw: 1 } },
      { cost: { raw: 1 } },
    ]);
    expect(percents.reduce((sum, n) => sum + n, 0)).toBeCloseTo(100, 5);
    expect(percents.every((n) => n === 33.3 || n === 33.4)).toBe(true);
  });
});

describe("findNodeForTurnId", () => {
  const tree = node({
    id: "root",
    kind: "root",
    turnIds: ["t-poll"],
    children: [
      node({
        id: "waiting",
        kind: "waiting",
        turnIds: ["t-poll"],
        children: [
          node({ id: "poll", kind: "bucket", turnIds: ["t-poll"] }),
        ],
      }),
    ],
  });

  it("prefers the deepest node that owns the turn", () => {
    expect(findNodeForTurnId(tree, "t-poll")?.id).toBe("poll");
  });

  it("selects that node even when it is the session root", () => {
    const onlyRoot = node({ id: "root", kind: "root", turnIds: ["t1"] });
    expect(suggestionTarget(onlyRoot, ["t1"])).toEqual({
      turnId: "t1",
      nodeId: "root",
    });
  });

  it("falls back to the root when the selected node id is stale", () => {
    expect(resolveSelectedNode(tree, null).id).toBe("root");
    expect(resolveSelectedNode(tree, "waiting").id).toBe("waiting");
    expect(resolveSelectedNode(tree, "s-poll:waiting.poll").id).toBe("root");
  });
});
