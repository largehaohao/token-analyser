import path from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { preview, sha256 } from "./hash.ts";
import { nativeCost } from "./native-pricing.ts";
import { requestPerformance } from "./performance.ts";
import type { ContextMeasurement, RolloutLine, SessionMeta, SessionSource, TaskTiming, TokenUsage, ToolCall, Turn } from "./types.ts";

export function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function iso(value: unknown): string {
  const ms = typeof value === "number" ? value : Date.parse(text(value));
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => text(record(item).text ?? record(item).thinking)).filter(Boolean).join("\n");
}

export type NativeSession = {
  source: SessionSource;
  sourceId: string;
  meta: SessionMeta;
  turns: Turn[];
  messageCount: number;
  lastEventAt: string | null;
  taskTimings: TaskTiming[];
  contextMeasurement?: ContextMeasurement | null;
  forkedFrom?: string;
  model?: string | null;
};

export function detectSource(events: RolloutLine[], filePath = ""): SessionSource | null {
  // DSH session headers also have type/session + version/cwd; check before pi.
  if (
    /(?:^|[/\\])\.dsh(?:[/\\]|$)/.test(filePath) ||
    events.some((event) =>
      event.type === "assistant/message" ||
      event.type === "user/message" ||
      event.type === "tool/call" ||
      event.type === "session/title"
    )
  ) return "dsh";
  if (events.some((event) => event.type === "session_meta" || event.type === "turn_context")) return "codex";
  if (events.some((event) => event.type === "session" && (event.version != null || event.cwd != null))) return "pi";
  if (events.some((event) => event.source === "cursor")) return "cursor";
  if (events.some((event) => typeof event.sessionId === "string" || event.isSidechain != null)) return "claude";
  if (events.some((event) => typeof event.role === "string" || event.type === "turn_ended")) return "cursor";
  if (filePath.includes(`${path.sep}.claude${path.sep}`)) return "claude";
  if (filePath.includes(`${path.sep}.pi${path.sep}`)) return "pi";
  if (filePath.includes(`${path.sep}agent-transcripts${path.sep}`)) return "cursor";
  return null;
}

/** Input counts in Claude and pi exclude their separately reported cache counts. */
function measuredUsage(value: unknown, source: SessionSource): TokenUsage | null {
  const usage = record(value);
  const input = number(usage.input_tokens ?? usage.input ?? usage.inputTokens);
  const output = number(usage.output_tokens ?? usage.output ?? usage.outputTokens);
  if (input == null || output == null) return null;
  const cached = number(usage.cache_read_input_tokens ?? usage.cacheRead ?? usage.cacheReadTokens) ?? 0;
  const write = number(usage.cache_creation_input_tokens ?? usage.cacheWrite ?? usage.cacheWriteTokens) ?? 0;
  const totalInput = source === "cursor" ? input : input + cached + write;
  if (cached > totalInput) return null;
  return {
    input_tokens: totalInput, cached_input_tokens: cached, cache_write_input_tokens: write,
    output_tokens: output, reasoning_output_tokens: number(usage.reasoningTokens) ?? 0,
    total_tokens: totalInput + output,
  };
}

function toolInput(name: string, value: unknown): { name: string; input: string; write: boolean } {
  const data = record(value);
  const lower = name.toLowerCase();
  const quote = (value: unknown) => `'${text(value).replaceAll("'", "'\\''")}'`;
  if (["bash", "shell", "run_terminal_cmd", "exec", "exec_command"].includes(lower)) {
    return { name: "exec", input: text(data.command ?? data.cmd) || text(value) || JSON.stringify(value ?? {}), write: false };
  }
  if (["read", "read_file", "readfile"].includes(lower)) {
    return { name: "exec", input: `cat ${quote(data.file_path ?? data.path ?? data.target_file)}`, write: false };
  }
  if (["grep", "search", "glob"].includes(lower)) {
    return { name: "exec", input: `rg ${quote(data.pattern ?? data.query)} ${quote(data.path)}`, write: false };
  }
  const write = ["edit", "write", "write_file", "edit_file", "apply_patch", "str_replace", "multiedit"].includes(lower);
  return { name: write ? "apply_patch" : ["agent", "task"].includes(lower) ? "spawn_agent" : name,
    input: typeof value === "string" ? value : JSON.stringify(value ?? {}), write };
}

