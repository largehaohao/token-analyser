import type { SessionListItem, SessionSource } from "./api";

export type SessionSourceFilter = "all" | SessionSource;

export const SESSION_SOURCES = [
  { id: "all", label: "所有来源" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "pi", label: "pi" },
] as const;

export function normalizeSourceFilter(value: unknown): SessionSourceFilter {
  return SESSION_SOURCES.find((item) => item.id === value)?.id ?? "all";
}

export function filterSessionsBySource(
  sessions: SessionListItem[],
  source: SessionSourceFilter,
): SessionListItem[] {
  return source === "all"
    ? sessions
    : sessions.filter((s) => (s.source ?? "codex") === source);
}

export function sourceCounts(
  sessions: SessionListItem[],
): Record<SessionSourceFilter, number> {
  const counts = { all: sessions.length, codex: 0, claude: 0, cursor: 0, pi: 0 };
  for (const session of sessions) counts[session.source ?? "codex"] += 1;
  return counts;
}

export function sourceEmptyCopy(source: SessionSourceFilter): string {
  const label = SESSION_SOURCES.find((item) => item.id === source)!.label;
  return source === "all"
    ? "在本机运行 Codex、Claude Code、Cursor 或 pi 后，会话会自动出现在这里。也可以选择或拖入已有的 JSONL 记录。"
    : `未发现 ${label} 会话记录。可在本机运行 ${label}，或选择、拖入该来源的 JSONL 记录。`;
}
