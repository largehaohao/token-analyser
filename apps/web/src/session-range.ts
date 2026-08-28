// `days` is the UTC calendar span a rolling window can cover (window + 1
// midnight crossing). The trend chart must include every day a session in
// range can land on, otherwise KPIs and bars disagree.
export const SESSION_RANGES = [
  { id: "5h", label: "5小时", ms: 5 * 60 * 60 * 1000, days: 2 },
  { id: "1d", label: "1天", ms: 24 * 60 * 60 * 1000, days: 2 },
  { id: "7d", label: "7天", ms: 7 * 24 * 60 * 60 * 1000, days: 8 },
  { id: "30d", label: "30天", ms: 30 * 24 * 60 * 60 * 1000, days: 31 },
  { id: "all", label: "全部", ms: null, days: 30 },
] as const;

export type SessionRangeId = (typeof SESSION_RANGES)[number]["id"];

export const DEFAULT_SESSION_RANGE: SessionRangeId = "7d";

export type DatedSession = {
  startedAt: string | null;
  lastEventAt: string | null;
};

function sessionTimeMs(session: DatedSession): number | null {
  const iso = session.lastEventAt ?? session.startedAt;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function rangeCutoffMs(
  rangeId: SessionRangeId,
  nowMs: number,
): number | null {
  const range = SESSION_RANGES.find((item) => item.id === rangeId);
  if (!range || range.ms == null) return null;
  return nowMs - range.ms;
}

export function overviewQuery(
  rangeId: SessionRangeId,
  nowMs = Date.now(),
): { since?: string; days: number } {
  const range = SESSION_RANGES.find((item) => item.id === rangeId);
  const days = range?.days ?? 8;
  const cutoff = rangeCutoffMs(rangeId, nowMs);
  return {
    days,
    ...(cutoff != null ? { since: new Date(cutoff).toISOString() } : {}),
  };
}

export function filterSessionsByRange<T extends DatedSession>(
  sessions: T[],
  rangeId: SessionRangeId,
  nowMs: number,
): T[] {
  const cutoff = rangeCutoffMs(rangeId, nowMs);
  if (cutoff == null) return sessions;
  return sessions.filter((session) => {
    const t = sessionTimeMs(session);
    return t != null && t >= cutoff;
  });
}
