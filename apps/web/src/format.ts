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

export function disclaimer(rateCardAsOf: string): string {
  return `Local estimate from telemetry and the public rate card dated ${rateCardAsOf}. Not OpenAI's bill.`;
}
