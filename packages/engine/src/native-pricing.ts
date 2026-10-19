import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cost, TokenPricing, TokenUsage } from "./types.ts";

export const API_PRICES_PATH = fileURLToPath(new URL("../../../config/api-prices.json", import.meta.url));

export type ApiModelPrice = {
  input: number;
  cached: number;
  output: number;
  fast_multiplier?: number;
  /** Cache-creation rate as a multiple of the standard input rate. */
  cache_write_multiplier?: number;
};

/** Official-model metadata owned by the Qwen price updater (see qwen-pricing.ts). */
export type ApiQwenModelSpec = {
  display: string;
  section: string;
  region: string;
  aliases?: string[];
  tier?: string;
  cny?: { input: number; cached: number; output: number };
};

export type ApiQwenSection = {
  as_of: string;
  source: string;
  cache_rule_source: string;
  cache_hit_ratio: number;
  cache_write_ratio: number;
  usd_per_cny: number;
  usd_per_cny_source: string;
  models: Record<string, ApiQwenModelSpec>;
};

export type ApiPrices = {
  as_of: string;
  models: Record<string, ApiModelPrice>;
  qwen?: ApiQwenSection;
};

/**
 * Providers whose logs bill first-party API token rates. Third-party
 * subscription relays keep their own recorded spend instead.
 */
const API_RATE_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "qwen",
  "dashscope",
  "aliyun",
  "bailian",
]);

export function loadApiPrices(): ApiPrices {
  return JSON.parse(readFileSync(API_PRICES_PATH, "utf8")) as ApiPrices;
}

/**
 * Rates for a logged model ID, and the canonical ID it was declared as an
 * alias of. Alias IDs live under `qwen.models[*].aliases`: naming a relay's
 * own model ID there is an explicit statement that it serves that official
 * model, so it prices there regardless of provider.
 */
export function apiRateSource(
  model: string | null,
  prices: ApiPrices,
): { rates: ApiModelPrice; aliasOf?: string } | undefined {
  if (!model) return undefined;
  const direct = prices.models[model];
  if (direct) return { rates: direct };
  for (const [canonical, spec] of Object.entries(prices.qwen?.models ?? {})) {
    if (spec.aliases?.includes(model)) return { rates: prices.models[canonical]!, aliasOf: canonical };
  }
  return undefined;
}

export function apiRateForModel(
  model: string | null,
  prices: ApiPrices,
): ApiModelPrice | undefined {
  return apiRateSource(model, prices)?.rates;
}

export function nativeCost(
  usage: TokenUsage | null,
  model: string | null,
  opts: { recordedUsd?: number | null; provider?: string; fast?: boolean; cacheWrite1h?: number } = {},
): { cost: Cost; pricing: TokenPricing | null } {
  const source = apiRateSource(model, loadApiPrices());
  // A relay that bills nothing records 0 for a model with published rates; that
  // is "not billed", so the official rate estimate fills the ledger. A 0 on an
  // unpriced model stays the logged fact.
  const unbilled = opts.recordedUsd === 0 && source?.rates != null;
  const cost: Cost = {
    raw: usage ? usage.input_tokens + usage.output_tokens : 0,
    uncached_input: usage ? usage.input_tokens - usage.cached_input_tokens : 0,
    cached_input: usage?.cached_input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    credits: null,
    usd: unbilled ? null : opts.recordedUsd ?? null,
    ...(!usage ? { unmeasured: 1 } : {}),
  };
  // Third-party and subscription providers can have their own rates. Prefer
  // their recorded USD, and only estimate first-party API-equivalent token
  // cost, plus every model ID explicitly declared as an official-model alias.
  const providerPriced = !opts.provider
    || API_RATE_PROVIDERS.has(opts.provider)
    || source?.aliasOf != null;
  if (cost.usd != null || !providerPriced) return { cost, pricing: null };
  const rates = source?.rates;
  if (!usage || !rates || (opts.fast && !rates.fast_multiplier)) return { cost, pricing: null };
  const multiplier = opts.fast ? rates.fast_multiplier! : 1;
  const writeRatio = rates.cache_write_multiplier ?? (model?.startsWith("claude-") ? 1.25 : 1);
  const writeRate = rates.input * writeRatio * multiplier;
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
