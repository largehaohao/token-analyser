import { describe, expect, it } from "vitest";
import { parseUnitPref } from "./unit-pref";

describe("parseUnitPref", () => {
  it("accepts only the three ledger units", () => {
    expect(parseUnitPref("tokens")).toBe("tokens");
    expect(parseUnitPref("credits")).toBe("credits");
    expect(parseUnitPref("usd")).toBe("usd");
    expect(parseUnitPref("USD")).toBeNull();
    expect(parseUnitPref("")).toBeNull();
    expect(parseUnitPref(null)).toBeNull();
  });
});
