export const TURN_PAGE_SIZE = 200;

export function nextTurnLimit(
  current: number,
  total: number,
  page = TURN_PAGE_SIZE,
): number {
  return Math.min(total, current + page);
}

export function visibleTurns<T>(turns: T[], limit: number): T[] {
  return turns.slice(0, Math.max(0, limit));
}

export function limitIncludingId<T extends { id: string }>(
  turns: T[],
  limit: number,
  highlightId: string | null,
  page = TURN_PAGE_SIZE,
): number {
  const capped = Math.min(Math.max(limit, 0), turns.length);
  if (!highlightId) return capped;
  const index = turns.findIndex((turn) => turn.id === highlightId);
  if (index < 0) return capped;
  const needed = Math.ceil((index + 1) / page) * page;
  return Math.min(turns.length, Math.max(capped, needed));
}
