/**
 * 硬件温度 · Prometheus 采集（RX 7900 XTX + Ryzen hwmon）。
 */

import {
  DEFAULT_POWER_CONFIG,
  type FetchLike,
  type PowerQueryConfig,
  type RangeResponse,
} from "./power.ts";

export type { FetchLike };

export const TEMP_LIMITS = { edge: 85, junction: 100, memory: 96 } as const;

const GPU_NAME = "AMD Radeon RX 7900 XTX";
const CPU_NAME = "AMD Ryzen 7 7700";

const PROM_QUERIES = {
  gpuTemp: `amdgpu_temperature_celsius{name="${GPU_NAME}"}`,
  fan: `amdgpu_fan_rpm{name="${GPU_NAME}"}`,
  power: `amdgpu_gfx_power_watts{name="${GPU_NAME}"}`,
  busy: `amdgpu_gpu_busy_percent{name="${GPU_NAME}"}`,
  vramUsed: `amdgpu_vram_used_bytes{name="${GPU_NAME}"}`,
  vramTotal: `amdgpu_vram_total_bytes{name="${GPU_NAME}"}`,
  powerCap: `amdgpu_power_cap_watts{name="${GPU_NAME}"}`,
  cpuTemp: 'node_hwmon_temp_celsius{chip="pci0000:00_0000:00:18_3"}',
} as const;

type RangeValue = [number, string];
type RangeSeries = { metric?: Record<string, string>; values?: RangeValue[] };

export type TempReading = { value: number | null; limit?: number };

export type TempGpuTemps = {
  edge: TempReading;
  junction: TempReading;
  memory: TempReading;
};

export type TempGpu = {
  id: number;
  card: string;
  name: string;
  status: "normal" | "warm" | "over" | "missing";
  temperatures: TempGpuTemps;
  fan_rpm: number | null;
  power_w: number | null;
  power_cap_w: number | null;
  utilization: number | null;
  vram_used_gib: number | null;
  vram_total_gib: number | null;
};

export type TempCpu = {
  name: string;
  status: "available" | "missing";
  temperatures: {
    tctl: { value: number | null };
    tccd1: { value: number | null };
  };
};

export type TempSample = {
  timestamp: number;
  cpu: TempCpu;
  gpus: TempGpu[];
};

export type TempSnapshotResult =
  | { ok: true; config: PowerQueryConfig; sample: TempSample }
  | { ok: false; config: PowerQueryConfig; error: string };

export type TempHistoryResult =
  | {
      ok: true;
      config: PowerQueryConfig;
      seconds: number;
      step: number;
      samples: TempSample[];
    }
  | {
      ok: false;
      config: PowerQueryConfig;
      error: string;
      seconds: number;
      step: number;
    };

type GpuStatusInput = {
  edge: { value: number | null; limit: number };
  junction: { value: number | null; limit: number };
  memory: { value: number | null; limit: number };
};

const WARM_MARGIN_C = 8;
const SNAPSHOT_WINDOW_SEC = 90;

function parseNumber(raw: string): number | null {
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function roundOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}

function bytesToGib(bytes: number): number {
  return roundOneDecimal(bytes / 2 ** 30);
}

export function gpuStatus(temps: GpuStatusInput): TempGpu["status"] {
  const sensors = [temps.edge, temps.junction, temps.memory] as const;
  if (sensors.some((s) => s.value == null)) return "missing";
  for (const s of sensors) {
    const value = s.value!;
    if (value > s.limit) return "over";
  }
  for (const s of sensors) {
    const value = s.value!;
    if (s.limit - value <= WARM_MARGIN_C) return "warm";
  }
  return "normal";
}

function seriesByCard(
  series: RangeSeries[] | undefined,
  opts?: { requireSensor?: boolean },
): Map<string, RangeSeries[]> {
  const map = new Map<string, RangeSeries[]>();
  for (const entry of series ?? []) {
    const metric = entry.metric ?? {};
    if (metric.name !== GPU_NAME) continue;
    const card = metric.card;
    if (!card) continue;
    if (opts?.requireSensor && !metric.sensor) continue;
    const list = map.get(card) ?? [];
    list.push(entry);
    map.set(card, list);
  }
  return map;
}

