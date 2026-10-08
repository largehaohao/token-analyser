import path from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { preview, sha256 } from "./hash.ts";
import { nativeCost } from "./native-pricing.ts";
import type { RolloutLine, SessionMeta, SessionSource, TaskTiming, TokenUsage, ToolCall, Turn } from "./types.ts";

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
  forkedFrom?: string;
  model?: string | null;
};

export function detectSource(events: RolloutLine[], filePath = ""): SessionSource | null {
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
    if (!["tool_use", "toolCall"].includes(text(item.type))) continue;
    const input = toolInput(text(item.name), item.input ?? item.arguments);
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

export function parseNativeSession(events: RolloutLine[], filePath: string, source: SessionSource): NativeSession {
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
  const meta: SessionMeta = {
    id, parentId: source === "claude" && agentId ? `claude:${claudeParent}`
      : source === "cursor" && header?.parentSessionId ? `cursor:${text(header.parentSessionId)}` : null,
    nickname: source === "pi" ? text([...events].reverse().find((event) => event.type === "session_info")?.name) || null : agentId ? text(agentId) : text(header?.name) || null,
    cwd: text(events.find((event) => event.cwd)?.cwd) || null,
    startedAt: iso(header?.timestamp) || null,
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
    const native = nativeCost(usage, model, { recordedUsd, provider: source === "cursor" ? "cursor" : text(message.provider) || undefined,
      fast, cacheWrite1h: number(record(record(message.usage).cache_creation).ephemeral_1h_input_tokens) ?? 0 });
    const toolData = toolsFromContent(message.content ?? call.event.content, outputs);
    turns.push({ id: `${id}:${callId}`, sessionId: id, startedAt: call.startedAt,
      endedAt: iso(call.event.timestamp) || iso(message.timestamp) || lastEventAt || "",
      model, effort: text(message.thinkingLevel) || call.effort, fastMode: fast,
      pricing: native.pricing, usageRecorded: usage != null,
      prompt: call.prompt, response: contentText(message.content ?? call.event.content),
      tools: toolData.tools, usage: usage ?? { input_tokens: 0, cached_input_tokens: 0,
        cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      cost: native.cost, bucket: "other", labels: [], hasPatchApply: toolData.write, collaborationMode: null });
  }
  return { source, sourceId: ownId, meta, turns, messageCount: messageIds.size, lastEventAt,
    model: turns.at(-1)?.model ?? (text(header?.selectedModel) || null),
    taskTimings: [], ...(forkedFrom ? { forkedFrom } : {}) };
}