export function toolsFromContent(content: unknown, outputs: Map<string, string>): { tools: ToolCall[]; write: boolean } {
  let write = false;
  const tools: ToolCall[] = [];
  if (!Array.isArray(content)) return { tools, write };
  for (const block of content) {
    const item = record(block);
    if (!["tool_use", "toolCall", "tool-call"].includes(text(item.type))) continue;
    let args: unknown = item.input ?? item.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { /* keep the raw string for toolInput */ }
    }
    const input = toolInput(text(item.name), args);
    write ||= input.write;
    const output = outputs.get(text(item.id)) ?? "";
    tools.push({ name: input.name, input: input.input, outputSha256: sha256(output),
      outputBytes: Buffer.byteLength(output, "utf8"), outputPreview: preview(output) });
  }
  return { tools, write };
}

function fallbackTimestamp(filePath: string): string {
  try { return new Date(statSync(filePath).mtimeMs).toISOString(); } catch { return ""; }
}

function parseDshSession(events: RolloutLine[], filePath: string): NativeSession {
  const header = events.find((event) => event.type === "session") ?? events[0];
  const sourceId = text(header?.id) ||
    path.basename(path.dirname(filePath)).replace(/^session-/, "") ||
    path.basename(filePath).replace(/\.(jsonl|ndjson)(\.zstd)?$/i, "");
  const id = `dsh:${sourceId}`;
  const parentRaw = text(header?.parentSession);
  const title = text(record(events.find((event) => event.type === "session/title")?.data).title);
  const startedAt = iso(header?.createdAt) || iso(header?.time) || null;
  const lastEventAt = iso(events.at(-1)?.time) || fallbackTimestamp(filePath) || null;
  const outputs = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const data = record(event.data);
    const message = record(data.message);
    const callId = text(message.toolCallId ?? record(message.source).callId);
    if (callId) outputs.set(callId, contentText(message.content));
  }
  // DSH has no ttft_ms field; first stream chunk minus step/start is the wait.
  const stepStarted = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "step/start") continue;
    const data = record(event.data);
    const at = number(event.time);
    if (at == null) continue;
    stepStarted.set(`${data.turn}:${data.step}`, at);
  }
  let prompt = "";
  let promptStarted = startedAt ?? "";
  const turns: Turn[] = [];
  let messageCount = 0;
  for (const [index, event] of events.entries()) {
    const data = record(event.data);
    if (event.type === "user/message") {
      messageCount += 1;
      const next = contentText(data.content);
      if (next) {
        prompt = next;
        promptStarted = iso(event.time) || promptStarted;
      }
      continue;
    }
    if (event.type !== "assistant/message") continue;
    messageCount += 1;
    const message = record(data.message);
    const usage = measuredUsage(data.usage, "dsh");
    const modelSource = record(message.source);
    const model = text(modelSource.model) || text(record(data.header).model) || null;
    const endedAt = iso(event.time) || lastEventAt || "";
    const stream = Array.isArray(data.stream) ? data.stream : [];
    const streamTimes = stream
      .map((item) => number(record(item).time) ?? number(record(item).time0))
      .filter((value): value is number => value != null);
    // Request window: step/start → last stream chunk. TTFT is to the first
    // chunk; tok/s uses (duration − TTFT) via requestPerformance.
    const requestStarted = stepStarted.get(`${data.turn}:${data.step}`);
    const firstStream = streamTimes[0] ?? null;
    const lastStream = streamTimes.length > 0 ? streamTimes[streamTimes.length - 1]! : null;
    const ttftMs = requestStarted != null && firstStream != null && firstStream >= requestStarted
      ? firstStream - requestStarted
      : null;
    const durationMs = requestStarted != null && lastStream != null && lastStream >= requestStarted
      ? lastStream - requestStarted
      : firstStream != null && lastStream != null && lastStream >= firstStream
      ? lastStream - firstStream
      : null;
    const native = nativeCost(usage, model, {
      recordedUsd: number(record(data.usage).costUSD ?? data.costUSD),
      provider: text(modelSource.provider) || undefined,
    });
    const toolData = toolsFromContent(message.content, outputs);
    turns.push({
      id: `${id}:${typeof event.seq === "number" ? event.seq : index}`,
      sessionId: id,
      startedAt: promptStarted || endedAt,
      endedAt,
      model,
      effort: null,
      fastMode: false,
      pricing: native.pricing,
      usageRecorded: usage != null,
      requestPerformance: requestPerformance(
        usage?.output_tokens ?? null,
        message,
        data.usage,
        {
          ...(durationMs != null ? { duration_ms: durationMs } : {}),
          ...(ttftMs != null ? { ttft_ms: ttftMs } : {}),
        },
      ),
      prompt,
      response: contentText(message.content),
      tools: toolData.tools,
      usage: usage ?? {
        input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
      },
      cost: native.cost,
      bucket: "other",
      labels: [],
      hasPatchApply: toolData.write,
      collaborationMode: null,
    });
  }
  return {
    source: "dsh",
    sourceId,
    meta: {
      id,
      parentId: parentRaw ? `dsh:${parentRaw}` : null,
      nickname: title || null,
      cwd: text(header?.cwd) || null,
      startedAt,
      contextMeasurement: null,
    },
    turns,
    messageCount,
    lastEventAt,
    taskTimings: [],
    model: turns.at(-1)?.model ?? null,
  };
}

