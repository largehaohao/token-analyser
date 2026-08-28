import { preview, sha256 } from "./hash.ts";
import { effectiveRateCard, priceUsage } from "./rate-card.ts";
import type {
  RolloutLine,
  SessionMeta,
  TokenUsage,
  ToolCall,
  Turn,
} from "./types.ts";

type TurnContext = {
  model: string | null;
  effort: string | null;
  fastMode: boolean;
  collaborationMode: string | null;
};

type PendingTool = {
  name: string;
  input: string;
  callId: string;
};

type WindowState = {
  promptParts: string[];
  pendingTools: PendingTool[];
  tools: ToolCall[];
  hasPatchApply: boolean;
  startedAt: string | null;
};

type PendingOwner = {
  pending: PendingTool;
  turn: Turn;
};

function usageEqual(a: TokenUsage, b: TokenUsage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function extractSubagentMeta(source: unknown): {
  parentId: string | null;
  nickname: string | null;
} {
  const sourceRecord = asRecord(source);
  const subagent = sourceRecord ? asRecord(sourceRecord.subagent) : null;
  const threadSpawn = subagent ? asRecord(subagent.thread_spawn) : null;
  if (!threadSpawn) {
    return { parentId: null, nickname: null };
  }
  return {
    parentId:
      typeof threadSpawn.parent_thread_id === "string"
        ? threadSpawn.parent_thread_id || null
        : null,
    nickname:
      typeof threadSpawn.agent_nickname === "string"
        ? threadSpawn.agent_nickname || null
        : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function canonicalToolName(value: unknown): string {
  const name = asString(value).trim();
  const lower = name.toLowerCase();
  if (/(^|[._]|__)exec(?:_command)?$/.test(lower)) return "exec";
  if (/(^|[._]|__)wait(?:_agent|_threads)?$/.test(lower)) return "wait_agent";
  if (/(^|[._]|__)list(?:_agents|_threads)?$/.test(lower)) return "list_agents";
  if (/(^|[._]|__)write_stdin$/.test(lower)) return "write_stdin";
  if (/(^|[._]|__)send_message(?:_to_thread)?$/.test(lower)) {
    return "send_message";
  }
  if (/(^|[._]|__)(?:spawn_agent|create_thread|fork_thread)$/.test(lower)) {
    return "spawn_agent";
  }
  if (/(^|[._]|__)followup_task$/.test(lower)) return "send_message";
  return name;
}

function normalizeToolInput(value: unknown, toolName: string): string {
  const text = asString(value);
  if (toolName !== "exec" || !text) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    if (record && typeof record.cmd === "string") return record.cmd;
    if (record && typeof record.command === "string") return record.command;
  } catch {
    // The input may already be a plain shell command.
  }
  return text;
}

function extractTurnContext(payload: Record<string, unknown>): TurnContext {
  const collaboration = asRecord(payload.collaboration_mode);
  const settings = collaboration ? asRecord(collaboration.settings) : null;
  const effort =
    (typeof settings?.reasoning_effort === "string"
      ? settings.reasoning_effort
      : undefined) ??
    (typeof payload.effort === "string" ? payload.effort : undefined) ??
    null;
  const fastMode =
    payload.fast_mode === true || payload.speed === "fast";
  const model =
    (typeof payload.model === "string" ? payload.model : undefined) ??
    (typeof settings?.model === "string" ? settings.model : undefined) ??
    null;
  return {
    model,
    effort,
    fastMode,
    collaborationMode: asString(collaboration?.mode) || null,
  };
}

function extractUsage(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "total_tokens",
  ]) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) {
      return null;
    }
  }
  const usage: TokenUsage = {
    input_tokens: Number(record.input_tokens ?? 0),
    cached_input_tokens: Number(record.cached_input_tokens ?? 0),
    cache_write_input_tokens: Number(record.cache_write_input_tokens ?? 0),
    output_tokens: Number(record.output_tokens ?? 0),
    reasoning_output_tokens: Number(record.reasoning_output_tokens ?? 0),
    total_tokens: Number(record.total_tokens ?? 0),
  };
  return Object.values(usage).every(
    (item) => Number.isFinite(item) && item >= 0,
  ) && usage.cached_input_tokens <= usage.input_tokens
    ? usage
    : null;
}

