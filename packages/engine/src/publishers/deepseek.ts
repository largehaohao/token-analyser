import type { ParsedRate, PublisherSpec } from "../price-catalog.ts";
import { markdownTables, parseMoney } from "./markdown.ts";

type Window = "peak" | "off-peak";
type Kind = "hit" | "miss" | "output";

function windowOf(cell: string): Window | null {
  const label = cell.trim().toLowerCase();
  if (label === "peak") return "peak";
  if (label === "off-peak") return "off-peak";
  return null;
}

function kindOf(cell: string): Kind | null {
  const label = cell.toLowerCase();
  if (label.includes("cache hit")) return "hit";
  if (label.includes("cache miss")) return "miss";
  if (label.includes("output")) return "output";
  return null;
}

/**
 * DeepSeek publishes peak and off-peak USD rates in one table. The catalog
 * keeps both, and the declared default tier (peak) is what quotes use: the
 * off-peak window depends on UTC hours and Chinese holidays, which a session
 * log does not record.
 */
export function parseDeepseekPricing(
  markdown: string,
  spec: PublisherSpec,
): Record<string, ParsedRate> {
  const tables = markdownTables(markdown);
  const table = tables.find((rows) =>
    rows.some((row) => row.some((cell) => /deepseek-/i.test(cell))),
  );
  if (!table) throw new Error("deepseek_pricing_format_changed");

  const header = table.find((row) =>
    Object.values(spec.models).some((model) =>
      row.some((cell) => cell.toLowerCase().startsWith(model.match.toLowerCase())),
    ),
  );
  if (!header) throw new Error("deepseek_pricing_format_changed");

  const columns = new Map<string, number>();
  for (const [id, model] of Object.entries(spec.models)) {
    const index = header.findIndex((cell) =>
      cell.toLowerCase().startsWith(model.match.toLowerCase()),
    );
    if (index < 0) throw new Error("deepseek_pricing_format_changed");
    columns.set(id, index);
  }

  const found = new Map<string, { peak: Partial<Record<Kind, number>>; off: Partial<Record<Kind, number>> }>();
  for (const id of columns.keys()) found.set(id, { peak: {}, off: {} });

  for (const row of table) {
    const kind = kindOf(row[1] ?? "");
    const window = windowOf(row[2] ?? "");
    if (!kind || !window) continue;
    for (const [id, index] of columns) {
      const amount = parseMoney(row[index] ?? "");
      if (amount == null) throw new Error("deepseek_pricing_format_changed");
      const bucket = found.get(id)!;
      const target = window === "peak" ? bucket.peak : bucket.off;
      target[kind] = amount;
    }
  }

  const rates: Record<string, ParsedRate> = {};
  for (const [id, bucket] of found) {
    const peak = bucket.peak;
    const off = bucket.off;
    if (
      peak.hit == null || peak.miss == null || peak.output == null ||
      off.hit == null || off.miss == null || off.output == null
    ) {
      throw new Error("deepseek_pricing_format_changed");
    }
    rates[id] = {
      input: peak.miss,
      cached: peak.hit,
      output: peak.output,
      tier: spec.default_tier || "peak",
      off_peak: { input: off.miss, cached: off.hit, output: off.output },
    };
  }
  return rates;
}
