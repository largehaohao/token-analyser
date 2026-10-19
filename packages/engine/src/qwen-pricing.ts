import { readFileSync } from "node:fs";
import { writeFileAtomically } from "./atomic-write.ts";
import { loadUserConfig } from "./config.ts";
import {
  API_PRICES_PATH,
  type ApiModelPrice,
  type ApiPrices,
  type ApiQwenModelSpec,
} from "./native-pricing.ts";
import type { SessionStore } from "./store.ts";

/**
 * Qwen (Alibaba Model Studio) publishes its pay-as-you-go tables as a
 * Markdown document alongside the HTML page, mirroring the Codex card updater.
 */
export const QWEN_PRICING_MARKDOWN_URL =
  "https://help.aliyun.com/zh/model-studio/model-pricing.md";
export const QWEN_PRICING_PAGE_URL =
  "https://help.aliyun.com/zh/model-studio/model-pricing";

const MAX_QWEN_PRICING_BYTES = 2_000_000;
const QWEN_PRICING_TIMEOUT_MS = 15_000;
const QWEN_AUTO_REFRESH_MS = 60 * 60 * 1000;
const USD_PLACES = 4;

export type QwenPricingUpdateOptions = {
  apiPricesPath?: string;
  fetcher?: typeof fetch;
  now?: Date;
};

type OfficialRate = {
  input: number;
  cached: number;
  output: number;
  tier: string;
};

const ESCAPED_LT = "\u0001";
const ESCAPED_GT = "\u0002";

