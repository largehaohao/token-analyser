import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeCost } from "../src/native-pricing.ts";
import { parseGeminiPricing } from "../src/publishers/gemini.ts";
import {
  loadPriceCatalog,
  quoteCatalog,
  updateCatalogFromOfficial,
  type PriceCatalog,
} from "../src/price-catalog.ts";
import type { TokenUsage } from "../src/types.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
const publishers = path.resolve(import.meta.dirname, "../../../config/prices/publishers");
const deepseek = readFileSync(path.join(fixtures, "deepseek-pricing.md"), "utf8");
const grok = readFileSync(path.join(fixtures, "grok-models.md"), "utf8");
const gemini = readFileSync(path.join(fixtures, "gemini-pricing.md"), "utf8");

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "price-catalog-"));
  dirs.push(dir);
  return dir;
}

function fetcher(pages: Record<string, string | number>): typeof fetch {
  return async (input) => {
    const url = String(input);
    const page = Object.entries(pages).find(([needle]) => url.includes(needle));
    if (!page || typeof page[1] === "number") {
      return new Response("down", { status: typeof page?.[1] === "number" ? page[1] : 404 });
    }
    return new Response(page[1], { status: 200, headers: { "content-type": "text/markdown" } });
  };
}

function usage(input = 1_000_000): TokenUsage {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1_000_000,
    reasoning_output_tokens: 0,
    total_tokens: input + 1_000_000,
  };
}

afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("official model catalog", () => {
  it("prices DeepSeek, Grok, and Gemini from their official pages", async () => {
    const dir = tempDir();
    const catalogPath = path.join(dir, "catalog.json");
    const update = await updateCatalogFromOfficial({
      catalogPath,
      publishersDir: publishers,
      now: new Date("2026-11-20T00:00:00Z"),
      fetcher: fetcher({
        "deepseek.com": deepseek,
        "docs.x.ai": grok,
        "google.dev": gemini,
      }),
    });

    expect(update.changed).toBe(true);
    expect(update.sources.map((source) => [source.id, source.status, source.modelCount])).toEqual([
      ["deepseek", "ok", 2],
      ["gemini", "ok", 7],
      ["grok", "ok", 4],
    ]);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as PriceCatalog;
    expect(catalog.models["deepseek-flash"]).toMatchObject({
      input: 0.3,
      cached: 0.006,
      output: 1.2,
      tier: "peak",
      off_peak: { input: 0.15, cached: 0.003, output: 0.6 },
    });
    expect(catalog.models["deepseek-v4-pro"]).toMatchObject({ input: 1.32, cached: 0.044, output: 3.96 });
    expect(catalog.models["grok-4.7"]).toMatchObject({
      input: 2,
      cached: 0.5,
      output: 6,
      long_context: { from_tokens: 200_000, input: 4, cached: 1, output: 12 },
    });
    expect(catalog.models["grok-4.5"]).toMatchObject({ input: 2, cached: 0.3, output: 6 });
    expect(catalog.models["grok-4.3"]).toMatchObject({ input: 1.25, cached: 0.2, output: 2.5 });
    expect(catalog.models["gemini-3.8-flash"]).toMatchObject({ input: 0.75, cached: 0.075, output: 3.75 });
    expect(catalog.models["gemini-4-carbon"]).toMatchObject({ input: 2, cached: 0.1, output: 10 });
    expect(catalog.models["gemini-4-argon"]).toMatchObject({ input: 2, cached: 0.1, output: 10 });
    expect(catalog.models["gemini-4-neon"]).toMatchObject({ input: 3, cached: 0.15, output: 15 });
    expect(catalog.models["gemini-4-hydrogen"]).toMatchObject({ input: 1.5, cached: 0.075, output: 7.5 });
    expect(catalog.aliases["Gemini 4 Carbon"]).toBe("gemini-4-carbon");
    expect(catalog.models["gemini-3.5-flash-lite"]).toMatchObject({ input: 0.3, cached: 0.03, output: 2.5 });
    expect(catalog.aliases["deepseek-v4-flash"]).toBe("deepseek-flash");
    expect(catalog.aliases["Gemini 3.8 Flash"]).toBe("gemini-3.8-flash");
    expect(catalog.aliases["gemini-3.8-flash-high"]).toBe("gemini-3.8-flash");
    expect(catalog.aliases["grok/grok-4.7-build-fast"]).toBe("grok-4.7");

    const display = quoteCatalog("Gemini 3.8 Flash", catalog);
    expect(display?.rates).toMatchObject({ input: 0.75, cached: 0.075, output: 3.75 });
    expect(quoteCatalog("grok-4.7", catalog, 200_000)?.rates.input).toBe(4);
    expect(quoteCatalog("grok-4.7", catalog, 199_999)?.rates.input).toBe(2);
  });

  it("uses the Gemini rate that applies on the update date", async () => {
    const dir = tempDir();
    const catalogPath = path.join(dir, "catalog.json");
    await updateCatalogFromOfficial({
      catalogPath,
      publishersDir: publishers,
      now: new Date("2027-01-02T00:00:00Z"),
      fetcher: fetcher({
        "deepseek.com": deepseek,
        "docs.x.ai": grok,
        "google.dev": gemini,
      }),
    });
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as PriceCatalog;
    expect(catalog.models["gemini-3.8-flash"]).toMatchObject({ input: 1.5, cached: 0.15, output: 7.5 });
    expect(catalog.models["gemini-4-carbon"]).toMatchObject({ input: 4, cached: 0.2, output: 20 });
    expect(catalog.models["deepseek-flash"]?.input).toBe(0.3);
  });

  it("leaves the catalog untouched when a page no longer matches", async () => {
    const dir = tempDir();
    const catalogPath = path.join(dir, "catalog.json");
    const previous = `${JSON.stringify({ as_of: "2026-01-01", sources: {}, models: {}, aliases: {} }, null, 2)}\n`;
    writeFileSync(catalogPath, previous);
    const update = await updateCatalogFromOfficial({
      catalogPath,
      publishersDir: publishers,
      now: new Date("2026-11-20T00:00:00Z"),
      fetcher: fetcher({
        "deepseek.com": "not a pricing table",
        "docs.x.ai": grok,
        "google.dev": gemini,
      }),
    });
    expect(update.sources.find((source) => source.id === "deepseek")?.status).toBe("deepseek_pricing_format_changed");
    expect(update.sources.find((source) => source.id === "grok")?.status).toBe("ok");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as PriceCatalog;
    expect(catalog.models["deepseek-flash"]).toBeUndefined();
    expect(catalog.models["grok-4.7"]?.input).toBe(2);

    const broken = readFileSync(catalogPath, "utf8");
    const again = await updateCatalogFromOfficial({
      catalogPath,
      publishersDir: publishers,
      now: new Date("2026-11-20T00:00:00Z"),
      fetcher: fetcher({
        "deepseek.com": 503,
        "docs.x.ai": 503,
        "google.dev": 503,
      }),
    });
    expect(again.changed).toBe(false);
    expect(readFileSync(catalogPath, "utf8")).toBe(broken);
    expect(again.sources.every((source) => source.status.endsWith("_unavailable"))).toBe(true);
  });

  it("parses the saved full Gemini page the same way as the fixture", () => {
    const full = "/tmp/gemini-pricing.md";
    if (!existsSync(full)) return;
    const spec = JSON.parse(readFileSync(path.join(publishers, "gemini.json"), "utf8"));
    const now = new Date("2026-11-20T00:00:00Z");
    expect(parseGeminiPricing(readFileSync(full, "utf8"), spec, now)).toEqual(
      parseGeminiPricing(gemini, spec, now),
    );
  });

  it("estimates logged aliases from the committed catalog", () => {
    const catalog = loadPriceCatalog();
    expect(quoteCatalog("deepseek-v4-flash", catalog)?.rates).toMatchObject({ input: 0.3, cached: 0.006, output: 1.2 });
    expect(quoteCatalog("grok-4.7", catalog, 250_000)?.rates.output).toBe(12);
    const flash = nativeCost(usage(), "deepseek-v4-flash", { provider: "opencode", recordedUsd: 0 });
    const account = nativeCost(usage(), "deepseek-flash", { provider: "deepseek-account" });
    const geminiName = nativeCost(usage(), "Gemini 3.8 Flash");
    const grok = nativeCost(usage(250_000), "grok-4.7", { provider: "xai", recordedUsd: 0 });
    const routed = nativeCost(usage(), "grok/grok-4.7-build-fast", { provider: "xai" });
    expect(flash.cost.usd).toBeCloseTo(0.3 + 1.2, 8);
    expect(account.cost.usd).toBeCloseTo(0.3 + 1.2, 8);
    expect(geminiName.cost.usd).toBeCloseTo(0.75 + 3.75, 8);
    expect(grok.pricing?.output).toBe(12);
    expect(grok.cost.usd).toBeCloseTo((250_000 * 4 + 1_000_000 * 12) / 1e6, 8);
    expect(routed.pricing?.input).toBe(4);
    expect(routed.cost.usd).toBeCloseTo(4 + 12, 8);
  });
});
