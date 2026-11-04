# STRATA-style UI + System Temperature — Design

Date: 2026-11-04
Status: approved for implementation planning
Product: Token Analyser local dashboard — restyle to a light STRATA-like visual language, and add a hardware temperature sub-page fed by the same Prometheus host already used for power.

## Goal

1. Replace the current dark “terminal ledger” look with a light, warm-cool dashboard aesthetic matching the STRATA Hardware Monitor reference (soft page background, white cards, mint status pills, blue/orange/purple chart series).
2. Add a **系统温度** experience under a unified **硬件** nav entry, showing dual RX 7900 XTX + Ryzen 7 7700 temperatures with live cards and history charts.
3. Read temperatures from **Prometheus on the hardware host**, not from the STRATA HTTP UI / SSH tunnel on port 60572.

## Decisions already made

| Decision | Choice |
|---|---|
| Approach | Token remapping + Hardware shell + engine Prometheus aggregation |
| Data path | Prometheus at `power.prometheus_url` (default `http://192.168.1.102:9090`); no dependency on `localhost:60572` |
| Navigation | Single **硬件** entry with sub-tabs **温度 / 用电** |
| Theme | Full-site light STRATA palette only; no dark-mode toggle |
| Temperature UI fidelity | Screenshot-aligned layout (dual GPU cards, CPU card, guard strip, three history charts); rebuild with existing canvas/SVG patterns; not a 1:1 port of STRATA source |
| Branding | Keep product name **Token Analyser**; do not rebrand shell as STRATA |
| Fake data | Never invent temperatures; `connected: false` when Prometheus is unreachable |

## Non-goals

- Proxying or embedding the STRATA service on `:60572` / remote `:8092`
- Keeping a parallel dark theme
- Introducing Chart.js / Recharts / ECharts solely for this page
- Rewriting overview/session DOM structure beyond what CSS tokens require
- Monitoring the discrete iGPU (`AMD Radeon Graphics`) on the temperature page
- Changing Prometheus itself or deploying exporters

## Context (discovered)

- `localhost:60572` is an SSH local forward (`john@192.168.1.102` → `127.0.0.1:8092`). That UI polls its own `/api/metrics` and `/api/history`; the browser cannot call it cross-origin from Token Analyser, and the product requirement is to use the **upstream metrics**, not that UI.
- Hardware power already queries Prometheus via `packages/engine/src/power.ts` and `GET /power`.
- `power.ts` already contains a partial `fetchTemps` + `power.temps` config, but:
  - default GPU queries (`amdgpu_gfx_temperature`, etc.) return **empty** on this host;
  - `fetchTemps` is **not** exposed on `server.ts`.
- Live Prometheus metrics on the host include:
  - `amdgpu_temperature_celsius{sensor="edge\|junction\|memory", name="AMD Radeon RX 7900 XTX", card=...}`
  - `amdgpu_fan_rpm`, `amdgpu_gfx_power_watts`, `amdgpu_gpu_busy_percent`, `amdgpu_vram_*`, `amdgpu_power_cap_watts`
  - CPU: `node_hwmon_temp_celsius` joined with `node_hwmon_sensor_label` → **Tctl** / **Tccd1** on chip `pci0000:00_0000:00:18_3`

## Architecture

```
apps/web
  HardwarePage            # shell: 温度 | 用电
  SystemTemperaturePage   # new UI
  HardwarePowerPage       # existing, themed only
  api.getTemps / getTempsHistory

packages/engine
  power.ts                # fix + extend temps: instant + history
  server.ts               # GET /temps, GET /temps/history
  config via power.temps

Prometheus 192.168.1.102:9090
  amdgpu-* + node_hwmon_*
```

## Data & API

### Config

Reuse `~/.token-analyser/config.json` → `power` block (same `prometheus_url`). Extend / correct `power.temps` defaults so queries match real metric names. Optional overrides remain valid JSON fields only (same merge rules as today).

Suggested default GPU temperature query family:

```promql
amdgpu_temperature_celsius{name="AMD Radeon RX 7900 XTX"}
```

CPU:

```promql
node_hwmon_temp_celsius{chip="pci0000:00_0000:00:18_3"}
```

(or equivalent join on sensor labels Tctl/Tccd1). Chip selector may be configurable if hardware changes.

Thermal limits (display / status only, not enforced by this app): edge 85°C, junction 100°C, memory 96°C — matching the STRATA guard strip.

### Endpoints

**`GET /temps`**

Returns a single aggregated sample:

