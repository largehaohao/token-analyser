import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUserConfig } from "./config.ts";
import type { Cost, RateCard, TokenPricing, TokenUsage } from "./types.ts";

export const RATE_CARD_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/rate-card.json",
);

export function loadRateCard(cardPath: string = RATE_CARD_PATH): RateCard {
  return JSON.parse(readFileSync(cardPath, "utf8")) as RateCard;
}

export function effectiveRateCard(cardPath: string = RATE_CARD_PATH): RateCard {
  const card = loadRateCard(cardPath);
  const override = loadUserConfig().usd_per_credit;
  if (override == null) return card;
  return { ...card, usd_per_credit: override };
}

export function tokenPricingForModel(
  model: string | null,
  card: RateCard,
  fastMode: boolean,
): TokenPricing | null {
  if (!model) return null;
  // Pricing must be auditable. A future model that merely shares a prefix
  // may have different rates, so only explicit IDs in the dated card match.
  const rates = card.models[model];
  if (!rates) return null;
  const multiplier = fastMode ? rates.fast_multiplier ?? card.fast_multiplier : 1;
  return {
    mode: fastMode ? "fast" : "standard",
    multiplier,
    input: rates.input * multiplier,
    cached: rates.cached * multiplier,
    output: rates.output * multiplier,
  };
}

export function priceUsage(
  usage: TokenUsage,
  model: string | null,
  card: RateCard,
  fastMode: boolean,
): Cost {
  const uncached_input = usage.input_tokens - usage.cached_input_tokens;
  const cached_input = usage.cached_input_tokens;
  const output = usage.output_tokens;
  const raw = usage.input_tokens + usage.output_tokens;
  const rates = tokenPricingForModel(model, card, fastMode);
  if (!rates) {
    return { raw, uncached_input, cached_input, output, credits: null, usd: null };
  }
  const credits =
    (uncached_input / 1e6) * rates.input +
    (cached_input / 1e6) * rates.cached +
    (output / 1e6) * rates.output;
  const usd = credits * card.usd_per_credit;
  return { raw, uncached_input, cached_input, output, credits, usd };
}
