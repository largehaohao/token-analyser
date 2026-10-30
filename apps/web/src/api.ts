import { overviewQuery, type SessionRangeId } from "./session-range";
import type { SessionSourceFilter } from "./session-source";

export type Cost = {
  raw: number;
  uncached_input: number;
  cached_input: number;
  output: number;
  credits: number | null;
  usd: number | null;
  unmeasured?: number;
};

export type SessionSource = "codex" | "claude" | "cursor" | "pi" | "dsh";

export type PerformanceBasis = "task" | "request";

export type PerformanceSummary = {
  taskCount: number;
  ttftSampleCount: number;
  speedSampleCount: number;
  avgTtftMs: number | null;
  outputTokensPerSecond: number | null;
  /** "task": whole agent tasks; "request": single model requests; null: no samples. */
  basis: PerformanceBasis | null;
};

export type RequestPerformance = {
  ttftMs: number | null;
  durationMs: number | null;
  outputTokensPerSecond: number | null;
  speedSource: "recorded" | "decode" | "duration" | null;
};

export type WasteToggleId =
  | "poll"
  | "reread"
  | "compaction_loop"
  | "idle_subagents"
  | "coord"
  | "healthy_subagents"
  | "planning"
  | "code";

export type TreeNode = {
  id: string;
  kind: "root" | "bucket" | "waiting" | "subagents" | "child";
  label: string;
  bucket?: string;
  sessionId?: string;
  cost: Cost;
  percentOfParent: number;
  children: TreeNode[];
  turnIds: string[];
};

export type Turn = {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  model: string | null;
  effort: string | null;
  fastMode?: boolean;
  pricing?: {
    mode: "standard" | "fast";
    multiplier: number;
    input: number;
    cached: number;
    output: number;
    unit?: "credits" | "usd";
    cacheWrite?: number;
  } | null;
  usageRecorded?: boolean;
  response?: string;
  requestPerformance?: RequestPerformance;
  prompt: string;
  tools: {
    name: string;
    input: string;
    outputSha256: string;
    outputBytes: number;
    outputPreview: string;
  }[];
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  };
  cost: Cost;
  bucket?: string;
  labels?: string[];
};

export type Suggestion = {
  id: string;
  kind: string;
  title: string;
  body: string;
  turnIds: string[];
};

export type ContextItem = {
  name: string;
  chars: number;
  source?: string;
  description?: string;
};

export type ContextBucket = {
  chars: number;
  items: ContextItem[];
};

export type ContextProfile = {
  tools: ContextBucket;
  skills: ContextBucket;
};

/** Token counts the source itself measured, such as Cursor's context meter. */
export type ContextMeasurement = {
  usedTokens: number | null;
  limitTokens: number | null;
  usagePercent: number | null;
  source: string;
  categories: { id: string; label: string; tokens: number }[];
};

export type SessionSnapshot = {
  id: string;
  source?: SessionSource;
  sourceId?: string;
  messageCount?: number;
  forkedFrom?: string;
  parentId: string | null;
  nickname: string | null;
  cwd: string | null;
  live: boolean;
  path: string;
  startedAt: string | null;
  lastEventAt: string | null;
  model: string | null;
  effort: string | null;
  ledger_warning: boolean;
  parse_errors: { offset: number; message: string }[];
  rate_limits: unknown | null;
  rateLimitSnapshots?: { capturedAt: string; raw: unknown }[];
  rateCardAsOf: string;
  fastMode: boolean;
  cost: Cost;
  waste: Cost;
  toggles: Record<WasteToggleId, boolean>;
  tree: TreeNode;
  turns: Turn[];
  children: SessionSnapshot[];
  suggestions: Suggestion[];
  context?: ContextProfile;
  contextMeasurement?: ContextMeasurement | null;
  performance?: PerformanceSummary;
};

export type OverviewSlice = {
  key:
    | "planning"
    | "reading"
    | "verification"
    | "code"
    | "reread"
    | "tooling"
    | "communication"
    | "subagents"
    | "waiting"
    | "other";
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

export type PerformanceDistribution = {
  /** Sample counts: ≤1s, (1,2]s, (2,3]s, (3,5]s, >5s. */
  ttft: number[];
  /** Sample counts: ≤10, (10,25], (25,40], (40,60], >60 tok/s. */
  tps: number[];
  sampleCount: number;
};

/** The newest source-recorded usage-limit snapshot in the overview window. */
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
  apiPricesAsOf?: string;
  fastMultiplier?: number;
  quality?: {
    pricedRaw: number;
    unpricedRaw: number;
    ledgerWarningSessions: number;
    parseErrors: number;
  };
  days: OverviewDay[];
  slices: OverviewSlice[];
  models?: OverviewModel[];
  performance?: PerformanceSummary;
  performanceDistribution?: PerformanceDistribution;
  rateLimits?: OverviewRateLimits | null;
};

