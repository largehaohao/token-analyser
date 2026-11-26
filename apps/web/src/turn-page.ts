export const TURN_PAGE_SIZE = 200;

export type TurnTimingFields = {
  startedAt: string;
  endedAt: string;
};

/** Canonical turn timestamp: prefer when the LLM turn finished over prompt start. */
export function turnTimestamp(turn: TurnTimingFields): string {
  return turn.endedAt || turn.startedAt;
}

function compareTurnIso(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) return aMs - bMs;
  if (Number.isFinite(aMs)) return 1;
  if (Number.isFinite(bMs)) return -1;
  return a.localeCompare(b);
}

/** Order turns newest-first, breaking shared-prompt ties by endedAt then array order. */
export function sortTurnsDescending<T extends TurnTimingFields>(
  turns: readonly T[],
): T[] {
  return turns
    .map((turn, index) => ({ turn, index }))
    .sort(
      (a, b) =>
        compareTurnIso(turnTimestamp(b.turn), turnTimestamp(a.turn)) ||
        compareTurnIso(b.turn.startedAt, a.turn.startedAt) ||
        b.index - a.index,
    )
    .map((entry) => entry.turn);
}

/** Order turns oldest-first for chronological charts. */
export function sortTurnsAscending<T extends TurnTimingFields>(
  turns: readonly T[],
): T[] {
  return turns
    .map((turn, index) => ({ turn, index }))
    .sort(
      (a, b) =>
        compareTurnIso(turnTimestamp(a.turn), turnTimestamp(b.turn)) ||
        compareTurnIso(a.turn.startedAt, b.turn.startedAt) ||
        a.index - b.index,
    )
    .map((entry) => entry.turn);
}

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
