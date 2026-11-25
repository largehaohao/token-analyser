import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "./atomic-write.ts";
import { loadIgnoredPrices } from "./price-ignore.ts";
import { withPricingLock } from "./pricing-lock.ts";
import { parseDeepseekPricing } from "./publishers/deepseek.ts";
import { parseGeminiPricing } from "./publishers/gemini.ts";
import { parseGrokPricing } from "./publishers/grok.ts";

export const CATALOG_PATH = fileURLToPath(
  new URL("../../../config/prices/catalog.json", import.meta.url),
);
export const PUBLISHERS_DIR = fileURLToPath(
  new URL("../../../config/prices/publishers", import.meta.url),
);

const MAX_PRICING_BYTES = 2_000_000;
const PRICING_TIMEOUT_MS = 15_000;

export type PublisherModelSpec = {
  match: string;
  display?: string;
  aliases?: string[];
};

export type PublisherSpec = {
  id: string;
  label: string;
  page: string;
  markdown_url: string;
  default_tier: string;
  suffixes?: string[];
  models: Record<string, PublisherModelSpec>;
};

export type TierRate = {
  input: number;
  cached: number;
  output: number;
};

export type ParsedRate = TierRate & {
  tier: string;
  long_context?: TierRate & { from_tokens: number };
  off_peak?: TierRate;
};

export type CatalogModel = ParsedRate & { source: string };

export type CatalogSource = {
  label: string;
  as_of: string;
  page: string;
  model_count: number;
};

export type PriceCatalog = {
  as_of: string;
  sources: Record<string, CatalogSource>;
  models: Record<string, CatalogModel>;
  aliases: Record<string, string>;
};

export type CatalogUpdateOptions = {
  enabled?: boolean;
  catalogPath?: string;
  publishersDir?: string;
  fetcher?: typeof fetch;
  now?: Date;
  ignoredModels?: Iterable<string>;
};

export type CatalogSourceResult = {
  id: string;
  label: string;
  status: string;
  asOf?: string;
  modelCount?: number;
};

type PublisherParser = (
  markdown: string,
  spec: PublisherSpec,
  now: Date,
) => Record<string, ParsedRate>;

const PARSERS: Record<string, PublisherParser> = {
  deepseek: parseDeepseekPricing,
  grok: parseGrokPricing,
  gemini: parseGeminiPricing,
};

function emptyCatalog(): PriceCatalog {
  return { as_of: "", sources: {}, models: {}, aliases: {} };
}

export function localPriceDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function acceptable(rate: TierRate): boolean {
  return rate.input > 0 &&
    rate.output > 0 &&
    rate.cached >= 0 &&
    rate.cached <= rate.input &&
    Number.isFinite(rate.input) &&
    Number.isFinite(rate.cached) &&
    Number.isFinite(rate.output);
}

export function loadPublisherSpecs(publishersDir = PUBLISHERS_DIR): PublisherSpec[] {
  if (!existsSync(publishersDir)) return [];
  const specs: PublisherSpec[] = [];
  for (const name of readdirSync(publishersDir).filter((file) => file.endsWith(".json")).sort()) {
    const spec = JSON.parse(readFileSync(path.join(publishersDir, name), "utf8")) as PublisherSpec;
    if (!spec.id || !spec.markdown_url || !spec.models || Object.keys(spec.models).length === 0) {
      throw new Error("catalog_targets_missing");
    }
    specs.push(spec);
  }
  return specs.sort((left, right) => left.id.localeCompare(right.id));
}

export function readPriceCatalog(catalogPath = CATALOG_PATH): {
  previousContent: string | null;
  catalog: PriceCatalog;
} {
  if (!existsSync(catalogPath)) return { previousContent: null, catalog: emptyCatalog() };
  try {
    const previousContent = readFileSync(catalogPath, "utf8");
    const catalog = JSON.parse(previousContent) as PriceCatalog;
    if (!catalog.models || !catalog.aliases || !catalog.sources) {
      throw new Error("invalid catalog");
    }
    return { previousContent, catalog };
  } catch (error) {
    if (error instanceof Error && error.message === "invalid catalog") {
      throw new Error("catalog_read_failed");
    }
    throw new Error("catalog_read_failed");
  }
}

export function loadPriceCatalog(catalogPath = CATALOG_PATH): PriceCatalog {
  return readPriceCatalog(catalogPath).catalog;
}

export function restorePriceCatalog(content: string | null, catalogPath = CATALOG_PATH): void {
  try {
    if (content == null) {
      if (existsSync(catalogPath)) unlinkSync(catalogPath);
      return;
    }
    writeFileAtomically(catalogPath, content);
  } catch {
    throw new Error("catalog_write_failed");
  }
}

