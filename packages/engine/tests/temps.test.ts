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
      if (url.includes(encodeURIComponent("amdgpu_temperature_celsius"))) {
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
