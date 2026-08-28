import {
  addKnownCost,
  emptyCost,
  emptyMaybeCost,
  type Cost,
  type SessionSnapshot,
  type Turn,
} from "./types.ts";
import { computeWaste } from "./waste.ts";

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
  unpricedRaw: number;
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
    planning: emptyMaybeCost(),
    code: emptyMaybeCost(),
    reread: emptyMaybeCost(),
    subagents: emptyMaybeCost(),
    waiting: emptyMaybeCost(),
    other: emptyMaybeCost(),
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

function turnTimeMs(turn: Turn): number | null {
  const iso = turn.endedAt || turn.startedAt;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function turnInRange(turn: Turn, sinceMs?: number): boolean {
  if (sinceMs == null) return true;
  const t = turnTimeMs(turn);
  return t != null && t >= sinceMs;
}

function walkTurns(
  session: SessionSnapshot,
  visit: (turn: Turn, flagged: boolean, nested: boolean) => void,
  nested = false,
): void {
  const flagged =
    session.ledger_warning || session.parse_errors.length > 0;
  for (const turn of session.turns) visit(turn, flagged, nested);
  for (const child of session.children) walkTurns(child, visit, true);
}

function filterSessionTurns(
  session: SessionSnapshot,
  sinceMs?: number,
): SessionSnapshot {
  if (sinceMs == null) return session;
  return {
    ...session,
    turns: session.turns.filter((turn) => turnInRange(turn, sinceMs)),
    children: session.children.map((child) =>
      filterSessionTurns(child, sinceMs),
    ),
  };
}

function sliceKey(turn: Turn, nested: boolean): OverviewSliceKey {
  if (nested) return "subagents";
  const bucket = turn.bucket ?? "other";
  if (bucket === "waiting.poll" || bucket === "waiting.coord") return "waiting";
  if (SLICE_SET.has(bucket)) return bucket as OverviewSliceKey;
  return "other";
}

function normalizeCost(cost: Cost): Cost {
  return cost.raw === 0 ? emptyCost() : cost;
}

function makeDay(date: string, cost: Cost, flagged: Cost, unpricedRaw: number): OverviewDay {
  return {
    date,
    cost: normalizeCost(cost),
    flaggedCost: normalizeCost(flagged),
    unpricedRaw,
  };
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
  const dayUnpriced = new Map(days.map((date) => [date, 0]));
  const slices = emptySliceMap();

  let cost = emptyMaybeCost();
  let waste = emptyMaybeCost();
  let turnCount = 0;
  let unpricedRaw = 0;
  let overflow = emptyMaybeCost();
  let overflowFlagged = emptyMaybeCost();
  let overflowUnpriced = 0;
  let later = emptyMaybeCost();
  let laterFlagged = emptyMaybeCost();
  let laterUnpriced = 0;

  for (const session of included) {
    const ranged = filterSessionTurns(session, opts.sinceMs);
    const sessionWaste = computeWaste({
      turns: ranged.turns,
      children: ranged.children,
      toggles: session.toggles,
    }).waste;
    waste = addKnownCost(waste, sessionWaste);
    turnCount += countTurns(ranged);

    walkTurns(ranged, (turn, flagged, nested) => {
      if (turn.cost.credits == null) unpricedRaw += turn.cost.raw;
      cost = addKnownCost(cost, turn.cost);
      const key = sliceKey(turn, nested);
      slices[key] = addKnownCost(slices[key], turn.cost);

      const day = utcDay(turn.endedAt || turn.startedAt);
      const unpriced = turn.cost.credits == null ? turn.cost.raw : 0;
      if (day && dayCosts.has(day)) {
        dayCosts.set(day, addKnownCost(dayCosts.get(day)!, turn.cost));
        dayUnpriced.set(day, (dayUnpriced.get(day) ?? 0) + unpriced);
        if (flagged) {
          dayFlagged.set(day, addKnownCost(dayFlagged.get(day)!, turn.cost));
        }
      } else if (day && lastDay && day > lastDay) {
        later = addKnownCost(later, turn.cost);
        laterUnpriced += unpriced;
        if (flagged) laterFlagged = addKnownCost(laterFlagged, turn.cost);
      } else {
        overflow = addKnownCost(overflow, turn.cost);
        overflowUnpriced += unpriced;
        if (flagged) overflowFlagged = addKnownCost(overflowFlagged, turn.cost);
      }
    });
  }

  const chartDays: OverviewDay[] = days.map((date) =>
    makeDay(
      date,
      dayCosts.get(date)!,
      dayFlagged.get(date)!,
      dayUnpriced.get(date) ?? 0,
    ),
  );
  if (overflow.raw !== 0 || overflowFlagged.raw !== 0) {
    chartDays.unshift(
      makeDay(OVERVIEW_EARLIER_DATE, overflow, overflowFlagged, overflowUnpriced),
    );
  }
  if (later.raw !== 0 || laterFlagged.raw !== 0) {
    chartDays.push(makeDay(OVERVIEW_LATER_DATE, later, laterFlagged, laterUnpriced));
  }

  return {
    sessionCount: included.length,
    turnCount,
    live: included.some((session) => session.live),
    collecting: opts.collecting ?? true,
    watchPath: opts.watchPath,
    cost: normalizeCost(cost),
    waste: normalizeCost(waste),
    unpricedRaw,
    days: chartDays,
    slices: OVERVIEW_SLICE_KEYS.map((key) => ({
      key,
      raw: slices[key].raw,
      credits: slices[key].raw === 0 ? 0 : slices[key].credits,
      usd: slices[key].raw === 0 ? 0 : slices[key].usd,
    })),
  };
}
