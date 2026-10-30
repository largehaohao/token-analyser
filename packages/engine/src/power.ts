/**
 * 硬件用电 · Prometheus 采集（后端）。
 *
 * 目标采集主机默认是 192.168.1.102（Prometheus HTTP API）。主机离线或
 * 指标缺失时返回 ok:false 与原因，路由据此返回 connected:false，前端回退
 * 到演示数据，不伪造读数。查询表达式与地址都可用 ~/.token-analyser/config.json
 * 的 `power` 块覆盖。
 */

export type PowerSample = {
  t: number;
  cpu: number | null;
  gpu: number | null;
  machine: number | null;
};

export type PowerQueryConfig = {
  prometheus_url: string;
  queries: { cpu: string; gpu: string; machine: string };
};

/** 常见导出器的默认表达式；写错指标名只会得到空序列，不会崩。 */
export const DEFAULT_POWER_CONFIG: PowerQueryConfig = {
  prometheus_url: "http://192.168.1.102:9090",
  queries: {
    cpu: "max by () (node_rapl_package_milliwatts) / 1000",
    gpu: "max by () (DCGM_FI_DEV_POWER_USAGE)",
    machine: "max by () (node_hwmon_power_watts)",
  },
};

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PowerFetchResult =
  | { ok: true; config: PowerQueryConfig; samples: PowerSample[] }
  | { ok: false; config: PowerQueryConfig; error: string };

type RangeValue = [number, string];
type RangeSeries = { metric?: Record<string, string>; values?: RangeValue[] };
export type RangeResponse = {
  status?: string;
  data?: { resultType?: string; result?: RangeSeries[] };
};

function parseValue(raw: string): number | null {
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 把 query_range 的 matrix 响应收敛成「时间 → 瓦特」映射：同一时刻存在
 * 多条序列（多路 RAPL/多块 GPU）时取最大值，与默认查询里的 max 语义一致。
 */
function seriesToMap(series: RangeSeries[] | undefined): Map<number, number> {
  const map = new Map<number, number>();
  for (const entry of series ?? []) {
    for (const [tsSec, raw] of entry.values ?? []) {
      const v = parseValue(raw);
      if (v == null) continue;
      const prev = map.get(tsSec);
      if (prev == null || v > prev) map.set(tsSec, v);
    }
  }
  return map;
}

export async function fetchPowerRange(options: {
  config?: PowerQueryConfig;
  startMs: number;
  endMs: number;
  stepMs: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<PowerFetchResult> {
  const config = options.config ?? DEFAULT_POWER_CONFIG;
  const base = {
    ok: false as const,
    config,
    error: "",
  };
  if (!Number.isFinite(options.startMs) || !Number.isFinite(options.endMs) ||
      options.endMs <= options.startMs || !(options.stepMs > 0))
    return { ...base, error: "invalid_range" };

  const doFetch = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 8000;
  const stepSec = Math.max(1, Math.round(options.stepMs / 1000));

  // 三个查询并行：总耗时 = 最慢单个查询，而非三者之和。engine 进程的
  // 事件循环可能被会话解析短暂占满，超时需给足余量。
  type Part = { ok: true; map: Map<number, number> } | { ok: false; error: string };
  const keys = ["cpu", "gpu", "machine"] as const;
  const parts: Part[] = await Promise.all(
    keys.map(async (key) => {
      const url =
        `${config.prometheus_url.replace(/\/+$/, "")}/api/v1/query_range` +
        `?query=${encodeURIComponent(config.queries[key])}` +
        `&start=${Math.floor(options.startMs / 1000)}` +
        `&end=${Math.floor(options.endMs / 1000)}` +
        `&step=${stepSec}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, { signal: controller.signal });
        if (!res.ok)
          return { ok: false, error: `prometheus_http_${res.status}` };
        const body = (await res.json()) as RangeResponse;
        if (body.status !== "success" || body.data?.resultType !== "matrix")
          return { ok: false, error: "prometheus_unexpected_response" };
        return { ok: true, map: seriesToMap(body.data.result) };
      } catch (err) {
        const reason =
          err instanceof Error && err.name === "AbortError"
            ? "prometheus_timeout"
            : "prometheus_unreachable";
        return { ok: false, error: reason };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const maps: Record<"cpu" | "gpu" | "machine", Map<number, number>> = {
    cpu: new Map(),
    gpu: new Map(),
    machine: new Map(),
  };
  let successCount = 0;
  let firstError: string | null = null;
  keys.forEach((key, index) => {
    const part = parts[index]!;
    if (part.ok) {
      maps[key] = part.map;
      successCount += 1;
    } else if (firstError == null) {
      firstError = part.error;
    }
  });
  // 允许部分序列失败（例如 GPU 导出器未装）：成功的序列照常返回，
  // 失败序列保持 null。仅当三个查询全部失败时才判采集不可达。
  if (successCount === 0)
    return { ...base, error: firstError ?? "prometheus_unreachable" };

  // 三个查询的时间网格取并集；某序列在该时刻没有点则保持缺失（null）。
  const times = new Set<number>();
  for (const map of Object.values(maps)) for (const ts of map.keys()) times.add(ts);
  const samples: PowerSample[] = [...times].sort((a, b) => a - b).map((tsSec) => ({
    t: tsSec * 1000,
    cpu: maps.cpu.get(tsSec) ?? null,
    gpu: maps.gpu.get(tsSec) ?? null,
    machine: maps.machine.get(tsSec) ?? null,
  }));
  return { ok: true, config, samples };
}

/** config.json 的 `power` 块 → 合并默认值；只接受完全有效的字符串字段。 */
export function mergePowerConfig(
  raw: unknown,
  defaults: PowerQueryConfig = DEFAULT_POWER_CONFIG,
): PowerQueryConfig {
  if (raw == null || typeof raw !== "object") return defaults;
  const record = raw as Record<string, unknown>;
  const url =
    typeof record.prometheus_url === "string" &&
    /^https?:\/\//.test(record.prometheus_url)
      ? record.prometheus_url
      : defaults.prometheus_url;
  const queries = { ...defaults.queries };
  const rawQueries =
    record.queries != null && typeof record.queries === "object"
      ? (record.queries as Record<string, unknown>)
      : {};
  for (const key of ["cpu", "gpu", "machine"] as const) {
    if (typeof rawQueries[key] === "string" && (rawQueries[key] as string).length > 0)
      queries[key] = rawQueries[key] as string;
  }
  return { prometheus_url: url, queries };
}
