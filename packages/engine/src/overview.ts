import {
  addCost,
  emptyCost,
  type Cost,
  type SessionSnapshot,
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
  const iso = session.startedAt ?? session.lastEventAt ?? "";
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function inRange(session: SessionSnapshot, sinceMs?: number): boolean {
  if (sinceMs == null) return true;
  const t = sessionTimeMs(session);
  return t == null || t >= sinceMs;
}

export function buildOverview(
  sessions: SessionSnapshot[],
  opts: OverviewOptions,
): Overview {
  const now = opts.now ?? new Date().toISOString();
  const included = sessions.filter((session) => inRange(session, opts.sinceMs));
  const dayCount = opts.dayCount ?? 8;
  const days = dayRange(now, dayCount);
  const dayCosts = new Map(days.map((date) => [date, emptyCost()]));
  const dayFlagged = new Map(days.map((date) => [date, emptyCost()]));
  const slices = emptySliceMap();

  let cost = emptyCost();
  let waste = emptyCost();
  let turnCount = 0;

  for (const session of included) {
    cost = addCost(cost, session.cost);
    waste = addCost(waste, session.waste);
    turnCount += countTurns(session);

    const day = utcDay(session.startedAt ?? session.lastEventAt ?? "");
    if (day && dayCosts.has(day)) {
      dayCosts.set(day, addCost(dayCosts.get(day)!, session.cost));
      if (session.ledger_warning || session.parse_errors.length > 0) {
        dayFlagged.set(day, addCost(dayFlagged.get(day)!, session.cost));
      }
    }

    for (const child of session.tree.children) {
      const key = SLICE_SET.has(child.label)
        ? (child.label as OverviewSliceKey)
        : "other";
      slices[key] = addCost(slices[key], child.cost);
    }
  }

  return {
    sessionCount: included.length,
    turnCount,
    live: included.some((session) => session.live),
    collecting: opts.collecting ?? true,
    watchPath: opts.watchPath,
    cost,
    waste,
    days: days.map((date) => ({
      date,
      cost: dayCosts.get(date)!,
      flaggedCost: dayFlagged.get(date)!,
    })),
    slices: OVERVIEW_SLICE_KEYS.map((key) => ({
      key,
      raw: slices[key].raw,
      credits: slices[key].credits,
      usd: slices[key].usd,
    })),
  };
}
