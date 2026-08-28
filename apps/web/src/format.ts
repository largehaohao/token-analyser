import type { Cost } from "./api";

export type CostUnit = "tokens" | "credits" | "usd";

export function formatCost(cost: Cost, unit: CostUnit): string {
  if (unit === "tokens") {
    return cost.raw.toLocaleString("en-US");
  }
  if (unit === "credits") {
    if (cost.credits == null) return "—";
    return cost.credits.toFixed(1);
  }
  if (cost.usd == null) return "—";
  return `$${cost.usd.toFixed(2)}`;
}

export function wasteShare(waste: Cost, total: Cost): string {
  if (total.raw === 0) return "0%";
  return `${((100 * waste.raw) / total.raw).toFixed(1)}%`;
}

export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function formatCreditsLabel(n: number | null): string {
  if (n == null) return "—";
  if (n !== 0 && Math.abs(n) < 1) return n.toFixed(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function formatChartNumber(n: number, metric: "usd" | "tokens" | "credits"): string {
  if (metric === "tokens") return formatCompactTokens(n);
  if (metric === "credits") return formatCreditsLabel(n);
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function disclaimer(rateCardAsOf: string): string {
  return `Local estimate from telemetry and the public rate card dated ${rateCardAsOf}. Not OpenAI's bill.`;
}
