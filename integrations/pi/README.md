# pi request-timing extension

`request-timing.ts` records what pi's session log cannot: the instant the model
emits its first token.

pi logs three time facts per request — `message.timestamp` (request start), the
entry `timestamp` (request end), and `durationMs` (the whole window). Nothing
inside that window is timestamped, so time to first token is not recoverable
from existing sessions; the dashboard shows `日志未记录首 token 时间` for them.

## Install

```bash
cp request-timing.ts ~/.pi/agent/extensions/request-timing.ts
```

pi loads TypeScript extensions from that directory through `jiti`, so no build
step is needed. Reload pi (or start a new session) to pick it up.

## What it records

One `request_timing` custom entry per model request, appended after the
assistant entry it describes:

| Field | Meaning |
| --- | --- |
| `ttft_ms` | provider request sent → first output delta (text, thinking, or tool call) |
| `headersMs` | request sent → response headers (TTFB) |
| `firstRawStreamMs` | request sent → first raw stream chunk |
| `piDurationMs` | pi's own `durationMs`, kept under this name so the analyser still reads pi's value for the duration |
| `attempts`, `attemptLog` | provider retries in the turn, with each attempt's start time and status |
| `harnessGapMs` | turn start → request sent (harness work, not provider time) |
| `messageEntryId`, `responseId` | join keys onto the assistant entry |
| `outputTokens`, `reasoningTokens`, `inputTokens`, `cacheRead`, `stopReason`, `model`, `provider`, `api` | context for the sample |

Retries restart the clock, so the recorded sample describes the attempt that
produced the message, and `attempts` keeps the retries visible. Aborted turns
and compaction requests are dropped rather than attributed to a message.

The entry stores no prompt, response text, tool arguments, credentials, or file
paths.

## Engine side

`packages/engine/src/session-adapters.ts` collects the entries per pi file and
joins them onto the model call by `messageEntryId`, falling back to
`responseId`. The join is passed to `requestPerformance` after the assistant
message, so pi's `durationMs` stays the reported duration and the entry supplies
`ttft_ms`. When the assistant entry records no duration, the entry's own window
is used: `piDurationMs` first, then `startedAt` → `endedAt` (request sent →
message end). Both are measurements taken inside the request.

With TTFT and a duration, turn tok/s is a decode rate over
`duration − TTFT`, and the row labels its denominator `解码时长`; a request with
only a duration keeps the full-window rate and is labelled `请求总耗时`, so a
session recorded with the extension off is never read as the same measurement.
A `ttft_ms` at or past the end of the logged window is reported as TTFT, and
that request's tok/s stays `—` — the two recorded numbers leave no decode
window, and nothing is inferred to fill it.

## Controls

- `/request-timing` in pi toggles recording and shows the last sample.
- `PI_REQUEST_TIMING=0` disables it at startup.
