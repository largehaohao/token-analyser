# Agent Token / Credits Monitor — Design

Date: 2026-08-27
Status: approved for implementation planning
Product: local dashboard that shows where a Codex task spent tokens, credits, and dollars, and which of that spend is avoidable waste.

This is not a claim about OpenAI's billing ledger. Every credits/$ figure is a local estimate from rollout telemetry and a dated public rate card.

## Goal

A user who just burned a large Codex task (or is still burning one) can open a local page and see, in an `htop`-style tree, how spend splits across planning, code, reread, subagents, and waiting — then toggle which buckets count as waste and read "this task wasted X credits / $Y" plus concrete suggestions.

Grounding incident: [openai/codex#35259](https://github.com/openai/codex/issues/35259) (2026-07-24). In one corrected usage window, wait/status-only model turns were **19.8% of raw local tokens**. The bug is model-mediated polling, not the fact that Ultra/subagents exist.

## Decisions already made

| Decision | Choice |
|---|---|
| Surface | Local web dashboard at `http://127.0.0.1:7788` |
| Timing | Live-first: watch a session while Codex is still writing the JSONL. Post-hoc import is the same pipeline. |
| Waste | Derived sum of user-toggled buckets. Default = avoidable anomalies, not "all expensive work". |
| Agents | Codex rollout JSONL in MVP. Claude Code is out of MVP. |
| Units | Tokens, credits, and $ are first-class. One ledger, three views. A top-bar switcher changes every number on screen. |
| Stack | TypeScript: Node engine + Vite/React UI, SSE for live updates. |
| Privacy | Nothing leaves the machine. No account, no cloud, no DB. |

## Non-goals (MVP)

- Claude Code session import
- Changing Codex behavior (we observe, we do not patch the agent)
- Matching OpenAI's private ledger or subscription UI
- Auth, multi-user, remote hosting, persistence beyond a local parse cache
- Guessing Fast-mode multipliers when the session does not record Fast mode
- A polished product website or theme system

## Repository layout

```
apps/web/                 Vite + React dashboard
packages/engine/          ingest, ledger, classify, detect, price, HTTP/SSE
config/rate-card.json     dated public Codex credit rates + usd_per_credit
fixtures/redacted/        committed golden JSONL slices (no prompt bodies, hashed outputs)
docs/superpowers/specs/   this spec
```

Run with `pnpm dev` (engine + UI). Engine can also run headless:

```
pnpm analyse path/to/rollout.jsonl
```

That prints the `SessionSnapshot` JSON and an ASCII tree. It is a test/debug hook, not the product.

Default watch root: `~/.codex/sessions/**/rollout-*.jsonl`.
Optional extra roots: `~/.token-analyser/config.json` field `watch_paths`.
Parse cache: `~/.token-analyser/cache/` keyed by absolute path + inode + size + mtime. Corrupt cache is deleted and rebuilt. MVP still ships the cache; a cold start of a 59MB file must remain acceptable without it.

`archived_sessions` is not watched by default. Add it via `watch_paths` if wanted.

## Processes and APIs

Two local processes. The browser never reads JSONL.

**Engine**

- `GET /sessions` — list. Live sessions first, then by last event time.
- `GET /sessions/:id` — full `SessionSnapshot`.
- `PATCH /sessions/:id/waste-toggles` — body is the toggle map; response is the same snapshot with recomputed `waste`. Parser is not rerun.
- `GET /stream` — SSE events: `session_added`, `session_updated`, `session_error`.
- `POST /import` — `{ "path": "<absolute jsonl>" }` or multipart file saved under `~/.token-analyser/imports/` then analysed in place.

**UI** consumes those endpoints only.

Live detection: a session is LIVE if its JSONL has been appended to in the last 120 seconds.

## Data flow

```
fs.watch / tail new bytes
  → line-buffered JSONL parse (complete lines only)
  → ledger (genuine per-turn deltas)
  → classify (mutually exclusive buckets)
  → detect (labels on turns; does not change token counts)
  → price (rate card)
  → SessionSnapshot
  → SSE
```

Child rollouts are separate files. Join them with `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`. The engine builds the tree; the UI renders it.

## Snapshot contents (explainability)

Each turn in the snapshot keeps:

- timestamps, model, effort
- token fields and priced credits/$
- user prompt text for that turn (the `user_message` / user-role `response_item` that opened the turn)
- tool name + full tool input (e.g. `exec` command string)
- tool output: `sha256`, byte length, and a 200-character prefix

Full tool stdout is not copied into the cache. Prompt text and tool inputs stay local and are required so a waste row can answer "why".

## Ledger

A **turn** is one model invocation, closed by an `event_msg` whose payload type is `token_count`.

Use `payload.info.last_token_usage` as the turn delta. Use `total_token_usage` only as a running checksum.

Observed Codex shape (verified against local rollouts on 2026-08-27):

- `input_tokens` **includes** cached tokens.
- `uncached_input = input_tokens - cached_input_tokens`
- `reasoning_output_tokens` is a subset of `output_tokens`; do not add it again.
- **raw tokens** = `input_tokens + output_tokens` = uncached + cached + output.

This matches #35259's arithmetic: uncached + cached + output = raw.

### Include / exclude

1. Drop a `token_count` when `last_token_usage` and `total_token_usage` are both identical to the previous kept record (duplicate snapshot).
2. For a child session (`source.subagent` present), start accounting at that file's first live `event_msg.task_started`. Every `token_count` before that boundary is copied parent prefix and is discarded.
3. A parent's `last_token_usage` does not include child spend. Child spend lives on the child session and rolls up under the parent's `subagents` node. Parent `wait_agent` turns stay on the parent as `waiting.poll`.
4. Model and `reasoning_effort` (including `ultra`) come from the nearest preceding `turn_context`.
5. After each kept turn, `sum(kept last_*)` must equal `total_token_usage` on that same event (allow 1-token slack for rounding). On mismatch, set `ledger_warning` on the session and still display numbers; do not silently rewrite them.

Turns with no `token_count` produce no ledger row.

## Pricing

`config/rate-card.json` is versioned and dated. Credits for a turn:

```
credits =
  uncached_input / 1e6 * input_rate
  + cached_input / 1e6 * cached_rate
  + output       / 1e6 * output_rate
```

Rates are per 1M tokens, keyed by the model id from `turn_context` (e.g. `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`). Initial card copies the public Codex rate card as of 2026-08-27:

| Model | Input | Cached input | Output |
|---|---:|---:|---:|
| gpt-5.6-sol | 125 | 12.5 | 750 |
| gpt-5.6-terra | 50 | 5 | 300 |
| gpt-5.6-luna | 5 | 0.5 | 30 |

(Source: [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card). If a model is missing, the turn is `unpriced`: tokens still show, credits and $ show as `—`.)

`$ = credits * usd_per_credit`. `usd_per_credit` lives in the same JSON with `source` and `as_of`. Ship `0.04` labeled as the ChatGPT credit purchase unit price used in public invoice reconstructions (Aug 2026). Users override in `~/.token-analyser/config.json`.

Fast mode: if the session records Fast mode, multiply credits by the official Fast multiplier (2.5). If it does not record it, multiplier is 1. Never infer Fast from burn rate.

`token_count.payload.rate_limits` is displayed as a side-by-side comparison on the session page. It never overwrites the per-turn ledger.

UI copy on every credits/$ headline: "Local estimate from telemetry and the public rate card dated YYYY-MM-DD. Not OpenAI's bill."

## Classification tree

The tree is a **partition of raw tokens**. Siblings of one node sum to 100% of that node's raw. `waste` is not a sibling. Waste is the sum of buckets whose toggles are on.

Root shape:

```
task
 ├─ planning
 ├─ code
 ├─ reread
 ├─ subagents        (children's own ledgers only)
 │    └─ <nickname>  (same buckets recursively)
 ├─ waiting
 │    ├─ poll
 │    └─ coord
 └─ other
```

Percentages at the root are of the root's raw (parent turns + all descendants). Expanding a child shows percentages of that child's raw.

### Turn rules (first match wins)

Inspect the tools invoked on that turn (`custom_tool_call.name` and `function_call.name`).

1. Tools ⊆ `{wait_agent, list_agents, write_stdin, wait}` → `waiting.poll`
2. Tools ⊆ `{spawn_agent, send_message}` or only those plus poll tools → `waiting.coord`
3. Otherwise, if this row belongs to a child session, the tokens still classify with these same rules **inside the child**. The parent tree places the child's entire raw under `subagents / <nickname>`. The parent does not re-classify child turns as parent `code`/`reread`.
4. Read-only turn whose every extracted path was already read in this session **and** whose tool-output sha256 matches the previous output for that path → `reread`
5. Turn contains a write / patch / test execution → `code`
6. No tools, or `turn_context.collaboration_mode.mode === "plan"`, or only assistant text → `planning`
7. Else → `other`

`spawn_agent` / `send_message` are **not** `subagents`. `subagents` is only child-session spend.

### Read / write extraction from `exec`

Codex's main tool is `exec`. Parse the command string:

**Read** (path extraction): `cat`, `head`, `tail`, `bat`, `less`, `more`, `sed -n`, `rg`, `grep`, `ag`, `ack`, `wc`. Take file operands; ignore flags. `rg pattern path` counts `path`.

**Write / patch / test** (marks `code`): presence of `event_msg.patch_apply_end` on the turn, or `exec` matching `git apply`, `patch`, `tee `, `>`, `sed -i`, `python`/`pytest`/`vitest`/`jest`/`cargo test`/`go test`/`pnpm test`/`npm test`.

A turn that both writes and reads classifies as `code` (rule 5 after reread's stricter "read-only + same hash").

Same path, **different** hash: not `reread`. It falls through to `code` or `other`. That is a legitimate re-read of a changed file.

### Empty child (for the idle-subagent toggle)

A child is idle when `code.raw == 0` and `(poll.raw + reread.raw) / child.raw >= 0.8`.

## Waste toggles

| Toggle | Default | Adds to waste |
|---|---|---|
| Waiting poll | on | `waiting.poll` |
| Duplicate reads | on | `reread` (hash-equal only, by construction) |
| Compaction loop | on | turns labeled `compaction_loop` |
| Idle subagents | on | idle children's full raw |
| Coordination (spawn/send) | off | `waiting.coord` |
| Healthy subagent work | off | non-idle children's raw |
| Planning | off | `planning` |
| Code | off | `code` |

Changing toggles recomputes `waste.raw`, `waste.credits`, `waste.usd` from already-classified turns. Parser, ledger, and detectors do not rerun.

Waste is a **set of turns**, not a sum of bucket totals. A turn is in waste if any enabled toggle matches it, and it is counted once. That covers `compaction_loop` ⊆ `reread` and idle-child turns that are also `waiting.poll`.

## Detectors

Detectors only attach labels and suggestion records.

### A. Wait / poll idle

Label `poll` already comes from classification. Additional `poll_spin` when:

- ≥3 consecutive `waiting.poll` turns, and
- median interval between them is in `[20s, 70s]` (covers the 30s/60s cadence in #35259)

Suggestion example: "Parent woke the model every ~30s only to call `wait_agent`. Poll is X% of raw, ~Y credits."

### B. Duplicate reads

Classification already requires same path + same output sha256. Detector adds `reread_repeat` with the count and the first-read turn id, so the UI can say "this file was read N times with identical output".

### C. Compaction loop

Codex emits `type: "compacted"` (payload includes `window_id`, `previous_window_id`, `replacement_history`) and `event_msg.context_compacted`.

After a `compacted` event and before the next one: a `reread` of a path that had been read **before** that compact is labeled `compaction_loop`.

Escalate to suggestion `compaction_loop_heavy` when there are ≥2 compact events and, between the first and last, `code.raw / raw < 0.15` while `reread.raw / raw >= 0.3`.

Suggestion example: "Context compacted N times, then the same files were read back. ~Y credits. Finish the child task or shrink the working set before continuing."

## UI

Dark terminal-like page, monospace numbers, tree drawn with `├─` / `└─`.

**Left: session list**  
LIVE badge, cwd, model, effort, start time, raw, credits, $, waste share. Drag-and-drop JSONL calls `POST /import`. Unit switcher in the top bar (tokens / credits / $) applies globally.

**Main: selected session**

1. Headline: task raw + credits + $ and the waste figure in the active unit. Disclaimer line with rate-card date.
2. Tree with absolute value + percent. LIVE sessions update on each new kept `token_count`.
3. Waste toggle checklist (defaults above).
4. One to three suggestions, each linking to the evidential turns.
5. Turn table for the selected tree node: time, tools, prompt excerpt, uncached/cached/output, credits, $. New live turns insert at the top.

**Empty / error**

- No sessions: tell the user to run Codex locally; show the glob `~/.codex/sessions/**/rollout-*.jsonl`.
- Parse error: grey the row; detail is path, byte offset, message. Other sessions keep working.
- `ledger_warning`: yellow banner, numbers still shown.

No login, no cloud sync.

## Errors

- Incomplete last line while tailing: wait for the next write.
- File replaced (inode change): treat as a new file, parse from offset 0.
- One corrupt line: skip, record `parse_error`, continue.
- Missing model in rate card: `unpriced` turns, session still loads.

## Testing

Engine tests do not boot the UI. Fixtures in `fixtures/redacted/` are sliced from real local rollouts with prompt bodies removed and tool outputs replaced by their sha256 + length.

Required cases:

1. **Ledger**: duplicate `token_count` ignored; child prefix before `task_started` dropped; `sum(last)` matches `total` on a clean fixture; copied prefix would have inflated totals if not dropped.
2. **Waiting**: wait-only → `poll`; `spawn_agent` → `coord`; child work → `subagents`, not parent `code`.
3. **Reread**: same path + same hash → `reread` and waste; same path + different hash → not waste.
4. **Compact**: after `compacted`, re-read of a pre-compact path → `compaction_loop`.

Smoke: `pnpm analyse` on a large live file (e.g. the 59MB session under `~/.codex/sessions/2026/08/19/`) must exit 0 with `turns.length > 0`. That file is not committed.

UI test: Playwright hits a fixture engine and asserts the tree percentages sum to 100% and the waste figure changes when a toggle flips.

## Success criteria

A user can:

1. Open the dashboard while a Codex Ultra/multi-agent task is running and watch `waiting.poll` vs `subagents` move.
2. After the task, state in one number how much of that task was avoidable (default toggles) in tokens, credits, and $.
3. Click `waiting.poll` and see the `wait_agent` / `wait` calls with timestamps and tool inputs.
4. Reproduce #35259-style accounting on a fixture: wait-only share is computed from genuine deltas, not cumulative snapshots, and not from copied child prefixes.

If those four fail, the MVP is not done.