export type OverviewModel = {
  model: string;
  turnCount: number;
  cost: Cost;
  unpricedRaw: number;
};

export type SessionListItem = {
  id: string;
  source?: SessionSource;
  sourceId?: string;
  messageCount?: number;
  parentId: string | null;
  nickname: string | null;
  cwd: string | null;
  live: boolean;
  model: string | null;
  effort: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  cost: Cost;
  waste: Cost;
  parse_error: boolean;
  parse_error_offset?: number;
  parse_error_message?: string;
  ledger_warning: boolean;
  toolsChars: number;
  toolsCount: number;
  skillsChars: number;
  skillsCount: number;
  unpricedRaw?: number;
};

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = `: ${body.error}`;
    } catch {
      // ignore non-JSON error bodies
    }
    const err = new Error(`HTTP ${res.status}${detail}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 20_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const external = init?.signal ?? null;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort);
  }
  try {
    return await parseJson<T>(
      await fetch(url, { ...init, signal: controller.signal }),
    );
  } catch (error) {
    // 外部主动取消（切范围/卸载）原样抛出 AbortError，由调用方静默忽略；
    // 只有内部计时器触发的取消才是“请求超时”。
    if (controller.signal.aborted && !(external && external.aborted))
      throw new Error("请求超时，请确认本地引擎正在运行后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

export type PowerSampleDto = {
  t: number;
  cpu: number | null;
  gpu: number | null;
  machine: number | null;
};

export type PowerFeed = {
  source: "prometheus";
  connected: boolean;
  url?: string;
  error?: string;
  startMs: number;
  endMs: number;
  stepMs: number;
  samples: PowerSampleDto[];
};

/** 硬件用电：读取所选范围的功率采样；采集源不可达时 connected=false。 */
export async function getPowerFeed(
  startMs: number,
  endMs: number,
  stepMs: number,
  signal?: AbortSignal,
): Promise<PowerFeed> {
  const params = new URLSearchParams({
    start: String(Math.round(startMs)),
    end: String(Math.round(endMs)),
    step: String(Math.round(stepMs)),
  });
  return requestJson<PowerFeed>(
    `/power?${params.toString()}`,
    { signal },
    20000,
  );
}

export async function listSessions(): Promise<SessionListItem[]> {
  const body = await requestJson<{ sessions: SessionListItem[] }>("/sessions");
  return body.sessions;
}

export async function getOverview(
  range: SessionRangeId = "7d",
  nowMs = Date.now(),
  source: SessionSourceFilter = "all",
  window?: { sinceMs: number; untilMs: number; days: number },
  model?: string,
): Promise<Overview> {
  const query = window
    ? {
        since: new Date(window.sinceMs).toISOString(),
        days: window.days,
        until: new Date(window.untilMs).toISOString(),
      }
    : overviewQuery(range, nowMs);
  const params = new URLSearchParams();
  if (source !== "all") params.set("source", source);
  if (query.since) params.set("since", query.since);
  if ("until" in query && query.until) params.set("until", query.until);
  params.set("days", String(query.days));
  params.set(
    "timezone_offset_minutes",
    String(-new Date(nowMs).getTimezoneOffset()),
  );
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone) params.set("timezone", timezone);
  if (model) params.set("model", model);
  return requestJson<Overview>(`/overview?${params.toString()}`);
}

export type PricingSourceResult = {
  /** `ok`, or the engine error code for that price source. */
  status: string;
  asOf?: string;
  modelCount?: number;
};

export type ModelPricingUpdate = {
  asOf: string;
  modelCount: number;
  codex?: PricingSourceResult;
  qwen?: PricingSourceResult;
};

export async function updateModelPrices(): Promise<ModelPricingUpdate> {
  try {
    return await requestJson<ModelPricingUpdate>(
      "/pricing/update",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      30_000,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("official_pricing_unavailable")) {
      throw new Error("无法连接 OpenAI Codex 官网价格页，请检查网络后重试。");
    }
    if (message.includes("qwen_pricing_unavailable")) {
      throw new Error("无法连接千问官方价格页，请检查网络后重试。");
    }
    if (message.includes("official_pricing_format_changed")) {
      throw new Error("官网价格表格式发生变化，未修改本地价格配置。");
    }
    if (message.includes("qwen_pricing_format_changed")) {
      throw new Error("千问官方价格表格式发生变化，未修改本地价格配置。");
    }
    if (
      message.includes("rate_card_read_failed") ||
      message.includes("api_prices_read_failed")
    ) {
      throw new Error("无法读取本地模型价格配置文件。");
    }
    if (
      message.includes("rate_card_write_failed") ||
      message.includes("api_prices_write_failed")
    ) {
      throw new Error("本地价格配置写入失败，请检查文件权限。");
    }
    if (message.includes("pricing_recalculation_failed")) {
      throw new Error("重新计算本地成本失败，价格配置已恢复原样。");
    }
    if (message.includes("pricing_recalculation_rollback_failed")) {
      throw new Error("重新计价失败且配置回滚未完成，请检查本地价格配置。");
    }
    throw error;
  }
}

export async function getSession(id: string): Promise<SessionSnapshot> {
  return requestJson<SessionSnapshot>(`/sessions/${encodeURIComponent(id)}`);
}

export async function patchToggles(
  id: string,
  toggles: Partial<Record<WasteToggleId, boolean>>,
): Promise<SessionSnapshot> {
  return requestJson<SessionSnapshot>(
    `/sessions/${encodeURIComponent(id)}/waste-toggles`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toggles),
    },
  );
}

export async function importNdjson(
  filename: string,
  text: string,
): Promise<SessionSnapshot> {
  try {
    return await requestJson<SessionSnapshot>(
      "/import",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": encodeURIComponent(filename),
        },
        body: text,
      },
      120_000,
    );
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 413)
      throw new Error("文件超过引擎的导入上限，请选择较小的记录。");
    if (status && status < 500)
      throw new Error(
        "无法识别会话记录，请确认文件来自 Codex、Claude Code、Cursor、pi 或 DeepSeek Harness，且包含有效的 JSONL 内容。",
      );
    throw new Error(
      "导入结果尚未确认。请先检查会话列表，确认未导入后再重新选择文件。",
    );
  }
}

// Import returns a confirmed snapshot before a follow-up list refresh. Keep the
// new session visible even if that independent read temporarily fails.
export function sessionSummary(snapshot: SessionSnapshot): SessionListItem {
  const firstError = snapshot.parse_errors?.[0];
  return {
    id: snapshot.id,
    source: snapshot.source,
    sourceId: snapshot.sourceId,
    messageCount: snapshot.messageCount,
    parentId: snapshot.parentId,
    nickname: snapshot.nickname,
    cwd: snapshot.cwd,
    live: snapshot.live,
    model: snapshot.model,
    effort: snapshot.effort,
    startedAt: snapshot.startedAt,
    lastEventAt: snapshot.lastEventAt,
    cost: snapshot.cost,
    waste: snapshot.waste,
    parse_error: !!firstError,
    parse_error_offset: firstError?.offset,
    parse_error_message: firstError?.message,
    ledger_warning: snapshot.ledger_warning,
    toolsChars: snapshot.context?.tools.chars ?? 0,
    toolsCount: snapshot.context?.tools.items.length ?? 0,
    skillsChars: snapshot.context?.skills.chars ?? 0,
    skillsCount: snapshot.context?.skills.items.length ?? 0,
  };
}

export type StreamStatus = "connecting" | "open" | "error";

export type StreamEvent = {
  type: string;
  id: string;
  reason?: string;
};

export function openStream(
  onEvent: (e: StreamEvent) => void,
  onStatus?: (status: StreamStatus) => void,
): () => void {
  const es = new EventSource("/stream");
  onStatus?.("connecting");
  es.onopen = () => {
    onStatus?.("open");
    onEvent({ type: "resync", id: "*" });
  };
  es.onerror = () => {
    onStatus?.(es.readyState === EventSource.CLOSED ? "error" : "connecting");
  };

  const handler =
    (type: string) =>
    (ev: MessageEvent): void => {
      try {
        const data = JSON.parse(ev.data as string) as {
          id: string;
          reason?: string;
        };
        onEvent({ type, id: data.id, reason: data.reason });
      } catch {
        // ignore malformed events
      }
    };

  es.addEventListener("session_added", handler("session_added"));
  es.addEventListener("session_updated", handler("session_updated"));
  es.addEventListener("session_error", handler("session_error"));

  return () => es.close();
}
