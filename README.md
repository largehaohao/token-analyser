# Token Analyser

Local Codex dashboard for token, credit, and dollar estimates. The Node engine reads rollout JSONL; the Vite UI talks to it over HTTP and SSE. Nothing leaves the machine. Figures are local estimates from telemetry and the dated public rate card — not OpenAI's bill.

## Run

```bash
pnpm install
pnpm dev
```

`pnpm dev` waits until the engine is listening on `127.0.0.1:7789`, then starts the UI at [http://127.0.0.1:7788](http://127.0.0.1:7788).

Single-process production-style serve (engine hosts `apps/web/dist`):

```bash
pnpm start
```

Print a snapshot for one rollout file:

```bash
pnpm analyse path/to/rollout.jsonl
```

Default watch root: `~/.codex/sessions/**/rollout-*.jsonl`. Optional `~/.token-analyser/config.json`:

```json
{
  "watch_paths": ["/absolute/path/to/sessions"],
  "usd_per_credit": 0.05
}
```

Rate card: `config/rate-card.json`. Parse cache: `~/.token-analyser/cache/`.

## Test

```bash
pnpm test
```

Runs engine and web unit tests. Playwright (needs browsers):

```bash
E2E=1 pnpm test
```
