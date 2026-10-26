import { describe, expect, it } from "vitest";
import {
  DEFAULT_POWER_CONFIG,
  fetchPowerRange,
  mergePowerConfig,
  type FetchLike,
  type RangeResponse,
} from "../src/power.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 22, 0, 0);

function jsonResponse(body: RangeResponse): {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
} {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function matrix(values: [number, string][]): RangeResponse {
  return {
    status: "success",
    data: { resultType: "matrix", result: [{ metric: {}, values }] },
  };
}

/** 依 key 返回不同 fixture；断言查询里带了编码后的 PromQL。 */
function fetchWith(
  responses: Record<string, RangeResponse | { error: string }>,
): { impl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const impl: FetchLike = async (url) => {
    urls.push(url);
    for (const [fragment, response] of Object.entries(responses)) {
      if (!url.includes(encodeURIComponent(fragment).slice(0, 12))) continue;
      if ("error" in response) throw new TypeError("fetch failed");
      return jsonResponse(response);
    }
    throw new TypeError(`unexpected url ${url}`);
  };
  return { impl, urls };
}

describe("fetchPowerRange", () => {
  it("aligns three query_range responses onto union timestamps in watts", async () => {
    const s0 = T0 / 1000;
    const { impl } = fetchWith({
      // 默认表达式已在 PromQL 内完成毫瓦→瓦换算，这里直接回瓦。
      "node_rapl_package_milliwatts": matrix([
        [s0, "12.5"],
        [s0 + 60, "18.75"],
      ]),
      "DCGM_FI_DEV_POWER_USAGE": matrix([
        [s0, "42"],
        [s0 + 60, "NaN"],
      ]),
      "node_hwmon_power_watts": matrix([[s0, "215.4"]]),
    });
    const result = await fetchPowerRange({
      startMs: T0,
      endMs: T0 + 2 * MINUTE,
      stepMs: MINUTE,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.samples).toEqual([
      { t: T0, cpu: 12.5, gpu: 42, machine: 215.4 },
      // RAPL 毫瓦 → 瓦；DCGM 的 "NaN" 与缺失点一样保持 null。
      { t: T0 + MINUTE, cpu: 18.75, gpu: null, machine: null },
    ]);
  });

  it("keeps the maximum when one query returns multiple series", async () => {
    const dual: RangeResponse = {
      status: "success",
      data: {
        resultType: "matrix",
        result: [
          { metric: { package: "0" }, values: [[0, "10"]] },
          { metric: { package: "1" }, values: [[0, "30"]] },
        ],
      },
    };
    const { impl } = fetchWith({
      "node_rapl": dual,
      "DCGM": matrix([[0, "5"]]),
      "node_hwmon": matrix([[0, "60"]]),
    });
    const result = await fetchPowerRange({
      startMs: T0,
      endMs: T0 + MINUTE,
      stepMs: MINUTE,
      fetchImpl: impl,
    });
    expect(result.ok && result.samples[0]?.cpu).toBe(30);
  });

  it("rejects invalid ranges before any network call", async () => {
    const calls: string[] = [];
    const impl: FetchLike = async (url) => {
      calls.push(url);
      return jsonResponse(matrix([]));
    };
    const bad = await fetchPowerRange({
      startMs: T0,
      endMs: T0,
      stepMs: MINUTE,
      fetchImpl: impl,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("invalid_range");
    expect(calls).toHaveLength(0);
  });

  it("reports unreachable prometheus instead of throwing", async () => {
    const { impl } = fetchWith({ "node_rapl": { error: "fetch failed" } });
    const result = await fetchPowerRange({
      startMs: T0,
      endMs: T0 + MINUTE,
      stepMs: MINUTE,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("prometheus_unreachable");
  });

  it("reports non-success responses with the http status", async () => {
    const impl: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const result = await fetchPowerRange({
      startMs: T0,
      endMs: T0 + MINUTE,
      stepMs: MINUTE,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("prometheus_http_503");
  });
});

describe("mergePowerConfig", () => {
  it("returns defaults without a power block", () => {
    expect(mergePowerConfig(undefined)).toEqual(DEFAULT_POWER_CONFIG);
    expect(mergePowerConfig("nope")).toEqual(DEFAULT_POWER_CONFIG);
  });

  it("accepts a valid url and per-series query overrides only", () => {
    const merged = mergePowerConfig({
      prometheus_url: "http://10.0.0.5:9090/",
      queries: { gpu: "max(custom_gpu_watts)", cpu: 7 },
    });
    expect(merged.prometheus_url).toBe("http://10.0.0.5:9090/");
    expect(merged.queries.gpu).toBe("max(custom_gpu_watts)");
    expect(merged.queries.cpu).toBe(DEFAULT_POWER_CONFIG.queries.cpu);
    expect(merged.queries.machine).toBe(DEFAULT_POWER_CONFIG.queries.machine);
  });

  it("ignores non-http urls", () => {
    expect(mergePowerConfig({ prometheus_url: "file:///etc" }).prometheus_url)
      .toBe(DEFAULT_POWER_CONFIG.prometheus_url);
  });
});
