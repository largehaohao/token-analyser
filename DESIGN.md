---
version: alpha
name: Token Analyser
description: A local, terminal-inspired ledger for tracing Codex usage from totals to individual model calls.
colors:
  primary: "#7dffb3"
  background: "#070a08"
  surface: "#101612"
  inset: "#0a0f0c"
  border: "#2b3b31"
  text: "#e8eee8"
  muted: "#a4b0a8"
  warning: "#f5c542"
  danger: "#ff9184"
typography:
  body:
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: "1.6"
  display:
    fontFamily: '"Avenir Next", "Segoe UI", "PingFang SC", system-ui, sans-serif'
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
rounded:
  DEFAULT: "14px"
  control: "8px"
spacing:
  panel: "24px"
  gap: "20px"
components:
  button-outline:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
    rounded: "{rounded.control}"
  segmented-control:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.muted}"
  search-field:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.text}"
  state-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.DEFAULT}"
  notice:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
  notice-warning:
    textColor: "{colors.warning}"
  notice-error:
    textColor: "{colors.danger}"
  quality-strip:
    backgroundColor: "{colors.border}"
  ledger-strip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.DEFAULT}"
  chart-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.DEFAULT}"
  rail-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.DEFAULT}"
  rank-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
  hist-card:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
---

# Token Analyser design system

## Overview

The reference is an `htop` ledger: precise numeric columns, visible branches, quiet dark surfaces, and a mint trace through recorded usage. Preserve the approved terminal identity in [the product brief](docs/superpowers/specs/2026-08-27-agent-token-monitor-design.md). This is a product surface for people auditing local Codex runs, primarily on a laptop, with phone layouts for checking a run. The job is to connect a total to its evidence, not to sell an analytics service.

## Macrostructure family

App pages use a **Catalogue-led index**: the session inventory is the first reading surface, and the selected session opens into an evidence split. Overview reads as a ledger: a strip of equal-width figures with the comparison against the previous equal-length window, then a trend panel beside Token composition, then response performance (fixed latency histograms) beside the ranked behaviour list, a right rail for ledger state / top sessions / data sources, and detailed disclosures last. The variant changes hierarchy and rhythm from the earlier workbench presentation without changing the underlying data model or route behavior.

- Navigation: compact filled selection on desktop; equal-width links with an active rule on mobile. Source, time range and unit live in their own filter toolbar. Mobile starts with a collapsed filter summary; an explicit button expands all controls.
- App footer: single inline rule with local-processing and read-only notes (Ft2-inspired)
- Enrichment: none; data and evidence carry the page

The existing interface establishes Simplified Chinese (`zh-CN`); model IDs, Tokens, Credits, USD, Fast, and tool names remain technical terms. Locale does not establish a geographic market. There is no Japan-specific market or workflow evidence. No remote fonts, analytics, or decorative media are needed.

The signature is the token partition: the same colors and exact numerical semantics connect overview charts, session composition, the cost tree, and individual turns. Keep secondary analysis behind the established disclosures. Avoid marketing heroes, ornamental gradients, glowing badges, and treating expensive work as inherently wasteful.

**Ownership:** model B. `apps/web/src/styles.css` is the canonical runtime token source; this document mirrors accepted values and rationale. `apps/web/src/buckets.ts` maps domain categories to CSS color tokens. The imported root `tokens.css` provides semantic aliases and shared type/motion scales; it does not redefine the palette or create an independent theme adapter. `scripts/verify-ui-tokens.mjs` checks the documented mapping.

## Colors

Mint is the established selection/action accent; it is not an indication that every recorded turn is useful. Amber identifies potentially optimizable usage and data warnings, with explicit labels to distinguish them. Coral identifies request failures. Flat forest-black surfaces preserve the terminal character without a second visual brand.

Text must remain readable at the compact data sizes: use `--text` for values, `--text-muted` for labels, and `--text-dim` for supporting text. Never dim a meaningful label using opacity. Cache and output keep their existing blue and violet associations. Chart labels and patterns supplement color. Only the existing dark theme is supported; forced colors use operating-system colors.

## Typography

The body stack is local and Chinese-capable; no download or font swap changes layout. Avenir Next is used with restraint for the product name and page headings, with script-capable fallbacks. Numbers, model IDs, paths, and ledger values use `--mono` with tabular digits. Keep full values available in details and allow long paths and error messages to wrap. Chinese text is sentence-like and direct, without decorative letter spacing.

## Layout

The document owns page scrolling. Overview uses a 1424px maximum width; session analysis uses 1760px. The overview starts with the ledger strip: four equal figures separated by 1px rules, each figure carrying its own comparison line; the leading total keeps its mint tint. Below 1360px the strip becomes two columns and the rail drops under the content as an equal-width panel row; below 780px it becomes one column. Panel pairs (trend + composition, performance + ranked behaviour) sit side by side above 1180px and stack below it; the trend plot scrolls horizontally inside its own frame so a 30-day window keeps 24px targets. Detailed analysis stays behind disclosures. Pricing limitations remain visible next to totals; the longer mode explanation lives inside data quality.

