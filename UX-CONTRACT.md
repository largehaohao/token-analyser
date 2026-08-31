# UX contract

## Product context

Token Analyser is a local usage ledger for Codex users. It follows the existing Simplified Chinese interface (`zh-CN`), Gregorian dates, and the browser's IANA timezone. Technical model/tool names and Tokens, Credits, USD, and Fast remain unchanged. Accessibility target: WCAG 2.2 AA. Visual identity and token ownership are in [DESIGN.md](DESIGN.md).

## Business-context sources

| Domain                         | Maintained source                                                                        | UI consequence                                                                  | Reviewed   |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------- |
| Local access and privacy       | `docs/superpowers/specs/2026-08-27-agent-token-monitor-design.md`, Decisions / Non-goals | No account, telemetry, cloud hosting, or remote font requests                   | 2026-08-31 |
| Import lifecycle and retention | `README.md`, `packages/engine/src/server.ts`                                             | Local imports persist; existing files are not overwritten; no delete UI         | 2026-08-31 |
| Usage and estimates            | `README.md`, product brief, existing `format.ts`                                         | Retain dated estimate disclaimer; unknown prices remain `—`; no pricing changes | 2026-08-31 |
| Waste updates                  | Product brief, `PATCH /sessions/:id/waste-toggles`                                       | Only analysis preferences change; same turn counts once                         | 2026-08-31 |
| Existing navigation and locale | `App.tsx`, `session-navigation.ts`, `index.html`                                         | Overview, session selector/detail, Chinese copy, local state                    | 2026-08-31 |

The older brief's classification list is refined by the maintained README and current engine. This UI work preserves that newer classification and does not change financial or domain rules. There are no payment, permission-management, legal-consent, or destructive workflows to invent.

## Canonical UI Map

| Capability      | Canonical owner                                                      | Source of truth                 | Allowed variants                                     | Verification                                           |
| --------------- | -------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Form            | `ui.tsx:SearchField`, `App.tsx`, `SessionList.tsx`, `import-file.ts` | This contract; import API       | Local search / single-file import                    | Browser IME, clear, validation, duplicate-submit tests |
| Scrollbar       | `apps/web/src/styles.css`                                            | DESIGN.md                       | Document / bounded table / session selector geometry | Computed style and responsive browser tests            |
| Feedback        | `ui.tsx:Notice`, `ui.tsx:StatePanel`                                 | This contract                   | Loading / empty / missing / error / stale / success  | Live regions and request failure tests                 |
| Navigation      | `App.tsx`, `session-navigation.ts`                                   | This contract                   | Overview / sessions                                  | Back, reload, filter restoration                       |
| Choice controls | `ui.tsx:SegmentedControl`                                            | This contract                   | Time range / display unit                            | Pressed state and keyboard tests                       |
| Read/detail     | `CostTree.tsx`, `TurnTable.tsx`, `DetailSection.tsx`                 | Product brief and this contract | Session / category / turn evidence                   | Disclosure, paging, keyboard tests                     |
| Analysis update | `WasteToggles.tsx`                                                   | Waste PATCH API                 | Serialized preference updates                        | Success, rollback, recovery tests                      |

No select/listbox, date picker, bulk table selection, toast, modal, authentication, or delete capability is present. Segmented buttons are not listboxes; disclosure and inline feedback do not need a modal or toast system.

## Dataset navigation

- The API returns the complete session summary list. Preserve the existing explicit Load more strategy: 100 sessions or 100 turns per batch. Do not infer server paging or an incomplete dataset.
- Session queries filter locally, commit after IME composition, and clear immediately. Empty input is distinct from no results. A clear action returns focus to the search input.
- **Privacy override to URL defaults:** session IDs, search queries (which can contain local paths), list limit, and scroll position stay in tab-scoped sessionStorage. They never enter URLs or persistent localStorage. Range and active view are restored per tab; only `#overview` and `#sessions` appear in route URLs. Display unit uses the existing non-sensitive local preference.
- Browser Back restores the route, selection, and range. Returning to sessions restores its query, batch limit, and scroll offset. Changing a query resets the batch; a selected session outside the query remains readable and is explicitly explained.
- Filters and new data cannot strand a batch beyond the dataset. Current visible/total count remains available. There are no sort or bulk-selection controls.

## Flow ledger