/**
 * The extension entry's own request window, used only as a fallback duration
 * for a pi build whose assistant message records no `durationMs`. pi's own
 * `durationMs` on the assistant entry is passed first, so it stays
 * authoritative; the entry's provider window (request sent → message end) is
 * a measured window, not a gap between log entries.
 */
function piEntryWindow(data: Record<string, unknown>): Record<string, unknown> {
  const own = number(data.piDurationMs);
  if (own != null && own > 0) return { duration_ms: own };
  const started = Date.parse(text(data.startedAt));
  const ended = Date.parse(text(data.endedAt));
  return Number.isFinite(started) && Number.isFinite(ended) && ended > started
    ? { duration_ms: ended - started }
    : {};
}

export function parseNativeSession(events: RolloutLine[], filePath: string, source: SessionSource): NativeSession {
  if (source === "dsh") return parseDshSession(events, filePath);
  const header = events.find((event) => event.type === "session") ?? events[0];
  const agentId = events.find((event) => typeof event.agentId === "string")?.agentId ??
    (source === "claude" && path.basename(filePath).startsWith("agent-")
      ? path.basename(filePath).replace(/^agent-/, "").replace(/\.jsonl$/, "") : undefined);
  const sourceId = source === "pi" ? text(header?.id)
    : source === "claude" ? text(events.find((event) => event.sessionId)?.sessionId)
    : text(events.find((event) => event.sessionId)?.sessionId);
  const nativeId = sourceId || path.basename(filePath).replace(/\.(jsonl|ndjson|json)$/i, "");
  const claudeParent = source === "claude" && agentId && path.basename(path.dirname(filePath)) === "subagents"
    ? path.basename(path.dirname(path.dirname(filePath))) : nativeId;
  const ownId = source === "claude" && agentId ? `${claudeParent}:agent:${text(agentId)}` : nativeId;
  const id = `${source}:${ownId}`;
  const measurement = record(header?.contextMeasurement);
  const meta: SessionMeta = {
    id, parentId: source === "claude" && agentId ? `claude:${claudeParent}`
      : source === "cursor" && header?.parentSessionId ? `cursor:${text(header.parentSessionId)}` : null,
    nickname: source === "pi" ? text([...events].reverse().find((event) => event.type === "session_info")?.name) || null : agentId ? text(agentId) : text(header?.name) || null,
    cwd: text(events.find((event) => event.cwd)?.cwd) || null,
    startedAt: iso(header?.timestamp) || null,
    contextMeasurement: source === "cursor" && Object.keys(measurement).length > 0
      ? {
        usedTokens: number(measurement.usedTokens),
        limitTokens: number(measurement.limitTokens),
        usagePercent: number(measurement.usagePercent),
        source: text(measurement.source) || "cursor",
        categories: (Array.isArray(measurement.categories) ? measurement.categories : [])
          .map((item) => {
            const category = record(item);
            const tokens = number(category.tokens);
            return tokens == null ? null : { id: text(category.id), label: text(category.label), tokens };
          })
          .filter((item): item is { id: string; label: string; tokens: number } => item != null),
      }
      : null,
  };
  const lastEventAt = iso(events.at(-1)?.timestamp) || fallbackTimestamp(filePath) || null;
  const outputs = new Map<string, string>();
  for (const event of events) {
    const message = record(event.message);
    if (message.role === "toolResult") outputs.set(text(message.toolCallId), contentText(message.content));
    if (Array.isArray(message.content)) for (const block of message.content) {
      const item = record(block);
      if (item.type === "tool_result") outputs.set(text(item.tool_use_id), contentText(item.content));
    }
  }
  // Forks retain historical context. Exclude copied entry IDs from new spend.
  const inherited = new Set<string>();
  const forkedFrom = text(header?.parentSession ?? header?.forkedFrom);
  if (source === "pi" && forkedFrom && path.resolve(forkedFrom) !== path.resolve(filePath) && existsSync(forkedFrom)) {
    try {
      for (const line of readFileSync(forkedFrom, "utf8").split("\n")) {
        if (line.trim()) inherited.add(text(record(JSON.parse(line)).id));
      }
    } catch { /* Missing parent context cannot prevent analysis of this file. */ }
  }
  // pi's log has no first-token instant: it stores the request window
  // (message.timestamp → entry timestamp) and durationMs only. The
  // request-timing extension appends one `request_timing` entry per model
  // request, keyed to the assistant entry by turn_end.messageEntryId, whose
  // `ttft_ms` was measured inside the provider request. Retries restart the
  // clock, so the entry describes the attempt that produced the message and
  // `attempts` keeps the retries visible.
  const piTimings = new Map<string, Record<string, unknown>>();
  const piTimingsByResponse = new Map<string, Record<string, unknown>>();
  if (source === "pi") {
    for (const event of events) {
      if (event.type !== "custom" || event.customType !== "request_timing") continue;
      const data = record(event.data);
      // An entry with neither a first-token time nor a request window adds
      // nothing to the performance figures.
      if (data.ttft_ms === undefined && data.ttftMs === undefined
        && data.piDurationMs === undefined && data.startedAt === undefined) continue;
      const entryId = text(data.messageEntryId);
      const responseId = text(data.responseId);
      if (entryId) piTimings.set(entryId, data);
      else if (responseId) piTimingsByResponse.set(responseId, data);
    }
  }
  const calls = new Map<string, { event: RolloutLine; message: Record<string, unknown>; prompt: string; startedAt: string; effort: string | null }>();
  const contexts = new Map<string, { prompt: string; startedAt: string; effort: string | null }>();
  let context = { prompt: "", startedAt: "", effort: null as string | null };
  let selectedModel: string | null = null;
  const messageIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (source === "pi" && event.parentId !== undefined) {
      context = { ...(contexts.get(text(event.parentId)) ?? { prompt: "", startedAt: "", effort: null }) };
    }
    if (event.type === "thinking_level_change") context.effort = text(event.thinkingLevel) || null;
    if (event.type === "model_change") selectedModel = text(event.modelId) || null;
    const message = record(event.message);
    const role = text(message.role ?? event.role ?? (["user", "assistant"].includes(event.type) ? event.type : ""));
    const time = iso(event.timestamp) || iso(message.timestamp) || lastEventAt || "";
    if (role) messageIds.add(`${role}:${text(message.id ?? event.uuid ?? event.id) || index}`);
    if (role === "user") {
      const prompt = contentText(message.content ?? event.content);
      if (prompt) context = { ...context, prompt, startedAt: time };
    }
    const usageOnly = source === "pi" && ["usage", "compaction", "branch_summary"].includes(event.type) && event.usage != null;
    if ((role === "assistant" || usageOnly) && !inherited.has(text(event.id))) {
      const callId = text(message.id ?? event.uuid ?? event.id) || String(index);
      const callMessage = usageOnly ? { ...event, role: "assistant", content: [], model: event.model ?? selectedModel } : message;
      const previous = calls.get(callId);
      if (previous && source === "claude") {
        const blocks = [...(Array.isArray(previous.message.content) ? previous.message.content : []), ...(Array.isArray(callMessage.content) ? callMessage.content : [])];
        const unique = new Map(blocks.map((block) => [text(record(block).id) || JSON.stringify(block), block]));
        previous.message = { ...previous.message, ...callMessage, content: [...unique.values()],
          usage: { ...record(previous.message.usage), ...record(callMessage.usage) } };
        previous.event = event;
      } else {
        calls.set(callId, { event, message: { model: selectedModel, ...callMessage }, ...context,
          startedAt: context.startedAt || time });
      }
    }
    if (event.id) contexts.set(text(event.id), { ...context });
  }
  const turns: Turn[] = [];
  for (const [callId, call] of calls) {
    const message = call.message;
    const usage = measuredUsage(message.usage ?? call.event.usage, source);
    const costRecord = record(record(message.usage ?? call.event.usage).cost);
    const recordedUsd = number(costRecord.total ?? message.costUSD ?? call.event.costUSD);
    const model = text(message.model ?? call.event.model) || null;
    const fast = text(record(message.usage).speed ?? message.speed ?? call.event.speed) === "fast";
    // Extension-measured timing joins last so pi's own `durationMs` stays the
    // duration the analyser reports; the entry supplies the TTFT, and only
    // then its own window when the message records no duration. With both
    // known, tok/s is a decode rate over (duration − TTFT).
    const responseId = text(message.responseId);
    const piTiming = source === "pi"
      ? piTimings.get(callId) ?? (responseId ? piTimingsByResponse.get(responseId) : undefined)
      : undefined;
    const native = nativeCost(usage, model, { recordedUsd, provider: source === "cursor" ? "cursor" : text(message.provider) || undefined,
      fast, cacheWrite1h: number(record(record(message.usage).cache_creation).ephemeral_1h_input_tokens) ?? 0 });
    const toolData = toolsFromContent(message.content ?? call.event.content, outputs);
    turns.push({ id: `${id}:${callId}`, sessionId: id, startedAt: call.startedAt,
      endedAt: iso(call.event.timestamp) || iso(message.timestamp) || lastEventAt || "",
      model, effort: text(message.thinkingLevel) || call.effort, fastMode: fast,
      pricing: native.pricing, usageRecorded: usage != null,
      requestPerformance: requestPerformance(usage?.output_tokens ?? null, message, message.usage, call.event,
        ...(piTiming ? [piEntryWindow(piTiming), piTiming] : [])),
      prompt: call.prompt, response: contentText(message.content ?? call.event.content),
      tools: toolData.tools, usage: usage ?? { input_tokens: 0, cached_input_tokens: 0,
        cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      cost: native.cost, bucket: "other", labels: [], hasPatchApply: toolData.write, collaborationMode: null });
  }
  return { source, sourceId: ownId, meta, turns, messageCount: messageIds.size, lastEventAt,
    model: turns.at(-1)?.model ?? (text(header?.selectedModel) || null),
    taskTimings: [], ...(forkedFrom ? { forkedFrom } : {}) };
}
