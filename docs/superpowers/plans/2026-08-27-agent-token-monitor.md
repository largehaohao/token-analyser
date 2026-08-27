# Agent Token / Credits Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local Codex dashboard that tails `~/.codex/sessions/**/rollout-*.jsonl`, attributes genuine per-turn token deltas, partitions spend into an `htop` tree, and reports avoidable waste in tokens, credits, and dollars.

**Architecture:** A Node engine incrementally parses Codex JSONL, builds a `SessionSnapshot` (ledger → classify → detect → price → tree → waste), and serves it over HTTP/SSE on port 7789. A Vite/React UI on port 7788 proxies those APIs and never reads JSONL itself.

**Tech Stack:** pnpm workspaces, TypeScript 5.6, Node 22, vitest, Vite 6, React 19, Playwright. Engine uses `node:fs/promises`, `node:crypto`, and `tsx`. No database.

**Spec:** `docs/superpowers/specs/2026-08-27-agent-token-monitor-design.md`

## Global Constraints

- Dashboard URL in dev: `http://127.0.0.1:7788` (Vite). Engine API: `http://127.0.0.1:7789`. Production `pnpm start` serves UI+API on `7788`.
- Default watch glob: `~/.codex/sessions/**/rollout-*.jsonl`. Do not watch `archived_sessions` unless `watch_paths` adds it.
- LIVE: JSONL appended within the last 120 seconds.
- `input_tokens` includes cache. `uncached_input = input_tokens - cached_input_tokens`. `raw = input_tokens + output_tokens`. Do not add `reasoning_output_tokens` again.
- Waste is a set of turns (count each turn once). Default toggles: poll/reread/compaction_loop/idle_subagents on; coord/healthy_subagents/planning/code off.
- `spawn_agent` / `send_message` → `waiting.coord`, never `subagents`. `subagents` is only child-session spend.
- Credits/$ headline copy: `Local estimate from telemetry and the public rate card dated YYYY-MM-DD. Not OpenAI's bill.`
- Fast-mode multiplier is 2.5 only when the session explicitly records Fast mode; otherwise 1. Never infer Fast from burn rate.
- Nothing leaves the machine. Do not log prompt bodies to stdout in the CLI except the ASCII tree + numeric snapshot fields; `pnpm analyse --json` prints the snapshot (needed for tests) and is local-only.
- Engine tests never boot the UI. Do not commit raw `~/.codex` files; only redacted fixtures under `fixtures/redacted/`.

---

## File map

```
package.json                          pnpm workspace scripts
pnpm-workspace.yaml
pnpm-lock.yaml
tsconfig.base.json
config/rate-card.json                 dated public rates
fixtures/redacted/*.jsonl             golden slices

packages/engine/package.json
packages/engine/tsconfig.json
packages/engine/src/types.ts          all shared types (single source)
packages/engine/src/rate-card.ts      load + priceTurn
packages/engine/src/parse-jsonl.ts    line-buffered JSONL
packages/engine/src/hash.ts           sha256 of tool output
packages/engine/src/ledger.ts         token_count → LedgerTurn[]
packages/engine/src/exec-command.ts   read paths / write detection
packages/engine/src/classify.ts       bucket assignment
packages/engine/src/detect.ts         labels + suggestions
packages/engine/src/tree.ts           partition tree + child rollup
packages/engine/src/waste.ts          toggles → waste Cost
packages/engine/src/snapshot.ts       analyseSession(events, opts) → SessionSnapshot
packages/engine/src/ingest.ts         read file incrementally + parse_errors
packages/engine/src/watch.ts          scan + tail watch roots
packages/engine/src/cache.ts          ~/.token-analyser/cache
packages/engine/src/store.ts          in-memory session index + join children
packages/engine/src/server.ts         HTTP/SSE
packages/engine/src/analyse-cli.ts    `pnpm analyse`
packages/engine/src/config.ts         ~/.token-analyser/config.json
packages/engine/tests/*.test.ts

apps/web/package.json
apps/web/vite.config.ts               port 7788, proxy to 7789
apps/web/index.html
apps/web/src/main.tsx
apps/web/src/App.tsx
apps/web/src/api.ts
apps/web/src/format.ts
apps/web/src/SessionList.tsx
apps/web/src/SessionView.tsx
apps/web/src/CostTree.tsx
apps/web/src/WasteToggles.tsx
apps/web/src/TurnTable.tsx
apps/web/src/UnitSwitcher.tsx
apps/web/e2e/dashboard.spec.ts
```

---

### Task 1: Workspace, types, rate card

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `config/rate-card.json`
- Create: `packages/engine/package.json`
- Create: `packages/engine/tsconfig.json`
- Create: `packages/engine/src/types.ts`
- Create: `packages/engine/src/rate-card.ts`
- Create: `packages/engine/tests/rate-card.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `loadRateCard(path?: string): RateCard`
  - `priceUsage(usage: TokenUsage, model: string | null, card: RateCard, fastMode: boolean): Cost`
  - types in `packages/engine/src/types.ts` (copied below; later tasks must use these names exactly)

- [ ] **Step 1: Create workspace files**

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/engine
  - apps/web
```

Root `package.json`:

```json
{
  "name": "token-analyser",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "test": "pnpm --filter engine test",
    "analyse": "pnpm --filter engine analyse",
    "dev": "pnpm --filter engine start & pnpm --filter web dev",
    "start": "pnpm --filter engine start"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  }
}
```

`packages/engine/package.json`:

```json
{
  "name": "engine",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "analyse": "tsx src/analyse-cli.ts",
    "start": "tsx src/server.ts"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/engine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "noEmit": true },
  "include": ["src", "tests"]
}
```

`config/rate-card.json`:

```json
{
  "as_of": "2026-08-27",
  "source": "https://help.openai.com/en/articles/20001106-codex-rate-card",
  "usd_per_credit": 0.04,
  "usd_per_credit_source": "ChatGPT credit purchase unit price used in public invoice reconstructions (Aug 2026)",
  "fast_multiplier": 2.5,
  "models": {
    "gpt-5.6-sol": { "input": 125, "cached": 12.5, "output": 750 },
    "gpt-5.6-terra": { "input": 50, "cached": 5, "output": 300 },
    "gpt-5.6-luna": { "input": 5, "cached": 0.5, "output": 30 }
  }
}
```

Write `packages/engine/src/types.ts` with exactly:

```ts
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
```

If `addCost` mixing null/number is awkward, treat missing as 0 when the other side is a number, and null only when both are null. Tests in Task 5 lock pricing; Task 1 only needs types to compile.

- [ ] **Step 2: Write the failing test**