| Operation                | Pending                                                          | Success and focus                                                                                                                                   | Failure recovery                                                                                | Source                 |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| Open overview / sessions | Keep header; reserved loading panel for missing data             | Route title updates; page heading receives focus on route change                                                                                    | Retry in affected panel; navigation remains usable                                              | Existing routes        |
| Select session           | Keep list usable; never show the previous session as the new one | Load exact selection; keep focus on selection control                                                                                               | Distinguish 404 from request error; retry; keep same-session stale data                         | Session GET API        |
| Filter sessions          | Local; composition does not filter prematurely                   | Announce count; focus remains in input                                                                                                              | No results offers clear; full selected detail remains available                                 | Existing full-list API |
| Import JSONL / NDJSON    | App-owned single-flight guard; file name; fixed-size busy action | Server acknowledgement clears search and announces success; open detail with all time if still in sessions, otherwise offer an explicit open action | Retain file/error; never automatically resend uncertain POST; inspect session list before retry | Import API             |
| Change waste rule        | Block repeated activation during save; show saving state         | Only server-confirmed snapshot changes amounts; remain in context                                                                                   | Restore/reconcile authoritative state, retain error, offer retry                                | Waste PATCH API        |
| Open turn evidence       | Immediate native button disclosure                               | `aria-expanded`; complete prompt, input and recorded output are reachable                                                                           | Empty tools have explicit copy                                                                  | Product brief          |

## Navigation and responsive behavior

Top-level navigation uses real hash links with `aria-current`. Route document title policy: `成本总览 · Token Analyser` or `会话明细 · Token Analyser`; failures use an honest route label and never leak prompts or local paths into the title. Session selection is a button action inside the current route. A skip link targets the current main region.

The document scrolls naturally. On desktop the session selector can scroll independently; on narrow screens it remains a bounded region above the detail. The turn table scrolls horizontally with an explicit cue and vertically within its own frame. Full evidence remains reachable at 360px and reduced motion. The narrow header is not sticky, so it cannot cover the focused field or evidence.

Long model names and session IDs wrap where needed; row previews may truncate because explicit details expose the complete value. Turn timestamps retain exact date/time access. The top-level route change focuses its heading; selecting a session keeps list focus. Ctrl/Command+K focuses session search without intercepting IME or typing. No global single-character shortcuts.

## Feedback and async resilience

One inline Notice/StatePanel family owns errors, pending, empty, and success copy. Critical failures persist until recovery or an explicit dismissal; no success toast masks an error. Global connection status describes the SSE connection. A disconnected stream keeps readable data and revalidates on reconnect; HTTP failures, not browser online hints, determine read availability.

Existing request sequencing and coalescing remain canonical. Only the current selection/range may commit results or clear its pending state. Reads have a bounded timeout and an explicit retry. Background failure preserves usable data and explains staleness. Cross-session or out-of-range stale data is never presented under a new heading.

Import is non-idempotent file creation: prevent duplicate submission, never auto-retry, and explain uncertain completion rather than promising cancellation. The app shell owns the guard from file reading through server acknowledgement; changing views preserves progress and cannot start a second import. Completion while browsing overview stays on overview and offers an action to open the imported detail. A successful import must not be reported as failed merely because a follow-up read failed; invalidate any list read started before the write. The server's 256 MiB limit is mirrored for early validation and remains authoritative. Import state is kept only in memory; reloading during upload may leave completion uncertain, so inspect the session list before resending.

Waste toggles are local analysis preferences, not money transfers. Changes use the existing serialized PATCH path. A failed save remains a visible failure even if a subsequent GET successfully restores the server value. No offline write queue, durable secret draft, multi-user merge, or unsupported cancellation is promised.

## Validation and safety

Product forms use `noValidate`. Search has a real label, clear action, and composition guards. Import validates extension, non-empty contents, size, and one-file scope before upload, preserves the filename, and associates textual errors with the file action. The picker remains a keyboard alternative to drag-and-drop. A hidden native input is not a second invisible tab stop.

There are no unsaved text-edit forms, sensitive-value fields, clipboard operations, or destructive actions. Evidence is rendered as React text, never HTML. File content and prompts are not persisted in browser storage. No new retention or consent policy is introduced.

## Verification

Required checks: web TypeScript, engine and web unit tests, production build, Playwright against isolated fixture ports, token drift check, DESIGN.md lint, and the Frontend Design Premium strict audit. See `premium-ui.json` for executable project checks.

Compare overview and session detail in the existing dark theme at desktop and 390px. Exercise normal, loading, zero data, no matches, read failure/retry, stale requests, import validation/single-flight/success/failure, toggle failure, keyboard, Back/reload, long text, reduced motion, and global scrollbar styles. No Japanese market, dropdown popup, auth, delete, or payment verification is applicable.