function extractUserText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const part = asRecord(item);
      return part?.type === "input_text" ? asString(part.text) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function newWindow(): WindowState {
  return {
    promptParts: [],
    pendingTools: [],
    tools: [],
    hasPatchApply: false,
    startedAt: null,
  };
}

function finalizeTool(pending: PendingTool, output: string): ToolCall {
  return {
    name: pending.name,
    input: pending.input,
    outputSha256: sha256(output),
    outputBytes: Buffer.byteLength(output, "utf8"),
    outputPreview: preview(output),
  };
}

function pairToolOutput(
  window: WindowState,
  outstanding: PendingOwner[],
  callId: string,
  output: string,
): void {
  let index = callId
    ? window.pendingTools.findIndex((tool) => tool.callId === callId)
    : window.pendingTools.length === 1
      ? 0
      : -1;
  if (index !== -1) {
    const [pending] = window.pendingTools.splice(index, 1);
    window.tools.push(finalizeTool(pending!, output));
    return;
  }

  index = callId
    ? outstanding.findIndex((owner) => owner.pending.callId === callId)
    : outstanding.length === 1
      ? 0
      : -1;
  if (index !== -1) {
    const [owner] = outstanding.splice(index, 1);
    owner!.turn.tools.push(finalizeTool(owner!.pending, output));
  }
}

function movePendingTools(window: WindowState, turn: Turn, outstanding: PendingOwner[]): void {
  for (const pending of window.pendingTools) {
    outstanding.push({ pending, turn });
  }
  window.pendingTools = [];
}

function flushOutstandingTools(outstanding: PendingOwner[]): void {
  for (const owner of outstanding) {
    owner.turn.tools.push(finalizeTool(owner.pending, ""));
  }
  outstanding.length = 0;
}

function withinSlack(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1;
}

function accumulateEvent(
  event: RolloutLine,
  window: WindowState,
  armed: boolean,
  outstanding: PendingOwner[],
) {
  if (!armed) return;

  const payload = asRecord(event.payload) ?? {};

  if (event.type === "turn_context") {
    return;
  }

  if (event.type === "event_msg") {
    const type = payload.type;
    if (type === "task_started") {
      window.startedAt =
        asString(payload.started_at) || event.timestamp;
      return;
    }
    if (type === "user_message") {
      const text = asString(payload.message ?? payload.text ?? payload.content);
      if (text) window.promptParts.push(text);
      return;
    }
    if (type === "patch_apply_end") {
      window.hasPatchApply = true;
    }
    return;
  }

  if (event.type !== "response_item") return;

  const itemType = payload.type;
  if (itemType === "message" && payload.role === "user") {
    const text = extractUserText(payload);
    if (text) window.promptParts.push(text);
    return;
  }

  if (itemType === "custom_tool_call" || itemType === "function_call") {
    const fn = asRecord(payload.function);
    const name = canonicalToolName(payload.name ?? fn?.name);
    window.pendingTools.push({
      name,
      input: normalizeToolInput(
        payload.input ?? payload.arguments ?? fn?.arguments,
        name,
      ),
      callId: asString(payload.call_id),
    });
    return;
  }

  if (
    itemType === "custom_tool_call_output" ||
    itemType === "function_call_output"
  ) {
    pairToolOutput(
      window,
      outstanding,
      asString(payload.call_id),
      asString(payload.output),
    );
  }
}

