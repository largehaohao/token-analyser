/**
 * 系统温度页的纯函数。只格式化、筛选和合并已有采样，不生成演示温度。
 */

export const TEMP_PERIODS = [
  { id: 300, label: "最近 5 分钟" },
  { id: 600, label: "最近 10 分钟" },
  { id: 1800, label: "最近 30 分钟" },
  { id: 3600, label: "最近 60 分钟" },
] as const;

export type TempPeriodId = (typeof TEMP_PERIODS)[number]["id"];

/** 与引擎关机线一致，仅用于刻度和保护条文案，不是温度读数。 */
export const TEMP_DISPLAY_LIMITS = { edge: 85, junction: 100, memory: 96 } as const;

export const WARM_MARGIN_C = 8;

export type TempReadingTone = "normal" | "warm" | "over" | "missing";

export function formatTemp(value: number | null, digits = 0): string {
  return value != null && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function formatSampleTime(timestampSec: number): string {
  const date = new Date(timestampSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

/** 上次成功采样距现在超过 8 秒视为过期。时间戳单位是秒。 */
export function isStale(sampleTimestampSec: number, nowMs: number): boolean {
  return nowMs / 1000 - sampleTimestampSec > 8;
}

export function readingTone(value: number | null, limit: number): TempReadingTone {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(limit)) return "missing";
  if (value > limit) return "over";
  if (limit - value <= WARM_MARGIN_C) return "warm";
  return "normal";
}

export function worstGpuStatus(
  statuses: Array<TempReadingTone | null | undefined>,
): TempReadingTone {
  if (statuses.some((status) => status === "over")) return "over";
  if (statuses.some((status) => status === "warm")) return "warm";
  if (statuses.length === 0 || statuses.some((status) => status == null || status === "missing")) {
    return "missing";
  }
  return "normal";
}

/** 后来的样本覆盖同一时间戳；结果按时间升序。incoming 为空时保留原数组。 */
export function mergeTempSamples<T extends { timestamp: number }>(base: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return base;
  const byTimestamp = new Map<number, T>();
  for (const sample of base) byTimestamp.set(sample.timestamp, sample);
  for (const sample of incoming) byTimestamp.set(sample.timestamp, sample);
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function readSeries<T extends { timestamp: number }>(
  samples: T[],
  read: (sample: T) => number | null,
): { t: number; v: number | null }[] {
  return samples.map((sample) => {
    const value = read(sample);
    return {
      t: sample.timestamp,
      v: value != null && Number.isFinite(value) ? value : null,
    };
  });
}
