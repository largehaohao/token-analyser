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
