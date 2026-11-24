import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-write.ts";
import { tokenAnalyserHome } from "./config.ts";

export type IgnoredPriceScope = { group: string; model: string };

export type IgnoredPriceState = {
  version: 1;
  models: string[];
  groups: Record<string, string[]>;
};

export type PriceIgnoreOptions = {
  filePath?: string;
};

export const PRICE_IGNORE_FILE = "ignored-prices.json";

export function priceIgnorePath(): string {
  return path.join(tokenAnalyserHome(), PRICE_IGNORE_FILE);
}

export function priceIgnoreKey(scope: IgnoredPriceScope): string {
  return `${scope.group}:${scope.model}`;
}

function emptyState(): IgnoredPriceState {
  return { version: 1, models: [], groups: {} };
}

function normalize(value: unknown): IgnoredPriceState {
  if (!value || typeof value !== "object") return emptyState();
  const record = value as Partial<IgnoredPriceState>;
  const models = Array.isArray(record.models)
    ? [...new Set(record.models.filter((id): id is string => typeof id === "string" && id.length > 0))].sort()
    : [];
  const groups: Record<string, string[]> = {};
  if (record.groups && typeof record.groups === "object") {
    for (const [group, ids] of Object.entries(record.groups)) {
      if (!group || !Array.isArray(ids)) continue;
      const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))].sort();
      if (unique.length > 0) groups[group] = unique;
    }
  }
  return {
    version: 1,
    models,
    groups: Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function loadIgnoredPrices(options?: PriceIgnoreOptions): IgnoredPriceState {
  const filePath = options?.filePath ?? priceIgnorePath();
  if (!existsSync(filePath)) return emptyState();
  try {
    return normalize(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return emptyState();
  }
}

export function saveIgnoredPrices(
  state: IgnoredPriceState,
  options?: PriceIgnoreOptions,
): void {
  const filePath = options?.filePath ?? priceIgnorePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomically(filePath, `${JSON.stringify(normalize(state), null, 2)}\n`);
}

export function isPriceIgnored(
  state: IgnoredPriceState,
  scope: IgnoredPriceScope,
): boolean {
  return state.models.includes(scope.model) ||
    (state.groups[scope.group] ?? []).includes(scope.model);
}

export function ignorePrice(
  scope: IgnoredPriceScope,
  options?: PriceIgnoreOptions,
): IgnoredPriceState {
  const state = loadIgnoredPrices(options);
  const key = priceIgnoreKey(scope);
  const models = state.models.includes(scope.model)
    ? state.models
    : [...state.models, scope.model].sort();
  const groupModels = state.groups[scope.group] ?? [];
  const groups = groupModels.includes(scope.model)
    ? state.groups
    : {
        ...state.groups,
        [scope.group]: [...groupModels, scope.model].sort(),
      };
  const next = normalize({ version: 1, models, groups });
  saveIgnoredPrices(next, options);
  return next;
}

/** Put one model back on the sheet and into later official updates. */
export function restorePrice(
  scope: IgnoredPriceScope,
  options?: PriceIgnoreOptions,
): IgnoredPriceState {
  const state = loadIgnoredPrices(options);
  const groups = { ...state.groups };
  const remaining = (groups[scope.group] ?? []).filter((id) => id !== scope.model);
  if (remaining.length === 0) delete groups[scope.group];
  else groups[scope.group] = remaining;
  const stillIgnored = Object.values(groups).some((ids) => ids.includes(scope.model));
  const models = stillIgnored ? state.models : state.models.filter((id) => id !== scope.model);
  const next = normalize({ version: 1, models, groups });
  saveIgnoredPrices(next, options);
  return next;
}
