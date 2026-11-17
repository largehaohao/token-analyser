import { describe, expect, it } from "vitest";
import { parseThemePref } from "./theme-pref";

describe("parseThemePref", () => {
  it("accepts only the two themes", () => {
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("Dark")).toBeNull();
    expect(parseThemePref("system")).toBeNull();
    expect(parseThemePref("")).toBeNull();
    expect(parseThemePref(null)).toBeNull();
    expect(parseThemePref(undefined)).toBeNull();
  });
});