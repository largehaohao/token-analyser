# STRATA-style UI + System Temperature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Token Analyser to a light STRATA-like palette and add a Hardware → 温度 page that reads dual-GPU + CPU temps from Prometheus (same host as `/power`), with no dependency on `:60572`.

**Architecture:** Extend `packages/engine` with `fetchTempSnapshot` / `fetchTempHistory` that query real `amdgpu_*` / `node_hwmon_*` metrics and expose `GET /temps` + `GET /temps/history`. The web app gains a `HardwarePage` shell (温度 | 用电), a new `SystemTemperaturePage`, and a global CSS token remap to the STRATA light palette.

**Tech Stack:** TypeScript, Node engine, Vitest, Vite + React 19, Prometheus HTTP API, canvas charts (no new chart library).

**Spec:** `docs/superpowers/specs/2026-11-04-strata-ui-system-temps-design.md`

## Global Constraints

- Never invent temperature readings; unreachable Prometheus → `connected: false`.
- Do not call or proxy `localhost:60572` / STRATA HTTP.
- Filter GPUs to `name="AMD Radeon RX 7900 XTX"` (exclude iGPU).
- Thermal display limits: edge 85°C, junction 100°C, memory 96°C; warm when margin ≤ 8°C.
- Full-site light theme only; no dark toggle.
- Product name stays Token Analyser.
- Do not commit unless the user explicitly asks (user rule overrides plan commit steps).

## File map

| File | Responsibility |
|---|---|
| `packages/engine/src/temps.ts` (create) | Snapshot + history aggregation, limits, status helpers |
| `packages/engine/src/power.ts` | Keep power; re-export or leave old generic `fetchTemps` unused by HTTP; fix/leave defaults without breaking power config merge |
| `packages/engine/src/server.ts` | Route `GET /temps`, `GET /temps/history` |
| `packages/engine/tests/temps.test.ts` (create) | Unit tests with mocked fetch |
| `apps/web/vite.config.ts` | Proxy `/temps` |
| `apps/web/src/api.ts` | `getTemps`, `getTempsHistory` + DTO types |
| `apps/web/src/session-navigation.ts` | Views `hardware` + `hardwareTab`; `#power` → power tab |
| `apps/web/src/HardwarePage.tsx` (create) | Shell with 温度 \| 用电 |
| `apps/web/src/SystemTemperaturePage.tsx` (create) | Live cards + history charts |
| `apps/web/src/hardware-temps.ts` (create) | Pure helpers: status copy, chart window filter, formatters |
| `apps/web/src/hardware-temps.test.ts` (create) | Helper unit tests |
| `apps/web/src/App.tsx` | Nav label 硬件; render HardwarePage |
| `apps/web/src/styles.css`, `tokens.css`, `DESIGN.md` | Light palette |
| `apps/web/src/styles.css` | Temperature-page layout classes |

---

### Task 1: Engine temp snapshot + history module

**Files:**
- Create: `packages/engine/src/temps.ts`
- Create: `packages/engine/tests/temps.test.ts`
- Modify: `packages/engine/src/power.ts` — export `FetchLike`, `RangeResponse` (already exported); keep `mergePowerConfig` using existing `temps` block for URL only if needed; snapshot module reads `prometheus_url` from `PowerQueryConfig`

**Interfaces:**
- Consumes: `PowerQueryConfig.prometheus_url`, `FetchLike` from `power.ts`
- Produces:
  - `TEMP_LIMITS = { edge: 85, junction: 100, memory: 96 }`
  - `gpuStatus(temps): "normal" | "warm" | "over" | "missing"`
  - `fetchTempSnapshot(options): Promise<TempSnapshotResult>`
  - `fetchTempHistory(options): Promise<TempHistoryResult>`
  - Types `TempSample`, `TempGpu`, `TempCpu`, `TempSnapshotResult`, `TempHistoryResult` matching the spec JSON

