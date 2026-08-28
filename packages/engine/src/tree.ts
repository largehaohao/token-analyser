import {
  addKnownCost,
  emptyCost,
  emptyMaybeCost,
  type Bucket,
  type Cost,
  type SessionSnapshot,
  type TreeNode,
  type Turn,
} from "./types.ts";

const BUCKET_ORDER: Bucket[] = [
  "planning",
  "code",
  "reread",
  "waiting.poll",
  "waiting.coord",
  "other",
];

const ROOT_CHILD_LABELS = [
  "planning",
  "code",
  "reread",
  "subagents",
  "waiting",
  "other",
] as const;

export function sumTurns(turns: Turn[]): Cost {
  const summed = turns.reduce(
    (acc, t) => addKnownCost(acc, t.cost),
    emptyMaybeCost(),
  );
  return summed.raw === 0 ? emptyCost() : summed;
}

function bucketRaw(turns: Turn[], bucket: Bucket): number {
  return turns
    .filter((t) => t.bucket === bucket)
    .reduce((sum, t) => sum + t.cost.raw, 0);
}

function percentOf(parent: Cost, nodeCost: Cost): number {
  if (parent.raw === 0) return 0;
  return (100 * nodeCost.raw) / parent.raw;
}

function makeBucketNode(
  bucket: Bucket,
  label: string,
  turns: Turn[],
  parentCost: Cost,
  idPrefix: string,
): TreeNode {
  const bucketTurns = turns.filter((t) => t.bucket === bucket);
  const nodeCost = sumTurns(bucketTurns);
  return {
    id: `${idPrefix}:${bucket}`,
    kind: "bucket",
    label,
    bucket,
    cost: nodeCost,
    percentOfParent: percentOf(parentCost, nodeCost),
    children: [],
    turnIds: bucketTurns.map((t) => t.id),
  };
}

export function buildTree(args: {
  sessionId: string;
  label: string;
  turns: Turn[];
  children: SessionSnapshot[];
}): TreeNode {
  const ownCost = sumTurns(args.turns);

  const subagentsCost = args.children.reduce(
    (acc, child) => addKnownCost(acc, child.cost),
    emptyMaybeCost(),
  );

  const rootCost = addKnownCost(ownCost, subagentsCost);

  const bucketNodes = new Map<Bucket, TreeNode>();
  for (const bucket of BUCKET_ORDER) {
    bucketNodes.set(
      bucket,
      makeBucketNode(bucket, bucket, args.turns, rootCost, args.sessionId),
    );
  }

  const subagentChildren: TreeNode[] = args.children.map((child) => {
    const childTree = buildTree({
      sessionId: child.id,
      label: child.nickname ?? child.id,
      turns: child.turns,
      children: child.children,
    });
    return {
      id: `${args.sessionId}:child:${child.id}`,
      kind: "child" as const,
      label: child.nickname ?? child.id,
      sessionId: child.id,
      cost: child.cost,
      percentOfParent: percentOf(subagentsCost, child.cost),
      children: childTree.children,
      turnIds: [],
    };
  });

  const subagentsNode: TreeNode = {
    id: `${args.sessionId}:subagents`,
    kind: "subagents",
    label: "subagents",
    cost: subagentsCost,
    percentOfParent: percentOf(rootCost, subagentsCost),
    children: subagentChildren,
    turnIds: [],
  };

  const pollNode = bucketNodes.get("waiting.poll")!;
  const coordNode = bucketNodes.get("waiting.coord")!;
  const waitingCost = addKnownCost(pollNode.cost, coordNode.cost);
  pollNode.percentOfParent = percentOf(waitingCost, pollNode.cost);
  coordNode.percentOfParent = percentOf(waitingCost, coordNode.cost);

  const waitingNode: TreeNode = {
    id: `${args.sessionId}:waiting`,
    kind: "waiting",
    label: "waiting",
    cost: waitingCost,
    percentOfParent: percentOf(rootCost, waitingCost),
    children: [pollNode, coordNode],
    turnIds: [],
  };

  const childByLabel: Record<(typeof ROOT_CHILD_LABELS)[number], TreeNode> = {
    planning: bucketNodes.get("planning")!,
    code: bucketNodes.get("code")!,
    reread: bucketNodes.get("reread")!,
    subagents: subagentsNode,
    waiting: waitingNode,
    other: bucketNodes.get("other")!,
  };

  const rootChildren = ROOT_CHILD_LABELS.map((label) => {
    const node = childByLabel[label];
    node.percentOfParent = percentOf(rootCost, node.cost);
    return node;
  });

  return {
    id: args.sessionId,
    kind: "root",
    label: args.label,
    sessionId: args.sessionId,
    cost: rootCost,
    percentOfParent: 100,
    children: rootChildren,
    turnIds: [],
  };
}

export function isIdleChild(child: SessionSnapshot): boolean {
  const ownRaw = sumTurns(child.turns).raw;
  if (ownRaw === 0) return false;

  const codeRaw = bucketRaw(child.turns, "code");
  if (codeRaw !== 0) return false;

  const pollRaw = bucketRaw(child.turns, "waiting.poll");
  const rereadRaw = bucketRaw(child.turns, "reread");
  return (pollRaw + rereadRaw) / ownRaw >= 0.8;
}
