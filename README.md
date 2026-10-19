# Token Analyser

Local dashboard for Codex, Claude Code, Cursor, and pi sessions. The Node engine reads local JSONL and Cursor's SQLite store; the Vite UI talks to it over HTTP and SSE. Session data stays on the machine. Figures come from recorded usage or dated public API rates; they are not subscription bills.

## Run

```bash
pnpm install
pnpm dev
```

Requires Node.js 22.13 or newer (Cursor SQLite uses `node:sqlite`).

`pnpm dev` waits until the engine is listening on `127.0.0.1:7789`, then starts the UI at [http://127.0.0.1:7788](http://127.0.0.1:7788).

Single-process production-style serve (engine hosts `apps/web/dist`):

```bash
pnpm start
```

Print a snapshot for one rollout file:

```bash
pnpm analyse path/to/rollout.jsonl
```

Default sources are discovered recursively:

| Source | Local records | Analysis |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` (`CODEX_HOME` supported) | Tokens, credits, USD, tools; agent-task TTFT and tok/s when logged |
| Claude Code | `~/.claude/projects/**/*.jsonl` (`CLAUDE_CONFIG_DIR` supported) | Input, cache read/write, output, API-equivalent USD, tools, subagents |
| Cursor | `~/.cursor/projects/**/agent-transcripts/**/*.jsonl` and Cursor User `globalStorage/state.vscdb` / `workspaceStorage/**/state.vscdb` | Conversation, tools, session metadata, Cursor's own context-token meter; request usage, TTFT and tok/s are not recorded |
| pi | `~/.pi/agent/sessions/**/*.jsonl` (`PI_CODING_AGENT_DIR` supported) | Input, cache read/write, output, recorded USD, tools, branch/fork context, per-request duration (tok/s) |

Cursor's User directory is `~/Library/Application Support/Cursor/User` on macOS,
`%APPDATA%/Cursor/User` on Windows, and `$XDG_CONFIG_HOME/Cursor/User` (or
`~/.config/Cursor/User`) on Linux. Its databases are opened read-only; active WAL
changes are watched. The database schema is internal to Cursor and may change.
Zero-valued Cursor token placeholders are treated as missing telemetry, not
measured zero. The UI shows `—` for missing usage and `≥` for partial totals.
TTFT and tok/s stay unavailable for logs that do not record the required timings.
The performance panel states which unit it measured: **整次 agent 任务** (Codex
`task_started` / `task_complete` windows) or **单次模型请求** (sources that only
record request timing, such as pi's `durationMs`). The two are never mixed, and
neither is derived from gaps between log timestamps. A source that records
neither request duration nor output tokens — including Cursor, whose local store
keeps both at zero — reports `—` with the reason stated.
The request detail table and its expanded rows show TTFT (seconds) and tok/s
for each LLM call. Request-level `time_to_first_token_ms` / `ttft_ms`,
`duration_ms`, and `output_tokens_per_second` fields are read from the call's
metadata (including `metrics`, `timing`, `request_performance`, and pi's
`durationMs`). Recorded
speed takes precedence; otherwise tok/s is output tokens divided by the
recorded request duration, including first-token wait. Task-level measurements
are kept in the summary and are not copied into individual request rows.

Cursor records how much context a conversation held
(`promptTokenBreakdown`, `contextTokensUsed`, `contextTokenLimit`,
`contextUsagePercent`). The session's **上下文与会话信息** section shows that
meter as a context size with its category breakdown. It is a context
measurement, not billable token usage, so it never enters the token ledger, cost
or cache-hit figures.

Use the visible **会话来源** buttons below the header to select all sources,
Codex, Claude Code, Cursor, or pi in both the overview and session detail views.
Their counts include all discovered root sessions across all time. The default
7-day range can hide older sessions; **查看全部时间** reveals that history.
The selected source is restored on reload and browser back navigation.
Search the session list by source name, model, directory, or session ID.
Claude streaming records sharing a message ID are combined using the latest
reported usage fields. Claude subagent paths identify their parent session.
pi forks exclude entry IDs copied from an available parent file; if that file is
missing, only the child log can be analysed and inherited spend cannot be
distinguished. Branch context follows entry `parentId` rather than file order.

Optional `~/.token-analyser/config.json` replaces the default discovery paths:

```json
{
  "watch_paths": ["/absolute/path/to/sessions"],
  "usd_per_credit": 0.05,
  "usd_per_cny": 0.15
}
```

Codex rate card: `config/rate-card.json`. API-equivalent rates:
`config/api-prices.json` (dated, sourced from official pricing pages). Recorded
USD takes precedence; a turn whose log records 0 spend counts as unbilled and is
estimated from the official rate. Credits apply only to Codex; Claude, Cursor, and
pi costs are never converted to Codex credits. The price update button refreshes the Codex
card and the Qwen rates in `config/api-prices.json`; a publisher that cannot be
reached leaves its own local rates untouched and the UI says which source
failed. The `qwen` block owns Qwen updates: each entry names the official model
ID, the pricing-page section and region tab to read, the CNY rates last
accepted, the `cache_hit_ratio` / `cache_write_ratio` read from the page's
cache note, and the `usd_per_cny` conversion (override it with `usd_per_cny` in
`config.json`). Model IDs listed under `qwen.models[*].aliases` price as their
canonical model for any provider, so a relay that reports its own name —
`swift-1.5-iq3_xxs` serving `qwen3.8-flash-next` — never falls back to `—`. Only the public pricing
document is fetched; session data never leaves the machine. The engine refreshes
Qwen rates on startup and hourly whenever the card's Qwen date is not today's
date, then re-prices local sessions; set `QWEN_PRICING_AUTO_UPDATE=0` to pin
them.
Parse cache: `~/.token-analyser/cache/`.
Imported `.jsonl` / `.ndjson` files are copied to
`~/.token-analyser/imports/` and restored on the next launch. Existing imports
are never overwritten by another file with the same name.
The CLI also accepts a Cursor `state.vscdb`; `--json` returns an array for a
database and one snapshot for JSONL. To import a database through the API, use
`POST /import` with JSON `{ "path": "/absolute/path/to/state.vscdb" }`; database
uploads are not supported because an active WAL belongs to the original store.

The dashboard shows pricing coverage and ledger/parse health beside the headline
figures. Daily trends use the browser's IANA timezone (with numeric-offset
fallback), and the shipped rate card is dated so historical estimates remain
auditable. Unknown models keep their token counts and display money as `—`
instead of silently borrowing another model's price; model IDs must match an
explicit entry in the dated rate card.

Fast mode is accounted per turn, so switching `/fast` on or off during a
conversation changes only the affected turns. Each Fast turn is marked in the
detail table, and model-specific multipliers come from the dated rate card.
Desktop `thread_settings_applied` tiers and per-turn `fast` / `priority` tiers
are recognized. Expanded turns show the effective input, cached-input, and
output prices per million tokens. Updating model prices also synchronizes the
official purchased-credit Fast multiplier (currently 2× Standard). Included
subscription allowance uses a different multiplier and is not estimated here.

The behavior breakdown uses mutually exclusive categories: planning and
thinking, source reading and search, tests/builds/checks, code changes and
execution, duplicate reads, tool/environment operations, user messaging,
polling and coordination waits, and a final “other / unknown” fallback. A
turn is only kept in the fallback when its tool shape does not match any of
the explicit rules, so the breakdown remains auditable instead of hiding all
read or verification work in one bucket.

## Test

```bash
pnpm test
```

Runs engine and web unit tests. Playwright (needs browsers):

```bash
E2E=1 pnpm test
```