`packages/engine/tests/rate-card.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadRateCard, priceUsage } from "../src/rate-card.ts";

const cardPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/rate-card.json",
);

describe("rate card", () => {
  it("prices Sol uncached/cached/output per 1M", () => {
    const card = loadRateCard(cardPath);
    const cost = priceUsage(
      {
        input_tokens: 1_000_000,
        cached_input_tokens: 400_000,
        cache_write_input_tokens: 0,
        output_tokens: 1_000_000,
        reasoning_output_tokens: 10,
        total_tokens: 2_000_000,
      },
      "gpt-5.6-sol",
      card,
      false,
    );
    // uncached = 600_000 → 0.6 * 125 = 75
    // cached   = 400_000 → 0.4 * 12.5 = 5
    // output   = 1_000_000 → 750
    expect(cost.raw).toBe(2_000_000);
    expect(cost.uncached_input).toBe(600_000);
    expect(cost.credits).toBeCloseTo(830, 5);
    expect(cost.usd).toBeCloseTo(33.2, 5);
  });

  it("returns null credits for unknown models", () => {
    const card = loadRateCard(cardPath);
    const cost = priceUsage(
      {
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 10,
        reasoning_output_tokens: 0,
        total_tokens: 110,
      },
      "mystery-model",
      card,
      false,
    );
    expect(cost.raw).toBe(110);
    expect(cost.credits).toBeNull();
    expect(cost.usd).toBeNull();
  });

  it("applies fast multiplier only when fastMode is true", () => {
    const card = loadRateCard(cardPath);
    const usage = {
      input_tokens: 1_000_000,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1_000_000,
    };
    const slow = priceUsage(usage, "gpt-5.6-sol", card, false);
    const fast = priceUsage(usage, "gpt-5.6-sol", card, true);
    expect(slow.credits).toBeCloseTo(125, 5);
    expect(fast.credits).toBeCloseTo(312.5, 5);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/zhanghao/projects/token-analyser && pnpm --filter engine test`

Expected: FAIL because `rate-card.ts` does not exist or `loadRateCard` is not exported. If `engine` is not installed yet, run `pnpm install` in the repo root first, then rerun. The first failure must be missing module / missing export, not an assertion on wrong math.

- [ ] **Step 4: Write minimal implementation**

`packages/engine/src/rate-card.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Cost, RateCard, TokenUsage } from "./types.ts";

const defaultPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/rate-card.json",
);

export function loadRateCard(cardPath: string = defaultPath): RateCard {
  return JSON.parse(readFileSync(cardPath, "utf8")) as RateCard;
}

export function priceUsage(
  usage: TokenUsage,
  model: string | null,
  card: RateCard,
  fastMode: boolean,
): Cost {
  const uncached_input = usage.input_tokens - usage.cached_input_tokens;
  const cached_input = usage.cached_input_tokens;
  const output = usage.output_tokens;
  const raw = usage.input_tokens + usage.output_tokens;
  const rates = model ? card.models[model] : undefined;
  if (!rates) {
    return { raw, uncached_input, cached_input, output, credits: null, usd: null };
  }
  let credits =
    (uncached_input / 1e6) * rates.input +
    (cached_input / 1e6) * rates.cached +
    (output / 1e6) * rates.output;
  if (fastMode) credits *= card.fast_multiplier;
  const usd = credits * card.usd_per_credit;
  return { raw, uncached_input, cached_input, output, credits, usd };
}
```

- [ ] **Step 5: Run tests and make sure they pass**

Run: `pnpm --filter engine test`

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json config/rate-card.json packages/engine
git commit -m "$(cat <<'EOF'
Add engine workspace, shared types, and Codex rate-card pricing.