export function buildLedger(
  events: RolloutLine[],
  sessionId: string,
  opts: { isSubagent: boolean },
): {
  turns: Turn[];
  ledger_warning: boolean;
  fastMode: boolean;
  meta: SessionMeta;
} {
  const card = effectiveRateCard();
  let meta: SessionMeta = {
    id: sessionId,
    parentId: null,
    nickname: null,
    cwd: null,
    startedAt: null,
  };

  let turnContext: TurnContext = {
    model: null,
    effort: null,
    fastMode: false,
    collaborationMode: null,
  };
  let sessionFastMode = false;

  let armed = !opts.isSubagent;
  let window = newWindow();
  const outstanding: PendingOwner[] = [];
  let lastPrompt = "";
  let keptTurnCount = 0;
  let ledger_warning = false;

  let prevLastUsage: TokenUsage | null = null;
  let prevTotalUsage: TokenUsage | null = null;
  let runningInput = 0;
  let runningOutput = 0;
  let runningCached = 0;
  let runningCacheWrite = 0;
  let runningReasoning = 0;
  let runningTotal = 0;

  const turns: Turn[] = [];

  for (const event of events) {
    const payload = asRecord(event.payload) ?? {};

    if (event.type === "session_meta") {
      const subagentMeta = extractSubagentMeta(payload.source);
      meta = {
        id: asString(payload.id ?? payload.session_id) || sessionId,
        parentId: subagentMeta.parentId,
        nickname: subagentMeta.nickname,
        cwd: (payload.cwd as string | null | undefined) ?? null,
        startedAt:
          (payload.started_at as string | null | undefined) ??
          event.timestamp,
      };
      continue;
    }

    if (event.type === "turn_context") {
      turnContext = extractTurnContext(payload);
      if (turnContext.fastMode) sessionFastMode = true;
      continue;
    }

    if (event.type === "event_msg" && payload.type === "task_started") {
      if (opts.isSubagent) armed = true;
      accumulateEvent(event, window, armed, outstanding);
      continue;
    }

    if (
      event.type === "event_msg" &&
      payload.type === "token_count" &&
      armed
    ) {
      const info = asRecord(payload.info);
      const lastUsage = extractUsage(info?.last_token_usage);
      const totalUsage = extractUsage(info?.total_token_usage);
      if (!lastUsage || !totalUsage) {
        if (
          info &&
          (info.last_token_usage !== undefined ||
            info.total_token_usage !== undefined)
        ) {
          ledger_warning = true;
        }
        continue;
      }

      if (
        prevLastUsage &&
        prevTotalUsage &&
        usageEqual(lastUsage, prevLastUsage) &&
        usageEqual(totalUsage, prevTotalUsage)
      ) {
        continue;
      }

      keptTurnCount += 1;
      const turnId = `${sessionId}:${event.ordinal ?? keptTurnCount}`;
      const prompt = window.promptParts.join("\n") || lastPrompt;
      if (window.promptParts.length > 0) lastPrompt = prompt;

      const turn: Turn = {
        id: turnId,
        sessionId,
        startedAt: window.startedAt ?? event.timestamp,
        endedAt: event.timestamp,
        model: turnContext.model,
        effort: turnContext.effort,
        prompt,
        tools: window.tools,
        usage: lastUsage,
        cost: priceUsage(
          lastUsage,
          turnContext.model,
          card,
          turnContext.fastMode,
        ),
        bucket: "other",
        labels: [],
        hasPatchApply: window.hasPatchApply,
        collaborationMode: turnContext.collaborationMode,
      };
      turns.push(turn);
      movePendingTools(window, turn, outstanding);

      prevLastUsage = lastUsage;
      prevTotalUsage = totalUsage;

      runningInput += lastUsage.input_tokens;
      runningOutput += lastUsage.output_tokens;
      runningCached += lastUsage.cached_input_tokens;
      runningCacheWrite += lastUsage.cache_write_input_tokens;
      runningReasoning += lastUsage.reasoning_output_tokens;
      runningTotal += lastUsage.total_tokens;

      if (
        !withinSlack(runningInput, totalUsage.input_tokens) ||
        !withinSlack(runningOutput, totalUsage.output_tokens) ||
        !withinSlack(runningCached, totalUsage.cached_input_tokens) ||
        !withinSlack(runningCacheWrite, totalUsage.cache_write_input_tokens) ||
        !withinSlack(runningReasoning, totalUsage.reasoning_output_tokens) ||
        !withinSlack(runningTotal, totalUsage.total_tokens)
      ) {
        ledger_warning = true;
      }

      window = newWindow();
      continue;
    }

    accumulateEvent(event, window, armed, outstanding);
  }

  flushOutstandingTools(outstanding);

  return {
    turns,
    ledger_warning,
    fastMode: sessionFastMode,
    meta,
  };
}