- [ ] **Step 1: Write failing tests** in `packages/engine/tests/temps.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  TEMP_LIMITS,
  fetchTempSnapshot,
  fetchTempHistory,
  gpuStatus,
  type FetchLike,
} from "../src/temps.ts";

const T0 = 1_700_000_000;

function okJson(body: unknown): {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
} {
  return { ok: true, status: 200, json: async () => body };
}

function matrixResult(
  series: { metric: Record<string, string>; values: [number, string][] }[],
) {
  return {
    status: "success",
    data: { resultType: "matrix", result: series },
  };
}

describe("gpuStatus", () => {
  it("marks warm within 8°C of any limit and over when exceeded", () => {
    expect(
      gpuStatus({
        edge: { value: 78, limit: 85 },
        junction: { value: 50, limit: 100 },
        memory: { value: 50, limit: 96 },
      }),
    ).toBe("warm");
    expect(
      gpuStatus({
        edge: { value: 90, limit: 85 },
        junction: { value: 50, limit: 100 },
        memory: { value: 50, limit: 96 },
      }),
    ).toBe("over");
  });
});

describe("fetchTempSnapshot", () => {
  it("aggregates two XTX cards and CPU Tctl/Tccd1 from Prometheus fixtures", async () => {
    const impl: FetchLike = async (url) => {
      if (url.includes(encodeURIComponent("amdgpu_temperature_celsius"))) {
        return okJson(
          matrixResult([
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "edge",
              },
              values: [[T0, "49"]],
            },
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "junction",
              },
              values: [[T0, "59"]],
            },
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "memory",
              },
              values: [[T0, "66"]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "edge",
              },
              values: [[T0, "48"]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "junction",
              },
              values: [[T0, "54"]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "memory",
              },
              values: [[T0, "50"]],
            },
            {
              metric: {
                card: "/dev/dri/card2",
                name: "AMD Radeon Graphics",
                sensor: "edge",
              },
              values: [[T0, "41"]],
            },
          ]),
        );
      }
      if (url.includes("amdgpu_fan_rpm")) {
        return okJson(
          matrixResult([
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, "0"]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, "1000"]],
            },
          ]),
        );
      }
      if (url.includes("amdgpu_gfx_power_watts")) {
        return okJson(
          matrixResult([
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, "21"]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, "19"]],
            },
          ]),
        );
      }
      if (url.includes("amdgpu_gpu_busy_percent")) {
        return okJson(
          matrixResult([
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, "3"]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, "1"]],
            },
          ]),
        );
      }
      if (url.includes("amdgpu_vram_used_bytes")) {
        return okJson(
          matrixResult([
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, String(1 << 30)]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, String(2 << 30)]],
            },
          ]),
        );
      }
      if (url.includes("amdgpu_vram_total_bytes")) {
        return okJson(
          matrixResult([
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, String(24 * (1 << 30))]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, String(24 * (1 << 30))]],
            },
          ]),
        );
      }
      if (url.includes("amdgpu_power_cap_watts")) {
        return okJson(
          matrixResult([
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, "303"]],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
              },
              values: [[T0, "303"]],
            },
          ]),
        );
      }
      if (url.includes("node_hwmon_temp_celsius")) {
        return okJson(
          matrixResult([
            {
              metric: {
                chip: "pci0000:00_0000:00:18_3",
                sensor: "temp1",
              },
              values: [[T0, "44"]],
            },
            {
              metric: {
                chip: "pci0000:00_0000:00:18_3",
                sensor: "temp3",
              },
              values: [[T0, "36.625"]],
            },
          ]),
        );
      }
      throw new TypeError(`unexpected ${url}`);
    };

    const result = await fetchTempSnapshot({
      config: {
        prometheus_url: "http://prom.test",
        queries: { cpu: "x", gpu: "y", machine: "z" },
        temps: {
          gpu: [],
          cpu: [],
          max_components_per_device: 16,
        },
      },
      fetchImpl: impl,
      nowMs: T0 * 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.gpus).toHaveLength(2);
    expect(result.sample.gpus[0]!.temperatures.edge.value).toBe(49);
    expect(result.sample.gpus[0]!.status).toBe("normal");
    expect(result.sample.cpu.temperatures.tctl.value).toBe(44);
    expect(result.sample.cpu.temperatures.tccd1.value).toBe(36.6);
    expect(TEMP_LIMITS.edge).toBe(85);
  });

  it("returns ok:false when every query fails", async () => {
    const impl: FetchLike = async () => {
      throw new TypeError("offline");
    };
    const result = await fetchTempSnapshot({
      config: {
        prometheus_url: "http://prom.test",
        queries: { cpu: "x", gpu: "y", machine: "z" },
        temps: { gpu: [], cpu: [], max_components_per_device: 16 },
      },
      fetchImpl: impl,
      nowMs: T0 * 1000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("prometheus_unreachable");
  });
});

describe("fetchTempHistory", () => {
  it("builds timestamp-aligned samples and clamps seconds", async () => {
    const impl: FetchLike = async (url) => {
      if (url.includes("amdgpu_temperature_celsius")) {
        return okJson(
          matrixResult([
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "edge",
              },
              values: [
                [T0, "40"],
                [T0 + 15, "41"],
              ],
            },
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "junction",
              },
              values: [
                [T0, "50"],
                [T0 + 15, "51"],
              ],
            },
            {
              metric: {
                card: "/dev/dri/card0",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "memory",
              },
              values: [
                [T0, "60"],
                [T0 + 15, "61"],
              ],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "edge",
              },
              values: [
                [T0, "42"],
                [T0 + 15, "43"],
              ],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "junction",
              },
              values: [
                [T0, "52"],
                [T0 + 15, "53"],
              ],
            },
            {
              metric: {
                card: "/dev/dri/card1",
                name: "AMD Radeon RX 7900 XTX",
                sensor: "memory",
              },
              values: [
                [T0, "62"],
                [T0 + 15, "63"],
              ],
            },
          ]),
        );
      }
      // Support metrics: empty matrix is fine (nulls)
      if (
        url.includes("amdgpu_fan_rpm") ||
        url.includes("amdgpu_gfx_power_watts") ||
        url.includes("amdgpu_gpu_busy_percent") ||
        url.includes("amdgpu_vram_used_bytes") ||
        url.includes("amdgpu_vram_total_bytes") ||
        url.includes("amdgpu_power_cap_watts")
      ) {
        return okJson(matrixResult([]));
      }
      if (url.includes("node_hwmon_temp_celsius")) {
        return okJson(
          matrixResult([
            {
              metric: {
                chip: "pci0000:00_0000:00:18_3",
                sensor: "temp1",
              },
              values: [
                [T0, "40"],
                [T0 + 15, "41"],
              ],
            },
            {
              metric: {
                chip: "pci0000:00_0000:00:18_3",
                sensor: "temp3",
              },
              values: [
                [T0, "30"],
                [T0 + 15, "31"],
              ],
            },
          ]),
        );
      }
      throw new TypeError(url);
    };
    const result = await fetchTempHistory({
      config: {
        prometheus_url: "http://prom.test",
        queries: { cpu: "x", gpu: "y", machine: "z" },
        temps: { gpu: [], cpu: [], max_components_per_device: 16 },
      },
      seconds: 99999,
      fetchImpl: impl,
      nowMs: (T0 + 15) * 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seconds).toBe(3600);
    expect(result.samples.length).toBeGreaterThanOrEqual(2);
    expect(result.samples[0]!.gpus[0]!.temperatures.edge.value).toBe(40);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm --filter engine exec vitest run tests/temps.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `packages/engine/src/temps.ts`**

Hard-coded queries (not the broken `power.temps` gpu list):

```promql
amdgpu_temperature_celsius{name="AMD Radeon RX 7900 XTX"}
amdgpu_fan_rpm{name="AMD Radeon RX 7900 XTX"}
amdgpu_gfx_power_watts{name="AMD Radeon RX 7900 XTX"}
amdgpu_gpu_busy_percent{name="AMD Radeon RX 7900 XTX"}
amdgpu_vram_used_bytes{name="AMD Radeon RX 7900 XTX"}
amdgpu_vram_total_bytes{name="AMD Radeon RX 7900 XTX"}
amdgpu_power_cap_watts{name="AMD Radeon RX 7900 XTX"}
node_hwmon_temp_celsius{chip="pci0000:00_0000:00:18_3"}
```

Implementation notes:
- Use `query_range` with a short window for snapshot (last ~90s, take last point) — same pattern as `queryTempVector` in `power.ts`.
- Sort discrete cards by `card` label; assign `id` 0..n-1.
- Map CPU `temp1` → tctl, `temp3` → tccd1 (match this host’s sensor labels).
- Bytes → GiB: `bytes / 2**30`, one decimal.
- `history` step: `Math.max(2, Math.min(15, Math.round(seconds / 300)))`.
- Clamp seconds: `Math.max(60, Math.min(3600, Math.round(seconds)))`.
- Build samples on the union of timestamps across all series.

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm --filter engine exec vitest run tests/temps.test.ts`
Expected: PASS

