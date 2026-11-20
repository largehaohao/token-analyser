import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, preview } from "./hash.ts";
import { nativeCost } from "./native-pricing.ts";
import { requestPerformance } from "./performance.ts";
import type { ContextMeasurement, RolloutLine, ToolCall } from "./types.ts";
import type { NativeSession } from "./session-adapters.ts";

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function iso(value: unknown): string {
  const ms = typeof value === "number" ? value : Date.parse(text(value));
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : "";
}

const SYSTEM_STEPS = new Set([
  "SYSTEM_MESSAGE", "CHECKPOINT", "CONVERSATION_HISTORY", "DIRECTORY_RULES", "EPHEMERAL_MESSAGE", "ERROR_MESSAGE",
]);

export function isAntigravityTranscript(events: RolloutLine[], filePath = ""): boolean {
  if (events.some((event) =>
    typeof event.step_index === "number" &&
    (event.type === "PLANNER_RESPONSE" || event.type === "USER_INPUT" || event.type === "MESSAGE")
  )) return true;
  return /[/\\]\.system_generated[/\\]logs[/\\]transcript(?:_full)?\.jsonl$/i.test(filePath);
}

/** Discovery indexes transcript.jsonl only. The full file and chunk rolls repeat it. */
export function isAntigravityDuplicateLog(filePath: string): boolean {
  if (path.basename(filePath) === "transcript_full.jsonl") return true;
  return filePath.split(path.sep).includes("chunks");
}

function locate(filePath: string): { base: string; id: string } | null {
  const logs = path.dirname(filePath);
  const system = path.dirname(logs);
  const conv = path.dirname(system);
  const brain = path.dirname(conv);
  if (path.basename(logs) !== "logs" || path.basename(system) !== ".system_generated") return null;
  if (path.basename(brain) !== "brain") return null;
  return { base: path.dirname(brain), id: path.basename(conv) };
}

function userText(raw: string): string {
  let main = raw;
  for (const tag of ["<ADDITIONAL_METADATA>", "<USER_SETTINGS_CHANGE>", "<USER_RULES>"]) {
    const at = main.indexOf(tag);
    if (at >= 0) main = main.slice(0, at);
  }
  main = main.trim();
  if (main.startsWith("<USER_REQUEST>")) {
    main = main.slice("<USER_REQUEST>".length);
    if (main.endsWith("</USER_REQUEST>")) main = main.slice(0, -"</USER_REQUEST>".length);
  }
  return main.trim();
}

function splitEffort(label: string): { model: string; effort: string | null } {
  const match = /^(.*)\((low|medium|high|extra high|xhigh|extra)\)\s*$/i.exec(label.trim());
  if (!match) return { model: label.trim(), effort: null };
  const word = match[2]!.toLowerCase();
  const effort = word === "extra high" || word === "xhigh" || word === "extra" ? "xhigh" : word;
  return { model: match[1]!.trim(), effort };
}

function selectedModel(content: string): { model: string; effort: string | null } | null {
  const blocks = content.split("<USER_SETTINGS_CHANGE>").slice(1)
    .map((block) => block.split("</USER_SETTINGS_CHANGE>")[0] ?? block);
  const source = blocks.length > 0 ? blocks.join("\n") : content;
  const match = source.match(/`Model Selection` from [\s\S]+? to ([\s\S]+?)(?:\. No need|\.\s*If reporting|$)/);
  const raw = match?.[1]?.trim().replace(/\.+$/, "");
  if (!raw || raw === "None") return null;
  return splitEffort(raw);
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function mapTool(name: string, args: unknown): { name: string; input: string; write: boolean } {
  const data = record(args);
  const lower = name.toLowerCase();
  const command = text(data.CommandLine ?? data.command ?? data.cmd);
  const file = text(data.AbsolutePath ?? data.file_path ?? data.FilePath ?? data.path ?? data.TargetFile ?? data.DirectoryPath);
  const pattern = text(data.Query ?? data.pattern ?? data.SearchPattern ?? data.query);
  if (["run_command", "command", "bash", "shell", "exec", "exec_command"].includes(lower)) {
    return { name: "exec", input: command || JSON.stringify(args ?? {}), write: false };
  }
  if (["view_file", "read_file", "read", "readfile"].includes(lower)) {
    return { name: "exec", input: `cat ${quoted(file)}`, write: false };
  }
  if (["grep_search", "grep"].includes(lower)) {
    const where = text(data.SearchPath ?? data.Path ?? data.path);
    return { name: "exec", input: `rg ${quoted(pattern)} ${quoted(where)}`, write: false };
  }
  if (["list_directory", "list_dir"].includes(lower)) {
    return { name: "exec", input: `ls ${quoted(file)}`, write: false };
  }
  const write = ["write_to_file", "replace_file_content", "multi_replace_file_content", "edit", "edit_file", "apply_patch"].includes(lower);
  if (write) return { name: "apply_patch", input: typeof args === "string" ? args : JSON.stringify(args ?? {}), write: true };
  if (["invoke_subagent", "send_message", "agent", "task"].includes(lower)) {
    return { name: "spawn_agent", input: typeof args === "string" ? args : JSON.stringify(args ?? {}), write: false };
  }
  return { name: name || "tool", input: typeof args === "string" ? args : JSON.stringify(args ?? {}), write: false };
}

function usableCwd(value: string): string | null {
  const cwd = value.trim();
  if (!cwd) return null;
  if (cwd.includes("/.gemini/") || cwd.includes("\\.gemini\\") || cwd.includes(`${path.sep}.gemini${path.sep}`)) return null;
  return cwd;
}

function toolOutput(raw: string): string {
  if (!raw.startsWith("Created At:")) return raw;
  const lines = raw.split("\n");
  let index = 1;
  if (lines[index]?.startsWith("Completed At:")) index += 1;
  while (lines[index] === "") index += 1;
  return lines.slice(index).join("\n");
}

function antigravityUsage(event: RolloutLine) {
  const input = number(event.input_tokens);
  const output = number(event.output_tokens);
  if (input == null || output == null) return null;
  const cached = number(event.cache_read_tokens) ?? 0;
  const write = number(event.cache_write_tokens ?? event.cache_creation_input_tokens) ?? 0;
  const reasoning = number(event.reasoning_tokens ?? event.thinking_tokens) ?? 0;
  const totalInput = input + cached + write;
  if (cached > totalInput) return null;
  return {
    input_tokens: totalInput,
    cached_input_tokens: cached,
    cache_write_input_tokens: write,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: totalInput + output,
  };
}

function pbtxtTitle(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.trim().match(/^title:\s*(.*)$/);
      if (!match) continue;
      const raw = match[1]!.trim();
      if (raw.startsWith('"')) {
        let value = "";
        let escaped = false;
        for (let index = 1; index < raw.length; index += 1) {
          const char = raw[index]!;
          if (escaped) { value += char; escaped = false; continue; }
          if (char === "\\") { escaped = true; continue; }
          if (char === '"') return value.trim() || null;
          value += char;
        }
      }
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
      } catch { /* plain text title */ }
      const bare = raw.trim();
      if (bare) return bare;
    }
  } catch { /* annotation is optional */ }
  return null;
}

