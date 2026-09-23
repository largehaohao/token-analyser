import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateRateCardFromOfficial } from "../src/pricing-update.ts";
import { SessionStore } from "../src/store.ts";
import { startServer } from "../src/server.ts";
import type { RateCard } from "../src/types.ts";

const OFFICIAL_PRICING = `
#### Token rates
<table>
  <thead>
    <tr>
      <th scope="col">Credits per 1M tokens</th>
      <th scope="col">Input Tokens</th>
      <th scope="col">Cached input tokens</th>
      <th scope="col">Output Tokens</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>GPT-6 Astra</td><td>250 credits</td><td>25 credits</td><td>1,250 credits</td></tr>
    <tr><td>GPT-6 Sol</td><td>50 credits</td><td>5 credits</td><td>250 credits</td></tr>
    <tr><td>GPT-6 Luna</td><td>2.5 credits</td><td>0.25 credits</td><td>12.5 credits</td></tr>
    <tr><td>GPT-5.6 Sol</td><td>100 credits</td><td>10 credits</td><td>500 credits</td></tr>
    <tr><td>Daybreak Red</td><td>312.5 credits</td><td>31.25 credits</td><td>1,875 credits</td></tr>
    <tr><td>GPT-5.4 mini</td><td>18.75 credits</td><td>1.875 credits</td><td>113 credits</td></tr>
  </tbody>
</table>
`;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "pricing-update-"));
  tempDirs.push(directory);
  return directory;
}

function writeRateCard(filePath: string, card: RateCard): string {
  const content = `${JSON.stringify(card, null, 2)}\n`;
  writeFileSync(filePath, content);
  return content;
}

function baseRateCard(): RateCard {
  return {
    as_of: "2026-01-01",
    source: "https://example.com/old-pricing",
    usd_per_credit: 0.04,
    usd_per_credit_source: "local conversion",
    fast_multiplier: 2.5,
    models: {
      "gpt-5.6": { input: 1, cached: 0.1, output: 2 },
      "gpt-5.4-mini": {
        input: 1,
        cached: 0.1,
        output: 2,
        fast_multiplier: 2,
      },
      "legacy-model": { input: 3, cached: 0.3, output: 6 },
    },
  };
}

function mockedFetch(markdown = OFFICIAL_PRICING): typeof fetch {
  return async () =>
    new Response(markdown, {
      status: 200,
      headers: { "content-type": "text/markdown" },
    });
}

afterEach(() => {
  delete process.env.TOKEN_ANALYSER_HOME;
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("updateRateCardFromOfficial", () => {
  it("updates official model rates and preserves local conversion settings", async () => {
    const directory = makeTempDir();
    const rateCardPath = path.join(directory, "rate-card.json");
    const previousContent = writeRateCard(rateCardPath, baseRateCard());

    const result = await updateRateCardFromOfficial({
      rateCardPath,
      fetcher: mockedFetch(),
      now: new Date(2026, 8, 23, 12),
    });
    const updated = JSON.parse(readFileSync(rateCardPath, "utf8")) as RateCard;

    expect(result).toEqual({
      asOf: "2026-09-23",
      modelCount: 6,
      previousContent,
    });
    expect(updated.source).toBe("https://developers.openai.com/codex/pricing");
    expect(updated.usd_per_credit).toBe(0.04);
    expect(updated.usd_per_credit_source).toBe("local conversion");
    expect(updated.fast_multiplier).toBe(2.5);
    expect(updated.models["gpt-6-astra"]).toEqual({
      input: 250,
      cached: 25,
      output: 1250,
    });
    expect(updated.models["gpt-5.6"]).toEqual({
      input: 100,
      cached: 10,
      output: 500,
    });
    expect(updated.models["gpt-5.6-sol"]).toEqual({
      input: 100,
      cached: 10,
      output: 500,
    });
    expect(updated.models["gpt-5.6-cyber"]).toEqual({
      input: 312.5,
      cached: 31.25,
      output: 1875,
    });
    expect(updated.models["gpt-5.4-mini"]).toEqual({
      input: 18.75,
      cached: 1.875,
      output: 113,
      fast_multiplier: 2,
    });
    expect(updated.models["legacy-model"]).toEqual({
      input: 3,
      cached: 0.3,
      output: 6,
    });
  });

  it("leaves the local file unchanged when the official table cannot be parsed", async () => {
    const directory = makeTempDir();
    const rateCardPath = path.join(directory, "rate-card.json");
    const previousContent = writeRateCard(rateCardPath, baseRateCard());

    await expect(
      updateRateCardFromOfficial({
        rateCardPath,
        fetcher: mockedFetch("#### Token rates\nNo pricing table"),
      }),
    ).rejects.toThrow("official_pricing_format_changed");
    expect(readFileSync(rateCardPath, "utf8")).toBe(previousContent);
  });

  it("updates through the local HTTP endpoint", async () => {
    const directory = makeTempDir();
    process.env.TOKEN_ANALYSER_HOME = directory;
    const rateCardPath = path.join(directory, "rate-card.json");
    writeRateCard(rateCardPath, baseRateCard());
    const store = new SessionStore({ cacheDir: path.join(directory, "cache") });
    const server = await startServer({
      port: 0,
      store,
      pricingUpdate: {
        rateCardPath,
        fetcher: mockedFetch(),
        now: new Date(2026, 8, 23, 12),
      },
    });

    try {
      const response = await fetch(`${server.url}/pricing/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        asOf: "2026-09-23",
        modelCount: 6,
      });
      const updated = JSON.parse(readFileSync(rateCardPath, "utf8")) as RateCard;
      expect(updated.models["gpt-6-sol"]).toEqual({
        input: 50,
        cached: 5,
        output: 250,
      });
    } finally {
      await server.close();
    }
  });
});