---

### Task 2: HTTP routes + Vite proxy

**Files:**
- Modify: `packages/engine/src/server.ts` (near `/power` handler ~626)
- Modify: `apps/web/vite.config.ts`

**Interfaces:**
- Consumes: `fetchTempSnapshot`, `fetchTempHistory`, `loadUserConfig().power`
- Produces: `GET /temps`, `GET /temps/history?seconds=`

- [ ] **Step 1: Add routes** after the `/power` block in `server.ts`:

```ts
import { fetchTempSnapshot, fetchTempHistory } from "./temps.ts";

// GET /temps
if (req.method === "GET" && parts[0] === "temps" && parts.length === 1) {
  const config = loadUserConfig();
  const result = await fetchTempSnapshot({ config: config.power });
  if (result.ok) {
    sendJson(res, 200, {
      source: "prometheus",
      connected: true,
      url: result.config.prometheus_url,
      ...result.sample,
    });
  } else {
    sendJson(res, 200, {
      source: "prometheus",
      connected: false,
      url: result.config.prometheus_url,
      error: result.error,
      timestamp: Date.now() / 1000,
      cpu: {
        name: "AMD Ryzen 7 7700",
        status: "missing",
        temperatures: {
          tctl: { value: null },
          tccd1: { value: null },
        },
      },
      gpus: [],
    });
  }
  return;
}

// GET /temps/history?seconds=
if (
  req.method === "GET" &&
  parts[0] === "temps" &&
  parts[1] === "history" &&
  parts.length === 2
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const seconds = Number(url.searchParams.get("seconds"));
  if (!Number.isFinite(seconds)) {
    sendJson(res, 400, { error: "invalid_range" });
    return;
  }
  const config = loadUserConfig();
  const result = await fetchTempHistory({
    config: config.power,
    seconds,
  });
  if (result.ok) {
    sendJson(res, 200, {
      source: "prometheus",
      connected: true,
      url: result.config.prometheus_url,
      seconds: result.seconds,
      step: result.step,
      samples: result.samples,
    });
  } else {
    sendJson(res, 200, {
      source: "prometheus",
      connected: false,
      url: result.config.prometheus_url,
      error: result.error,
      seconds: result.seconds,
      step: result.step,
      samples: [],
    });
  }
  return;
}
```