function rateSignature(catalog: PriceCatalog): string {
  return JSON.stringify({ models: catalog.models, aliases: catalog.aliases });
}

function addModelAliases(
  aliases: Record<string, string>,
  spec: PublisherSpec,
  id: string,
): void {
  const declared = spec.models[id];
  if (!declared) return;
  if (declared.display) aliases[declared.display] = id;
  for (const alias of declared.aliases ?? []) aliases[alias] = id;
  for (const suffix of spec.suffixes ?? []) aliases[`${id}${suffix}`] = id;
}

export function isPriceCatalogStale(
  catalog: PriceCatalog,
  specs: PublisherSpec[],
  now = new Date(),
): boolean {
  const today = localPriceDate(now);
  return specs.some((spec) => catalog.sources[spec.id]?.as_of !== today);
}

function compileCatalog(
  specs: PublisherSpec[],
  parsed: Map<string, Record<string, ParsedRate>>,
  previous: PriceCatalog,
  now: Date,
  ignored: Set<string> = new Set(),
): PriceCatalog {
  const models: Record<string, CatalogModel> = {};
  const aliases: Record<string, string> = {};
  const sources: Record<string, CatalogSource> = {};
  const today = localPriceDate(now);

  for (const spec of specs) {
    const rates = parsed.get(spec.id);
    const previousSource = previous.sources[spec.id];
    if (!rates) {
      if (!previousSource) continue;
      sources[spec.id] = previousSource;
      for (const [id, model] of Object.entries(previous.models)) {
        if (model.source === spec.id) models[id] = model;
      }
      for (const [alias, canonical] of Object.entries(previous.aliases)) {
        if (models[canonical]?.source === spec.id) aliases[alias] = canonical;
      }
      continue;
    }

    let activeCount = 0;
    for (const [id, rate] of Object.entries(rates)) {
      if (ignored.has(id)) {
        const previousModel = previous.models[id];
        if (previousModel?.source === spec.id) {
          models[id] = previousModel;
          addModelAliases(aliases, spec, id);
        }
        continue;
      }
      activeCount += 1;
      models[id] = { ...rate, source: spec.id };
      addModelAliases(aliases, spec, id);
    }
    sources[spec.id] = {
      label: spec.label,
      as_of: today,
      page: spec.page,
      model_count: activeCount,
    };
  }

  return {
    as_of: today,
    sources: sortedRecord(sources),
    models: sortedRecord(models),
    aliases: sortedRecord(aliases),
  };
}