EOF
)"
```

---

### Task 2: Line-buffered JSONL parser

**Files:**
- Create: `packages/engine/src/parse-jsonl.ts`
- Create: `packages/engine/tests/parse-jsonl.test.ts`

**Interfaces:**
- Consumes: `RolloutLine`, `ParseError` from `types.ts`
- Produces: `parseJsonlChunk(chunk: string, byteOffsetStart: number): { events: RolloutLine[]; rest: string; errors: ParseError[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";

describe("parseJsonlChunk", () => {
  it("parses complete lines and keeps an incomplete tail", () => {
    const chunk = '{"timestamp":"t","type":"session_meta","payload":{"id":"a"}}\n{"timestamp":"t2","type":"turn_context"';
    const result = parseJsonlChunk(chunk, 0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("session_meta");
    expect(result.rest).toBe('{"timestamp":"t2","type":"turn_context"');
    expect(result.errors).toEqual([]);
  });

  it("skips a corrupt line and continues", () => {
    const chunk = "{not json}\n{\"timestamp\":\"t\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}\n";
    const result = parseJsonlChunk(chunk, 100);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("event_msg");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].offset).toBe(100);
    expect(result.errors[0].message.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter engine exec vitest run tests/parse-jsonl.test.ts`

Expected: FAIL with `Cannot find module '../src/parse-jsonl.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ParseError, RolloutLine } from "./types.ts";

export function parseJsonlChunk(
  chunk: string,
  byteOffsetStart: number,
): { events: RolloutLine[]; rest: string; errors: ParseError[] } {
  const events: RolloutLine[] = [];
  const errors: ParseError[] = [];
  let offset = byteOffsetStart;
  const parts = chunk.split("\n");
  const rest = parts.pop() ?? "";
  for (const line of parts) {
    if (line.trim() === "") {
      offset += line.length + 1;
      continue;
    }
    try {
      events.push(JSON.parse(line) as RolloutLine);
    } catch (err) {
      errors.push({
        offset,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return { events, rest, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter engine exec vitest run tests/parse-jsonl.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/parse-jsonl.ts packages/engine/tests/parse-jsonl.test.ts
git commit -m "$(cat <<'EOF'
Parse Codex JSONL incrementally and skip corrupt lines.

EOF
)"
```

---

### Task 3: Ledger (duplicates, last_token_usage, checksum)

**Files:**
- Create: `packages/engine/src/hash.ts`
- Create: `packages/engine/src/ledger.ts`
- Create: `packages/engine/tests/ledger.test.ts`
- Create: `fixtures/redacted/duplicate-token-count.jsonl`

**Interfaces:**
- Consumes: `RolloutLine`, `Turn` fields except `bucket`/`labels` (those stay default until classify/detect)
- Produces:
  - `sha256(text: string): string`
  - `preview(text: string, n?: number): string` (default 200)
  - `buildLedger(events: RolloutLine[], sessionId: string, opts: { isSubagent: boolean }): { turns: Turn[]; ledger_warning: boolean; fastMode: boolean; meta: SessionMeta }`
  - `SessionMeta = { id: string; parentId: string | null; nickname: string | null; cwd: string | null; startedAt: string | null }`

Define `SessionMeta` in `types.ts`.

Ledger rules:
- A turn closes on `event_msg` with `payload.type === "token_count"`.
- Skip when both `last_token_usage` and `total_token_usage` deep-equal the previous **kept** record.
- For `isSubagent: true`, ignore `token_count` events until the first `event_msg` with `payload.type === "task_started"`.
- Accumulate tools (`custom_tool_call` / `function_call`) and user prompts (`payload.role === "user"` or `event_msg` `user_message`) since the previous kept turn (or since `task_started` for children).
- `hasPatchApply` if an `event_msg.patch_apply_end` occurred in that window.
- Model/effort from the nearest preceding `turn_context` (`payload.model`, `payload.collaboration_mode.settings.reasoning_effort` or `payload.effort` if present).
- `fastMode` true only if `turn_context.payload.fast_mode === true` or `turn_context.payload.speed === "fast"` (string compare). Otherwise false.
- Turn `id` = `${sessionId}:${ordinal}` using the `token_count` line's `ordinal` if present, else a 1-based index of kept turns.
- `bucket` temporary value `"other"`; `labels` `[]`; `cost` filled by calling `priceUsage` here with `fastMode` so later tasks see priced turns. Import `loadRateCard`/`priceUsage`.
- After each kept turn, compare running sums of kept `last_token_usage.input_tokens` and `output_tokens` (and cached) to `total_token_usage`. Allow ±1 slack. On miss, `ledger_warning = true` and keep the numbers.

- [ ] **Step 1: Write fixtures and failing tests**

`fixtures/redacted/duplicate-token-count.jsonl` (two identical snapshots after a real first turn; second unique turn):

```jsonl
{"timestamp":"2026-08-27T00:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"s1","session_id":"s1","cwd":"/repo","source":"vscode"}}
{"timestamp":"2026-08-27T00:00:01.000Z","ordinal":1,"type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.6-sol","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-sol","reasoning_effort":"medium"}}}}
{"timestamp":"2026-08-27T00:00:02.000Z","ordinal":2,"type":"event_msg","payload":{"type":"task_started","turn_id":"t1","started_at":"2026-08-27T00:00:02.000Z"}}
{"timestamp":"2026-08-27T00:00:03.000Z","ordinal":3,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"timestamp":"2026-08-27T00:00:04.000Z","ordinal":4,"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"cat README.md","call_id":"c1"}}
{"timestamp":"2026-08-27T00:00:05.000Z","ordinal":5,"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"readme-v1"}}
{"timestamp":"2026-08-27T00:00:06.000Z","ordinal":6,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":1050},"total_token_usage":{"input_tokens":1000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":1050}}}}
{"timestamp":"2026-08-27T00:00:07.000Z","ordinal":7,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":1050},"total_token_usage":{"input_tokens":1000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":1050}}}}
{"timestamp":"2026-08-27T00:00:08.000Z","ordinal":8,"type":"response_item","payload":{"type":"custom_tool_call","name":"wait_agent","input":"{\"timeout_ms\":30000}","call_id":"c2"}}
{"timestamp":"2026-08-27T00:00:09.000Z","ordinal":9,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":0,"total_tokens":2020},"total_token_usage":{"input_tokens":3000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":70,"reasoning_output_tokens":10,"total_tokens":3070}}}}
```

`packages/engine/tests/ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";
import { buildLedger } from "../src/ledger.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

function eventsFrom(name: string) {
  const text = readFileSync(path.join(fixtures, name), "utf8");
  return parseJsonlChunk(text.endsWith("\n") ? text : text + "\n", 0).events;
}

describe("buildLedger", () => {
  it("keeps genuine last_token_usage deltas and drops duplicate snapshots", () => {
    const { turns, ledger_warning } = buildLedger(
      eventsFrom("duplicate-token-count.jsonl"),
      "s1",
      { isSubagent: false },
    );
    expect(turns).toHaveLength(2);
    expect(turns[0].usage.input_tokens).toBe(1000);
    expect(turns[0].cost.raw).toBe(1050);
    expect(turns[1].usage.cached_input_tokens).toBe(800);
    expect(turns[1].cost.uncached_input).toBe(1200);
    expect(turns[1].tools[0].name).toBe("wait_agent");
    expect(turns[0].prompt).toContain("hello");
    expect(ledger_warning).toBe(false);
    const rawSum = turns[0].cost.raw + turns[1].cost.raw;
    expect(rawSum).toBe(1050 + 2020);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter engine exec vitest run tests/ledger.test.ts`

Expected: FAIL, missing `../src/ledger.ts`.

- [ ] **Step 3: Write `hash.ts` and `ledger.ts`**

`hash.ts`:

```ts
import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function preview(text: string, n = 200): string {
  return text.length <= n ? text : text.slice(0, n);
}
```

Implement `buildLedger` so the test above passes. Pair `custom_tool_call` with the next `custom_tool_call_output` that shares `call_id` (same for `function_call` / `function_call_output`, where arguments/output are strings). Tool `input` is `payload.input` or `payload.arguments` coerced to string.

Deep-equal usage with `JSON.stringify` on the two usage objects.

Checksum: running sum of kept last.input_tokens vs total.input_tokens, last.output_tokens vs total.output_tokens, last.cached_input_tokens vs total.cached_input_tokens, each within 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter engine exec vitest run tests/ledger.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/hash.ts packages/engine/src/ledger.ts packages/engine/src/types.ts packages/engine/tests/ledger.test.ts fixtures/redacted/duplicate-token-count.jsonl
git commit -m "$(cat <<'EOF'
Attribute per-turn token deltas and ignore duplicate snapshots.

EOF
)"
```

---

### Task 4: Child prefix exclusion

**Files:**
- Create: `fixtures/redacted/child-prefix.jsonl`
- Modify: `packages/engine/tests/ledger.test.ts` (add cases)
- Modify: `packages/engine/src/ledger.ts` if Task 3 did not yet honor `isSubagent`

**Interfaces:**
- Consumes: `buildLedger(..., { isSubagent: true })`
- Produces: same `buildLedger`. `SessionMeta.parentId` / `nickname` parsed from `session_meta.payload.source.subagent.thread_spawn`.

- [ ] **Step 1: Write fixture and failing test**

`fixtures/redacted/child-prefix.jsonl`: copied parent `token_count` **before** `task_started`, then a live child turn after it.

```jsonl
{"timestamp":"2026-08-27T00:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"child-1","session_id":"child-1","cwd":"/repo","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-1","depth":1,"agent_path":"/root/research","agent_nickname":"Plato"}}}}}
{"timestamp":"2026-08-27T00:00:01.000Z","ordinal":1,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":999999,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0,"total_tokens":1000000},"total_token_usage":{"input_tokens":999999,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0,"total_tokens":1000000}}}}
{"timestamp":"2026-08-27T00:00:02.000Z","ordinal":2,"type":"event_msg","payload":{"type":"task_started","turn_id":"live","started_at":"2026-08-27T00:00:02.000Z"}}
{"timestamp":"2026-08-27T00:00:03.000Z","ordinal":3,"type":"turn_context","payload":{"turn_id":"live","model":"gpt-5.6-luna","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-luna","reasoning_effort":"high"}}}}
{"timestamp":"2026-08-27T00:00:04.000Z","ordinal":4,"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"cat src/a.ts","call_id":"c1"}}
{"timestamp":"2026-08-27T00:00:05.000Z","ordinal":5,"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"file-a"}}
{"timestamp":"2026-08-27T00:00:06.000Z","ordinal":6,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":500,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":0,"total_tokens":540},"total_token_usage":{"input_tokens":500,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":0,"total_tokens":540}}}}
```

Add to `ledger.test.ts`:

```ts
  it("drops copied prefix token_counts before child task_started", () => {
    const { turns, meta } = buildLedger(
      eventsFrom("child-prefix.jsonl"),
      "child-1",
      { isSubagent: true },
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].cost.raw).toBe(540);
    expect(turns[0].usage.input_tokens).toBe(500);
    expect(meta.parentId).toBe("parent-1");
    expect(meta.nickname).toBe("Plato");
  });

  it("would inflate totals if prefix were kept (guard)", () => {
    const { turns } = buildLedger(
      eventsFrom("child-prefix.jsonl"),
      "child-1",
      { isSubagent: false },
    );
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[0].cost.raw).toBe(1_000_000);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter engine exec vitest run tests/ledger.test.ts`

Expected: FAIL on the child-prefix assertion if prefix dropping is not implemented.

- [ ] **Step 3: Implement prefix drop + meta parse**

When `opts.isSubagent` is true, set `armed = false` until `payload.type === "task_started"`. While `!armed`, skip `token_count` (still parse session_meta). After arming, keep turns as in Task 3.

Parse `source`: if `source` is an object with `subagent.thread_spawn`, set `parentId` and `nickname`. If `source` is the string `"vscode"` or anything else, `parentId` is null.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter engine exec vitest run tests/ledger.test.ts`

Expected: PASS (duplicate + two child tests).

- [ ] **Step 5: Commit**

```bash
git add fixtures/redacted/child-prefix.jsonl packages/engine/src/ledger.ts packages/engine/src/types.ts packages/engine/tests/ledger.test.ts
git commit -m "$(cat <<'EOF'
Start child ledgers at task_started and drop copied prefixes.

EOF
)"
```

---

### Task 5: Classify buckets (poll, coord, reread-hash, code, planning)

**Files:**
- Create: `packages/engine/src/exec-command.ts`
- Create: `packages/engine/src/classify.ts`
- Create: `packages/engine/tests/exec-command.test.ts`
- Create: `packages/engine/tests/classify.test.ts`
- Create: `fixtures/redacted/wait-poll.jsonl`
- Create: `fixtures/redacted/spawn-coord.jsonl`
- Create: `fixtures/redacted/reread-same-hash.jsonl`
- Create: `fixtures/redacted/reread-different-hash.jsonl`

**Interfaces:**
- Consumes: `Turn` from `buildLedger` (bucket still `"other"`)
- Produces:
  - `extractReadPaths(command: string): string[]`
  - `isWriteOrTest(command: string): boolean`
  - `classifyTurns(turns: Turn[]): Turn[]` (mutates copies; first-match-wins per spec)
  - Read tools for path extraction: `cat|head|tail|bat|less|more|sed -n|rg|grep|ag|ack|wc`
  - Write/test: `git apply`, `\bpatch\b`, `tee `, `>`, `sed -i`, `pytest`, `vitest`, `jest`, `cargo test`, `go test`, `pnpm test`, `npm test`, or `hasPatchApply`

Classify first match:
1. tools ⊆ `{wait_agent, list_agents, write_stdin, wait}` → `waiting.poll`
2. tools nonempty and ⊆ `{spawn_agent, send_message, wait_agent, list_agents, write_stdin, wait}` AND intersects `{spawn_agent, send_message}` → `waiting.coord`
3. read-only (every tool is `exec` whose command is a read, no write/test, `!hasPatchApply`) AND every extracted path was already seen in this session with the **same** `outputSha256` → `reread`
4. `hasPatchApply` or any exec `isWriteOrTest` → `code`
5. no tools → `planning`
6. else → `other`

For reread hash: maintain `Map<path, sha256>` of the first output per path. A later read of that path is reread only if **all** paths in the turn are already in the map with equal hash. First read of a path is not reread (falls through to code/other). Same path different hash: update the map to the new hash, do not mark reread.

- [ ] **Step 1: Write failing exec-command tests**

```ts
import { describe, expect, it } from "vitest";
import { extractReadPaths, isWriteOrTest } from "../src/exec-command.ts";

describe("extractReadPaths", () => {
  it("takes file operands and ignores flags", () => {
    expect(extractReadPaths("cat README.md")).toEqual(["README.md"]);
    expect(extractReadPaths("rg -n TODO src/app.ts")).toEqual(["src/app.ts"]);
    expect(extractReadPaths("sed -n '1,10p' foo.rs")).toEqual(["foo.rs"]);
  });
});

describe("isWriteOrTest", () => {
  it("detects patches and tests", () => {
    expect(isWriteOrTest("git apply /tmp/x.patch")).toBe(true);
    expect(isWriteOrTest("pnpm test")).toBe(true);
    expect(isWriteOrTest("cat README.md")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail, then implement `exec-command.ts`**

Implementation sketch: split on whitespace; if argv[0] basename is a read command, collect argv tokens that do not start with `-` and are not the pattern for `rg`/`grep` (treat the last non-flag token as path when there are ≥2 non-flag tokens after the binary; for `cat` every non-flag token is a path). Keep this heuristic small and lock it with the tests above.

Run: `pnpm --filter engine exec vitest run tests/exec-command.test.ts`

Expected after implement: PASS.

- [ ] **Step 3: Write classify fixtures and failing tests**

`wait-poll.jsonl`: session_meta + turn_context + task_started + `custom_tool_call` name `wait_agent` + token_count (raw 100).

`spawn-coord.jsonl`: same but `spawn_agent`.

`reread-same-hash.jsonl`: two turns both `exec cat foo.ts` with output `"aaa"` each, first then second token_count.

`reread-different-hash.jsonl`: same path, outputs `"aaa"` then `"bbb"`.

`packages/engine/tests/classify.test.ts` loads fixtures via parse+buildLedger+classifyTurns:

```ts
it("wait_agent only → waiting.poll", () => {
  expect(classified("wait-poll.jsonl")[0].bucket).toBe("waiting.poll");
});
it("spawn_agent → waiting.coord", () => {
  expect(classified("spawn-coord.jsonl")[0].bucket).toBe("waiting.coord");
});
it("same path same hash second read → reread", () => {
  const turns = classified("reread-same-hash.jsonl");
  expect(turns[0].bucket).not.toBe("reread");
  expect(turns[1].bucket).toBe("reread");
});
it("same path different hash is not reread", () => {
  const turns = classified("reread-different-hash.jsonl");
  expect(turns[1].bucket).not.toBe("reread");
});
```

Helper `classified(name)` must use `isSubagent: false`.

Fixture JSONL bodies: follow the same envelope as Task 3 (session_meta, turn_context, task_started, tool, output, token_count). Use distinct `call_id`s. For two-turn files, two token_count blocks with last_token_usage matching the spec's include-cache formula (e.g. first last `{input:100,cached:0,output:10}`, second `{input:120,cached:50,output:10}`).

- [ ] **Step 4: Implement `classifyTurns` and pass**

Run: `pnpm --filter engine exec vitest run tests/classify.test.ts tests/exec-command.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/exec-command.ts packages/engine/src/classify.ts packages/engine/tests/exec-command.test.ts packages/engine/tests/classify.test.ts fixtures/redacted/wait-poll.jsonl fixtures/redacted/spawn-coord.jsonl fixtures/redacted/reread-same-hash.jsonl fixtures/redacted/reread-different-hash.jsonl
git commit -m "$(cat <<'EOF'
Classify turns into poll, coord, reread-by-hash, and code.

EOF
)"
```

---

### Task 6: Tree, child rollup, waste set

**Files:**
- Create: `packages/engine/src/tree.ts`
- Create: `packages/engine/src/waste.ts`
- Create: `packages/engine/tests/tree.test.ts`
- Create: `packages/engine/tests/waste.test.ts`

**Interfaces:**
- Consumes: classified `Turn[]`; child `SessionSnapshot[]` (for tests, build child snapshots with `turns`/`cost`/`tree` stubs)
- Produces:
  - `sumTurns(turns: Turn[]): Cost`
  - `buildTree(args: { sessionId: string; label: string; turns: Turn[]; children: SessionSnapshot[] }): TreeNode`
  - `isIdleChild(child: SessionSnapshot): boolean` — `code.raw == 0` and `(poll.raw + reread.raw) / child.cost.raw >= 0.8` (if child.cost.raw === 0, not idle)
  - `computeWaste(args: { turns: Turn[]; children: SessionSnapshot[]; toggles: Record<WasteToggleId, boolean> }): { waste: Cost; turnIds: Set<string> }`

`buildTree` root `kind: "root"`, children in order: `planning`, `code`, `reread`, `subagents` (kind `subagents`, each grandchild kind `child` with that child's `buildTree` result as nested children), `waiting` (kind `waiting` with `waiting.poll` and `waiting.coord` bucket nodes), `other`.

Bucket node `turnIds` are this session's turns in that bucket only (not descendants). `subagents` node `cost` is `addCost` of children snapshots' `cost`. Root `cost` is `addCost(sumTurns(own turns), subagents.cost)`.

`percentOfParent`: 0 if parent raw is 0, else `100 * node.cost.raw / parent.cost.raw`. Siblings' percents need not be rounded to integers; tests use `toBeCloseTo` and assert sum of root child percents is ~100.

Waste set:
- `poll` toggle: own turns with `bucket === "waiting.poll"`
- `reread`: own `bucket === "reread"`
- `compaction_loop`: own turns with label `compaction_loop`
- `coord`: own `waiting.coord`
- `planning` / `code`: own those buckets
- `idle_subagents`: **all turns** of idle children (recursive flatten `child.turns` plus idle descendants)
- `healthy_subagents`: all turns of non-idle children
A turn id is added if any matching toggle is on. Sum those turns' `cost` via `addCost`. Child turns included via idle/healthy are not also added from the parent's own `turns` array (parent does not contain them).

- [ ] **Step 1: Write failing tree test**

Build two parent turns (poll raw 100, code raw 300) and one child snapshot with a single code turn raw 200, nickname Plato, `cost` matching that turn. Assert:

```ts
expect(root.cost.raw).toBe(600);
const names = root.children.map((c) => c.label);
expect(names).toEqual(["planning","code","reread","subagents","waiting","other"]);
const code = root.children.find((c) => c.label === "code")!;
expect(code.cost.raw).toBe(300);
expect(code.percentOfParent).toBeCloseTo(50, 5);
const subs = root.children.find((c) => c.label === "subagents")!;
expect(subs.cost.raw).toBe(200);
expect(subs.children[0].label).toBe("Plato");
const waiting = root.children.find((c) => c.label === "waiting")!;
expect(waiting.children.find((c) => c.bucket === "waiting.poll")!.cost.raw).toBe(100);
```

Helper: construct `Turn` objects inline (do not require JSONL).

- [ ] **Step 2: Implement `tree.ts`, pass tree tests**

- [ ] **Step 3: Write failing waste tests**

```ts
it("default toggles count poll and hash-reread once even if also compaction_loop", () => {
  const poll = turn({ id: "1", bucket: "waiting.poll", raw: 100 });
  const reread = turn({ id: "2", bucket: "reread", raw: 50, labels: ["compaction_loop"] });
  const { waste, turnIds } = computeWaste({
    turns: [poll, reread],
    children: [],
    toggles: DEFAULT_WASTE_TOGGLES,
  });
  expect(turnIds).toEqual(new Set(["1", "2"]));
  expect(waste.raw).toBe(150);
});

it("idle child full raw counts once with poll toggle also on", () => {
  const childTurn = turn({ id: "c1", bucket: "waiting.poll", raw: 80, sessionId: "child" });
  const child = snapshotWithTurns("child", "Plato", [childTurn]); // cost.raw 80, no code
  const { waste, turnIds } = computeWaste({
    turns: [],
    children: [child],
    toggles: DEFAULT_WASTE_TOGGLES,
  });
  expect(turnIds).toEqual(new Set(["c1"]));
  expect(waste.raw).toBe(80);
});

it("different hash reread bucket is not waste by default", () => {
  const t = turn({ id: "3", bucket: "other", raw: 40 });
  const { waste } = computeWaste({
    turns: [t],
    children: [],
    toggles: DEFAULT_WASTE_TOGGLES,
  });
  expect(waste.raw).toBe(0);
});
```

`turn()` helper fills `cost.raw` and other Cost fields; `credits`/`usd` can be 0.

- [ ] **Step 4: Implement `waste.ts` and pass**

Run: `pnpm --filter engine exec vitest run tests/tree.test.ts tests/waste.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/tree.ts packages/engine/src/waste.ts packages/engine/tests/tree.test.ts packages/engine/tests/waste.test.ts
git commit -m "$(cat <<'EOF'
Build the cost tree and count waste as a unique turn set.

EOF
)"
```

---

### Task 7: Detectors

**Files:**
- Create: `packages/engine/src/detect.ts`
- Create: `packages/engine/tests/detect.test.ts`
- Create: `fixtures/redacted/compacted-reread.jsonl`

**Interfaces:**
- Consumes: classified `Turn[]` plus original `RolloutLine[]` (compact events)
- Produces: `detect(turns: Turn[], events: RolloutLine[]): { turns: Turn[]; suggestions: Suggestion[] }`

Rules:
- `poll_spin`: ≥3 consecutive `waiting.poll` turns whose median `endedAt` interval (ms) is in `[20000, 70000]`. Label each of those consecutive turns `poll_spin`. Suggestion id `poll-spin-1`, title includes `wait_agent` if any such tool exists, body includes percent of session raw and credits (use `sumTurns` on labeled turns vs all turns).
- `reread_repeat`: for each path that has ≥2 hash-equal reads, label the 2nd+ turns `reread_repeat`. Suggestion may be omitted if compaction_loop suggestion already covers them; still set the label.
- `compaction_loop`: find `events` with `type === "compacted"` timestamps. Paths read (exec read tools) **before** compact T, then a `reread` turn **after** T and before the next compact, get label `compaction_loop`.
- `compaction_loop_heavy` suggestion when `compacted` count ≥ 2 and, considering turns whose `endedAt` is between first and last compact: `code.raw/raw < 0.15` and `reread.raw/raw >= 0.3`.

- [ ] **Step 1: Write failing tests**

Three tests in `detect.test.ts`:
1. Three poll turns at t=0, 30s, 60s → all labeled `poll_spin`; one suggestion.
2. Two poll turns 30s apart → no `poll_spin`.
3. Fixture `compacted-reread.jsonl`: read `foo.ts` output `x`, then `{"type":"compacted","payload":{"window_id":"w1"}}`, then read `foo.ts` output `x` again → second turn labeled `compaction_loop`.

Timestamps on turns must be ISO strings 30s apart; `detect` uses `Date.parse`.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter engine exec vitest run tests/detect.test.ts`

Expected: FAIL missing module.

- [ ] **Step 3: Implement `detect.ts`**

- [ ] **Step 4: Pass tests**

Run: `pnpm --filter engine exec vitest run tests/detect.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/detect.ts packages/engine/tests/detect.test.ts fixtures/redacted/compacted-reread.jsonl
git commit -m "$(cat <<'EOF'
Detect poll spins, identical rereads, and compaction loops.

EOF
)"
```

---

### Task 8: `analyseSession` + CLI

**Files:**
- Create: `packages/engine/src/snapshot.ts`
- Create: `packages/engine/src/analyse-cli.ts`
- Create: `packages/engine/tests/snapshot.test.ts`

**Interfaces:**
- Consumes: parse, ledger, classify, detect, tree, waste
- Produces:
  - `analyseSession(args: { events: RolloutLine[]; path: string; sessionId?: string; children?: SessionSnapshot[]; toggles?: Record<WasteToggleId, boolean>; live?: boolean; parse_errors?: ParseError[] }): SessionSnapshot`
  - CLI: `tsx src/analyse-cli.ts <file.jsonl> [--json]`

Pipeline inside `analyseSession`:
1. Read `session_meta` to know `isSubagent` and id (`payload.id` or `payload.session_id`).
2. `buildLedger(events, id, { isSubagent })`.
3. `classifyTurns`.
4. `detect`.
5. `buildTree` with `args.children ?? []`.
6. `computeWaste` with `args.toggles ?? DEFAULT_WASTE_TOGGLES`.
7. Fill `rate_limits` from the last `token_count.payload.rate_limits` if any.
8. `model`/`effort` from last turn; `startedAt` from meta or first turn; `lastEventAt` from last event timestamp; `rateCardAsOf` from `loadRateCard().as_of`; `cost` = tree root cost.

CLI without `--json`: print ASCII tree using `├─` / `└─`, label, percent (1 decimal), raw, credits. Then a line `waste: ...`. With `--json`: `JSON.stringify(snapshot)`.

- [ ] **Step 1: Failing snapshot test**

```ts
it("wait-poll fixture is 100% waiting.poll and default waste equals that cost", () => {
  const snap = analyseSession({
    events: eventsFrom("wait-poll.jsonl"),
    path: "wait-poll.jsonl",
  });
  expect(snap.turns[0].bucket).toBe("waiting.poll");
  expect(snap.waste.raw).toBe(snap.cost.raw);
  expect(snap.tree.children.find((c) => c.label === "waiting")!.percentOfParent).toBeCloseTo(100, 5);
});
```

Also assert `analyseSession` on `child-prefix.jsonl` with no children has `cost.raw === 540` (prefix dropped). Pass `isSubagent` via session_meta.

- [ ] **Step 2: Implement snapshot.ts, pass test**

- [ ] **Step 3: Implement CLI; smoke locally (do not commit the 59MB file)**

Run: `pnpm analyse fixtures/redacted/wait-poll.jsonl`

Expected: ASCII tree showing waiting ~100%.

Optional: `pnpm analyse ~/.codex/sessions/2026/08/19/rollout-2026-08-19T18-52-32-01a019a6-bd5d-7333-90a4-5df21a44b8d1.jsonl` must exit 0 and print `turns` count > 0 if the file exists. Skip if missing.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/snapshot.ts packages/engine/src/analyse-cli.ts packages/engine/tests/snapshot.test.ts
git commit -m "$(cat <<'EOF'
Assemble session snapshots and add a headless analyse CLI.

EOF
)"
```

---

### Task 9: Ingest, watch, cache, session store

**Files:**
- Create: `packages/engine/src/config.ts`
- Create: `packages/engine/src/ingest.ts`
- Create: `packages/engine/src/cache.ts`
- Create: `packages/engine/src/watch.ts`
- Create: `packages/engine/src/store.ts`
- Create: `packages/engine/tests/ingest.test.ts`
- Create: `packages/engine/tests/store.test.ts`

**Interfaces:**
- Consumes: `analyseSession`, `parseJsonlChunk`
- Produces:
  - `loadUserConfig(): { watch_paths: string[]; usd_per_credit?: number }` — reads `~/.token-analyser/config.json` if present; default `watch_paths: [join(homedir(), ".codex/sessions")]`
  - `readJsonlFile(path: string): { events: RolloutLine[]; parse_errors: ParseError[] }` — streams the file, line-buffered
  - `ingestFile(path: string): SessionSnapshot` — `readJsonlFile` + `analyseSession` (children empty; store joins later)
  - Cache key: `sha256(path + inode + size + mtimeMs)`. Store snapshot JSON under `~/.token-analyser/cache/<key>.json`. If read JSON.parse throws, delete file and recompute. Cache is skipped when `mtime` is newer than cache (LIVE files).
  - `SessionStore`: `refresh(paths: string[]): void` ingests each rollout-*.jsonl; maps id → snapshot; attaches children by `parentId`; `list(): SessionListItem[]` roots only, LIVE first then `lastEventAt` desc; `get(id): SessionSnapshot | undefined` with `children` populated; `setToggles(id, toggles)` recomputes waste+tree percents via `computeWaste`/`buildTree` without re-parsing.
  - `live` true if `stat.mtimeMs > Date.now() - 120_000`.
  - `watchSessions(store, onChange)`: `fs.watch` on each watch root, recursive if available; on `rename`/`change` for `rollout-*.jsonl`, `ingestFile` and `onChange(id)`.

- [ ] **Step 1: Failing ingest test**

Write a temp file with `wait-poll.jsonl` contents plus a trailing incomplete line `{"timestamp":`. `readJsonlFile` must still return the complete events and no throw.

Second test: corrupt middle line still returns later events + `parse_errors`.

- [ ] **Step 2: Implement ingest, pass**

- [ ] **Step 3: Failing store test**

Two temp JSONL files: parent id `parent-1` with a `wait_agent` turn; child `child-prefix.jsonl` renamed ids already parent-1. `store.refresh([parentPath, childPath])`; `store.list()` has one root; `store.get("parent-1").children[0].nickname === "Plato"`; `store.get("parent-1").tree` subagents raw equals child cost; `setToggles(parent-1, { ...DEFAULT, poll: false, idle_subagents: false })` drops waste to 0 if only poll/idle were contributing.

- [ ] **Step 4: Implement store + cache + watch (watch can be a thin fs.watch wrapper tested with a temp dir write)**

Watch test: create temp dir, start `watchSessions`, append a complete JSONL line+newline for a new rollout file, wait until store.list().length === 1 (timeout 2s).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/config.ts packages/engine/src/ingest.ts packages/engine/src/cache.ts packages/engine/src/watch.ts packages/engine/src/store.ts packages/engine/tests/ingest.test.ts packages/engine/tests/store.test.ts
git commit -m "$(cat <<'EOF'
Watch Codex rollouts, cache snapshots, and join subagent trees.

EOF
)"
```

---

### Task 10: HTTP + SSE + import

**Files:**
- Create: `packages/engine/src/server.ts`
- Create: `packages/engine/tests/server.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `watchSessions`, `loadUserConfig`, `ingestFile`
- Produces: `startServer(opts?: { port?: number; store?: SessionStore; staticDir?: string }): Promise<{ url: string; close: () => Promise<void> }>`

Routes (Node `http.createServer`, no Express):
- `GET /sessions` → `{ sessions: SessionListItem[] }`
- `GET /sessions/:id` → snapshot JSON or 404 `{ error: "not_found" }`
- `PATCH /sessions/:id/waste-toggles` body `Record<WasteToggleId, boolean>` (may be partial; merge onto existing) → snapshot
- `GET /stream` SSE: `Content-Type: text/event-stream`. Events `session_added` | `session_updated` | `session_error` with `data: { id, reason? }`. Heartbeat comment every 15s.
- `POST /import` JSON `{ path: string }` (absolute, must end with `.jsonl`) → ingest, add to store, 200 snapshot. Reject non-absolute or non-`.jsonl` with 400. Multipart: if `Content-Type` starts with `multipart/form-data`, write file to `~/.token-analyser/imports/<basename>` then ingest that path. Keep multipart parsing small (boundary split) or accept JSON-path only in MVP if multipart tests are painful — if skipping multipart, document that the UI import uses `{ path }` after writing via the engine. Prefer JSON `{ path }` plus a `POST /import` that accepts raw body when `Content-Type: application/x-ndjson` saved to imports. UI Task 11 will send `{ path }` after `showOpenFilePicker` is unavailable; drag-drop in the browser cannot read arbitrary disk paths. **Resolution:** drag-drop sends the file bytes to `POST /import` with `Content-Type: application/x-ndjson` and header `X-Filename`. Engine writes `~/.token-analyser/imports/<filename>` and ingests.

CORS: `Access-Control-Allow-Origin: http://127.0.0.1:7788` and `Access-Control-Allow-Methods: GET,PATCH,POST,OPTIONS`.

Default listen `127.0.0.1:7789`. If `process.env.PORT`, use that. If `staticDir` is set (production), serve files from it for non-API paths, fallback `index.html`.

`server.ts` when run as main: load config, create store, refresh watch paths (glob `**/rollout-*.jsonl` via `fs.readdir` recursive), watch, startServer.

- [ ] **Step 1: Failing server tests using `startServer({ port: 0, store })`**

Seed store from wait-poll fixture. `fetch(url + "/sessions")` returns one item. `GET /sessions/s1` has `waste.raw === cost.raw`. `PATCH` `{ poll: false }` → waste.raw === 0. `POST /import` with ndjson body of spawn-coord fixture → new id in list. SSE: add a listener, `store` ingest another file through a test helper `store.upsert(snap)` that emits if you wired `onChange`; assert one `session_updated` or `session_added` within 1s.

- [ ] **Step 2: Implement server.ts, pass tests**

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/server.ts packages/engine/tests/server.test.ts
git commit -m "$(cat <<'EOF'
Serve snapshots over HTTP and SSE for the local dashboard.

EOF
)"
```

---

### Task 11: Vite UI — list, tree, toggles, turns, units

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/format.ts`
- Create: `apps/web/src/SessionList.tsx`
- Create: `apps/web/src/SessionView.tsx`
- Create: `apps/web/src/CostTree.tsx`
- Create: `apps/web/src/WasteToggles.tsx`
- Create: `apps/web/src/TurnTable.tsx`
- Create: `apps/web/src/UnitSwitcher.tsx`
- Create: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: engine HTTP types (`SessionListItem`, `SessionSnapshot`, `TreeNode`, `Turn`, `WasteToggleId`)
- Produces: dashboard at `http://127.0.0.1:7788`

`apps/web/package.json`:

```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 7788,
    proxy: {
      "/sessions": "http://127.0.0.1:7789",
      "/stream": { target: "http://127.0.0.1:7789", ws: false },
      "/import": "http://127.0.0.1:7789",
    },
  },
  build: { outDir: "dist" },
});
```

`api.ts` functions:
- `listSessions(): Promise<SessionListItem[]>` GET `/sessions`
- `getSession(id: string): Promise<SessionSnapshot>` GET `/sessions/${id}`
- `patchToggles(id: string, toggles: Partial<Record<WasteToggleId, boolean>>): Promise<SessionSnapshot>`
- `importNdjson(filename: string, text: string): Promise<SessionSnapshot>` POST `/import` with `X-Filename`
- `openStream(onEvent: (e: { type: string; id: string }) => void): () => void` EventSource `/stream`

`format.ts`: `formatCost(cost, unit: "tokens" | "credits" | "usd")` — tokens use `raw` with grouping; credits 1 decimal; usd `$` 2 decimals; `null` → `—`.

UI behavior:
- Dark background `#0b0d10`, text `#d7dbE0`, accent `#7dffb3`, warning `#f5c542`, error `#ff6b6b`, font `ui-monospace, SFMono-Regular, Menlo, monospace`.
- Left list: LIVE badge if `live`; grey row if `parse_error`; show cwd, model, effort, start, cost in active unit, waste share `waste.raw/cost.raw`.
- Empty list copy: `No Codex sessions found. Run Codex locally, then sessions appear from ~/.codex/sessions/**/rollout-*.jsonl`
- Main: headline total + waste in active unit; disclaimer with `rateCardAsOf`; yellow banner if `ledger_warning`.
- `CostTree`: render `├─` / `└─` from `tree.children`; click sets `selectedNodeId`; show label, percent 1 decimal, formatted cost.
- `WasteToggles`: eight checkboxes bound to snapshot.toggles; onChange PATCH.
- Suggestions: up to 3; click selects first `turnIds` node.
- `TurnTable`: turns whose ids are in the selected node's `turnIds` (if selected is `waiting`, union children turnIds; if `subagents`/`child`, that subtree). Columns: time, tools (name + input), prompt excerpt 80 chars, uncached, cached, output, credits, $. Newest first.
- Drag-and-drop on the list: read file as text, `importNdjson`.
- Unit switcher in a top bar, React context so list + main both update.

Wire `App.tsx` to load list on mount, EventSource refresh getSession/list.

Production: `server.ts` main checks `existsSync("../../apps/web/dist")` and passes `staticDir`, listens on `7788` when `process.env.SERVE_UI === "1"`. Root `package.json` `"start": "pnpm --filter web build && SERVE_UI=1 PORT=7788 pnpm --filter engine start"` and `"dev"` runs engine on 7789 plus vite 7788. Change Task 1 scripts if they still say otherwise — do it in this task.

- [ ] **Step 1: Scaffold web app so `pnpm --filter web dev` starts**

No unit test required for CSS. Manually: with engine running against fixtures via a tiny `packages/engine/src/dev-fixture.ts` that loads `fixtures/redacted/*.jsonl` into the store instead of `~/.codex` when `process.env.FIXTURE_DIR` is set. Add that env branch in `server.ts` main (5 lines). Verify list shows wait-poll.

- [ ] **Step 2: Implement components listed above**

- [ ] **Step 3: Commit**

```bash
git add apps/web package.json packages/engine/src/server.ts
git commit -m "$(cat <<'EOF'
Add the local dashboard for session trees, waste toggles, and live updates.

EOF
)"
```

---

### Task 12: Playwright — percentages sum to 100, toggle changes waste

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/dashboard.spec.ts`
- Modify: `apps/web/package.json` (scripts `test:e2e`)
- Modify: root `package.json` test script to include e2e when `E2E=1`

**Interfaces:**
- Consumes: running engine with `FIXTURE_DIR=fixtures/redacted` and Vite preview or `vite dev`
- Produces: Playwright spec

- [ ] **Step 1: Write the failing spec**

```ts
import { test, expect } from "@playwright/test";

test("tree percents sum to ~100 and waste moves when poll is unchecked", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("wait-poll").or(page.getByText("/repo"))).toBeVisible({ timeout: 10_000 });
  await page.getByText("/repo").first().click();
  await expect(page.getByText(/Not OpenAI's bill/)).toBeVisible();
  const percents = page.locator("[data-percent]");
  await expect(percents.first()).toBeVisible();
  const values = await percents.allTextContents();
  const sum = values.map((v) => parseFloat(v)).reduce((a, b) => a + b, 0);
  expect(sum).toBeGreaterThan(99);
  expect(sum).toBeLessThan(101);
  const waste = page.getByTestId("waste-headline");
  const before = await waste.textContent();
  await page.getByLabel("Waiting poll").uncheck();
  await expect(waste).not.toHaveText(before ?? "");
});
```

Add `data-percent` on each **root-level** tree row (the six buckets) with the numeric percent. Add `data-testid="waste-headline"` on the waste number. Checkbox labels must match the spec names: `Waiting poll`, `Duplicate reads`, `Compaction loop`, `Idle subagents`, `Coordination (spawn/send)`, `Healthy subagent work`, `Planning`, `Code`.

- [ ] **Step 2: Run e2e to verify it fails** (missing testids or app)

Start engine `FIXTURE_DIR=fixtures/redacted PORT=7789 pnpm --filter engine start` and `pnpm --filter web dev`, then `pnpm --filter web exec playwright test`.

Expected first run: FAIL until testids exist.

- [ ] **Step 3: Add testids / labels, rerun until PASS**

- [ ] **Step 4: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/e2e apps/web/src apps/web/package.json
git commit -m "$(cat <<'EOF'
Cover the dashboard tree and waste toggles with Playwright.

EOF
)"
```

---

## Self-review

**Spec coverage**
- Live watch + 120s LIVE flag → Task 9
- Post-hoc import → Task 10 (`POST /import`) + Task 11 drag-drop
- Per-turn ledger, duplicate snapshots, child prefix → Tasks 3–4
- raw/uncached/cached formula + rate card + unpriced + Fast only if recorded → Tasks 1, 3
- Classify poll/coord/reread-hash/code/planning/other → Task 5
- Tree + subagents rollup + waste set-once → Task 6
- Detectors poll_spin / reread_repeat / compaction_loop → Task 7
- Analyse CLI + snapshot → Task 8
- Cache, watch_paths, no archived default → Task 9
- HTTP/SSE, disclaimer, ledger_warning, parse errors → Tasks 10–11
- UI list/tree/toggles/suggestions/turn table/unit switcher → Task 11
- Playwright 100% + toggle → Task 12
- Claude Code / cloud / official bill matching → excluded (non-goals)

**Type names** used throughout: `Turn`, `Cost`, `Bucket`, `WasteToggleId`, `DEFAULT_WASTE_TOGGLES`, `TreeNode`, `SessionSnapshot`, `SessionListItem`, `RolloutLine`, `buildLedger`, `classifyTurns`, `detect`, `buildTree`, `computeWaste`, `analyseSession`, `SessionStore`.