The session page has a sticky catalogue rail beside its evidence pane on wide screens. Below 780px, it shows either the list or the detail. Selecting a session opens and focuses the detail; “返回会话列表” restores focus to the selected item. Search, selection and list scroll remain mounted. The list is bounded to 65dvh on mobile. Source switches return to the list; the keyboard search shortcut also reveals the list before focusing the input. Controls reflow down to 320px. No page shell has a fixed height to accommodate a table.

Use the existing 24px panel spacing and 20px gaps. Only the session selector, turn table, and long evidence blocks own internal overflow; every scroll region inherits the global scrollbar baseline. Reserve loading surfaces and feedback lines. The header's controls, disclosure summaries, and busy buttons keep stable dimensions.

## Elevation & Depth

Tonal surfaces and borders carry hierarchy. Static cards have no ornamental shadow. Tooltips alone may use `--shadow`. Keep the header opaque so text does not overlap background data. No ambient gradients or perpetual live-status animation.

## Shapes

Cards use `--radius` (14px); controls use `--radius-control` (8px). Pills are reserved for short statuses and units. The small ledger mark is built from four numeric-looking strokes; all other icons use the same 24-unit outline grid and inherit text color.

## Components

| Document token                        | Runtime owner                      | Consumers                                       |
| ------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| `colors.primary`                      | `--accent`                         | Button, links, selection, focus, recorded usage |
| `colors.background / surface / inset` | `--bg / --bg-raised / --bg-inset`  | Page, cards, inputs, table headers              |
| `colors.border / text / muted`        | `--border / --text / --text-muted` | All shared components                           |
| `colors.warning / danger`             | `--warn / --danger`                | Notices, validation, optimization values        |
| `typography.body / display / mono`    | `--font / --display / --mono`      | Body, headings, ledger figures                  |
| `rounded.DEFAULT / control`           | `--radius / --radius-control`      | Panels and controls                             |
| `spacing.panel / gap`                 | `--space-panel / --space-gap`      | Panel padding and layout rhythm                 |

`ui.tsx` owns Button (emphasis × intent), SegmentedControl, SearchField, StatePanel, Notice, and icons. Enabled actions have a hover treatment, 2px focus ring, pressed state, and pointer cursor. Disabled and busy actions cannot run; a busy button reserves its label's dimensions. Native links navigate. Native buttons expand turn evidence. Do not make table rows pretend to be buttons.

The ledger strip, chart cards, rail panels, ranked rows and histogram cards are surfaces, not cards to be clicked: only ranked rows, the session-count figure and rail session rows are buttons, and each names what pressing it does. A chart figure is always paired with its tabular `srTable`, a text value, and a comparison where one exists; a number without a comparison states that plainly. Histograms use fixed shared buckets (`≤ 1s`, `1–2s`, … and `≤ 40 tok/s`, `40–50 tok/s`, …, `140–150 tok/s`, `> 150 tok/s`) so two sessions, ranges and sources compare on one scale, and their denominator is stated (`3/14 轮有记录`). Output speed stays coarse up to 40 tok/s and then splits every 10 tok/s, so a fast model's spread is visible. A dense histogram labels each bar with its bucket's upper edge (`≤40`, `50`, …, `>150`) and prints the percentage only on the tallest bar; the full range name stays in the hover text and in the summary line.

Loading uses an app-owned spinner in a reserved StatePanel, never a speculative skeleton. Stale reads retain data and show an inline notice. Search has an explicit clear button. Import shows a file name, truthful busy state, validation, and a persistent outcome. Details and context disclosures use native semantics. Behavior, privacy, navigation, and recovery are owned by [UX-CONTRACT.md](UX-CONTRACT.md).

Use 140ms color/border transitions; motion never drives layout. Under reduced motion, loaders remain visible but static, transitions stop, and evidence scrolling is immediate. A live connection is indicated by text and a steady dot.

## Do's and Don'ts

- Do keep totals, date range, display unit, and pricing limitations in view.
- Do retain the local-estimate disclaimer and unknown-model `—` values.
- Do use labels, focus, patterns, and textual values alongside color.
- Don't add accounts, cloud delivery, deletion, or pricing rules as part of UI work.
- Don't hide failures behind success copy, move controls during loading, or expose search text and local paths in URLs.

## Hardware electricity preview

The `#power` page reuses the existing ledger figures, chart cards, controls,
spacing, semantic colors and Chinese copy. CPU/GPU/whole-machine watts precede
whole-machine interval energy and CNY cost, and that pair is the page's primary
reading: a two-figure hero panel in the largest ledger type on the page, echoed
by a compact energy/cost summary under the page title. The price field starts at
0.6629 CNY/kWh and its label keeps four decimals for prices finer than a cent.
The demo notice stays visible and
component readings never add to the whole-machine total. Three line styles
supplement color; overflowing charts and tables give an explicit scroll cue.
The trend keeps its 24px columns: at most 150 columns per range, each column a
sampling bucket's mean, so finer sampling scrolls the plot instead of shrinking
it. The bucket's peak rides in the tooltip, and the statistics table reports
total, average and peak from the raw sampling grid, never from the buckets.