async function fetchPublisherMarkdown(
  spec: PublisherSpec,
  fetcher: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICING_TIMEOUT_MS);
  try {
    const response = await fetcher(spec.markdown_url, {
      signal: controller.signal,
      headers: { Accept: "text/markdown, text/plain;q=0.9" },
    });
    if (!response.ok) throw new Error(`${spec.id}_pricing_unavailable`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_PRICING_BYTES) {
      throw new Error(`${spec.id}_pricing_format_changed`);
    }
    const markdown = await response.text();
    if (markdown.length > MAX_PRICING_BYTES) throw new Error(`${spec.id}_pricing_format_changed`);
    return markdown;
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("_pricing_format_changed")) throw error;
    throw new Error(`${spec.id}_pricing_unavailable`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function updateCatalogFromOfficial(
  options?: CatalogUpdateOptions,
): Promise<{
  changed: boolean;
  previousContent: string | null;
  sources: CatalogSourceResult[];
}> {
  const catalogPath = options?.catalogPath ?? CATALOG_PATH;
  const fetcher = options?.fetcher ?? fetch;
  const now = options?.now ?? new Date();
  const specs = loadPublisherSpecs(options?.publishersDir);
  if (specs.length === 0) throw new Error("catalog_targets_missing");
  const { previousContent, catalog: previous } = readPriceCatalog(catalogPath);
  const ignored = new Set(options?.ignoredModels ?? []);

  const parsed = new Map<string, Record<string, ParsedRate>>();
  const results = await Promise.all(specs.map(async (spec): Promise<CatalogSourceResult> => {
    const parse = PARSERS[spec.id];
    if (!parse) return { id: spec.id, label: spec.label, status: `${spec.id}_pricing_format_changed` };
    try {
      const markdown = await fetchPublisherMarkdown(spec, fetcher);
      const rates = parse(markdown, spec, now);
      const activeIds = Object.keys(spec.models).filter((id) => !ignored.has(id));
      const missing = activeIds.filter((id) => !rates[id]);
      if (missing.length > 0 || Object.values(rates).some((rate) => !acceptable(rate) || (rate.long_context != null && !acceptable(rate.long_context)) || (rate.off_peak != null && !acceptable(rate.off_peak)))) {
        throw new Error(`${spec.id}_pricing_format_changed`);
      }
      parsed.set(spec.id, rates);
      return {
        id: spec.id,
        label: spec.label,
        status: "ok",
        asOf: localPriceDate(now),
        modelCount: activeIds.length,
      };
    } catch (error) {
      const status = error instanceof Error && error.message
        ? error.message
        : `${spec.id}_pricing_unavailable`;
      return { id: spec.id, label: spec.label, status };
    }
  }));

  if (parsed.size === 0) {
    return { changed: false, previousContent, sources: results };
  }

  const next = compileCatalog(specs, parsed, previous, now, ignored);
  const ratesChanged = rateSignature(next) !== rateSignature(previous);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (serialized === previousContent) {
    return { changed: false, previousContent, sources: results };
  }

  try {
    writeFileAtomically(catalogPath, serialized);
  } catch {
    throw new Error("catalog_write_failed");
  }
  return { changed: ratesChanged, previousContent, sources: results };
}

export function quoteCatalog(
  model: string | null,
  catalog: PriceCatalog,
  inputTokens?: number,
): { canonicalId: string; rates: TierRate; tier: string } | null {
  if (!model) return null;
  const canonicalId = canonicalModelId(catalog, model);
  if (!canonicalId) return null;
  const spec = catalog.models[canonicalId];
  if (!spec) return null;
  const long = spec.long_context;
  if (long && inputTokens != null && inputTokens >= long.from_tokens) {
    return {
      canonicalId,
      tier: "long",
      rates: { input: long.input, cached: long.cached, output: long.output },
    };
  }
  return {
    canonicalId,
    tier: spec.tier,
    rates: { input: spec.input, cached: spec.cached, output: spec.output },
  };
}

function canonicalModelId(catalog: PriceCatalog, model: string): string | undefined {
  if (catalog.models[model]) return model;
  if (catalog.aliases[model]) return catalog.aliases[model];
  const needle = model.toLowerCase();
  const modelHit = Object.keys(catalog.models).find((id) => id.toLowerCase() === needle);
  if (modelHit) return modelHit;
  const aliasHit = Object.keys(catalog.aliases).find((alias) => alias.toLowerCase() === needle);
  return aliasHit ? catalog.aliases[aliasHit] : undefined;
}

/**
 * Refresh declared publisher rates on start and hourly. Unchanged numbers do
 * not rewrite the catalog, so a daily check does not invalidate session caches.
 * `PRICING_AUTO_UPDATE=0` and `QWEN_PRICING_AUTO_UPDATE=0` both pin the card.
 * Vitest starts the server against the repo catalog, so it never fetches.
 */
export function startCatalogAutoRefresh(
  store: { refreshPricing(): number | Promise<number> },
  opts: {
    intervalMs?: number;
    update?: typeof updateCatalogFromOfficial;
    onUpdate?: (result: { modelCount: number }) => void;
    onError?: (reason: string) => void;
  } = {},
): () => void {
  if (
    process.env.PRICING_AUTO_UPDATE === "0" ||
    process.env.QWEN_PRICING_AUTO_UPDATE === "0" ||
    process.env.VITEST
  ) {
    return () => {};
  }
  const refresh = opts.update ?? (() => updateCatalogFromOfficial({
    ignoredModels: loadIgnoredPrices().models,
  }));
  let stopped = false;
  let running = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await withPricingLock(async () => {
        if (stopped) return;
        const specs = loadPublisherSpecs();
        if (!isPriceCatalogStale(loadPriceCatalog(), specs)) return;
        const update = await refresh();
        if (stopped) {
          restorePriceCatalog(update.previousContent);
          return;
        }
        if (!update.changed) return;
        try {
          await store.refreshPricing();
        } catch (error) {
          try {
            restorePriceCatalog(update.previousContent);
          } catch {
            opts.onError?.("pricing_recalculation_rollback_failed");
            return;
          }
          throw error;
        }
        const modelCount = update.sources.reduce((sum, source) => sum + (source.modelCount ?? 0), 0);
        opts.onUpdate?.({ modelCount });
      });
    } catch (error) {
      opts.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  function runTick(): void {
    if (stopped || running) return;
    running = true;
    void tick().finally(() => {
      running = false;
    });
  }

  const timer = setInterval(runTick, opts.intervalMs ?? 60 * 60 * 1000);
  timer.unref?.();
  runTick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
