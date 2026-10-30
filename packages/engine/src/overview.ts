import {
  addKnownCost,
  emptyCost,
  emptyMaybeCost,
  type Cost,
  type SessionSnapshot,
  type Turn,
  type PerformanceSummary,
  type SessionSource,
} from "./types.ts";
import { computeWaste } from "./waste.ts";
import { loadRateCard } from "./rate-card.ts";
import { loadApiPrices } from "./native-pricing.ts";
import {
  collectTaskTimings,
  performanceDistribution,
  requestTimings,
  summarizePerformance,
  type PerformanceDistribution,
} from "./performance.ts";

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

/** The most recent source-recorded usage-limit snapshot in the window. */
export type OverviewRateLimits = {
  sessionId: string;
  source: SessionSource;
  capturedAt: string | null;
  raw: unknown;
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
  /** Date of the Qwen rates in `config/api-prices.json`; empty when absent. */
  apiPricesAsOf: string;
  fastMultiplier: number;
  quality: {
    pricedRaw: number;
    unpricedRaw: number;
    ledgerWarningSessions: number;
    parseErrors: number;
  };
  days: OverviewDay[];
  slices: OverviewSlice[];
  models: OverviewModel[];
  performance: PerformanceSummary;
  performanceDistribution: PerformanceDistribution;
  rateLimits: OverviewRateLimits | null;
};

export type OverviewOptions = {
  source?: SessionSource;
  watchPath: string;
  collecting?: boolean;
  now?: string;
  dayCount?: number;
  sinceMs?: number;
  /** Exclusive upper bound, used for the equal-length previous window. */
  untilMs?: number;
  /** IANA timezone from the browser, used for DST-correct trend buckets. */
  timezone?: string;
  /** Minutes east of UTC, matching `-Date#getTimezoneOffset()`. */
  timezoneOffsetMinutes?: number;
  /**
   * When set, days / cost / slices / performance only include this model.
   * The models list still covers every model in the window.
   */
  model?: string;
};

/** Stable model key for overview grouping and filters. */
export function turnModelKey(model: string | null | undefined): string {
  return model?.trim() || "(unknown)";
}

export const OVERVIEW_EARLIER_DATE = "earlier";
export const OVERVIEW_LATER_DATE = "later";

const SLICE_SET = new Set<string>(OVERVIEW_SLICE_KEYS);

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

function latestRateLimits(
  sessions: SessionSnapshot[],
  sinceMs?: number,
  untilMs?: number,
): OverviewRateLimits | null {
  let best: OverviewRateLimits | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  function visit(session: SessionSnapshot): void {
    for (const snapshot of session.rateLimitSnapshots ?? []) {
      const ms = parseTimeMs(snapshot.capturedAt);
      if (ms == null || (sinceMs != null && ms < sinceMs) || (untilMs != null && ms >= untilMs)) continue;
      if (ms >= bestMs) {
        bestMs = ms;
        best = {
          sessionId: session.id,
          source: session.source ?? "codex",
          capturedAt: snapshot.capturedAt,
          raw: snapshot.raw,
        };
      }
    }
    for (const child of session.children) visit(child);
  }
  for (const session of sessions) visit(session);
  return best;
}

function hasTurnInRange(
  session: SessionSnapshot,
  sinceMs: number | undefined,
  untilMs: number | undefined,
): boolean {
  for (const turn of session.turns)
    if (turnInRange(turn, sinceMs, untilMs)) return true;
  return session.children.some((child) =>
    hasTurnInRange(child, sinceMs, untilMs),
  );
}

function inRange(
  session: SessionSnapshot,
  sinceMs?: number,
  untilMs?: number,
): boolean {
  const t = sessionTimeMs(session);
  if (sinceMs != null && !(t != null && t >= sinceMs)) return false;
  // A session that stayed active across the upper bound still belongs to the
  // earlier window; its turns are filtered separately.
  if (untilMs != null) {
    const endedBefore = t != null && t < untilMs;
    if (!endedBefore && !hasTurnInRange(session, undefined, untilMs))
      return false;
  }
  return true;
}

