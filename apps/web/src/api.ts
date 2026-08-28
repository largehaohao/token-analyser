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
  key: "planning" | "code" | "reread" | "subagents" | "waiting" | "other";
  raw: number;
  credits: number | null;
  usd: number | null;
};

export type OverviewDay = {
  date: string;
  cost: Cost;
  flaggedCost: Cost;
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
  days: OverviewDay[];
  slices: OverviewSlice[];
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
};

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listSessions(): Promise<SessionListItem[]> {
  const body = await parseJson<{ sessions: SessionListItem[] }>(
    await fetch("/sessions"),
  );
  return body.sessions;
}

export async function getOverview(range: SessionRangeId = "7d"): Promise<Overview> {
  const query = overviewQuery(range);
  const params = new URLSearchParams();
  if (query.since) params.set("since", query.since);
  params.set("days", String(query.days));
  return parseJson<Overview>(await fetch(`/overview?${params.toString()}`));
}

export async function getSession(id: string): Promise<SessionSnapshot> {
  return parseJson<SessionSnapshot>(await fetch(`/sessions/${id}`));
}

export async function patchToggles(
  id: string,
  toggles: Partial<Record<WasteToggleId, boolean>>,
): Promise<SessionSnapshot> {
  return parseJson<SessionSnapshot>(
    await fetch(`/sessions/${id}/waste-toggles`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toggles),
    }),
  );
}

export async function importNdjson(
  filename: string,
  text: string,
): Promise<SessionSnapshot> {
  return parseJson<SessionSnapshot>(
    await fetch("/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        "X-Filename": filename,
      },
      body: text,
    }),
  );
}

export type StreamStatus = "connecting" | "open" | "error";

export function openStream(
  onEvent: (e: { type: string; id: string }) => void,
  onStatus?: (status: StreamStatus) => void,
): () => void {
  const es = new EventSource("/stream");
  onStatus?.("connecting");
  es.onopen = () => onStatus?.("open");
  es.onerror = () => {
    onStatus?.(es.readyState === EventSource.CLOSED ? "error" : "connecting");
  };

  const handler =
    (type: string) =>
    (ev: MessageEvent): void => {
      try {
        const data = JSON.parse(ev.data as string) as { id: string };
        onEvent({ type, id: data.id });
      } catch {
        // ignore malformed events
      }
    };

  es.addEventListener("session_added", handler("session_added"));
  es.addEventListener("session_updated", handler("session_updated"));
  es.addEventListener("session_error", handler("session_error"));

  return () => es.close();
}
