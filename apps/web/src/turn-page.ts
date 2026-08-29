export const TURN_PAGE_SIZE = 200;

export function highlightScrollBehavior(
  reduceMotion: boolean,
): ScrollBehavior {
  return reduceMotion ? "auto" : "smooth";
}

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

export function visibleTurnWindow<T extends { id: string }>(
  turns: T[],
  limit: number,
  highlightId: string | null,
  page = TURN_PAGE_SIZE,
): T[] {
  if (!highlightId) return visibleTurns(turns, limit);
  const index = turns.findIndex((turn) => turn.id === highlightId);
  if (index < 0) return visibleTurns(turns, limit);
  const size = Math.min(turns.length, Math.max(limit, page, 0));
  const start = Math.max(
    0,
    Math.min(
      index - Math.floor((size - 1) / 2),
      Math.max(0, turns.length - size),
    ),
  );
  return turns.slice(start, start + size);
}
