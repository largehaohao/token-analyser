export type RateLimitGauge = {
  id: string;
  group: string | null;
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function windowMinutesOf(rec: Record<string, unknown>): number | null {
  const minutes =
    num(rec.window_duration_mins) ??
    num(rec.window_minutes) ??
    num(rec.windowMinutes);
  if (minutes != null) return minutes;
  const seconds = num(rec.window_seconds) ?? num(rec.windowSeconds);
  return seconds != null ? seconds / 60 : null;
}

export function parseRateLimits(raw: unknown): RateLimitGauge[] {
  const gauges: RateLimitGauge[] = [];

  function walk(value: unknown, path: string[]): void {
    const rec = asRecord(value);
    if (!rec) return;

    const usedPercent =
      num(rec.used_percent) ?? num(rec.usedPercent) ?? num(rec.percent_used);
    if (usedPercent != null) {
      gauges.push({
        id: path.join(".") || "limit",
        group: path.length > 1 ? path.slice(0, -1).join(" · ") : null,
        label: path[path.length - 1] ?? "limit",
        usedPercent,
        windowMinutes: windowMinutesOf(rec),
        resetsAt: num(rec.resets_at) ?? num(rec.resetsAt),
      });
      return;
    }

    for (const [key, child] of Object.entries(rec)) {
      walk(child, [...path, key]);
    }
  }

  walk(raw, []);
  return gauges;
}

export function formatResetAt(resetsAt: number, nowMs = Date.now()): string {
  const ms = resetsAt > 0 && resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  if (!Number.isFinite(ms)) return "";
  const deltaSec = Math.round((ms - nowMs) / 1000);
  if (Math.abs(deltaSec) < 90) return `${deltaSec}s`;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function formatWindow(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

export function resetTimestampMs(resetsAt: number): number | null {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

export function resetIso(resetsAt: number): string | null {
  const ms = resetTimestampMs(resetsAt);
  if (ms == null) return null;
  return new Date(ms).toISOString();
}
