import type { Overview, OverviewModel } from "./api";

/** Empty string means every model in the current window. */
export const ALL_MODELS = "";

export function modelOptions(models: OverviewModel[] | undefined): string[] {
  return [...(models ?? [])]
    .map((entry) => entry.model)
    .sort((a, b) => a.localeCompare(b));
}

export function overviewForModelFilter(
  base: Overview,
  filtered: Overview | null,
  model: string,
): Overview {
  return model !== ALL_MODELS && filtered != null ? filtered : base;
}