```json
{
  "source": "prometheus",
  "connected": true,
  "url": "http://192.168.1.102:9090",
  "timestamp": 1730000000.0,
  "cpu": {
    "name": "AMD Ryzen 7 7700",
    "status": "available",
    "temperatures": {
      "tctl": { "value": 44.0 },
      "tccd1": { "value": 36.6 }
    }
  },
  "gpus": [
    {
      "id": 0,
      "card": "/dev/dri/card0",
      "name": "AMD Radeon RX 7900 XTX",
      "status": "normal",
      "temperatures": {
        "edge": { "value": 49, "limit": 85 },
        "junction": { "value": 59, "limit": 100 },
        "memory": { "value": 66, "limit": 96 }
      },
      "fan_rpm": 0,
      "power_w": 19,
      "power_cap_w": 303,
      "utilization": 0,
      "vram_used_gib": 0.03,
      "vram_total_gib": 24.0
    }
  ]
}
```

- GPU `id` is a stable 0-based index over discrete XTX cards (sorted by `card` label).
- `status`: `normal` / `warm` / `over` / `missing` from margin vs limits (warm when margin ≤ 8°C).
- On total failure: HTTP 200 with `connected: false`, `error`, empty/partial nulls — same posture as `/power`.

**`GET /temps/history?seconds=N`**

- `N` clamped to 60–3600 (invalid → 400 `invalid_range`).
- Prometheus `query_range` for the same GPU/CPU series; step ≈ `max(2, min(15, round(N/300)))` seconds.
- Response shape is fixed: `{ source, connected, url, seconds, step, samples }` where `samples` is an array of the **same per-timestamp object** as `GET /temps` (minus `connected`/`url`/`source`), ordered ascending by `timestamp`. Missing points for a series are `null` values inside that sample, not omitted timestamps when any series has a point (union of timestamps across queries).

### Front-end polling

- On temperature sub-page mount: fetch history once, then poll `/temps` every ~2s.
- Unmount / leave tab: stop polling.
- Stale rule: if last successful sample age > ~8s, show disconnect banner; keep last readings labeled stale.

### Vite proxy

Add `/temps` → engine (`7789`), alongside existing `/power`.

## Navigation & pages

### Shell

- Top nav label: **硬件** (replaces **硬件用电**).
- `HardwarePage` hosts segmented control: **温度** | **用电**.
- Hash routes: `#hardware/temps`, `#hardware/power`.
- Legacy `#power` redirects to `#hardware/power`.
- Default hardware land: **温度**.

### System temperature layout

1. Header: title「CPU 与双卡温度」, live pill, last-updated time.
2. Guard strip: online/warning copy + GPU shutdown lines.
3. Two GPU cards side-by-side (core / hotspot / memory + meters + fan/power/load/VRAM).
4. Full-width CPU card (Tctl, Tccd1).
5. History section: period select (5 / 10 / 30 / 60 min); GPU0, GPU1, CPU charts; series colors blue / orange / purple (CPU: Tctl blue, Tccd1 purple).

### Power sub-page

Existing `HardwarePowerPage` embedded unchanged in behavior; inherits new tokens only.

## Visual system

### Token remap (canonical)

Update `tokens.css`, `apps/web/src/styles.css` `:root`, and `DESIGN.md`:

| Role | Value |
|---|---|
| `--bg` | `#f6f7f9` |
| surface / cards | `#ffffff` |
| text | `#19212d` |
| muted | `#626d7c` |
| border / line | `#e5e9ef` |
| accent | `#1c7564` |
| accent soft bg | `#e9f4ef` |
| warn | `#955d00` (+ soft `#fff4dd`) |
| danger | `#bd3744` |
| chart blue / orange / purple | `#3b7ad0` / `#be6d21` / `#8b63be` |

- `color-scheme: light`.
- Light shadows (`0 5px 24px` soft), not heavy dark drop shadows.
- Font: keep Chinese-capable system stack; Inter-like sans is fine without mandatory webfont fetch.

### Scope of CSS work

1. Global variables + DESIGN.md.
2. Audit hard-coded dark colors (selection rings, scrollbar, chart strokes, overlays) for contrast on light bg.
3. New temperature-page classes only for layout unique to that page.
4. Update e2e / visual assertions that pin dark hex values.

### Out of visual scope

- Full DOM rewrite of overview/session trees.
- New component library.
- Dark/light toggle.

## Testing

- Engine unit tests for temp PromQL parsing / device grouping (fixture JSON Prometheus responses), including empty-result and partial-GPU cases.
- History clamping and `connected: false` path.
- Web: navigation hash `#hardware/temps` / `#power` redirect; temperature page renders missing state without throwing.
- Manual: with Prometheus reachable, dual XTX + Tctl/Tccd1 match values seen on the STRATA UI within normal scrape lag.

## Implementation order (for the later plan)

1. Fix `power.temps` defaults + extend `fetchTemps` / add history helper; wire `/temps` routes; Vite proxy.
2. `HardwarePage` shell + hash routing; embed existing power page.
3. `SystemTemperaturePage` + API client + charts.
4. Global light token remap + contrast pass + DESIGN.md.
5. Tests + e2e assertion updates.

## Open points resolved during design

- Not using STRATA HTTP as a dependency.
- iGPU excluded from the temperature cards.
- No demo/fake temperatures (unlike power page’s demo fallback for charts).