function valueAtLastTs(entry: RangeSeries): number | null {
  const values = entry.values ?? [];
  if (values.length === 0) return null;
  return parseNumber(values[values.length - 1]![1]);
}

function scalarByCard(series: RangeSeries[] | undefined): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const [card, entries] of seriesByCard(series)) {
    let v: number | null = null;
    for (const entry of entries) {
      const parsed = valueAtLastTs(entry);
      if (parsed != null) v = parsed;
    }
    map.set(card, v);
  }
  return map;
}

function tempByCardAndSensor(
  series: RangeSeries[] | undefined,
): Map<string, Map<string, number | null>> {
  const map = new Map<string, Map<string, number | null>>();
  for (const entry of series ?? []) {
    const metric = entry.metric ?? {};
    if (metric.name !== GPU_NAME) continue;
    const card = metric.card;
    const sensor = metric.sensor;
    if (!card || !sensor) continue;
    const v = valueAtLastTs(entry);
    let sensors = map.get(card);
    if (!sensors) {
      sensors = new Map();
      map.set(card, sensors);
    }
    sensors.set(sensor, v);
  }
  return map;
}

function cpuTempsAtLast(series: RangeSeries[] | undefined): {
  tctl: number | null;
  tccd1: number | null;
} {
  let tctl: number | null = null;
  let tccd1: number | null = null;
  for (const entry of series ?? []) {
    const sensor = entry.metric?.sensor;
    const v = valueAtLastTs(entry);
    if (sensor === "temp1") tctl = v;
    if (sensor === "temp3") tccd1 = v != null ? roundOneDecimal(v) : null;
  }
  return { tctl, tccd1 };
}

function buildGpuTemps(sensors: Map<string, number | null> | undefined): TempGpuTemps {
  const edgeVal = sensors?.get("edge") ?? null;
  const junctionVal = sensors?.get("junction") ?? null;
  const memoryVal = sensors?.get("memory") ?? null;
  return {
    edge: { value: edgeVal, limit: TEMP_LIMITS.edge },
    junction: { value: junctionVal, limit: TEMP_LIMITS.junction },
    memory: { value: memoryVal, limit: TEMP_LIMITS.memory },
  };
}

function buildGpusFromMaps(options: {
  tempMap: Map<string, Map<string, number | null>>;
  fan: Map<string, number | null>;
  power: Map<string, number | null>;
  busy: Map<string, number | null>;
  vramUsed: Map<string, number | null>;
  vramTotal: Map<string, number | null>;
  powerCap: Map<string, number | null>;
}): TempGpu[] {
  const cards = [...options.tempMap.keys()].sort();
  return cards.map((card, id) => {
    const temperatures = buildGpuTemps(options.tempMap.get(card));
    const status = gpuStatus({
      edge: { value: temperatures.edge.value, limit: TEMP_LIMITS.edge },
      junction: { value: temperatures.junction.value, limit: TEMP_LIMITS.junction },
      memory: { value: temperatures.memory.value, limit: TEMP_LIMITS.memory },
    });
    const usedBytes = options.vramUsed.get(card);
    const totalBytes = options.vramTotal.get(card);
    return {
      id,
      card,
      name: GPU_NAME,
      status,
      temperatures,
      fan_rpm: options.fan.get(card) ?? null,
      power_w: options.power.get(card) ?? null,
      power_cap_w: options.powerCap.get(card) ?? null,
      utilization: options.busy.get(card) ?? null,
      vram_used_gib: usedBytes != null ? bytesToGib(usedBytes) : null,
      vram_total_gib: totalBytes != null ? bytesToGib(totalBytes) : null,
    };
  });
}

function buildCpu(cpuSeries: RangeSeries[] | undefined): TempCpu {
  const { tctl, tccd1 } = cpuTempsAtLast(cpuSeries);
  const hasAny = tctl != null || tccd1 != null;
  return {
    name: CPU_NAME,
    status: hasAny ? "available" : "missing",
    temperatures: { tctl: { value: tctl }, tccd1: { value: tccd1 } },
  };
}

type QueryPart =
  | { ok: true; key: keyof typeof PROM_QUERIES; series: RangeSeries[] }
  | { ok: false; key: keyof typeof PROM_QUERIES; error: string };