(Adjust `TempHistoryResult` so `seconds`/`step` exist on both ok and fail branches.)

- [ ] **Step 2: Vite proxy**

In `apps/web/vite.config.ts` `server.proxy`, add:

```ts
"/temps": apiTarget,
```

- [ ] **Step 3: Smoke against live Prometheus** (manual)

Run engine (`pnpm --filter engine start` or `pnpm dev`), then:

```bash
curl -sS 'http://127.0.0.1:7789/temps' | head -c 800
curl -sS 'http://127.0.0.1:7789/temps/history?seconds=300' | head -c 400
```

Expected: `connected: true` and two GPUs when host is up.

---

### Task 3: Web API client + navigation + Hardware shell

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/session-navigation.ts`
- Create: `apps/web/src/HardwarePage.tsx`
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/session-navigation.test.ts` (or extend existing nav test if present)

**Interfaces:**
- Consumes: `/temps`, `/temps/history`
- Produces: `getTemps()`, `getTempsHistory(seconds)`, view `"hardware"`, tab `"temps" | "power"`

- [ ] **Step 1: Add DTO + client** to `api.ts`

```ts
export type TempSensorReading = {
  value: number | null;
  limit?: number;
};

export type TempGpuDto = {
  id: number;
  card: string;
  name: string;
  status: "normal" | "warm" | "over" | "missing";
  temperatures: {
    edge: TempSensorReading;
    junction: TempSensorReading;
    memory: TempSensorReading;
  };
  fan_rpm: number | null;
  power_w: number | null;
  power_cap_w: number | null;
  utilization: number | null;
  vram_used_gib: number | null;
  vram_total_gib: number | null;
};

export type TempCpuDto = {
  name: string;
  status: "available" | "partial" | "missing";
  temperatures: {
    tctl: { value: number | null };
    tccd1: { value: number | null };
  };
};

export type TempSampleDto = {
  timestamp: number;
  cpu: TempCpuDto;
  gpus: TempGpuDto[];
};

export type TempsFeed = {
  source: "prometheus";
  connected: boolean;
  url?: string;
  error?: string;
} & TempSampleDto;

export type TempsHistoryFeed = {
  source: "prometheus";
  connected: boolean;
  url?: string;
  error?: string;
  seconds: number;
  step: number;
  samples: TempSampleDto[];
};

export async function getTemps(signal?: AbortSignal): Promise<TempsFeed> {
  return requestJson<TempsFeed>("/temps", { signal }, 12000);
}

export async function getTempsHistory(
  seconds: number,
  signal?: AbortSignal,
): Promise<TempsHistoryFeed> {
  const params = new URLSearchParams({ seconds: String(Math.round(seconds)) });
  return requestJson<TempsHistoryFeed>(
    `/temps/history?${params}`,
    { signal },
    20000,
  );
}
```

