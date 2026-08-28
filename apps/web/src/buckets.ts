export type SliceKey =
  | "planning"
  | "code"
  | "reread"
  | "subagents"
  | "waiting"
  | "other";

export const SLICE_META: Record<SliceKey, { label: string; color: string }> = {
  planning: { label: "规划与思考", color: "#5b8cff" },
  code: { label: "代码与执行", color: "#7dffb3" },
  reread: { label: "重复读取", color: "#ff9f5a" },
  subagents: { label: "子 Agent", color: "#a78bfa" },
  waiting: { label: "等待 / 轮询", color: "#38bdf8" },
  other: { label: "其他 / 未知", color: "#fb7185" },
};

const TREE_LABELS: Record<string, { label: string; color: string }> = {
  planning: SLICE_META.planning,
  code: SLICE_META.code,
  reread: SLICE_META.reread,
  subagents: SLICE_META.subagents,
  waiting: SLICE_META.waiting,
  other: SLICE_META.other,
  "waiting.poll": { label: "轮询 wait", color: "#38bdf8" },
  "waiting.coord": { label: "协调 spawn", color: "#818cf8" },
};

export function treeAppearance(
  label: string,
  kind: string,
  bucket?: string,
): { label: string; color: string } {
  const key = bucket ?? label;
  if (key in TREE_LABELS) return TREE_LABELS[key];
  if (kind === "child") return { label, color: SLICE_META.subagents.color };
  return { label, color: "#7dffb3" };
}

export const LABEL_CHIP: Record<string, string> = {
  poll_spin: "空转轮询",
  reread_repeat: "重复读",
  compaction_loop: "压缩回读",
};
