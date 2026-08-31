import { overviewQuery, type SessionRangeId } from "./session-range";

export type Cost = {
  raw: number;
  uncached_input: number;
  cached_input: number;
  output: number;
  credits: number | null;
  usd: number | null;
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

export type SessionSnapshot = {
  id: string;
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
  quality?: {
    pricedRaw: number;
    unpricedRaw: number;
    ledgerWarningSessions: number;
    parseErrors: number;
  };
  days: OverviewDay[];
  slices: OverviewSlice[];
  models?: OverviewModel[];
};

export type OverviewModel = {
  model: string;
  turnCount: number;
  cost: Cost;
  unpricedRaw: number;
};

export type SessionListItem = {
  id: string;
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
  try {
    return await parseJson<T>(
      await fetch(url, { ...init, signal: controller.signal }),
    );
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("请求超时，请确认本地引擎正在运行后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function listSessions(): Promise<SessionListItem[]> {
  const body = await requestJson<{ sessions: SessionListItem[] }>("/sessions");
  return body.sessions;
}

export async function getOverview(
  range: SessionRangeId = "7d",
  nowMs = Date.now(),
): Promise<Overview> {
  const query = overviewQuery(range, nowMs);
  const params = new URLSearchParams();
  if (query.since) params.set("since", query.since);
  params.set("days", String(query.days));
  params.set(
    "timezone_offset_minutes",
    String(-new Date(nowMs).getTimezoneOffset()),
  );
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone) params.set("timezone", timezone);
  return requestJson<Overview>(`/overview?${params.toString()}`);
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
        "无法识别会话记录，请确认文件来自 Codex，且包含有效的 JSONL 内容。",
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
