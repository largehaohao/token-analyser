import { createRequire } from "node:module";
import { iso, record, text } from "./session-adapters.ts";
import type { RolloutLine } from "./types.ts";

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

type StepUsage = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function stepUsage(parts: Record<string, unknown>[]): StepUsage | null {
  const finishes = parts.filter((part) => part.type === "step-finish");
  if (finishes.length === 0) return null;
  const usage: StepUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const step of finishes) {
    const tokens = record(step.tokens);
    const cache = record(tokens.cache);
    usage.input += number(tokens.input) ?? 0;
    usage.output += number(tokens.output) ?? 0;
    usage.reasoning += number(tokens.reasoning) ?? 0;
    usage.cacheRead += number(cache.read) ?? 0;
    usage.cacheWrite += number(cache.write) ?? 0;
    usage.cost += number(step.cost) ?? 0;
  }
  return usage;
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((item) => {
      const type = text(record(item).type);
      return type === "" || type === "text";
    })
    .map((item) => text(record(item).text))
    .filter(Boolean)
    .join("\n");
}

function messageText(data: Record<string, unknown>, parts: Record<string, unknown>[]): string {
  const fromParts = parts
    .filter((part) => part.type === "text")
    .map((part) => text(part.text))
    .filter(Boolean)
    .join("\n");
  if (fromParts) return fromParts;
  return text(data.text) || visibleText(data.content);
}

/** OpenCode records request created, first stream chunk, and stream end.
 * `time.completed` often includes later tool runs, so the request window stops
 * at `time.streamed` or the last text/reasoning block. */
function requestTiming(
  data: Record<string, unknown>,
  parts: Record<string, unknown>[],
): { ttft_ms?: number; duration_ms?: number } {
  const time = record(data.time);
  const started = number(time.created);
  if (started == null) return {};
  const streamMarks: number[] = [];
  const pushMark = (value: unknown) => {
    const mark = number(value);
    if (mark != null) streamMarks.push(mark);
  };
  for (const part of parts) {
    if (part.type !== "text" && part.type !== "reasoning") continue;
    const partTime = record(part.time);
    pushMark(partTime.start ?? partTime.created);
    pushMark(partTime.end ?? partTime.completed);
  }
  if (Array.isArray(data.content)) {
    for (const item of data.content) {
      const block = record(item);
      if (block.type !== "text" && block.type !== "reasoning") continue;
      const blockTime = record(block.time);
      pushMark(blockTime.created ?? blockTime.start);
      pushMark(blockTime.completed ?? blockTime.end);
    }
  }
  const firstStream = streamMarks.length > 0 ? Math.min(...streamMarks) : null;
  const lastContent = streamMarks.length > 0 ? Math.max(...streamMarks) : null;
  const streamed = number(time.streamed);
  const ended = streamed != null && (firstStream == null || streamed >= firstStream)
    ? streamed
    : lastContent != null && lastContent >= started
    ? lastContent
    : number(time.completed);
  const ttftMs = firstStream != null && firstStream >= started ? firstStream - started : undefined;
  const durationMs = ended != null && ended >= started && ended > 0 ? ended - started : undefined;
  return {
    ...(ttftMs != null ? { ttft_ms: ttftMs } : {}),
    ...(durationMs != null && durationMs > 0 ? { duration_ms: durationMs } : {}),
  };
}

function toolsForMessage(data: Record<string, unknown>, parts: Record<string, unknown>[]): { id: string; name: string; input: unknown; output: string }[] {
  const fromParts = parts.filter((part) => part.type === "tool");
  if (fromParts.length > 0) {
    return fromParts.map((part) => {
      const state = record(part.state);
      return {
        id: text(part.callID),
        name: text(part.tool) || "tool",
        input: state.input ?? {},
        output: text(state.output) || visibleText(state.content),
      };
    });
  }
  if (!Array.isArray(data.content)) return [];
  return data.content.filter((item) => record(item).type === "tool").map((item) => {
    const block = record(item);
    const state = record(block.state);
    return {
      id: text(block.id) || text(block.callID),
      name: text(block.name) || text(block.tool) || "tool",
      input: state.input ?? {},
      output: text(state.output) || visibleText(state.content),
    };
  });
}

function tokensFromMessage(data: Record<string, unknown>): StepUsage | null {
  const tokens = record(data.tokens);
  const input = number(tokens.input);
  const output = number(tokens.output);
  if (input == null || output == null) return null;
  const cache = record(tokens.cache);
  return {
    input, output, reasoning: number(tokens.reasoning) ?? 0,
    cacheRead: number(cache.read) ?? 0, cacheWrite: number(cache.write) ?? 0,
    cost: number(data.cost) ?? 0,
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  try { return record(JSON.parse(text(value))); } catch { return {}; }
}

function groupBySession(
  rows: Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
  const bySession = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const sessionId = text(row.session_id);
    const list = bySession.get(sessionId);
    if (list) list.push(row);
    else bySession.set(sessionId, [row]);
  }
  return bySession;
}

