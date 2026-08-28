import type { Cost } from "./api";

export type CostUnit = "tokens" | "credits" | "usd";

export function costValue(cost: Cost, unit: CostUnit): number | null {
  if (unit === "tokens") return cost.raw;
  if (unit === "credits") return cost.credits;
  return cost.usd;
}

export function formatCost(cost: Cost, unit: CostUnit): string {
  const value = costValue(cost, unit);
  if (unit === "tokens") {
    return (value ?? 0).toLocaleString("en-US");
  }
  if (value == null) return "—";
  if (unit === "credits") {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatUnitSuffix(unit: CostUnit): string {
  if (unit === "tokens") return "tokens";
  if (unit === "credits") return "credits";
  return "USD";
}

export function formatPercent(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

/** Largest-remainder percents so displayed slices sum to 100. */
export function allocatePercents(values: number[], digits = 1): number[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total === 0) return values.map(() => 0);
  const factor = 10 ** digits;
  const target = 100 * factor;
  const scaled = values.map((value) => (target * Math.max(0, value)) / total);
  const floored = scaled.map((value) => Math.floor(value + 1e-9));
  let remainder = target - floored.reduce((sum, value) => sum + value, 0);
  const order = scaled
    .map((value, index) => ({ index, frac: value - floored[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  const out = floored.slice();
  for (let i = 0; remainder > 0 && order.length > 0; i += 1) {
    out[order[i % order.length].index] += 1;
    remainder -= 1;
  }
  return out.map((value) => value / factor);
}

export function wasteShare(
  waste: Cost,
  total: Cost,
  unit: CostUnit = "tokens",
): string {
  const totalValue = costValue(total, unit);
  const wasteValue = costValue(waste, unit);
  if (totalValue == null || wasteValue == null) {
    return unit === "tokens" ? "0%" : wasteShare(waste, total, "tokens");
  }
  if (totalValue === 0) return "0%";
  return formatPercent((100 * wasteValue) / totalValue);
}

export function cacheHitRatio(cost: Cost): number | null {
  const input = cost.uncached_input + cost.cached_input;
  if (input <= 0) return null;
  return cost.cached_input / input;
}

export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function formatExactTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatCreditsLabel(n: number | null): string {
  if (n == null) return "—";
  if (n !== 0 && Math.abs(n) < 1) return n.toFixed(2);
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

export function formatChartNumber(
  n: number,
  metric: "usd" | "tokens" | "credits",
): string {
  if (metric === "tokens") return formatCompactTokens(n);
  if (metric === "credits") return formatCreditsLabel(n);
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function formatRelativeTime(
  iso: string | null,
  nowMs = Date.now(),
): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const deltaSec = Math.round((nowMs - t) / 1000);
  const abs = Math.abs(deltaSec);
  const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (abs < 60) return rtf.format(-deltaSec, "second");
  if (abs < 3600) return rtf.format(-Math.round(deltaSec / 60), "minute");
  if (abs < 86_400) return rtf.format(-Math.round(deltaSec / 3600), "hour");
  if (abs < 30 * 86_400) return rtf.format(-Math.round(deltaSec / 86_400), "day");
  return formatAbsoluteTime(iso);
}

export function formatAbsoluteTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

export function disclaimer(rateCardAsOf: string): string {
  return `Local estimate from telemetry and the public rate card dated ${rateCardAsOf}. Not OpenAI's bill.`;
}