function turnTimeMs(turn: Turn): number | null {
  const iso = turn.endedAt || turn.startedAt;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function turnInRange(turn: Turn, sinceMs?: number, untilMs?: number): boolean {
  const t = turnTimeMs(turn);
  if (sinceMs != null && !(t != null && t >= sinceMs)) return false;
  if (untilMs != null && !(t != null && t < untilMs)) return false;
  return true;
}

function inWindowRange(turn: Turn, sinceMs: number | undefined, untilMs: number | undefined): boolean {
  return turnInRange(turn, sinceMs, untilMs);
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

function flattenTurns(session: SessionSnapshot): Turn[] {
  return [
    ...session.turns,
    ...session.children.flatMap((child) => flattenTurns(child)),
  ];
}

function turnMatchesModel(turn: Turn, model: string | undefined): boolean {
  if (model == null || model === "") return true;
  return turnModelKey(turn.model) === model;
}

function collectTurnsById(
  session: SessionSnapshot,
  map = new Map<string, Turn>(),
): Map<string, Turn> {
  for (const turn of session.turns) map.set(turn.id, turn);
  for (const child of session.children) collectTurnsById(child, map);
  return map;
}

function windowTurnIds(
  session: SessionSnapshot,
  sinceMs?: number,
  untilMs?: number,
): Set<string> {
  const ids = new Set<string>();
  walkTurns(session, (turn) => {
    if (inWindowRange(turn, sinceMs, untilMs)) ids.add(turn.id);
  });
  return ids;
}

function windowedWaste(
  session: SessionSnapshot,
  sinceMs?: number,
  untilMs?: number,
  model?: string,
): Cost {
  const { turnIds } = computeWaste({
    turns: session.turns,
    children: session.children,
    toggles: session.toggles,
  });
  const inWindow = windowTurnIds(session, sinceMs, untilMs);
  const byId = collectTurnsById(session);
  let waste = emptyMaybeCost();
  for (const id of turnIds) {
    if (!inWindow.has(id)) continue;
    const turn = byId.get(id)!;
    if (!turnMatchesModel(turn, model)) continue;
    waste = addKnownCost(waste, turn.cost);
  }
  return normalizeCost(waste);
}

function filterSessionTurns(
  session: SessionSnapshot,
  sinceMs?: number,
  untilMs?: number,
): SessionSnapshot {
  if (sinceMs == null && untilMs == null) return session;
  return {
    ...session,
    turns: session.turns.filter((turn) => inWindowRange(turn, sinceMs, untilMs)),
    children: session.children.map((child) =>
      filterSessionTurns(child, sinceMs, untilMs),
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
  return cost.raw === 0 && !cost.unmeasured && !cost.usd ? emptyCost() : cost;
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
  const matchingSource = sessions.filter((session) =>
    !opts.source || (session.source ?? "codex") === opts.source,
  );
  const included = matchingSource.filter((session) =>
    inRange(session, opts.sinceMs, opts.untilMs),
  );
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
  let sessionCount = 0;
  let unpricedRaw = 0;
  let overflow = emptyMaybeCost();
  let overflowFlagged = emptyMaybeCost();
  let overflowUnpriced = 0;
  let later = emptyMaybeCost();
  let laterFlagged = emptyMaybeCost();
  let laterUnpriced = 0;
  let ledgerWarningSessions = 0;
  let parseErrors = 0;
  const modelFilter = opts.model?.trim() || undefined;

  for (const session of included) {
    const ranged = filterSessionTurns(session, opts.sinceMs, opts.untilMs);
    waste = addKnownCost(
      waste,
      windowedWaste(session, opts.sinceMs, opts.untilMs, modelFilter),
    );
    let sessionMatched = false;

    walkTurns(ranged, (turn, flagged, nested) => {
      const model = turnModelKey(turn.model);
      const prev = models.get(model) ?? {
        cost: emptyMaybeCost(),
        turnCount: 0,
        unpricedRaw: 0,
      };
      prev.cost = addKnownCost(prev.cost, turn.cost);
      prev.turnCount += 1;
      if (turn.cost.credits == null && turn.cost.usd == null) prev.unpricedRaw += turn.cost.raw;
      models.set(model, prev);

      if (!turnMatchesModel(turn, modelFilter)) return;
      sessionMatched = true;
      turnCount += 1;
      if (turn.cost.credits == null && turn.cost.usd == null) unpricedRaw += turn.cost.raw;
      cost = addKnownCost(cost, turn.cost);
      const key = sliceKey(turn, nested);
      slices[key] = addKnownCost(slices[key], turn.cost);

      const day = calendarDay(
        turn.endedAt || turn.startedAt,
        timezoneFormatter,
        timezoneOffsetMinutes,
      );
      const unpriced = turn.cost.credits == null && turn.cost.usd == null ? turn.cost.raw : 0;
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
    // Quality follows the same session membership as cost/days when filtered.
    if (sessionMatched || modelFilter == null) {
      sessionCount += 1;
      const quality = collectQuality(session);
      ledgerWarningSessions += quality.ledgerWarningSessions;
      parseErrors += quality.parseErrors;
    }
  }

  const chartDays: OverviewDay[] = days.map((date) =>
    makeDay(
      date,
      dayCosts.get(date)!,
      dayFlagged.get(date)!,
      dayUnpriced.get(date) ?? 0,
    ),
  );
  if (overflow.raw !== 0 || overflowFlagged.raw !== 0 || overflow.unmeasured || overflow.usd) {
    chartDays.unshift(
      makeDay(OVERVIEW_EARLIER_DATE, overflow, overflowFlagged, overflowUnpriced),
    );
  }
  if (later.raw !== 0 || laterFlagged.raw !== 0 || later.unmeasured || later.usd) {
    chartDays.push(makeDay(OVERVIEW_LATER_DATE, later, laterFlagged, laterUnpriced));
  }

  const timedSamples = included.flatMap((session) => {
    const ranged = filterSessionTurns(session, opts.sinceMs, opts.untilMs);
    // Model filters are turn-scoped; task windows are not attributed to a model.
    if (modelFilter) {
      const turns = flattenTurns(ranged).filter((turn) =>
        turnMatchesModel(turn, modelFilter),
      );
      return requestTimings(turns).map((sample) => ({
        ...sample,
        basis: "request" as const,
      }));
    }
    const hasTasks = collectTaskTimings(session).length > 0;
    // Sources without agent-task windows time a single model request.
    return (hasTasks ? collectTaskTimings(session) : requestTimings(session.turns))
      .map((sample) => ({ ...sample, basis: hasTasks ? ("task" as const) : ("request" as const) }))
      .filter((sample) =>
        (opts.sinceMs == null || (sample.endedAt != null && Date.parse(sample.endedAt) >= opts.sinceMs)) &&
          (opts.untilMs == null || (sample.endedAt != null && Date.parse(sample.endedAt) < opts.untilMs)),
      );
  });

  const card = loadRateCard();
  return {
    sessionCount: modelFilter ? sessionCount : included.length,
    turnCount,
    live: included.some((session) => session.live),
    collecting: opts.collecting ?? true,
    watchPath: opts.watchPath,
    cost: normalizeCost(cost),
    waste: normalizeCost(waste),
    unpricedRaw,
    rateCardAsOf: card.as_of,
    apiPricesAsOf: loadApiPrices().qwen?.as_of ?? "",
    fastMultiplier: card.fast_multiplier,
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
    performance: summarizePerformance(timedSamples),
    performanceDistribution: performanceDistribution(timedSamples),
    rateLimits: latestRateLimits(matchingSource, opts.sinceMs, opts.untilMs),
  };
}
