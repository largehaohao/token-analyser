/**
 * pi request-timing extension.
 *
 * pi's session log records only the request window (`message.timestamp` →
 * entry `timestamp`, plus `durationMs`), so the first-token instant is absent
 * and TTFT cannot be recovered from the log. This extension measures it live:
 *
 *   before_provider_request   t0  (payload assembled, request about to send)
 *   after_provider_response   t1  (response headers: TTFB)
 *   provider_stream_event     t2  (first raw chunk)
 *   message_update            t3  (first normalized output delta = first token)
 *
 * `ttft_ms` is t3 − t0 and is written as a `request_timing` session entry
 * joined to the assistant entry by `turn_end.messageEntryId` (secondary key:
 * `responseId`). It carries no prompt or response text.
 *
 * Disable with PI_REQUEST_TIMING=0, or toggle at runtime with /request-timing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "request_timing";
const STATUS_KEY = "request-timing";

/** Normalized stream events that carry model output. `start` alone does not. */
const DELTA_EVENTS = new Set([
  "text_start", "text_delta",
  "thinking_start", "thinking_delta",
  "toolcall_start", "toolcall_delta",
]);

interface Attempt {
  t0: number;
  wall: string;
  headersMs: number | null;
  firstRawMs: number | null;
  firstDeltaMs: number | null;
  status: number | null;
}

interface Pending {
  turnIndex: number;
  harnessGapMs: number | null;
  attempts: Attempt[];
  model: string | null;
  provider: string | null;
  api: string | null;
}

interface Ready extends Pending {
  current: Attempt;
  endedAt: string;
  stopReason: string | null;
  responseId: string | null;
  piDurationMs: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  inputTokens: number | null;
  cacheRead: number | null;
}

