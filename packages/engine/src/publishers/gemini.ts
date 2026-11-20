import type { ParsedRate, PublisherSpec } from "../price-catalog.ts";
import { decodeEntities, selectUsd } from "./markdown.ts";

function sectionFor(markdown: string, id: string): string {
  const decoded = decodeEntities(markdown);
  const heading = new RegExp(`^##[^\n]*id="${id}"`, "m");
  const match = heading.exec(decoded);
  if (!match) throw new Error("gemini_pricing_format_changed");
  const from = match.index;
  const next = decoded.indexOf("\n## ", from + 3);
  return next < 0 ? decoded.slice(from) : decoded.slice(from, next);
}

function standardTab(section: string): string {
  const start = section.search(/\{%\s*tab\s+title="Standard"\s*%\}/i);
  if (start < 0) return section;
  const end = section.indexOf("{% /tab %}", start);
  return end < 0 ? section.slice(start) : section.slice(start, end);
}

function listRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const chunk of section.split(/\n\s*---\s*\n/)) {
    const cells: string[] = [];
    let current: string | null = null;
    for (const line of chunk.split(/\n/)) {
      const bullet = line.match(/^\s*\*\s?(.*)$/);
      if (bullet && /^\s*\*\s?/.test(line)) {
        if (current != null) cells.push(current.trim());
        current = bullet[1] ?? "";
      } else if (current != null) {
        current = `${current}\n${line.trim()}`;
      }
    }
    if (current != null) cells.push(current.trim());
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

function featureCell(rows: string[][], label: string): string | null {
  const wanted = label.toLowerCase();
  const labels = rows.map((cells) => cells[0]?.replace(/\s+/g, " ").trim().toLowerCase() ?? "");
  const exact = labels.findIndex((text) => text === wanted);
  const index = exact >= 0 ? exact : labels.findIndex((text) => text.startsWith(wanted));
  const row = index >= 0 ? rows[index] : undefined;
  return row?.[row.length - 1] ?? null;
}

/**
 * Gemini's paid Standard tier is the quote. Promotional end dates are applied
 * at update time. Batch, Flex, Priority, audio-only, and cache-storage prices
 * are not the rates a normal text request pays.
 */
export function parseGeminiPricing(
  markdown: string,
  spec: PublisherSpec,
  now: Date,
): Record<string, ParsedRate> {
  const rates: Record<string, ParsedRate> = {};
  for (const [id, model] of Object.entries(spec.models)) {
    const rows = listRows(standardTab(sectionFor(markdown, model.match)));
    const input = selectUsd(featureCell(rows, "input price") ?? "", now);
    const cached = selectUsd(featureCell(rows, "context caching price") ?? "", now);
    const output = selectUsd(featureCell(rows, "output price") ?? "", now);
    if (input == null || cached == null || output == null) {
      throw new Error("gemini_pricing_format_changed");
    }
    rates[id] = { input, cached, output, tier: spec.default_tier || "standard" };
  }
  return rates;
}