function cleanCell(value: string): string {
  return value
    // Markdown escapes tier bounds as `0\<Token≤1M`; protect them so the tag
    // stripper cannot treat an escaped bound as the start of an element.
    .replace(/\\</g, ESCAPED_LT)
    .replace(/\\>/g, ESCAPED_GT)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`>\\]/g, " ")
    .replace(/&nbsp;|&#160;|&amp;/gi, " ")
    .replace(/&lt;/gi, ESCAPED_LT)
    .replace(/&gt;/gi, ESCAPED_GT)
    .split(ESCAPED_LT).join("<")
    .split(ESCAPED_GT).join(">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCnyPrice(cell: string): number | null {
  const match = cleanCell(cell).match(/^¥?\s*(\d[\d,]*(?:\.\d+)?)\s*元$/);
  if (!match) return null;
  const parsed = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The pricing page states the context-cache discount in its opening note, so
 * cached input never needs a second document. The card's previous ratios are
 * the fallback when the wording changes.
 */
function parseCacheRatios(
  markdown: string,
  fallback: { hit?: number; write?: number },
): { hit: number; write: number } {
  const hit = markdown.match(/命中按\s*(\d+(?:\.\d+)?)\s*%/)?.[1];
  const write = markdown.match(/创建按标准输入单价的\s*(\d+(?:\.\d+)?)\s*%/)?.[1];
  const parsedHit = hit ? Number(hit) / 100 : fallback?.hit;
  const parsedWrite = write ? Number(write) / 100 : fallback?.write;
  if (
    parsedHit == null ||
    parsedWrite == null ||
    !Number.isFinite(parsedHit) ||
    !Number.isFinite(parsedWrite) ||
    parsedHit <= 0 ||
    parsedHit > 1 ||
    parsedWrite < 1
  ) {
    throw new Error("qwen_pricing_format_changed");
  }
  return { hit: parsedHit, write: parsedWrite };
}

function headings(markdown: string): { index: number; level: number }[] {
  return [...markdown.matchAll(/^(#{1,6})\s+([^\n]*)$/gm)].map((match) => ({
    index: match.index!,
    level: match[1]!.length,
  }));
}

function sectionSlice(markdown: string, title: string): string {
  const wanted = title.replace(/\s+/g, "").toLowerCase();
  const found = headings(markdown).find((heading) => {
    const lineEnd = markdown.indexOf("\n", heading.index);
    const label = markdown
      .slice(heading.index + heading.level, lineEnd < 0 ? markdown.length : lineEnd)
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    return label === wanted;
  });
  if (!found) return "";
  const end = nextHeadingIndex(markdown, found);
  return markdown.slice(found.index, end);
}

function nextHeadingIndex(
  markdown: string,
  heading: { index: number; level: number },
): number {
  const rest = headings(markdown).find(
    (candidate) =>
      candidate.index > heading.index && candidate.level <= heading.level,
  );
  return rest ? rest.index : markdown.length;
}

/**
 * Region tables live either inside a `<Tab title="…">` block (tabbed families)
 * or below a region heading. Both shapes are accepted.
 */
function regionSlice(section: string, region: string): string {
  const wanted = region.replace(/\s+/g, "");
  const tabs = [...section.matchAll(/<Tab\s+title="([^"]*)">/g)];
  const tab = tabs.find((match) => match[1]!.replace(/\s+/g, "") === wanted);
  if (tab) {
    const next = tabs.find(
      (candidate) => candidate.index! > tab.index! && candidate[1] !== tab[1],
    );
    return section.slice(tab.index!, next ? next.index! : section.length);
  }

  const heading = [...section.matchAll(/^(#{1,6})\s+([^\n]*)$/gm)].find(
    (match) =>
      cleanCell(match[2]!).replace(/\s+/g, "") === wanted,
  );
  if (!heading) return "";
  const level = heading[1]!.length;
  const rest = [...section.matchAll(/^(#{1,6})\s+[^\n]*$/gm)].find(
    (candidate) => candidate.index! > heading.index! && candidate[1]!.length <= level,
  );
  return section.slice(heading.index!, rest ? rest.index! : section.length);
}

function tableCells(table: string, tag: "th" | "td"): string[] {
  return [...table.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map(
    (match) => cleanCell(match[1]!),
  );
}

function priceColumn(
  headers: string[],
  startsWith: string,
  label: string,
): number {
  const index = headers.findIndex((header) =>
    header.replace(/\s+/g, "").startsWith(startsWith),
  );
  if (index < 0) throw new Error(`qwen_pricing_${label}_missing`);
  return index;
}

function officialRate(
  markdown: string,
  spec: ApiQwenModelSpec,
  cacheHitRatio: number,
): OfficialRate {
  const section = sectionSlice(markdown, spec.section);
  const region = regionSlice(section, spec.region);
  const tables = [...region.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  if (tables.length === 0) throw new Error("qwen_pricing_format_changed");

  for (const table of tables) {
    const headers = tableCells(table, "th");
    const inputCol = priceColumn(headers, "输入单价（每百万", "input_price_missing");
    const outputCol = priceColumn(headers, "输出单价（每百万", "output_price_missing");
    const cacheCol = headers.findIndex((header) =>
      header.replace(/\s+/g, "").startsWith("缓存命中输入单价"),
    );
    const tierCol = headers.findIndex((header) =>
      header.replace(/\s+/g, "").startsWith("单次请求的输入"),
    );

    const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
    if (!body) continue;

    for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = tableCells(row[1]!, "td");
      if (cells.length !== headers.length) continue;
      const model = cells[0]!.split(" ")[0]!.toLowerCase();
      if (model !== spec.display.toLowerCase()) continue;

      const input = parseCnyPrice(cells[inputCol]!);
      const output = parseCnyPrice(cells[outputCol]!);
      const cached =
        cacheCol >= 0 ? parseCnyPrice(cells[cacheCol]!) : input == null ? null : round(input * cacheHitRatio, 6);
      const tier = tierCol >= 0 ? cells[tierCol]! : "";
      if (input == null || output == null || cached == null) {
        throw new Error("qwen_pricing_format_changed");
      }
      if (input > 10_000 || output > 10_000 || cached > input) {
        throw new Error("qwen_pricing_format_changed");
      }
      return { input, cached, output, tier };
    }
  }

  throw new Error("qwen_pricing_format_changed");
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function readApiPrices(apiPricesPath: string): {
  previousContent: string;
  current: ApiPrices;
} {
  let previousContent: string;
  try {
    previousContent = readFileSync(apiPricesPath, "utf8");
    const current = JSON.parse(previousContent) as ApiPrices;
    if (!current.models || typeof current.models !== "object") {
      throw new Error("invalid api prices");
    }
    return { previousContent, current };
  } catch {
    throw new Error("api_prices_read_failed");
  }
}

export function restoreApiPrices(
  content: string,
  apiPricesPath = API_PRICES_PATH,
): void {
  try {
    writeFileAtomically(apiPricesPath, content);
  } catch {
    throw new Error("api_prices_write_failed");
  }
}

export function qwenPriceAsOf(apiPricesPath: string = API_PRICES_PATH): string {
  return readApiPrices(apiPricesPath).current.qwen?.as_of ?? "";
}

function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The card is stale once its Qwen section no longer carries today's date. */
export function isQwenPriceCardStale(
  asOf: string,
  now: Date = new Date(),
): boolean {
  return asOf !== localDate(now);
}

/**
 * Refresh every model declared under `qwen.models` from the official page.
 * The write is all-or-nothing: a missing model, an unparseable cell, or an
 * out-of-range price leaves the local card untouched.
 */
export async function updateQwenPricesFromOfficial(
  options?: QwenPricingUpdateOptions,
): Promise<{
  asOf: string;
  modelCount: number;
  usdPerCny: number;
  previousContent: string;
}> {
  const apiPricesPath = options?.apiPricesPath ?? API_PRICES_PATH;
  const fetchPricing = options?.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    QWEN_PRICING_TIMEOUT_MS,
  );

  let markdown: string;
  try {
    const response = await fetchPricing(QWEN_PRICING_MARKDOWN_URL, {
      signal: controller.signal,
      headers: { Accept: "text/markdown, text/plain;q=0.9" },
    });
    if (!response.ok) throw new Error("qwen_pricing_unavailable");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_QWEN_PRICING_BYTES) {
      throw new Error("qwen_pricing_format_changed");
    }
    markdown = await response.text();
    if (markdown.length > MAX_QWEN_PRICING_BYTES) {
      throw new Error("qwen_pricing_format_changed");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "qwen_pricing_format_changed" ||
        error.message === "qwen_pricing_input_price_missing" ||
        error.message === "qwen_pricing_output_price_missing")
    ) {
      throw error;
    }
    throw new Error("qwen_pricing_unavailable");
  } finally {
    clearTimeout(timeout);
  }

  const { previousContent, current } = readApiPrices(apiPricesPath);
  const section = current.qwen;
  const specs = Object.entries(section?.models ?? {});
  if (specs.length === 0) throw new Error("qwen_pricing_targets_missing");

  const override = loadUserConfig().usd_per_cny;
  const usdPerCny = override ?? section?.usd_per_cny;
  if (!usdPerCny || !Number.isFinite(usdPerCny) || usdPerCny <= 0) {
    throw new Error("qwen_pricing_fx_missing");
  }
  const fxSource = override
    ? "user config ~/.token-analyser/config.json"
    : section!.usd_per_cny_source;

  const { hit, write } = parseCacheRatios(markdown, {
    hit: section?.cache_hit_ratio,
    write: section?.cache_write_ratio,
  });

  const models = { ...current.models };
  const qwenModels: Record<string, ApiQwenModelSpec> = {};
  for (const [id, spec] of specs) {
    const rate = officialRate(markdown, spec, hit);
    const entry: ApiModelPrice = {
      input: round(rate.input * usdPerCny, USD_PLACES),
      cached: round(rate.cached * usdPerCny, USD_PLACES),
      output: round(rate.output * usdPerCny, USD_PLACES),
      cache_write_multiplier: write,
    };
    if (!entry.input || !entry.cached || !entry.output) {
      throw new Error("qwen_pricing_format_changed");
    }
    models[id] = { ...models[id], ...entry };
    qwenModels[id] = {
      ...spec,
      tier: rate.tier || spec.tier,
      cny: { input: rate.input, cached: rate.cached, output: rate.output },
    };
  }

  const asOf = localDate(options?.now ?? new Date());
  const next: ApiPrices = {
    ...current,
    models,
    qwen: {
      ...section!,
      as_of: asOf,
      source: QWEN_PRICING_PAGE_URL,
      cache_hit_ratio: hit,
      cache_write_ratio: write,
      usd_per_cny: usdPerCny,
      usd_per_cny_source: fxSource,
      models: qwenModels,
    },
  };

  try {
    writeFileAtomically(apiPricesPath, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    throw new Error("api_prices_write_failed");
  }

  return { asOf, modelCount: specs.length, usdPerCny, previousContent };
}

/**
 * Keep Qwen prices current without user action: check on start and hourly, and
 * re-price local sessions whenever the card's Qwen date is not today's date.
 * Set `QWEN_PRICING_AUTO_UPDATE=0` to keep the card pinned.
 */
export function startQwenPriceAutoRefresh(
  store: SessionStore,
  opts: {
    intervalMs?: number;
    apiPricesPath?: string;
    update?: typeof updateQwenPricesFromOfficial;
    onUpdate?: (result: { asOf: string; modelCount: number }) => void;
    onError?: (reason: string) => void;
  } = {},
): () => void {
  if (process.env.QWEN_PRICING_AUTO_UPDATE === "0") return () => {};
  const refresh = opts.update ?? updateQwenPricesFromOfficial;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      if (!isQwenPriceCardStale(qwenPriceAsOf(opts.apiPricesPath))) return;
      const update = await refresh();
      if (stopped) {
        restoreApiPrices(update.previousContent, opts.apiPricesPath);
        return;
      }
      store.refreshPricing();
      opts.onUpdate?.({ asOf: update.asOf, modelCount: update.modelCount });
    } catch (error) {
      // A stale card stays auditable; the next tick retries.
      opts.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  const timer = setInterval(() => void tick(), opts.intervalMs ?? QWEN_AUTO_REFRESH_MS);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
