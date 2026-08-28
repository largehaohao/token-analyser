import {
  addCost,
  addKnownCost,
  emptyCost,
  emptyMaybeCost,
  type Cost,
  type SessionSnapshot,
  type Turn,
} from "./types.ts";

export const OVERVIEW_SLICE_KEYS = [
  "planning",
  "code",
  "reread",
  "subagents",
  "waiting",
  "other",
] as const;

export type OverviewSliceKey = (typeof OVERVIEW_SLICE_KEYS)[number];

export type OverviewSlice = {
  key: OverviewSliceKey;
  raw: number;
  credits: number | null;
  usd: number | null;
};

export type OverviewDay = {
  date: string;
  cost: Cost;
  flaggedCost: Cost;
};

export type Overview = {
  sessionCount: number;
  turnCount: number;
  live: boolean;
  collecting: boolean;
  watchPath: string;
  cost: Cost;
  waste: Cost;
  unpricedRaw: number;
  days: OverviewDay[];
  slices: OverviewSlice[];
};

export type OverviewOptions = {
  watchPath: string;
  collecting?: boolean;
  now?: string;
  dayCount?: number;
  sinceMs?: number;
};

export const OVERVIEW_EARLIER_DATE = "earlier";
export const OVERVIEW_LATER_DATE = "later";

const SLICE_SET = new Set<string>(OVERVIEW_SLICE_KEYS);

function countTurns(snap: SessionSnapshot): number {
  return (
    snap.turns.length +
    snap.children.reduce((sum, child) => sum + countTurns(child), 0)
  );
}

function utcDay(iso: string): string | null {
  if (!iso || iso.length < 10) return null;
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function dayRange(nowIso: string, count: number): string[] {
  const now = new Date(nowIso);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function emptySliceMap(): Record<OverviewSliceKey, Cost> {
  return {
    planning: emptyCost(),
    code: emptyCost(),
    reread: emptyCost(),
    subagents: emptyCost(),
    waiting: emptyCost(),
    other: emptyCost(),
  };
}

function sessionTimeMs(session: SessionSnapshot): number | null {
  const iso = session.lastEventAt ?? session.startedAt ?? "";
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function inRange(session: SessionSnapshot, sinceMs?: number): boolean {
  if (sinceMs == null) return true;
  const t = sessionTimeMs(session);
  return t != null && t >= sinceMs;
}

function walkTurns(
  session: SessionSnapshot,
  visit: (turn: Turn, flagged: boolean) => void,
): void {
  const flagged =
    session.ledger_warning || session.parse_errors.length > 0;
  for (const turn of session.turns) visit(turn, flagged);
  for (const child of session.children) walkTurns(child, visit);
}

export function buildOverview(
  sessions: SessionSnapshot[],
  opts: OverviewOptions,
): Overview {
  const now = opts.now ?? new Date().toISOString();
  const included = sessions.filter((session) => inRange(session, opts.sinceMs));
  const dayCount = opts.dayCount ?? 8;
  const days = dayRange(now, dayCount);
  const lastDay = days[days.length - 1] ?? "";
  const dayCosts = new Map(days.map((date) => [date, emptyMaybeCost()]));
  const dayFlagged = new Map(days.map((date) => [date, emptyMaybeCost()]));
  const slices = emptySliceMap();

  let cost = emptyMaybeCost();
  let waste = emptyMaybeCost();
  let turnCount = 0;
  let unpricedRaw = 0;
  let overflow = emptyMaybeCost();
  let overflowFlagged = emptyMaybeCost();
  let later = emptyMaybeCost();
  let laterFlagged = emptyMaybeCost();

  for (const session of included) {
    waste = addKnownCost(waste, session.waste);
    turnCount += countTurns(session);

    walkTurns(session, (turn, flagged) => {
      if (turn.cost.credits == null) unpricedRaw += turn.cost.raw;
      cost = addKnownCost(cost, turn.cost);

      const day = utcDay(turn.endedAt || turn.startedAt);
      if (day && dayCosts.has(day)) {
        dayCosts.set(day, addKnownCost(dayCosts.get(day)!, turn.cost));
        if (flagged) {
          dayFlagged.set(day, addKnownCost(dayFlagged.get(day)!, turn.cost));
        }
      } else if (day && lastDay && day > lastDay) {
        later = addKnownCost(later, turn.cost);
        if (flagged) laterFlagged = addKnownCost(laterFlagged, turn.cost);
      } else {
        overflow = addKnownCost(overflow, turn.cost);
        if (flagged) overflowFlagged = addKnownCost(overflowFlagged, turn.cost);
      }
    });

    for (const child of session.tree.children) {
      const key = SLICE_SET.has(child.label)
        ? (child.label as OverviewSliceKey)
        : "other";
      slices[key] = addCost(slices[key], child.cost);
    }
  }

  if (cost.raw === 0) cost = emptyCost();
  if (waste.raw === 0) waste = emptyCost();

  const chartDays: OverviewDay[] = days.map((date) => ({
    date,
    cost: dayCosts.get(date)!,
    flaggedCost: dayFlagged.get(date)!,
  }));
  if (overflow.raw !== 0 || overflowFlagged.raw !== 0) {
    chartDays.unshift({
      date: OVERVIEW_EARLIER_DATE,
      cost: overflow,
      flaggedCost: overflowFlagged,
    });
  }
  if (later.raw !== 0 || laterFlagged.raw !== 0) {
    chartDays.push({
      date: OVERVIEW_LATER_DATE,
      cost: later,
      flaggedCost: laterFlagged,
    });
  }

  return {
    sessionCount: included.length,
    turnCount,
    live: included.some((session) => session.live),
    collecting: opts.collecting ?? true,
    watchPath: opts.watchPath,
    cost,
    waste,
    unpricedRaw,
    days: chartDays,
    slices: OVERVIEW_SLICE_KEYS.map((key) => ({
      key,
      raw: slices[key].raw,
      credits: slices[key].credits,
      usd: slices[key].usd,
    })),
  };
}