interface TimingData {
  version: 1;
  messageEntryId: string | null;
  responseId: string | null;
  turnIndex: number;
  model: string | null;
  provider: string | null;
  api: string | null;
  stopReason: string | null;
  /** Time from sending the provider request to the first output delta. */
  ttft_ms: number | null;
  headersMs: number | null;
  firstRawStreamMs: number | null;
  /** pi's own total request duration, kept under a name the analyser reads
   * from the assistant message instead. */
  piDurationMs: number | null;
  attempts: number;
  attemptLog: Array<{ startedAt: string; status: number | null; headersMs: number | null }>;
  harnessGapMs: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  inputTokens: number | null;
  cacheRead: number | null;
  startedAt: string;
  endedAt: string;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function iso(): string {
  return new Date().toISOString();
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function idleAttempt(): Attempt {
  return { t0: now(), wall: iso(), headersMs: null, firstRawMs: null, firstDeltaMs: null, status: null };
}

export default function (pi: ExtensionAPI) {
  let enabled = process.env.PI_REQUEST_TIMING !== "0";
  let turnStartedAt: number | null = null;
  let turnIndex = 0;
  let pending: Pending | null = null;
  let ready: Ready | null = null;
  let lastTtftMs: number | null = null;

  const current = () => pending?.attempts[pending.attempts.length - 1] ?? null;

  const write = (entryId: string | null) => {
    if (!ready) return;
    const data: TimingData = {
      version: 1,
      messageEntryId: entryId,
      responseId: ready.responseId,
      turnIndex: ready.turnIndex,
      model: ready.model,
      provider: ready.provider,
      api: ready.api,
      stopReason: ready.stopReason,
      ttft_ms: ready.current.firstDeltaMs,
      headersMs: ready.current.headersMs,
      firstRawStreamMs: ready.current.firstRawMs,
      piDurationMs: ready.piDurationMs,
      attempts: ready.attempts.length,
      attemptLog: ready.attempts.map((attempt) => ({
        startedAt: attempt.wall,
        status: attempt.status,
        headersMs: attempt.headersMs,
      })),
      harnessGapMs: ready.harnessGapMs,
      outputTokens: ready.outputTokens,
      reasoningTokens: ready.reasoningTokens,
      inputTokens: ready.inputTokens,
      cacheRead: ready.cacheRead,
      startedAt: ready.current.wall,
      endedAt: ready.endedAt,
    };
    lastTtftMs = data.ttft_ms;
    ready = null;
    pi.appendEntry(ENTRY_TYPE, data);
  };

  pi.registerCommand("request-timing", {
    description: "Toggle per-request TTFT recording",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.setStatus(STATUS_KEY, enabled && lastTtftMs != null
        ? `ttft ${(lastTtftMs / 1000).toFixed(2)}s`
        : undefined);
      ctx.ui.notify(`Request timing ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("turn_start", (event) => {
    // A turn is one model request plus its tool calls. Drop anything the
    // previous turn never finished attributing (aborted run, compaction).
    ready = null;
    turnStartedAt = now();
    turnIndex = typeof event.turnIndex === "number" ? event.turnIndex : turnIndex + 1;
    pending = null;
  });

  pi.on("before_provider_request", () => {
    if (!enabled) { pending = null; return; }
    // Retries restart the clock: the attempt that yields the message is the
    // one whose TTFT is recorded, and the count keeps the retries visible.
    if (ready) write(null);
    const turn = pending;
    const previous = turn?.attempts ?? [];
    const gap = turnStartedAt == null ? null : Math.round(Math.max(0, now() - turnStartedAt));
    pending = {
      turnIndex,
      harnessGapMs: turn ? null : gap,
      attempts: [...previous],
      model: turn?.model ?? null,
      provider: turn?.provider ?? null,
      api: turn?.api ?? null,
    };
    pending.attempts.push(idleAttempt());
  });

  pi.on("after_provider_response", (event) => {
    const attempt = current();
    if (!attempt) return;
    attempt.headersMs = Math.max(0, Math.round(now() - attempt.t0));
    attempt.status = typeof event.status === "number" ? event.status : null;
  });

  pi.on("provider_stream_event", (event) => {
    const attempt = current();
    if (!attempt || attempt.firstRawMs != null) return;
    attempt.firstRawMs = Math.max(0, Math.round(now() - attempt.t0));
    const model = record(event).model;
    if (pending && typeof model === "string") pending.model = model;
  });

  pi.on("message_update", (event) => {
    const attempt = current();
    if (!attempt || attempt.firstDeltaMs != null) return;
    const kind = record(event.assistantMessageEvent).type;
    if (typeof kind !== "string" || !DELTA_EVENTS.has(kind)) return;
    attempt.firstDeltaMs = Math.max(0, Math.round(now() - attempt.t0));
  });

  pi.on("message_end", (event) => {
    if (!pending || event.message.role !== "assistant") return;
    const message = record(event.message);
    const usage = record(message.usage);
    const attempt = current() ?? idleAttempt();
    ready = {
      ...pending,
      model: typeof message.model === "string" ? message.model : pending.model,
      provider: typeof message.provider === "string" ? message.provider : pending.provider,
      api: typeof message.api === "string" ? message.api : pending.api,
      current: attempt,
      endedAt: iso(),
      stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
      responseId: typeof message.responseId === "string" ? message.responseId : null,
      piDurationMs: positive(message.durationMs),
      outputTokens: positive(usage.output),
      reasoningTokens: positive(usage.reasoning),
      inputTokens: positive(usage.input),
      cacheRead: positive(usage.cacheRead),
    };
    pending = null;
  });

  pi.on("turn_end", (event) => {
    // `messageEntryId` is the assistant entry this request produced, which is
    // how the analyser joins the timing back onto its token ledger row.
    const entryId = typeof event.messageEntryId === "string" ? event.messageEntryId : null;
    if (ready) write(entryId);
    pending = null;
  });

  pi.on("session_shutdown", () => {
    if (ready) write(null);
    pending = null;
  });
}
