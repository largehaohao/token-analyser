import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUserConfig } from "./config.ts";
import type { Cost, RateCard, TokenUsage } from "./types.ts";

const defaultPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/rate-card.json",
);

export function loadRateCard(cardPath: string = defaultPath): RateCard {
  return JSON.parse(readFileSync(cardPath, "utf8")) as RateCard;
}

export function effectiveRateCard(cardPath: string = defaultPath): RateCard {
  const card = loadRateCard(cardPath);
  const override = loadUserConfig().usd_per_credit;
  if (override == null) return card;
  return { ...card, usd_per_credit: override };
}

function ratesForModel(
  model: string | null,
  card: RateCard,
): RateCard["models"][string] | undefined {
  if (!model) return undefined;
  const exact = card.models[model];
  if (exact) return exact;
  let best: string | undefined;
  for (const key of Object.keys(card.models)) {
    if (model.startsWith(`${key}-`) || model.startsWith(`${key}.`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? card.models[best] : undefined;
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
  const rates = ratesForModel(model, card);
  if (!rates) {
    return { raw, uncached_input, cached_input, output, credits: null, usd: null };
  }
  let credits =
    (uncached_input / 1e6) * rates.input +
    (cached_input / 1e6) * rates.cached +
    (output / 1e6) * rates.output;
  if (fastMode) credits *= rates.fast_multiplier ?? card.fast_multiplier;
  const usd = credits * card.usd_per_credit;
  return { raw, uncached_input, cached_input, output, credits, usd };
}
