import type { CostUnit } from "./format";

export const UNIT_PREF_KEY = "token-analyser:unit";

export function parseUnitPref(raw: string | null | undefined): CostUnit | null {
  if (raw === "tokens" || raw === "credits" || raw === "usd") return raw;
  return null;
}

export function readUnitPref(): CostUnit {
  try {
    return parseUnitPref(localStorage.getItem(UNIT_PREF_KEY)) ?? "tokens";
  } catch {
    return "tokens";
  }
}

export function writeUnitPref(unit: CostUnit): void {
  try {
    localStorage.setItem(UNIT_PREF_KEY, unit);
  } catch {
    // Ignore quota / private-mode failures; the in-memory unit still works.
  }
}
