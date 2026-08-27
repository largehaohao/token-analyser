import { buildLedger } from "./ledger.ts";
import { classifyTurns } from "./classify.ts";
import { detect } from "./detect.ts";
import { buildTree } from "./tree.ts";
import { computeWaste } from "./waste.ts";
import { loadRateCard } from "./rate-card.ts";
import {
  DEFAULT_WASTE_TOGGLES,
  type ParseError,
  type RolloutLine,
  type SessionSnapshot,
  type WasteToggleId,
} from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function extractSessionInfo(
  events: RolloutLine[],
  overrideSessionId?: string,
): { id: string; isSubagent: boolean } {
  for (const event of events) {
    if (event.type !== "session_meta") continue;
    const payload = event.payload ?? {};
    const source = asRecord(payload.source);
    const subagent = source ? asRecord(source.subagent) : null;
    const threadSpawn = subagent ? asRecord(subagent.thread_spawn) : null;
    const id =
      asString(payload.id ?? payload.session_id) ||
      overrideSessionId ||
      "unknown";
    return { id, isSubagent: threadSpawn != null };
  }
  return { id: overrideSessionId ?? "unknown", isSubagent: false };
}

function extractRateLimits(events: RolloutLine[]): unknown | null {
  let last: unknown | null = null;
  for (const event of events) {
    if (event.type !== "event_msg") continue;
    const payload = event.payload ?? {};
    if (payload.type !== "token_count") continue;
    if (payload.rate_limits !== undefined) {
      last = payload.rate_limits;
    }
  }
  return last;
}

export function analyseSession(args: {
  events: RolloutLine[];
  path: string;
  sessionId?: string;
  children?: SessionSnapshot[];
  toggles?: Record<WasteToggleId, boolean>;
  live?: boolean;
  parse_errors?: ParseError[];
}): SessionSnapshot {
  const children = args.children ?? [];
  const toggles = args.toggles ?? DEFAULT_WASTE_TOGGLES;
  const parse_errors = args.parse_errors ?? [];

  const { id, isSubagent } = extractSessionInfo(args.events, args.sessionId);
  const { turns: ledgerTurns, ledger_warning, fastMode, meta } = buildLedger(
    args.events,
    id,
    { isSubagent },
  );

  const classified = classifyTurns(ledgerTurns);
  const { turns, suggestions } = detect(classified, args.events);

  const label = meta.nickname ?? meta.id;
  const tree = buildTree({
    sessionId: meta.id,
    label,
    turns,
    children,
  });

  const { waste } = computeWaste({ turns, children, toggles });

  const lastTurn = turns.length > 0 ? turns[turns.length - 1]! : null;
  const lastEvent =
    args.events.length > 0 ? args.events[args.events.length - 1]! : null;

  return {
    id: meta.id,
    parentId: meta.parentId,
    nickname: meta.nickname,
    cwd: meta.cwd,
    live: args.live ?? false,
    path: args.path,
    startedAt: meta.startedAt ?? turns[0]?.startedAt ?? null,
    lastEventAt: lastEvent?.timestamp ?? null,
    model: lastTurn?.model ?? null,
    effort: lastTurn?.effort ?? null,
    ledger_warning,
    parse_errors,
    rate_limits: extractRateLimits(args.events),
    rateCardAsOf: loadRateCard().as_of,
    fastMode,
    cost: tree.cost,
    waste,
    toggles,
    tree,
    turns,
    children,
    suggestions,
  };
}
