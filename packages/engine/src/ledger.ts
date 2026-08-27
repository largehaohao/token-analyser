import { preview, sha256 } from "./hash.ts";
import { loadRateCard, priceUsage } from "./rate-card.ts";
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
    parentId: asString(threadSpawn.parent_thread_id) || null,
    nickname: asString(threadSpawn.agent_nickname) || null,
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
  return String(value);
}

function extractTurnContext(payload: Record<string, unknown>): TurnContext {
  const collaboration = asRecord(payload.collaboration_mode);
  const settings = collaboration ? asRecord(collaboration.settings) : null;
  const effort =
    (settings?.reasoning_effort as string | undefined) ??
    (payload.effort as string | undefined) ??
    null;
  const fastMode =
    payload.fast_mode === true || payload.speed === "fast";
  return {
    model: (payload.model as string | undefined) ?? null,
    effort,
    fastMode,
  };
}

function extractUsage(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    input_tokens: Number(record.input_tokens ?? 0),
    cached_input_tokens: Number(record.cached_input_tokens ?? 0),
    cache_write_input_tokens: Number(record.cache_write_input_tokens ?? 0),
    output_tokens: Number(record.output_tokens ?? 0),
    reasoning_output_tokens: Number(record.reasoning_output_tokens ?? 0),
    total_tokens: Number(record.total_tokens ?? 0),
  };
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

function pairToolOutput(window: WindowState, callId: string, output: string) {
  const index = window.pendingTools.findIndex((tool) => tool.callId === callId);
  if (index === -1) return;
  const [pending] = window.pendingTools.splice(index, 1);
  window.tools.push(finalizeTool(pending, output));
}

function flushPendingTools(window: WindowState) {
  for (const pending of window.pendingTools) {
    window.tools.push(finalizeTool(pending, ""));
  }
  window.pendingTools = [];
}

function withinSlack(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1;
}

function accumulateEvent(
  event: RolloutLine,
  window: WindowState,
  armed: boolean,
) {
  if (!armed) return;

  const payload = event.payload ?? {};

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
    window.pendingTools.push({
      name: asString(payload.name),
      input: asString(payload.input ?? payload.arguments),
      callId: asString(payload.call_id),
    });
    return;
  }

  if (
    itemType === "custom_tool_call_output" ||
    itemType === "function_call_output"
  ) {
    pairToolOutput(window, asString(payload.call_id), asString(payload.output));
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
  const card = loadRateCard();
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
  };
  let sessionFastMode = false;

  let armed = !opts.isSubagent;
  let window = newWindow();
  let keptTurnCount = 0;
  let ledger_warning = false;

  let prevLastUsage: TokenUsage | null = null;
  let prevTotalUsage: TokenUsage | null = null;
  let runningInput = 0;
  let runningOutput = 0;
  let runningCached = 0;

  const turns: Turn[] = [];

  for (const event of events) {
    const payload = event.payload ?? {};

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
      accumulateEvent(event, window, armed);
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
      if (!lastUsage || !totalUsage) continue;

      if (
        prevLastUsage &&
        prevTotalUsage &&
        usageEqual(lastUsage, prevLastUsage) &&
        usageEqual(totalUsage, prevTotalUsage)
      ) {
        continue;
      }

      flushPendingTools(window);
      keptTurnCount += 1;
      const turnId = `${sessionId}:${event.ordinal ?? keptTurnCount}`;

      const turn: Turn = {
        id: turnId,
        sessionId,
        startedAt: window.startedAt ?? event.timestamp,
        endedAt: event.timestamp,
        model: turnContext.model,
        effort: turnContext.effort,
        prompt: window.promptParts.join("\n"),
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
      };
      turns.push(turn);

      prevLastUsage = lastUsage;
      prevTotalUsage = totalUsage;

      runningInput += lastUsage.input_tokens;
      runningOutput += lastUsage.output_tokens;
      runningCached += lastUsage.cached_input_tokens;

      if (
        !withinSlack(runningInput, totalUsage.input_tokens) ||
        !withinSlack(runningOutput, totalUsage.output_tokens) ||
        !withinSlack(runningCached, totalUsage.cached_input_tokens)
      ) {
        ledger_warning = true;
      }

      window = newWindow();
      continue;
    }

    accumulateEvent(event, window, armed);
  }

  return {
    turns,
    ledger_warning,
    fastMode: sessionFastMode,
    meta,
  };
}
