export const SESSION_PAGE_SIZE = 100;

export function nextSessionLimit(
  current: number,
  total: number,
  page = SESSION_PAGE_SIZE,
): number {
  return Math.min(total, current + page);
}

export function visibleSessions<T>(sessions: T[], limit: number): T[] {
  return sessions.slice(0, Math.max(0, limit));
}

export function resolveSelectedSession(
  selectedId: string | null,
  sessions: { id: string }[],
): string | null {
  if (sessions.length === 0) return null;
  if (selectedId && sessions.some((session) => session.id === selectedId)) {
    return selectedId;
  }
  return sessions[0]?.id ?? null;
}

export function sessionListIdentity(sessions: { id: string }[]): string {
  return sessions
    .map((session) => session.id)
    .slice()
    .sort()
    .join("\n");
}

export function shouldResetSessionLimit(prev: string, next: string): boolean {
  return prev !== next;
}

export function nextSessionIndex(
  length: number,
  currentIndex: number,
  key: "ArrowDown" | "ArrowUp",
): number {
  if (length <= 0) return -1;
  if (currentIndex < 0) return key === "ArrowDown" ? 0 : length - 1;
  if (key === "ArrowDown") return Math.min(length - 1, currentIndex + 1);
  return Math.max(0, currentIndex - 1);
}