function buildSessionEvents(
  row: Record<string, unknown>,
  messages: Record<string, unknown>[],
  partRows: Record<string, unknown>[],
): RolloutLine[] | null {
  const id = text(row.id);
  if (!id) return null;
  let modelRecord: Record<string, unknown> = {};
  try {
    modelRecord = record(typeof row.model === "string" ? JSON.parse(row.model) : row.model);
  } catch { modelRecord = {}; }
  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const part of partRows) {
    const messageId = text(part.message_id);
    const list = partsByMessage.get(messageId) ?? [];
    list.push(parseJson(part.data));
    partsByMessage.set(messageId, list);
  }
  const events: RolloutLine[] = [{
    type: "opencode_session", source: "opencode", sessionId: id,
    timestamp: iso(row.time_created), name: text(row.title), cwd: text(row.directory),
    parentSessionId: text(row.parent_id),
    selectedModel: text(modelRecord.id),
  }];
  let prompt = "";
  let hasAssistant = false;
  for (const message of messages) {
    const data = parseJson(message.data);
    const role = text(message.type) || text(data.role);
    const at = iso(message.time_created) || iso(record(data.time).created);
    const parts = partsByMessage.get(text(message.id)) ?? [];
    if (role === "user") {
      const next = messageText(data, parts);
      if (next) prompt = next;
      events.push({ type: "message", source: "opencode", sessionId: id, timestamp: at, role: "user",
        message: { role: "user", content: next } });
      continue;
    }
    if (role !== "assistant") continue;
    hasAssistant = true;
    const model = record(data.model);
    const usage = stepUsage(parts);
    const body = messageText(data, parts);
    const content: Record<string, unknown>[] = body ? [{ type: "text", text: body }] : [];
    const produced = usage ?? tokensFromMessage(data);
    for (const tool of toolsForMessage(data, parts)) {
      const callId = tool.id || text(message.id);
      content.push({ type: "tool_use", id: callId, name: tool.name, input: tool.input });
      events.push({ type: "message", timestamp: at, message: {
        role: "toolResult", toolCallId: callId, content: tool.output,
      } });
    }
    const timing = requestTiming(data, parts);
    events.push({
      type: "message", source: "opencode", sessionId: id, timestamp: at, role: "assistant",
      message: {
        role: "assistant", id: text(message.id),
        model: text(model.id) || text(data.modelID) || text(modelRecord.id) || null,
        content, prompt,
        ...(Object.keys(timing).length > 0 ? { request_performance: timing } : {}),
        usage: produced ? {
          input: produced.input,
          output: produced.output + produced.reasoning,
          cacheRead: produced.cacheRead,
          cacheWrite: produced.cacheWrite,
          reasoningTokens: produced.reasoning,
          cost: { total: produced.cost },
        } : undefined,
      },
    });
  }
  return hasAssistant ? events : null;
}

/** Read OpenCode's database without copying it or touching its WAL. */
export function readOpenCodeSessions(databasePath: string): RolloutLine[][] {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => text(row.name)));
    if (!tables.has("session_v2") && !tables.has("session")) return [];
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    if (tables.has("session_v2")) {
      for (const row of db.prepare(
        "SELECT id, parent_id, directory, title, time_created, time_updated, model FROM session_v2",
      ).all()) {
        seen.add(text(row.id));
        rows.push(row);
      }
    }
    if (tables.has("session")) {
      for (const row of db.prepare(
        "SELECT id, parent_id, directory, title, time_created, time_updated FROM session",
      ).all()) {
        if (seen.has(text(row.id))) continue;
        seen.add(text(row.id));
        rows.push(row);
      }
    }
    const messageRows = tables.has("session_message")
      ? db.prepare("SELECT id, session_id, type, time_created, data FROM session_message ORDER BY time_created, id").all()
      : [];
    const legacyMessageRows = tables.has("message")
      ? db.prepare("SELECT id, session_id, time_created, data FROM message ORDER BY time_created, id").all()
      : [];
    const messagesBySession = groupBySession(messageRows);
    const legacyBySession = groupBySession(legacyMessageRows);
    const needsParts = new Set<string>();
    for (const row of rows) {
      const id = text(row.id);
      const messages = messagesBySession.get(id) ?? legacyBySession.get(id) ?? [];
      let assistants = 0;
      let complete = 0;
      for (const message of messages) {
        const data = parseJson(message.data);
        const role = text(message.type) || text(data.role);
        if (role !== "assistant") continue;
        assistants += 1;
        // New rows carry tokens and visible text on the message. Older rows
        // often keep the body only in the part table.
        if (data.tokens != null && (text(data.text) || visibleText(data.content))) complete += 1;
      }
      if (assistants === 0 || complete < assistants) needsParts.add(id);
    }
    // Newer rows keep tokens on the message; only read the part table when a
    // session still needs step-finish / tool parts.
    const sessionPartRows = needsParts.size > 0 && tables.has("session_part")
      ? db.prepare("SELECT message_id, session_id, time_created, data FROM session_part ORDER BY ordinal").all()
      : [];
    const partRows = needsParts.size > 0 && tables.has("part")
      ? db.prepare("SELECT message_id, session_id, time_created, data FROM part ORDER BY time_created, id").all()
      : [];
    const sessionPartsBySession = groupBySession(sessionPartRows);
    const partsBySession = groupBySession(partRows);
    const sessions: RolloutLine[][] = [];
    for (const row of rows) {
      const id = text(row.id);
      const messages = messagesBySession.get(id) ?? legacyBySession.get(id) ?? [];
      const parts = needsParts.has(id)
        ? (sessionPartsBySession.get(id)?.length ? sessionPartsBySession.get(id) : partsBySession.get(id)) ?? []
        : [];
      const events = buildSessionEvents(row, messages, parts);
      if (events) sessions.push(events);
    }
    return sessions;
  } finally { db.close(); }
}
