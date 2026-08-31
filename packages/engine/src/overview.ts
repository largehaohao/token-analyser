import {
  addKnownCost,
  emptyCost,
  emptyMaybeCost,
  type Cost,
  type SessionSnapshot,
  type Turn,
} from "./types.ts";
import { computeWaste } from "./waste.ts";
import { loadRateCard } from "./rate-card.ts";

export const OVERVIEW_SLICE_KEYS = [
  "planning",
  "reading",
  "verification",
  "code",
  "reread",
  "tooling",
  "communication",
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

export type OverviewModel = {
  model: string;
  turnCount: number;
  cost: Cost;
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
  rateCardAsOf: string;
  quality: {
    pricedRaw: number;
    unpricedRaw: number;
    ledgerWarningSessions: number;
    parseErrors: number;
  };
  days: OverviewDay[];
  slices: OverviewSlice[];
  models: OverviewModel[];
};

export type OverviewOptions = {
  watchPath: string;
  collecting?: boolean;
  now?: string;
  dayCount?: number;
  sinceMs?: number;
  /** IANA timezone from the browser, used for DST-correct trend buckets. */
  timezone?: string;
  /** Minutes east of UTC, matching `-Date#getTimezoneOffset()`. */
  timezoneOffsetMinutes?: number;
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

function collectQuality(
  session: SessionSnapshot,
): { ledgerWarningSessions: number; parseErrors: number } {
  let ledgerWarningSessions = session.ledger_warning ? 1 : 0;
  let parseErrors = session.parse_errors.length;
  for (const child of session.children) {
    const quality = collectQuality(child);
    ledgerWarningSessions += quality.ledgerWarningSessions;
    parseErrors += quality.parseErrors;
  }
  return { ledgerWarningSessions, parseErrors };
}

function createTimezoneFormatter(
  timezone: string | undefined,
): Intl.DateTimeFormat | undefined {
  if (!timezone) return undefined;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return undefined;
  }
}

function calendarDay(
  iso: string,
  timezoneFormatter: Intl.DateTimeFormat | undefined,
  timezoneOffsetMinutes = 0,
): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  if (timezoneFormatter) {
    const parts = timezoneFormatter.formatToParts(time);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const day = `${value.year}-${value.month}-${value.day}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  }
  const day = new Date(time + timezoneOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function dayRange(
  nowIso: string,
  count: number,
  timezoneFormatter: Intl.DateTimeFormat | undefined,
  timezoneOffsetMinutes = 0,
): string[] {
  const currentDay = calendarDay(
    nowIso,
    timezoneFormatter,
    timezoneOffsetMinutes,
  );
  const end = Date.parse(`${currentDay ?? nowIso.slice(0, 10)}T00:00:00.000Z`);
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function emptySliceMap(): Record<OverviewSliceKey, Cost> {
  return {
    planning: emptyMaybeCost(),
    reading: emptyMaybeCost(),
    verification: emptyMaybeCost(),
    code: emptyMaybeCost(),
    reread: emptyMaybeCost(),
    tooling: emptyMaybeCost(),
    communication: emptyMaybeCost(),
    subagents: emptyMaybeCost(),
    waiting: emptyMaybeCost(),
    other: emptyMaybeCost(),
  };
}

function parseTimeMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function sessionTimeMs(session: SessionSnapshot): number | null {
  let best = parseTimeMs(session.lastEventAt ?? session.startedAt);
  for (const child of session.children) {
    const childMs = sessionTimeMs(child);
    if (childMs != null && (best == null || childMs > best)) best = childMs;
  }
  return best;
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

function collectTurnsById(
  session: SessionSnapshot,
  map = new Map<string, Turn>(),
): Map<string, Turn> {
  for (const turn of session.turns) map.set(turn.id, turn);
  for (const child of session.children) collectTurnsById(child, map);
  return map;
}

function windowTurnIds(session: SessionSnapshot, sinceMs?: number): Set<string> {
  const ids = new Set<string>();
  walkTurns(session, (turn) => {
    if (turnInRange(turn, sinceMs)) ids.add(turn.id);
  });
  return ids;
}

function windowedWaste(session: SessionSnapshot, sinceMs?: number): Cost {
  const { turnIds } = computeWaste({
    turns: session.turns,
    children: session.children,
    toggles: session.toggles,
  });
  const inWindow = windowTurnIds(session, sinceMs);
  const byId = collectTurnsById(session);
  let waste = emptyMaybeCost();
  for (const id of turnIds) {
    if (!inWindow.has(id)) continue;
    waste = addKnownCost(waste, byId.get(id)!.cost);
  }
  return waste.raw === 0 ? emptyCost() : waste;
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
  const timezoneFormatter = createTimezoneFormatter(opts.timezone);
  const timezoneOffsetMinutes = opts.timezoneOffsetMinutes ?? 0;
  const days = dayRange(
    now,
    dayCount,
    timezoneFormatter,
    timezoneOffsetMinutes,
  );
  const lastDay = days[days.length - 1] ?? "";
  const dayCosts = new Map(days.map((date) => [date, emptyMaybeCost()]));
  const dayFlagged = new Map(days.map((date) => [date, emptyMaybeCost()]));
  const dayUnpriced = new Map(days.map((date) => [date, 0]));
  const slices = emptySliceMap();
  const models = new Map<
    string,
    { cost: Cost; turnCount: number; unpricedRaw: number }
  >();

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
  let ledgerWarningSessions = 0;
  let parseErrors = 0;

  for (const session of included) {
    const quality = collectQuality(session);
    ledgerWarningSessions += quality.ledgerWarningSessions;
    parseErrors += quality.parseErrors;
    const ranged = filterSessionTurns(session, opts.sinceMs);
    waste = addKnownCost(waste, windowedWaste(session, opts.sinceMs));
    turnCount += countTurns(ranged);

    walkTurns(ranged, (turn, flagged, nested) => {
      if (turn.cost.credits == null) unpricedRaw += turn.cost.raw;
      cost = addKnownCost(cost, turn.cost);
      const key = sliceKey(turn, nested);
      slices[key] = addKnownCost(slices[key], turn.cost);
      const model = turn.model?.trim() || "(unknown)";
      const prev = models.get(model) ?? {
        cost: emptyMaybeCost(),
        turnCount: 0,
        unpricedRaw: 0,
      };
      prev.cost = addKnownCost(prev.cost, turn.cost);
      prev.turnCount += 1;
      if (turn.cost.credits == null) prev.unpricedRaw += turn.cost.raw;
      models.set(model, prev);

      const day = calendarDay(
        turn.endedAt || turn.startedAt,
        timezoneFormatter,
        timezoneOffsetMinutes,
      );
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
    rateCardAsOf: loadRateCard().as_of,
    quality: {
      pricedRaw: Math.max(0, cost.raw - unpricedRaw),
      unpricedRaw,
      ledgerWarningSessions,
      parseErrors,
    },
    days: chartDays,
    slices: OVERVIEW_SLICE_KEYS.map((key) => ({
      key,
      raw: slices[key].raw,
      credits: slices[key].raw === 0 ? 0 : slices[key].credits,
      usd: slices[key].raw === 0 ? 0 : slices[key].usd,
    })),
    models: [...models.entries()]
      .map(([model, entry]) => ({
        model,
        turnCount: entry.turnCount,
        cost: normalizeCost(entry.cost),
        unpricedRaw: entry.unpricedRaw,
      }))
      .sort((a, b) => b.cost.raw - a.cost.raw || a.model.localeCompare(b.model)),
  };
}
