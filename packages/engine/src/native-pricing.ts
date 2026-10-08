import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cost, TokenPricing, TokenUsage } from "./types.ts";

export const API_PRICES_PATH = fileURLToPath(new URL("../../../config/api-prices.json", import.meta.url));

type ApiPrices = {
  as_of: string;
  models: Record<string, { input: number; cached: number; output: number; fast_multiplier?: number }>;
};

export function loadApiPrices(): ApiPrices {
  return JSON.parse(readFileSync(API_PRICES_PATH, "utf8")) as ApiPrices;
}

export function nativeCost(
  usage: TokenUsage | null,
  model: string | null,
  opts: { recordedUsd?: number | null; provider?: string; fast?: boolean; cacheWrite1h?: number } = {},
): { cost: Cost; pricing: TokenPricing | null } {
  const cost: Cost = {
    raw: usage ? usage.input_tokens + usage.output_tokens : 0,
    uncached_input: usage ? usage.input_tokens - usage.cached_input_tokens : 0,
    cached_input: usage?.cached_input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    credits: null,
    usd: opts.recordedUsd ?? null,
    ...(!usage ? { unmeasured: 1 } : {}),
  };
  // Third-party and subscription providers can have their own rates. Prefer
  // their recorded USD, and only estimate first-party API-equivalent token cost.
  if (opts.recordedUsd != null || (opts.provider && !["anthropic", "openai"].includes(opts.provider))) return { cost, pricing: null };
  const rates = model ? loadApiPrices().models[model] : undefined;
  if (!usage || !rates || (opts.fast && !rates.fast_multiplier)) return { cost, pricing: null };
  const multiplier = opts.fast ? rates.fast_multiplier! : 1;
  const anthropic = model?.startsWith("claude-") ?? false;
  const writeRate = rates.input * (anthropic ? 1.25 : 1) * multiplier;
  const write1h = Math.min(opts.cacheWrite1h ?? 0, usage.cache_write_input_tokens);
  const pricing: TokenPricing = {
    mode: opts.fast ? "fast" : "standard", unit: "usd", multiplier,
    input: rates.input * multiplier, cached: rates.cached * multiplier,
    output: rates.output * multiplier, cacheWrite: writeRate,
  };
  if (cost.usd == null) {
    const ordinary = cost.uncached_input - usage.cache_write_input_tokens;
    cost.usd = (ordinary * pricing.input + cost.cached_input * pricing.cached +
      cost.output * pricing.output + (usage.cache_write_input_tokens - write1h) * writeRate +
      write1h * rates.input * 2 * multiplier) / 1e6;
  }
  return { cost, pricing };
}
