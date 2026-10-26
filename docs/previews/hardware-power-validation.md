# Hardware electricity page validation

Validated on 2026-10-23 / 2026-10-24, Asia/Singapore.

ZCode 3.16.3 with GLM-5.3 generated the feature's main implementation. Codex
reviewed it, fixed compilation, integration boundaries, measured-zero handling,
date input events, accessible scrolling, and responsive layout, then verified it.
No real hardware data source is connected.

## Passed

- Engine unit tests: 188 passed.
- Web unit tests: 142 passed, including 26 hardware-power cases.
- `pnpm --filter web exec tsc --noEmit`.
- `pnpm --filter web build`.
- `node scripts/verify-ui-tokens.mjs`: 16 mappings verified.
- `git diff --check`.
- End-to-end checks on isolated ports 7806/7807: 66 passed after excluding the
  two confirmed baseline failures below. Includes both new hardware page tests,
  custom date validation, tariff/range updates, navigation, 390px overflow and Axe.
- Manual browser checks at 1440px and 390px; exact custom dates, invalid ordering,
  range changes and editable tariff. Screenshots are adjacent to this report.
- Existing user changes in `config/api-prices.json` were preserved byte-for-byte:
  SHA-256 `c118ad34cf24a538a6c375563864a5dde236bc6498b3c83aa9de5b9484548ec5`.

## Confirmed baseline failures

The full initial end-to-end run found two existing session-detail table checks
failing at 1600px and 1440px in `e2e/dashboard.spec.ts:643`. Both fail identically
on an isolated archive of unmodified HEAD, served on 7808/7809. They concern
`.turn-table-scroll`, not the hardware page. They were not changed or suppressed
in the test sources. The final validation invocation excluded just these
two cases; temporary port-override configs were removed afterward.

Standalone Frontend Design Premium and DESIGN.md lint commands are not installed
or exposed in this session, so no standalone premium audit or design-lint pass is
claimed. Required executable checks from `premium-ui.json` were otherwise run.

## Preview

http://127.0.0.1:7796/#power uses a fixture-only engine on port 7797.
Hardware figures are deterministic demo values; electricity is isolated from
Token cost totals. Preview processes are intentionally left running.
