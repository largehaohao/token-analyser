export type SliceKey =
  | "planning"
  | "reading"
  | "verification"
  | "code"
  | "reread"
  | "tooling"
  | "communication"
  | "subagents"
  | "waiting"
  | "other";

export const SLICE_META: Record<SliceKey, { label: string; color: string }> = {
  planning: { label: "规划与思考", color: "var(--chart-blue)" },
  reading: { label: "读取与搜索", color: "var(--chart-cyan)" },
  verification: { label: "测试与验证", color: "var(--warn)" },
  code: { label: "代码与执行", color: "var(--accent)" },
  reread: { label: "重复读取", color: "var(--chart-orange)" },
  tooling: { label: "工具与环境", color: "var(--chart-neutral)" },
  communication: { label: "消息沟通", color: "var(--chart-pink)" },
  subagents: { label: "子 Agent", color: "var(--chart-violet)" },
  waiting: { label: "等待 / 轮询", color: "var(--chart-wait)" },
  other: { label: "其他 / 未知", color: "var(--chart-rose)" },
};

const TREE_LABELS: Record<string, { label: string; color: string }> = {
  planning: SLICE_META.planning,
  reading: SLICE_META.reading,
  verification: SLICE_META.verification,
  code: SLICE_META.code,
  reread: SLICE_META.reread,
  tooling: SLICE_META.tooling,
  communication: SLICE_META.communication,
  subagents: SLICE_META.subagents,
  waiting: SLICE_META.waiting,
  other: SLICE_META.other,
  "waiting.poll": { label: "轮询 wait", color: "var(--chart-wait)" },
  "waiting.coord": { label: "协调 spawn", color: "var(--chart-indigo)" },
};

export function treeAppearance(
  label: string,
  kind: string,
  bucket?: string,
): { label: string; color: string } {
  if (kind === "root") return { label: "本会话", color: "var(--text)" };
  const key = bucket ?? label;
  if (key in TREE_LABELS) return TREE_LABELS[key];
  if (kind === "child") return { label, color: SLICE_META.subagents.color };
  return { label, color: "var(--accent)" };
}

export const LABEL_CHIP: Record<string, string> = {
  poll_spin: "空转轮询",
  reread_repeat: "重复读",
  compaction_loop: "压缩回读",
};
