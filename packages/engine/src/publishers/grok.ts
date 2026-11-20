import type { ParsedRate, PublisherSpec } from "../price-catalog.ts";
import { markdownTables, parseMoney } from "./markdown.ts";

function thresholdTokens(cell: string): number | null {
  const match = cell.match(/(\d+(?:\.\d+)?)\s*k/i);
  if (!match) return null;
  return Number(match[1]) * 1000;
}

function tierOf(cell: string): "short" | "long" | null {
  if (/≥|[>]=/.test(cell)) return "long";
  if (/</.test(cell)) return "short";
  return null;
}

/**
 * xAI lists two context tiers. The short tier is the quote default. The long
 * tier applies only when the logged prompt is at least the published threshold.
 */
export function parseGrokPricing(
  markdown: string,
  spec: PublisherSpec,
): Record<string, ParsedRate> {
  const table = markdownTables(markdown).find((rows) => {
    const header = rows[0]?.map((cell) => cell.toLowerCase()) ?? [];
    return header.some((cell) => cell.includes("cached")) && header.some((cell) => cell.includes("output"));
  });
  if (!table) throw new Error("grok_pricing_format_changed");

  const header = table[0]!.map((cell) => cell.toLowerCase());
  const inputCol = header.findIndex((cell) => cell.includes("input") && !cell.includes("cached"));
  const cachedCol = header.findIndex((cell) => cell.includes("cached"));
  const outputCol = header.findIndex((cell) => cell.includes("output"));
  if (inputCol < 0 || cachedCol < 0 || outputCol < 0) {
    throw new Error("grok_pricing_format_changed");
  }

  const rates: Record<string, ParsedRate> = {};
  for (const [id, model] of Object.entries(spec.models)) {
    const rows = table.filter((row) =>
      (row[0] ?? "").toLowerCase().startsWith(model.match.toLowerCase()),
    );
    const short = rows.find((row) => tierOf(row[0] ?? "") === "short");
    const long = rows.find((row) => tierOf(row[0] ?? "") === "long");
    if (!short || !long) throw new Error("grok_pricing_format_changed");
    const input = parseMoney(short[inputCol] ?? "");
    const cached = parseMoney(short[cachedCol] ?? "");
    const output = parseMoney(short[outputCol] ?? "");
    const longInput = parseMoney(long[inputCol] ?? "");
    const longCached = parseMoney(long[cachedCol] ?? "");
    const longOutput = parseMoney(long[outputCol] ?? "");
    const fromTokens = thresholdTokens(long[0] ?? "");
    if (
      input == null || cached == null || output == null ||
      longInput == null || longCached == null || longOutput == null ||
      fromTokens == null
    ) {
      throw new Error("grok_pricing_format_changed");
    }
    rates[id] = {
      input,
      cached,
      output,
      tier: spec.default_tier || "short",
      long_context: {
        from_tokens: fromTokens,
        input: longInput,
        cached: longCached,
        output: longOutput,
      },
    };
  }
  return rates;
}
