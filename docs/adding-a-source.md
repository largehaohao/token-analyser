# Adding a source adapter

A source is one local agent log the engine can discover, parse, and show next
to Codex. pi (`fixtures/native/pi.jsonl`) is the JSONL example. Cursor
(`packages/engine/src/cursor-store.ts`) is the SQLite example. Copy the closer
one; do not invent a second session model.

## 1. Name the source

Add the id to `SessionSource` in both places:

- `packages/engine/src/types.ts`
- `apps/web/src/api.ts`

Keep the id stable. It becomes the session id prefix (`pi:…`, `cursor:…`).

## 2. Discover files

Add the default root in `defaultSessionPaths()` (`packages/engine/src/session-files.ts`).
Honour an existing home variable when the tool has one (`PI_CODING_AGENT_DIR`,
`DSH_HOME`). If the extension is new, teach `isSessionFile` and add the same
extension to `hasImportExtension` in `packages/engine/src/import-path.ts`.
`POST /import` resolves symlinks and only then checks that allowlist, so a
renamed symlink cannot smuggle a different file into `node:sqlite`.

Users override roots in `~/.token-analyser/config.json` → `watch_paths`.

## 3. Detect and parse

JSONL / zstd JSONL:

- `detectSource()` in `packages/engine/src/session-adapters.ts` must recognise
  the file before the Codex fallback. Check a distinctive event type, then the
  path.
- Add a branch in `parseNativeSession()` (see `parseDshSession` for a source
  that does not share the generic header). Map each model call to a `Turn`
  with measured token counts. Leave TTFT and tok/s null when the log does not
  record them; do not derive them from gaps between timestamps.
- `analyseSession()` in `packages/engine/src/snapshot.ts` already sends every
  non-Codex source through `parseNativeSession`.

SQLite (many sessions per file):

- Read-only open, `PRAGMA query_only=ON`, and call `assertSupportedNode()`
  before `require("node:sqlite")`. Follow `readCursorSessions`.
- Return `RolloutLine[][]` from `readMultiSessionEvents()` in
  `packages/engine/src/ingest.ts`. One array entry is one session.
- Do not copy the database or its WAL.

## 4. Fixture and test

Put a small redacted log in `fixtures/native/<source>.jsonl` (or a tiny
SQLite file built in the test, as `packages/engine/tests/native-sessions.test.ts`
does). Assert source id, token totals, parent links, and that missing timing
stays `—` rather than zero.

## 5. Show it in the UI

- `SESSION_SOURCES` in `apps/web/src/session-source.ts`
- The `source` allowlist on `GET /overview` in `packages/engine/src/server.ts`
- The source table in `README.md`

Overview counts, the session list, and cost trees pick up the new id from the
snapshot. No separate ledger type is required.