- [ ] **Step 2: Navigation**

Change `SessionNavigationView` to `"overview" | "sessions" | "hardware"`.

Add optional `hardwareTab: "temps" | "power"` on `SessionNavigation` (default `"temps"`).

Hash rules:
- `#hardware` / `#hardware/temps` → view hardware, tab temps
- `#hardware/power` → view hardware, tab power
- `#power` → view hardware, tab power (legacy)
- `writeSessionNavigation` / `pushSessionNavigation` write `#hardware/temps` or `#hardware/power`

Update `App.tsx` nav button label to「硬件」, `view === "hardware"`, title map includes 硬件.

- [ ] **Step 3: `HardwarePage.tsx`**

```tsx
import { HardwarePowerPage } from "./HardwarePowerPage";
import { SystemTemperaturePage } from "./SystemTemperaturePage";
import { SegmentedControl } from "./ui";

type Tab = "temps" | "power";

export function HardwarePage(props: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  now: number;
}) {
  return (
    <div className="hardware-page" data-testid="hardware-page">
      <div className="hardware-tabs">
        <SegmentedControl
          ariaLabel="硬件子页"
          value={props.tab}
          onChange={(id) => props.onTabChange(id as Tab)}
          options={[
            { id: "temps", label: "温度" },
            { id: "power", label: "用电" },
          ]}
        />
      </div>
      {props.tab === "temps" ? (
        <SystemTemperaturePage now={props.now} />
      ) : (
        <HardwarePowerPage now={props.now} />
      )}
    </div>
  );
}
```

Wire `App.tsx` to pass `hardwareTab` and update hash on tab change. Stub `SystemTemperaturePage` temporarily as empty main if Task 4 not done yet — prefer implementing Task 4 immediately after so the shell compiles.

- [ ] **Step 4: Run web unit tests for navigation**

Add/adjust a small test that `readSessionNavigation` maps `#power` → hardware/power.

Run: `pnpm --filter web test`
Expected: PASS for nav tests

---

### Task 4: System temperature page

**Files:**
- Create: `apps/web/src/hardware-temps.ts`
- Create: `apps/web/src/hardware-temps.test.ts`
- Create: `apps/web/src/SystemTemperaturePage.tsx`
- Modify: `apps/web/src/styles.css` — add `.temps-*` layout (gpu grid, cards, meters, charts)

**Interfaces:**
- Consumes: `getTemps`, `getTempsHistory`, `TempSampleDto`
- Produces: live UI matching spec layout

- [ ] **Step 1: Helpers + tests** in `hardware-temps.ts`

```ts
export const TEMP_PERIODS = [
  { id: 300, label: "最近 5 分钟" },
  { id: 600, label: "最近 10 分钟" },
  { id: 1800, label: "最近 30 分钟" },
  { id: 3600, label: "最近 60 分钟" },
] as const;

export function formatTemp(value: number | null, digits = 0): string {
  return value != null && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function meterPercent(value: number | null, limit: number): number {
  if (value == null || !Number.isFinite(value) || limit <= 0) return 0;
  return Math.min(100, Math.max(0, (value / limit) * 100));
}

export function filterSamplesByWindow<T extends { timestamp: number }>(
  samples: T[],
  nowSec: number,
  windowSec: number,
): T[] {
  const start = nowSec - windowSec;
  return samples.filter((s) => s.timestamp >= start && s.timestamp <= nowSec);
}

export function isStale(sampleTimestampSec: number, nowMs: number): boolean {
  return nowMs / 1000 - sampleTimestampSec > 8;
}
```

- [ ] **Step 2: Implement `SystemTemperaturePage`**

