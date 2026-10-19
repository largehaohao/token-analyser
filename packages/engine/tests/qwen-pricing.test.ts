import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isQwenPriceCardStale,
  qwenPriceAsOf,
  startQwenPriceAutoRefresh,
  updateQwenPricesFromOfficial,
} from "../src/qwen-pricing.ts";
import {
  apiRateForModel,
  loadApiPrices,
  nativeCost,
  type ApiPrices,
} from "../src/native-pricing.ts";
import type { TokenUsage } from "../src/types.ts";

const OFFICIAL_MARKDOWN = readFileSync(
  path.join(import.meta.dirname, "fixtures/qwen-pricing.md"),
  "utf8",
);

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "qwen-pricing-"));
  dirs.push(dir);
  return dir;
}

function writeCard(dir: string, card: ApiPrices): string {
  const file = path.join(dir, "api-prices.json");
  writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`);
  return file;
}

function baseCard(): ApiPrices {
  return {
    as_of: "2026-01-01",
    models: {
      "claude-sonnet-4-6": { input: 3, cached: 0.3, output: 15 },
      "qwen3.8-flash-next": { input: 9, cached: 0.9, output: 9 },
    },
    qwen: {
      as_of: "2026-01-01",
      source: "https://help.aliyun.com/zh/model-studio/model-pricing",
      cache_rule_source: "https://help.aliyun.com/zh/model-studio/model-pricing",
      cache_hit_ratio: 0.2,
      cache_write_ratio: 1.25,
      usd_per_cny: 0.1,
      usd_per_cny_source: "test conversion rate",
      models: {
        "qwen3.8-flash-next": {
          display: "qwen3.8-flash",
          section: "千问Flash",
          region: "华北2（北京）",
          aliases: ["swift-1.5-iq3_xxs"],
        },
      },
    },
  };
}

function officialFetcher(body = OFFICIAL_MARKDOWN): typeof fetch {
  return async () =>
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1_000_000,
    reasoning_output_tokens: 0,
    total_tokens: 2_000_000,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.TOKEN_ANALYSER_HOME;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("Qwen official price updates", () => {
  it("reads the Beijing flash rates, converts CNY to USD, and keeps other entries", async () => {
    const dir = tempDir();
    const cardPath = writeCard(dir, baseCard());

    const update = await updateQwenPricesFromOfficial({
      apiPricesPath: cardPath,
      fetcher: officialFetcher(),
    });

    const written = JSON.parse(readFileSync(cardPath, "utf8")) as ApiPrices;
    expect(written.models["claude-sonnet-4-6"]).toEqual({
      input: 3,
      cached: 0.3,
      output: 15,
    });
    expect(written.models["qwen3.8-flash-next"]).toEqual({
      input: 0.08,
      cached: 0.008,
      output: 0.27,
      cache_write_multiplier: 1.25,
    });
    expect(written.qwen?.as_of).toBe(localToday());
    expect(written.qwen?.cache_hit_ratio).toBe(0.1);
    expect(update.asOf).toBe(localToday());
    expect(update.modelCount).toBe(1);
    expect(written.qwen?.models["qwen3.8-flash-next"]).toMatchObject({
      display: "qwen3.8-flash",
      tier: "0<Token≤1M",
      aliases: ["swift-1.5-iq3_xxs"],
      cny: { input: 0.8, cached: 0.08, output: 2.7 },
    });
  });

  it("prefers the Beijing tab over the Singapore tab for the same model", async () => {
    const dir = tempDir();
    const cardPath = writeCard(dir, baseCard());

    await updateQwenPricesFromOfficial({
      apiPricesPath: cardPath,
      fetcher: officialFetcher(),
    });

    const written = JSON.parse(readFileSync(cardPath, "utf8")) as ApiPrices;
    // Singapore qwen3.8-flash is 1.094 CNY input; Beijing is 0.8 CNY.
    expect(written.models["qwen3.8-flash-next"]?.input).toBe(0.08);
  });

  it("reads a published cache-hit column when the table carries one", async () => {
    const dir = tempDir();
    const card = baseCard();
    card.qwen!.models["qwen3.8-omni-flash"] = {
      display: "qwen3.8-omni-flash",
      section: "千问Omni",
      region: "华北2（北京）",
    };
    const cardPath = writeCard(dir, card);

    await updateQwenPricesFromOfficial({
      apiPricesPath: cardPath,
      fetcher: officialFetcher(),
    });

    const written = JSON.parse(readFileSync(cardPath, "utf8")) as ApiPrices;
    expect(written.models["qwen3.8-omni-flash"]).toMatchObject({
      input: 0.08,
      cached: 0.01,
      output: 0.27,
    });
  });

  it("applies the CNY conversion rate from the local config file", async () => {
    const dir = tempDir();
    process.env.TOKEN_ANALYSER_HOME = dir;
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ watch_paths: [], usd_per_cny: 0.2 }),
    );
    const cardPath = writeCard(dir, baseCard());

    const update = await updateQwenPricesFromOfficial({
      apiPricesPath: cardPath,
      fetcher: officialFetcher(),
    });

    const written = JSON.parse(readFileSync(cardPath, "utf8")) as ApiPrices;
    expect(update.usdPerCny).toBe(0.2);
    expect(written.models["qwen3.8-flash-next"]).toMatchObject({
      input: 0.16,
      cached: 0.016,
      output: 0.54,
    });
    expect(written.qwen?.usd_per_cny_source).toContain("config.json");
  });

  it("keeps the local card when the official page is unreachable", async () => {
    const dir = tempDir();
    const cardPath = writeCard(dir, baseCard());
    const before = readFileSync(cardPath, "utf8");

    await expect(
      updateQwenPricesFromOfficial({
        apiPricesPath: cardPath,
        fetcher: async () => new Response("down", { status: 503 }),
      }),
    ).rejects.toThrow("qwen_pricing_unavailable");
    expect(readFileSync(cardPath, "utf8")).toBe(before);
  });

  it("keeps the local card when the official table drops a priced model", async () => {
    const dir = tempDir();
    const card = baseCard();
    card.qwen!.models["qwen-not-listed"] = {
      display: "qwen-not-listed",
      section: "千问Flash",
      region: "华北2（北京）",
    };
    const cardPath = writeCard(dir, card);
    const before = readFileSync(cardPath, "utf8");

    await expect(
      updateQwenPricesFromOfficial({
        apiPricesPath: cardPath,
        fetcher: officialFetcher(),
      }),
    ).rejects.toThrow("qwen_pricing_format_changed");
    expect(readFileSync(cardPath, "utf8")).toBe(before);
  });

  it("keeps the local card when the cache discount note disappears", async () => {
    const dir = tempDir();
    const card = baseCard();
    // The card's fallback ratios are dropped, so a missing page note is fatal.
    card.qwen = Object.fromEntries(
      Object.entries(card.qwen!).filter(
        ([key]) => key !== "cache_hit_ratio" && key !== "cache_write_ratio",
      ),
    ) as ApiPrices["qwen"];
    const cardPath = writeCard(dir, card);

    await expect(
      updateQwenPricesFromOfficial({
        apiPricesPath: cardPath,
        fetcher: officialFetcher(OFFICIAL_MARKDOWN.replace(/创建按标准输入单价的 125% 计费、命中按 10% 计费/, "")),
      }),
    ).rejects.toThrow("qwen_pricing_format_changed");
  });

  it("treats a card dated today as fresh", () => {
    expect(isQwenPriceCardStale("")).toBe(true);
    expect(isQwenPriceCardStale("2026-01-01")).toBe(true);
    expect(isQwenPriceCardStale(localToday())).toBe(false);
  });

  it("reads the dated Qwen section from the card", () => {
    const dir = tempDir();
    const cardPath = writeCard(dir, baseCard());
    expect(qwenPriceAsOf(cardPath)).toBe("2026-01-01");
  });

  it("refreshes local pricing automatically and stops on demand", async () => {
    const dir = tempDir();
    const cardPath = writeCard(dir, baseCard());
    let refreshed = 0;
    let updated: { asOf: string; modelCount: number } | null = null;
    const store = { refreshPricing: () => (refreshed += 1) };
    const update = async () => ({
      asOf: localToday(),
      modelCount: 1,
      usdPerCny: 0.1,
      previousContent: "",
    });

    const stop = startQwenPriceAutoRefresh(store as never, {
      apiPricesPath: cardPath,
      update,
      onUpdate: (result) => (updated = result),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshed).toBe(1);
    expect(updated).toEqual({ asOf: localToday(), modelCount: 1 });
    stop();
  });

  it("skips a tick that would overlap one still in flight", async () => {
    const dir = tempDir();
    const cardPath = writeCard(dir, baseCard());
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = startQwenPriceAutoRefresh(
      { refreshPricing: () => undefined } as never,
      {
        intervalMs: 15,
        apiPricesPath: cardPath,
        update: async () => {
          calls += 1;
          await gate;
          return {
            asOf: localToday(),
            modelCount: 1,
            usdPerCny: 0.1,
            previousContent: readFileSync(cardPath, "utf8"),
          };
        },
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(1);
    } finally {
      release();
      stop();
    }
  });

  it("restores the price file when re-pricing sessions fails", async () => {
    const dir = tempDir();
    const cardPath = writeCard(dir, baseCard());
    const before = readFileSync(cardPath, "utf8");
    const errors: string[] = [];
    const stop = startQwenPriceAutoRefresh(
      {
        refreshPricing: () => {
          throw new Error("reprice_failed");
        },
      } as never,
      {
        apiPricesPath: cardPath,
        onError: (reason) => errors.push(reason),
        update: async () => {
          writeFileSync(cardPath, '{"models":{}}\n');
          return {
            asOf: localToday(),
            modelCount: 1,
            usdPerCny: 0.1,
            previousContent: before,
          };
        },
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(readFileSync(cardPath, "utf8")).toBe(before);
      expect(errors).toEqual(["reprice_failed"]);
    } finally {
      stop();
    }
  });

  it("disables automatic refresh when QWEN_PRICING_AUTO_UPDATE is 0", () => {
    process.env.QWEN_PRICING_AUTO_UPDATE = "0";
    try {
      let refreshed = 0;
      const stop = startQwenPriceAutoRefresh(
        { refreshPricing: () => (refreshed += 1) } as never,
        { apiPricesPath: writeCard(tempDir(), baseCard()) },
      );
      stop();
      expect(refreshed).toBe(0);
    } finally {
      delete process.env.QWEN_PRICING_AUTO_UPDATE;
    }
  });
});

describe("Qwen model pricing lookups", () => {
  it("prices the swift alias with the canonical Qwen rates", () => {
    const prices = loadApiPrices();
    const canonical = prices.models["qwen3.8-flash-next"];
    expect(canonical).toBeDefined();
    expect(apiRateForModel("swift-1.5-iq3_xxs", prices)).toEqual(canonical);

    const priced = nativeCost(usage(), "swift-1.5-iq3_xxs", { provider: "qwen" });
    expect(priced.pricing?.unit).toBe("usd");
    expect(priced.pricing?.input).toBe(canonical!.input);
    expect(priced.cost.usd).toBeCloseTo(canonical!.input + canonical!.output, 8);
  });

  it("prices every provider for a model ID declared as an official alias", () => {
    const canonical = loadApiPrices().models["qwen3.8-flash-next"]!;
    for (const provider of ["qwen", "strata", "openrouter", undefined]) {
      const priced = nativeCost(usage(), "swift-1.5-iq3_xxs", { provider });
      expect(priced.pricing?.input, provider).toBe(canonical.input);
      expect(priced.cost.usd).toBeCloseTo(canonical.input + canonical.output, 8);
    }
  });

  it("keeps a recorded non-zero spend ahead of the estimate", () => {
    const recorded = nativeCost(usage(), "swift-1.5-iq3_xxs", {
      provider: "qwen",
      recordedUsd: 1.25,
    });
    expect(recorded.cost.usd).toBe(1.25);
    expect(recorded.pricing).toBeNull();
  });

  it("estimates a relay that bills nothing and records 0", () => {
    const canonical = loadApiPrices().models["qwen3.8-flash-next"]!;
    const zero = nativeCost(usage(), "swift-1.5-iq3_xxs", {
      provider: "strata",
      recordedUsd: 0,
    });
    expect(zero.pricing?.unit).toBe("usd");
    expect(zero.cost.usd).toBeCloseTo(canonical.input + canonical.output, 8);
  });

  it("does not borrow first-party rates for a provider outside the priced list", () => {
    const relayed = nativeCost(usage(), "claude-sonnet-4-6", {
      provider: "openrouter",
    });
    expect(relayed.pricing).toBeNull();
    expect(relayed.cost.usd).toBeNull();
  });
});
