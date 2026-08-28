import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { effectiveRateCard, loadRateCard, priceUsage } from "../src/rate-card.ts";
import { addCost } from "../src/types.ts";

const cardPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/rate-card.json",
);

describe("rate card", () => {
  it("keeps aggregate money unknown when any child is unpriced", () => {
    const known = { raw: 1, uncached_input: 1, cached_input: 0, output: 0, credits: 2, usd: 3 };
    const unknown = { raw: 1, uncached_input: 1, cached_input: 0, output: 0, credits: null, usd: null };
    expect(addCost(known, unknown).credits).toBeNull();
    expect(addCost(known, unknown).usd).toBeNull();
  });

  it("prices Sol uncached/cached/output per 1M", () => {
    const card = loadRateCard(cardPath);
    const cost = priceUsage(
      {
        input_tokens: 1_000_000,
        cached_input_tokens: 400_000,
        cache_write_input_tokens: 0,
        output_tokens: 1_000_000,
        reasoning_output_tokens: 10,
        total_tokens: 2_000_000,
      },
      "gpt-5.6-sol",
      card,
      false,
    );
    // uncached = 600_000 → 0.6 * 125 = 75
    // cached   = 400_000 → 0.4 * 12.5 = 5
    // output   = 1_000_000 → 750
    expect(cost.raw).toBe(2_000_000);
    expect(cost.uncached_input).toBe(600_000);
    expect(cost.credits).toBeCloseTo(830, 5);
    expect(cost.usd).toBeCloseTo(33.2, 5);
  });

  it("returns null credits for unknown models", () => {
    const card = loadRateCard(cardPath);
    const cost = priceUsage(
      {
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 10,
        reasoning_output_tokens: 0,
        total_tokens: 110,
      },
      "mystery-model",
      card,
      false,
    );
    expect(cost.raw).toBe(110);
    expect(cost.credits).toBeNull();
    expect(cost.usd).toBeNull();
  });

  it("applies fast multiplier only when fastMode is true", () => {
    const card = loadRateCard(cardPath);
    const usage = {
      input_tokens: 1_000_000,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1_000_000,
    };
    const slow = priceUsage(usage, "gpt-5.6-sol", card, false);
    const fast = priceUsage(usage, "gpt-5.6-sol", card, true);
    expect(slow.credits).toBeCloseTo(125, 5);
    expect(fast.credits).toBeCloseTo(312.5, 5);
  });

  describe("usd_per_credit override", () => {
    afterEach(() => {
      delete process.env.TOKEN_ANALYSER_HOME;
    });

    it("uses the shipped rate card when config.json is absent", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "rate-home-"));
      process.env.TOKEN_ANALYSER_HOME = dir;
      const shipped = loadRateCard(cardPath);
      const card = effectiveRateCard(cardPath);
      expect(card.usd_per_credit).toBe(shipped.usd_per_credit);
    });

    it("applies usd_per_credit from TOKEN_ANALYSER_HOME config.json", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "rate-home-"));
      process.env.TOKEN_ANALYSER_HOME = dir;
      writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ usd_per_credit: 1 }),
      );
      const card = effectiveRateCard(cardPath);
      expect(card.usd_per_credit).toBe(1);
      const cost = priceUsage(
        {
          input_tokens: 1_000_000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 1_000_000,
        },
        "gpt-5.6-sol",
        card,
        false,
      );
      expect(cost.credits).toBeCloseTo(125, 5);
      expect(cost.usd).toBeCloseTo(125, 5);
    });
  });
});