async function queryRange(options: {
  config: PowerQueryConfig;
  query: string;
  startSec: number;
  endSec: number;
  stepSec: number;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<QueryPart & { query: string }> {
  const key = (Object.entries(PROM_QUERIES).find(([, q]) => q === options.query)?.[0] ??
    "gpuTemp") as keyof typeof PROM_QUERIES;
  const url =
    `${options.config.prometheus_url.replace(/\/+$/, "")}/api/v1/query_range` +
    `?query=${encodeURIComponent(options.query)}` +
    `&start=${options.startSec}` +
    `&end=${options.endSec}` +
    `&step=${options.stepSec}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await options.fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, key, error: `prometheus_http_${res.status}`, query: options.query };
    const body = (await res.json()) as RangeResponse;
    if (body.status !== "success" || body.data?.resultType !== "matrix")
      return { ok: false, key, error: "prometheus_unexpected_response", query: options.query };
    return { ok: true, key, series: body.data.result ?? [], query: options.query };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "prometheus_timeout"
        : "prometheus_unreachable";
    return { ok: false, key, error: reason, query: options.query };
  } finally {
    clearTimeout(timer);
  }
}

function resolveConfig(config?: PowerQueryConfig): PowerQueryConfig {
  return config ?? DEFAULT_POWER_CONFIG;
}

function sampleTimestampSec(parts: Map<keyof typeof PROM_QUERIES, RangeSeries[]>): number {
  let ts = 0;
  for (const series of parts.values()) {
    for (const entry of series) {
      for (const [t] of entry.values ?? []) ts = Math.max(ts, t);
    }
  }
  return ts;
}

function aggregateSnapshot(parts: Map<keyof typeof PROM_QUERIES, RangeSeries[]>): TempSample {
  const tempMap = tempByCardAndSensor(parts.get("gpuTemp"));
  const gpus = buildGpusFromMaps({
    tempMap,
    fan: scalarByCard(parts.get("fan")),
    power: scalarByCard(parts.get("power")),
    busy: scalarByCard(parts.get("busy")),
    vramUsed: scalarByCard(parts.get("vramUsed")),
    vramTotal: scalarByCard(parts.get("vramTotal")),
    powerCap: scalarByCard(parts.get("powerCap")),
  });
  const ts = sampleTimestampSec(parts);
  return {
    timestamp: ts,
    cpu: buildCpu(parts.get("cpuTemp")),
    gpus,
  };
}

function allTimestamps(parts: Map<keyof typeof PROM_QUERIES, RangeSeries[]>): number[] {
  const set = new Set<number>();
  for (const series of parts.values()) {
    for (const entry of series) {
      for (const [t] of entry.values ?? []) set.add(t);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function valueAtTs(entry: RangeSeries, ts: number): number | null {
  for (const [t, raw] of entry.values ?? []) {
    if (t === ts) return parseNumber(raw);
  }
  return null;
}

function tempMapAtTs(gpuTemp: RangeSeries[] | undefined, ts: number): Map<string, Map<string, number | null>> {
  const map = new Map<string, Map<string, number | null>>();
  for (const entry of gpuTemp ?? []) {
    const metric = entry.metric ?? {};
    if (metric.name !== GPU_NAME) continue;
    const card = metric.card;
    const sensor = metric.sensor;
    if (!card || !sensor) continue;
    let sensors = map.get(card);
    if (!sensors) {
      sensors = new Map();
      map.set(card, sensors);
    }
    sensors.set(sensor, valueAtTs(entry, ts));
  }
  return map;
}

function scalarByCardAtTs(series: RangeSeries[] | undefined, ts: number): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const entry of series ?? []) {
    const metric = entry.metric ?? {};
    if (metric.name !== GPU_NAME) continue;
    const card = metric.card;
    if (!card) continue;
    const v = valueAtTs(entry, ts);
    if (v != null) map.set(card, v);
  }
  return map;
}

function cpuAtTs(series: RangeSeries[] | undefined, ts: number): TempCpu {
  let tctl: number | null = null;
  let tccd1: number | null = null;
  for (const entry of series ?? []) {
    const sensor = entry.metric?.sensor;
    const v = valueAtTs(entry, ts);
    if (sensor === "temp1") tctl = v;
    if (sensor === "temp3") tccd1 = v != null ? roundOneDecimal(v) : null;
  }
  const hasAny = tctl != null || tccd1 != null;
  return {
    name: CPU_NAME,
    status: hasAny ? "available" : "missing",
    temperatures: { tctl: { value: tctl }, tccd1: { value: tccd1 } },
  };
}

function aggregateAtTimestamp(
  ts: number,
  parts: Map<keyof typeof PROM_QUERIES, RangeSeries[]>,
): TempSample {
  const tempMap = tempMapAtTs(parts.get("gpuTemp"), ts);
  const gpus = buildGpusFromMaps({
    tempMap,
    fan: scalarByCardAtTs(parts.get("fan"), ts),
    power: scalarByCardAtTs(parts.get("power"), ts),
    busy: scalarByCardAtTs(parts.get("busy"), ts),
    vramUsed: scalarByCardAtTs(parts.get("vramUsed"), ts),
    vramTotal: scalarByCardAtTs(parts.get("vramTotal"), ts),
    powerCap: scalarByCardAtTs(parts.get("powerCap"), ts),
  });
  return { timestamp: ts, cpu: cpuAtTs(parts.get("cpuTemp"), ts), gpus };
}

async function fetchAllQueries(options: {
  config: PowerQueryConfig;
  startSec: number;
  endSec: number;
  stepSec: number;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<
  | { ok: true; parts: Map<keyof typeof PROM_QUERIES, RangeSeries[]> }
  | { ok: false; error: string }
> {
  const entries = Object.entries(PROM_QUERIES) as [keyof typeof PROM_QUERIES, string][];
  const results = await Promise.all(
    entries.map(([key, query]) =>
      queryRange({ ...options, query }).then((part) => ({ ...part, key })),
    ),
  );
  let successCount = 0;
  let firstError: string | null = null;
  const parts = new Map<keyof typeof PROM_QUERIES, RangeSeries[]>();
  for (const part of results) {
    if (part.ok) {
      successCount += 1;
      parts.set(part.key, part.series);
    } else if (firstError == null) {
      firstError = part.error;
    }
  }
  if (successCount === 0) return { ok: false, error: firstError ?? "prometheus_unreachable" };
  for (const [key] of entries) {
    if (!parts.has(key)) parts.set(key, []);
  }
  return { ok: true, parts };
}

export async function fetchTempSnapshot(options: {
  config?: PowerQueryConfig;
  fetchImpl?: FetchLike;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<TempSnapshotResult> {
  const config = resolveConfig(options.config);
  const nowMs = options.nowMs ?? Date.now();
  const endSec = Math.floor(nowMs / 1000);
  const startSec = endSec - SNAPSHOT_WINDOW_SEC;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 8000;

  const fetched = await fetchAllQueries({
    config,
    startSec,
    endSec,
    stepSec: 15,
    fetchImpl,
    timeoutMs,
  });
  if (!fetched.ok) return { ok: false, config, error: fetched.error };
  return { ok: true, config, sample: aggregateSnapshot(fetched.parts) };
}

export function clampHistorySeconds(seconds: number): number {
  return Math.max(60, Math.min(3600, Math.round(seconds)));
}

export function historyStepSec(seconds: number): number {
  return Math.max(2, Math.min(15, Math.round(seconds / 300)));
}

export async function fetchTempHistory(options: {
  config?: PowerQueryConfig;
  seconds: number;
  fetchImpl?: FetchLike;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<TempHistoryResult> {
  const config = resolveConfig(options.config);
  const seconds = clampHistorySeconds(options.seconds);
  const step = historyStepSec(seconds);
  const nowMs = options.nowMs ?? Date.now();
  const endSec = Math.floor(nowMs / 1000);
  const startSec = endSec - seconds;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 8000;

  const fetched = await fetchAllQueries({
    config,
    startSec,
    endSec,
    stepSec: step,
    fetchImpl,
    timeoutMs,
  });
  if (!fetched.ok) {
    return { ok: false, config, error: fetched.error, seconds, step };
  }

  const timestamps = allTimestamps(fetched.parts);
  const samples = timestamps.map((ts) => aggregateAtTimestamp(ts, fetched.parts));
  return { ok: true, config, seconds, step, samples };
}
