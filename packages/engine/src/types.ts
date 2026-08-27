export type TokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

export type Cost = {
  raw: number;
  uncached_input: number;
  cached_input: number;
  output: number;
  credits: number | null;
  usd: number | null;
};

export type Bucket =
  | "planning"
  | "code"
  | "reread"
  | "waiting.poll"
  | "waiting.coord"
  | "other";

export type DetectorLabel = "poll_spin" | "reread_repeat" | "compaction_loop";

export type ToolCall = {
  name: string;
  input: string;
  outputSha256: string;
  outputBytes: number;
  outputPreview: string;
};

export type Turn = {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  model: string | null;
  effort: string | null;
  prompt: string;
  tools: ToolCall[];
  usage: TokenUsage;
  cost: Cost;
  bucket: Bucket;
  labels: DetectorLabel[];
  hasPatchApply: boolean;
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

export const DEFAULT_WASTE_TOGGLES: Record<WasteToggleId, boolean> = {
  poll: true,
  reread: true,
  compaction_loop: true,
  idle_subagents: true,
  coord: false,
  healthy_subagents: false,
  planning: false,
  code: false,
};

export type TreeNode = {
  id: string;
  kind: "root" | "bucket" | "waiting" | "subagents" | "child";
  label: string;
  bucket?: Bucket;
  sessionId?: string;
  cost: Cost;
  percentOfParent: number;
  children: TreeNode[];
  turnIds: string[];
};

export type Suggestion = {
  id: string;
  kind: DetectorLabel | "compaction_loop_heavy";
  title: string;
  body: string;
  turnIds: string[];
};

export type ParseError = { offset: number; message: string };

export type RateCard = {
  as_of: string;
  source: string;
  usd_per_credit: number;
  usd_per_credit_source: string;
  fast_multiplier: number;
  models: Record<string, { input: number; cached: number; output: number }>;
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
  parse_errors: ParseError[];
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
  ledger_warning: boolean;
};

export type SessionMeta = {
  id: string;
  parentId: string | null;
  nickname: string | null;
  cwd: string | null;
  startedAt: string | null;
};

export type RolloutLine = {
  timestamp: string;
  type: string;
  ordinal?: number;
  payload?: Record<string, unknown>;
};

export function emptyCost(): Cost {
  return {
    raw: 0,
    uncached_input: 0,
    cached_input: 0,
    output: 0,
    credits: 0,
    usd: 0,
  };
}

export function addCost(a: Cost, b: Cost): Cost {
  const credits =
    a.credits == null || b.credits == null ? (a.credits == null && b.credits == null ? null : (a.credits ?? 0) + (b.credits ?? 0)) : a.credits + b.credits;
  const usd =
    a.usd == null || b.usd == null ? (a.usd == null && b.usd == null ? null : (a.usd ?? 0) + (b.usd ?? 0)) : a.usd + b.usd;
  return {
    raw: a.raw + b.raw,
    uncached_input: a.uncached_input + b.uncached_input,
    cached_input: a.cached_input + b.cached_input,
    output: a.output + b.output,
    credits,
    usd,
  };
}