function fileUriPath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}

function readSummary(base: string, id: string): { title?: string; cwd?: string; parent?: string } {
  const dbPath = path.join(base, "conversation_summaries.db");
  if (!existsSync(dbPath)) return {};
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON");
      const row = db.prepare(
        "SELECT title, workspace_uris, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?",
      ).get(id) as { title?: string; workspace_uris?: string; parent_conversation_id?: string } | undefined;
      if (!row) return {};
      let cwd: string | undefined;
      try {
        const uris = JSON.parse(text(row.workspace_uris) || "[]") as unknown;
        if (Array.isArray(uris)) {
          for (const uri of uris) {
            const parsed = fileUriPath(text(uri));
            if (parsed) { cwd = parsed; break; }
          }
        }
      } catch { /* workspace list is optional */ }
      const title = text(row.title).trim();
      const parent = text(row.parent_conversation_id).trim();
      return { ...(title ? { title } : {}), ...(cwd ? { cwd } : {}), ...(parent ? { parent } : {}) };
    } finally {
      db.close();
    }
  } catch { return {}; }
}

function readLastConversation(base: string, id: string): string | null {
  const file = path.join(base, "cache", "last_conversations.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const [cwd, value] of Object.entries(parsed)) {
      if (value === id) return usableCwd(cwd);
    }
  } catch { /* optional index */ }
  return null;
}

function emptyUsage() {
  return {
    input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
  };
}

