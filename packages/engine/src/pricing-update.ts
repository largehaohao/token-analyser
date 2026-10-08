import { randomUUID } from "node:crypto";
import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { RATE_CARD_PATH } from "./rate-card.ts";
import type { RateCard } from "./types.ts";

const OFFICIAL_PRICING_MARKDOWN_URL =
  "https://developers.openai.com/codex/pricing.md";
const OFFICIAL_PRICING_PAGE_URL = "https://developers.openai.com/codex/pricing";
const MAX_PRICING_DOCUMENT_BYTES = 1_000_000;
const PRICING_REQUEST_TIMEOUT_MS = 15_000;

type ModelRate = RateCard["models"][string];

export type PricingUpdateOptions = {
  rateCardPath?: string;
  fetcher?: typeof fetch;
  now?: Date;
};

const MODEL_ID_ALIASES: Record<string, string[]> = {
  "gpt-5.6 sol": ["gpt-5.6", "gpt-5.6-sol"],
  "daybreak blue": ["gpt-daybreak-blue-latest"],
  "daybreak red": ["gpt-daybreak-red-latest", "gpt-5.6-cyber"],
  "gpt-5.4 mini": ["gpt-5.4-mini"],
  "gpt-image-2 (image)": ["gpt-image-2"],
  "gpt-image-2 (text)": ["gpt-image-2-text"],
};

function cleanCell(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function modelIdsFor(displayName: string): string[] {
  const key = displayName.toLowerCase().replace(/\s+/g, " ").trim();
  const aliases = MODEL_ID_ALIASES[key];
  if (aliases) return aliases;

  const id = key
    .replace(/^gpt\s*-\s*/, "gpt-")
    .replace(/^gpt\s+/, "gpt-")
    .replace(/\s+/g, "-")
    .replace(/\((image|text)\)/g, "-$1")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return id ? [id] : [];
}

function parseCredits(value: string): number | null {
  const match = value
    .replace(/\s+/g, " ")
    .trim()
    .match(/^(\d[\d,]*(?:\.\d+)?)\s*credits?$/i);
  if (!match) return null;
  const parsed = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseOfficialRates(markdown: string): {
  rates: Map<string, ModelRate>;
  modelCount: number;
  fastMultiplier: number;
} {
  const sectionStart = markdown.indexOf("#### Token rates");
  const tableStart =
    sectionStart < 0 ? -1 : markdown.indexOf("<table", sectionStart);
  const tableEnd =
    tableStart < 0 ? -1 : markdown.indexOf("</table>", tableStart);
  if (tableStart < 0 || tableEnd < 0) {
    throw new Error("official_pricing_format_changed");
  }

  const table = markdown.slice(tableStart, tableEnd + "</table>".length);
  const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(
    (match) => cleanCell(match[1]!).toLowerCase(),
  );
  if (
    headers.length < 4 ||
    headers[0] !== "credits per 1m tokens" ||
    headers[1] !== "input tokens" ||
    headers[2] !== "cached input tokens" ||
    headers[3] !== "output tokens"
  ) {
    throw new Error("official_pricing_format_changed");
  }

  const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!body) throw new Error("official_pricing_format_changed");

  const rates = new Map<string, ModelRate>();
  const models = new Set<string>();
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (match) => cleanCell(match[1]!),
    );
    if (cells.length < 4) continue;

    const displayName = cells[0]!;
    const input = parseCredits(cells[1]!);
    const cached = parseCredits(cells[2]!);
    const output = parseCredits(cells[3]!);
    const ids = modelIdsFor(displayName);
    if (
      !displayName ||
      input == null ||
      cached == null ||
      output == null ||
      ids.length === 0
    ) {
      throw new Error("official_pricing_format_changed");
    }

    models.add(displayName);
    for (const id of ids) rates.set(id, { input, cached, output });
  }

  if (models.size < 5 || rates.size < 5) {
    throw new Error("official_pricing_format_changed");
  }
  return {
    rates,
    modelCount: models.size,
    fastMultiplier: parseFastMultiplier(markdown),
  };
}

function parseFastMultiplier(markdown: string): number {
  const rows = markdown
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map(cleanCell));
  const header = rows.findIndex((row) => row[0]?.toLowerCase() === "speed mode");
  const creditColumn = rows[header]?.findIndex((cell) =>
    /purchased credits.*pay-as-you-go/i.test(cell),
  ) ?? -1;
  const fastRow = header < 0
    ? undefined
    : rows.slice(header + 1).find((row) => row[0]?.toLowerCase() === "fast");
  const match = fastRow?.[creditColumn]?.match(/^(\d+(?:\.\d+)?)\s*[x×]$/i);
  const multiplier = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error("official_pricing_format_changed");
  }
  return multiplier;
}

function writeRateCardContent(rateCardPath: string, content: string): void {
  const directory = path.dirname(rateCardPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(rateCardPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, rateCardPath);
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already have been renamed or removed.
    }
    throw new Error("rate_card_write_failed");
  }
}

function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function restoreRateCard(
  content: string,
  rateCardPath = RATE_CARD_PATH,
): void {
  writeRateCardContent(rateCardPath, content);
}

export async function updateRateCardFromOfficial(
  options?: PricingUpdateOptions,
): Promise<{
  asOf: string;
  modelCount: number;
  previousContent: string;
}> {
  const rateCardPath = options?.rateCardPath ?? RATE_CARD_PATH;
  const fetchPricing = options?.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PRICING_REQUEST_TIMEOUT_MS,
  );

  let markdown: string;
  try {
    const response = await fetchPricing(OFFICIAL_PRICING_MARKDOWN_URL, {
      signal: controller.signal,
      headers: { Accept: "text/markdown, text/plain;q=0.9" },
    });
    if (!response.ok) throw new Error("official_pricing_unavailable");
    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_PRICING_DOCUMENT_BYTES
    ) {
      throw new Error("official_pricing_format_changed");
    }
    markdown = await response.text();
    if (markdown.length > MAX_PRICING_DOCUMENT_BYTES) {
      throw new Error("official_pricing_format_changed");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "official_pricing_format_changed"
    ) {
      throw error;
    }
    throw new Error("official_pricing_unavailable");
  } finally {
    clearTimeout(timeout);
  }

  const { rates: officialRates, modelCount, fastMultiplier } = parseOfficialRates(markdown);
  let previousContent: string;
  let current: RateCard;
  try {
    previousContent = readFileSync(rateCardPath, "utf8");
    current = JSON.parse(previousContent) as RateCard;
    if (!current.models || typeof current.models !== "object") {
      throw new Error("invalid_rate_card");
    }
  } catch {
    throw new Error("rate_card_read_failed");
  }

  const models = { ...current.models };
  for (const [id, rate] of officialRates) {
    models[id] = {
      ...models[id],
      ...rate,
    };
  }

  const asOf = localDate(options?.now ?? new Date());
  const nextCard: RateCard = {
    ...current,
    as_of: asOf,
    source: OFFICIAL_PRICING_PAGE_URL,
    fast_multiplier: fastMultiplier,
    models,
  };
  writeRateCardContent(rateCardPath, `${JSON.stringify(nextCard, null, 2)}\n`);

  return {
    asOf,
    modelCount,
    previousContent,
  };
}