Behavior:
- On mount: `getTempsHistory(3600)` once; start 2s `getTemps` poll; append each connected sample into local history (dedupe by timestamp); stop on unmount.
- Header, guard strip, 2 GPU cards, CPU card, history section with `<select>` for period.
- Charts: three `<canvas>` elements; draw polyline series like power page / STRATA (Y 0–110°C). Colors: CSS vars `--chart-blue`, `--chart-orange`, `--chart-violet` (mapped in theme task).
- Disconnected: banner + stale pill; keep last sample on screen.

- [ ] **Step 3: CSS** for `.temps-page`, `.temps-gpu-grid`, `.temps-gpu-card`, `.temps-cpu-card`, `.temps-guard`, `.temps-meter`, `.temps-chart-grid`, status pills — match STRATA spacing (rounded 12–14px cards, generous padding).

- [ ] **Step 4: Manual check** in browser at `#hardware/temps` with Prometheus up.

---

### Task 5: Global light theme remap

**Files:**
- Modify: `apps/web/src/styles.css` `:root` block (lines ~8–63)
- Modify: `tokens.css` if accent-ink needs light adjustment (`--color-accent-ink` should be white/surface, not dark bg)
- Modify: `DESIGN.md` colors section

**Interfaces:** none (visual only)

- [ ] **Step 1: Remap `:root` variables** to spec palette:

```css
:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --bg-raised: #ffffff;
  --bg-inset: #eef1f5;
  --border: #e5e9ef;
  --border-hot: #c5ccd6;
  --control-border: #c5ccd6;
  --text: #19212d;
  --text-muted: #626d7c;
  --text-dim: #7a8494;
  --accent: #1c7564;
  --accent-dim: #e9f4ef;
  --accent-hover: #155e50;
  --warn: #955d00;
  --danger: #bd3744;
  --danger-bg: #fdecee;
  --danger-border: #e7a0a6;
  --warn-bg: #fff4dd;
  --warn-border: #e6c27a;
  --chart-blue: #3b7ad0;
  --chart-violet: #8b63be;
  --chart-orange: #be6d21;
  /* retune remaining chart-* to readable on light */
  --shadow: 0 5px 24px rgba(23, 43, 70, 0.06);
  --scrollbar-thumb: #c5ccd6;
  --scrollbar-track: #f6f7f9;
  --scrollbar-hover: #9aa3b0;
  --scrollbar-active: #626d7c;
  /* overlays: replace dark rgba greens with light mint/selection */
  --surface-overlay: rgba(255, 255, 255, 0.72);
  --accent-overlay: rgba(28, 117, 100, 0.06);
  --accent-selection-ring: rgba(28, 117, 100, 0.22);
  --selected-overlay: rgba(28, 117, 100, 0.08);
}
```

- [ ] **Step 2: Update `DESIGN.md` frontmatter colors** to match.

- [ ] **Step 3: Fix `--color-accent-ink`** in `tokens.css` to `#ffffff` (or a dedicated `--accent-ink`) so primary buttons keep readable text on mint.

- [ ] **Step 4: Contrast pass** — search `styles.css` for hard-coded `#070`, `#0a0`, `rgba(0, 0, 0, 0.28)`, dark greens; adjust only spots that fail readability on light bg (nav, ledger strip, notices). Do not rewrite component structure.

- [ ] **Step 5: Run** `pnpm --filter web test` and `pnpm --filter engine test`; fix broken color assertions if any.

---

### Task 6: Verification

- [ ] **Step 1:** `pnpm --filter engine test` — PASS including `temps.test.ts`
- [ ] **Step 2:** `pnpm --filter web test` — PASS
- [ ] **Step 3:** With `pnpm dev` + Prometheus reachable:
  - `#hardware/temps` shows two GPUs + CPU updating
  - Charts populate after history load
  - `#hardware/power` still works
  - `#power` lands on 用电
  - Overview/sessions readable on light theme
- [ ] **Step 4:** Stop Prometheus or bad URL → temperature page shows 连接中断, no fake numbers

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Prometheus source, no :60572 | 1–2 |
| `GET /temps` + history shape | 1–2 |
| XTX filter, limits, status | 1 |
| Hardware shell 温度/用电 + hashes | 3 |
| Temperature page layout + charts | 4 |
| Light theme full-site | 5 |
| No fake temps | 1, 4, 6 |
| Tests | 1, 3, 6 |

## Self-review notes

- History response format locked to timestamp-aligned `samples[]` (spec).
- Old generic `fetchTemps` in `power.ts` left in place unused by new routes to avoid a large unrelated rewrite; new `temps.ts` is the source of truth for the page.
- Commit steps omitted per user git rule.
