import { loadApiPrices, type ApiModelPrice } from "./native-pricing.ts";
import { isPriceIgnored, loadIgnoredPrices, type IgnoredPriceState } from "./price-ignore.ts";
import { loadPriceCatalog, type CatalogModel } from "./price-catalog.ts";
import { loadRateCard } from "./rate-card.ts";
import type { RateCard } from "./types.ts";

export type PriceSheetRow = {
  id: string;
  input: number;
  cached: number;
  output: number;
  note: string;
};

export type PriceSheetGroup = {
  id: string;
  label: string;
  asOf: string;
  unit: "credits" | "usd";
  /** Shown next to the group, e.g. "积分 / 百万 token". */
  unitLabel: string;
  note: string;
  rows: PriceSheetRow[];
};

export type IgnoredPriceEntry = {
  group: string;
  label: string;
  model: string;
};

export type PriceSheet = {
  groups: PriceSheetGroup[];
  ignored: IgnoredPriceEntry[];
};

const SOURCE_ORDER = ["deepseek", "grok", "gemini"];

const GROUP_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  openai: "OpenAI",
  qwen: "千问",
  deepseek: "DeepSeek",
  grok: "Grok",
  gemini: "Gemini",
};

function ignoredEntries(state: IgnoredPriceState): IgnoredPriceEntry[] {
  return Object.entries(state.groups).flatMap(([group, models]) =>
    models.map((model) => ({
      group,
      label: GROUP_LABELS[group] ?? group,
      model,
    })),
  );
}

function rateRow(id: string, rate: { input: number; cached: number; output: number }, note = ""): PriceSheetRow {
  return { id, input: rate.input, cached: rate.cached, output: rate.output, note };
}

function formatRate(value: number): string {
  return String(Number(value.toFixed(6)));
}

function catalogNote(model: CatalogModel): string {
  const parts: string[] = [];
  if (model.tier === "peak") parts.push("高峰");
  if (model.off_peak) {
    parts.push(
      `低峰 ${formatRate(model.off_peak.input)} / ${formatRate(model.off_peak.cached)} / ${formatRate(model.off_peak.output)}`,
    );
  }
  if (model.long_context) {
    const thousands = model.long_context.from_tokens / 1000;
    parts.push(
      `≥${thousands}k ${formatRate(model.long_context.input)} / ${formatRate(model.long_context.cached)} / ${formatRate(model.long_context.output)}`,
    );
  }
  return parts.join(" · ");
}

function apiNote(rate: ApiModelPrice): string {
  const parts: string[] = [];
  if (rate.fast_multiplier) parts.push(`Fast ×${rate.fast_multiplier}`);
  if (rate.cache_write_multiplier && rate.cache_write_multiplier !== 1) {
    parts.push(`缓存写入 ×${rate.cache_write_multiplier}`);
  }
  return parts.join(" · ");
}

function codexNote(card: RateCard, rate: RateCard["models"][string]): string {
  if (rate.fast_multiplier && rate.fast_multiplier !== card.fast_multiplier) {
    return `Fast ×${rate.fast_multiplier}`;
  }
  return "";
}

function byId(rows: PriceSheetRow[]): PriceSheetRow[] {
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

/** The rates the ledger actually uses, grouped for the overview price sheet. */
export function buildPriceSheet(ignored: IgnoredPriceState = loadIgnoredPrices()): PriceSheet {
  const card = loadRateCard();
  const prices = loadApiPrices();
  const catalog = loadPriceCatalog();
  const catalogIds = new Set(Object.keys(catalog.models));
  const visible = (group: string, id: string) => !isPriceIgnored(ignored, { group, model: id });
  const groups: PriceSheetGroup[] = [];

  groups.push({
    id: "codex",
    label: "Codex",
    asOf: card.as_of,
    unit: "credits",
    unitLabel: "积分 / 百万 token",
    note: `Fast 模式按标价 ×${card.fast_multiplier}。1 积分 = $${card.usd_per_credit}。`,
    rows: byId(Object.entries(card.models)
      .filter(([id]) => visible("codex", id))
      .map(([id, rate]) => rateRow(id, rate, codexNote(card, rate)))),
  });

  const claude: PriceSheetRow[] = [];
  const openai: PriceSheetRow[] = [];
  const qwen: PriceSheetRow[] = [];
  for (const [id, rate] of Object.entries(prices.models)) {
    if (catalogIds.has(id)) continue;
    const group = prices.qwen?.models[id] || id.startsWith("qwen") ? "qwen" : id.startsWith("claude-") ? "claude" : "openai";
    if (!visible(group, id)) continue;
    const row = rateRow(id, rate, apiNote(rate));
    if (group === "claude") claude.push(row);
    else if (group === "qwen") qwen.push(row);
    else openai.push(row);
  }

  const apiAsOf = prices.as_of;
  if (claude.length > 0) {
    groups.push({
      id: "claude",
      label: "Claude",
      asOf: apiAsOf,
      unit: "usd",
      unitLabel: "美元 / 百万 token",
      note: "",
      rows: byId(claude),
    });
  }
  if (openai.length > 0) {
    groups.push({
      id: "openai",
      label: "OpenAI",
      asOf: apiAsOf,
      unit: "usd",
      unitLabel: "美元 / 百万 token",
      note: "",
      rows: byId(openai),
    });
  }
  if (qwen.length > 0) {
    groups.push({
      id: "qwen",
      label: "千问",
      asOf: prices.qwen?.as_of || apiAsOf,
      unit: "usd",
      unitLabel: "美元 / 百万 token",
      note: "由人民币官方价按配置汇率换算。",
      rows: byId(qwen),
    });
  }

  const catalogGroups = new Map<string, PriceSheetRow[]>();
  for (const [id, model] of Object.entries(catalog.models)) {
    if (!visible(model.source, id)) continue;
    const rows = catalogGroups.get(model.source) ?? [];
    rows.push(rateRow(id, model, catalogNote(model)));
    catalogGroups.set(model.source, rows);
  }
  const sourceIds = [
    ...SOURCE_ORDER.filter((id) => catalogGroups.has(id)),
    ...[...catalogGroups.keys()].filter((id) => !SOURCE_ORDER.includes(id)).sort(),
  ];
  for (const sourceId of sourceIds) {
    const source = catalog.sources[sourceId];
    groups.push({
      id: sourceId,
      label: source?.label ?? sourceId,
      asOf: source?.as_of ?? catalog.as_of,
      unit: "usd",
      unitLabel: "美元 / 百万 token",
      note: "",
      rows: byId(catalogGroups.get(sourceId) ?? []),
    });
  }

  return { groups, ignored: ignoredEntries(ignored) };
}