export function parseAntigravitySession(events: RolloutLine[], filePath: string): NativeSession {
  const located = locate(filePath);
  const sourceId = located?.id || path.basename(filePath).replace(/\.(jsonl|ndjson)$/i, "");
  const id = `antigravity:${sourceId}`;
  const summary = located ? readSummary(located.base, sourceId) : {};
  const title = (located ? pbtxtTitle(path.join(located.base, "annotations", `${sourceId}.pbtxt`)) : null) || summary.title || null;
  let fallbackCwd: string | null = summary.cwd || (located ? readLastConversation(located.base, sourceId) : null);
  const latest = new Map<number, RolloutLine>();
  const order: number[] = [];
  for (const event of events) {
    const step = event.step_index;
    if (typeof step !== "number" || !Number.isFinite(step)) continue;
    if (!latest.has(step)) order.push(step);
    latest.set(step, event);
  }
  const steps = order.map((step) => latest.get(step)!);
  let prompt = "";
  let promptAt = "";
  let model: string | null = null;
  let effort: string | null = null;
  let messageCount = 0;
  let lastMeasured: ReturnType<typeof antigravityUsage> = null;
  const turns: NativeSession["turns"] = [];
  let pending: { index: number; next: number } | null = null;
  // Previous user or tool step. Antigravity does not record a first-token
  // time; the gap to this planner step is the request window when it is short.
  let anchorMs: number | null = null;
  const startedAt = iso(steps[0]?.created_at) || iso(steps[0]?.timestamp) || null;
  const lastEventAt = iso(steps.at(-1)?.created_at) || iso(steps.at(-1)?.timestamp) || fallbackMtime(filePath) || null;

  for (const event of steps) {
    const type = text(event.type);
    const at = iso(event.created_at) || iso(event.timestamp) || lastEventAt || "";
    if (type === "USER_INPUT") {
      messageCount += 1;
      pending = null;
      const content = text(event.content);
      const selected = selectedModel(content);
      if (selected) {
        model = selected.model;
        effort = selected.effort;
      }
      const next = userText(content);
      if (next) {
        prompt = next;
        promptAt = at;
      }
      const userMs = Date.parse(at);
      if (Number.isFinite(userMs)) anchorMs = userMs;
      continue;
    }
    if (type === "PLANNER_RESPONSE" || type === "MESSAGE") {
      messageCount += 1;
      const explicit = text(event.model ?? event.model_id ?? event.modelId ?? event.model_name);
      const turnModel = explicit || model;
      const turnEffort = explicit ? splitEffort(explicit).effort ?? effort : effort;
      const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
      let write = false;
      const tools: ToolCall[] = calls.map((call) => {
        const item = record(call);
        const args = item.args ?? item.arguments ?? item.input;
        const mapped = mapTool(text(item.name), args);
        write ||= mapped.write;
        const cwd = usableCwd(text(record(args).Cwd ?? record(args).DirectoryPath));
        if (!fallbackCwd && cwd) fallbackCwd = cwd;
        return {
          name: mapped.name, input: mapped.input, outputSha256: sha256(""),
          outputBytes: 0, outputPreview: "",
        };
      });
      const usage = antigravityUsage(event);
      if (usage) lastMeasured = usage;
      const response = text(event.content) || text(event.thinking);
      if (usage == null && !response && tools.length === 0) {
        pending = null;
        const skippedMs = Date.parse(at);
        if (Number.isFinite(skippedMs)) anchorMs = skippedMs;
        continue;
      }
      const step = typeof event.step_index === "number" ? event.step_index : turns.length;
      const endedMs = Date.parse(at);
      const gap = anchorMs != null && Number.isFinite(endedMs) ? endedMs - anchorMs : null;
      const durationMs = gap != null && gap > 0 && gap <= 3 * 60 * 1000 ? gap : null;
      const native = nativeCost(usage, turnModel);
      turns.push({
        id: `${id}:${step}`,
        sessionId: id,
        startedAt: promptAt || at,
        endedAt: at,
        model: turnModel,
        effort: turnEffort,
        fastMode: false,
        pricing: native.pricing,
        usageRecorded: usage != null,
        requestPerformance: requestPerformance(usage?.output_tokens ?? null, durationMs != null ? { duration_ms: durationMs } : {}, event),
        prompt,
        response,
        tools,
        usage: usage ?? emptyUsage(),
        cost: native.cost,
        bucket: "other",
        labels: [],
        hasPatchApply: write,
        collaborationMode: null,
      });
      pending = tools.length > 0 ? { index: turns.length - 1, next: 0 } : null;
      if (Number.isFinite(endedMs)) anchorMs = endedMs;
      continue;
    }
    if (!SYSTEM_STEPS.has(type)) {
      const ms = Date.parse(at);
      if (Number.isFinite(ms)) anchorMs = ms;
    }
    if (SYSTEM_STEPS.has(type) || !pending) continue;
    const turn = turns[pending.index];
    const tool = turn?.tools[pending.next];
    if (!turn || !tool) {
      pending = null;
      continue;
    }
    const output = toolOutput(text(event.content) || text(event.error));
    tool.outputSha256 = sha256(output);
    tool.outputBytes = Buffer.byteLength(output, "utf8");
    tool.outputPreview = preview(output);
    pending.next += 1;
    if (pending.next >= turn.tools.length) pending = null;
  }

  const contextMeasurement: ContextMeasurement | null = lastMeasured ? {
    usedTokens: lastMeasured.input_tokens,
    limitTokens: null,
    usagePercent: null,
    source: "antigravity",
    categories: [
      { id: "input", label: "未缓存输入", tokens: lastMeasured.input_tokens - lastMeasured.cached_input_tokens - lastMeasured.cache_write_input_tokens },
      ...(lastMeasured.cached_input_tokens > 0 ? [{ id: "cache_read", label: "缓存读取", tokens: lastMeasured.cached_input_tokens }] : []),
      ...(lastMeasured.cache_write_input_tokens > 0 ? [{ id: "cache_write", label: "缓存写入", tokens: lastMeasured.cache_write_input_tokens }] : []),
    ].filter((item) => item.tokens > 0),
  } : null;

  return {
    source: "antigravity",
    sourceId,
    meta: {
      id,
      parentId: summary.parent ? `antigravity:${summary.parent}` : null,
      nickname: title,
      cwd: fallbackCwd,
      startedAt,
      contextMeasurement,
    },
    turns,
    messageCount,
    lastEventAt,
    taskTimings: [],
    model: turns.at(-1)?.model ?? model,
  };
}

function fallbackMtime(filePath: string): string {
  try { return new Date(statSync(filePath).mtimeMs).toISOString(); } catch { return ""; }
}
