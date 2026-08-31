# UI verification — 2026-08-31

The overview and session detail retain the existing Chinese interface, dark terminal palette, local-only processing, and pricing/classification behavior. Shared visuals are recorded in [DESIGN.md](../DESIGN.md); interaction ownership and recovery behavior are recorded in [UX-CONTRACT.md](../UX-CONTRACT.md).

| Check                                 | Result                                               |
| ------------------------------------- | ---------------------------------------------------- |
| `pnpm test`                           | 127 engine + 88 web tests passed                     |
| `pnpm --filter web exec tsc --noEmit` | Passed                                               |
| `pnpm --filter web build`             | Passed                                               |
| `pnpm --filter web test:e2e`          | 34 passed; 1 existing fixture-dependent test skipped |
| `node scripts/verify-ui-tokens.mjs`   | 16 documented/runtime token mappings matched         |
| DESIGN.md lint                        | 0 errors, 0 warnings                                 |
| Frontend Design Premium strict audit  | 0 findings; [report](../premium-audit.json)          |
| Formatting and `git diff --check`     | Passed                                               |

Browser verification covers loading, empty datasets, no search results, IME composition, clear/focus behavior, browser Back and reload, request ordering, stale data, missing sessions, retry, file validation, duplicate upload prevention across view changes, confirmed imports followed by failed reads, uncertain import outcomes, and failed preference saves with rollback and retry.

Visual and interaction checks include desktop and 390px layouts, complete turn evidence, internal table scrolling without page overflow, keyboard disclosures and skip navigation, tooltip dismissal with Escape, stable busy-button geometry, reduced motion, and forced colors. Automated axe checks found no WCAG A/AA violations in the tested overview and expanded session detail. This run does not include a screen-reader audit.

Mutation tests use a separate fixture engine on port 7799, a test frontend on 7798, and an isolated home under `apps/web/test-results/engine`. The user's running engine and original session files are not used for mutation tests. Playwright writes overview/session screenshots at 1280px and 390px into its ignored test-results directory.

The existing rate-limit gauge browser test skips when redacted fixtures contain no rate-limit data. Rate-limit calculations remain covered by the existing unit tests; browser verification of that fixture-dependent gauge state remains a limitation.
