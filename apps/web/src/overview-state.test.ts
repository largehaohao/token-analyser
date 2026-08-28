import { describe, expect, it } from "vitest";
import { overviewDisplayState } from "./overview-state";

describe("overviewDisplayState", () => {
  it("shows loading while the requested range has not landed", () => {
    expect(
      overviewDisplayState({
        requestedRange: "5h",
        appliedRange: "7d",
        hasOverview: true,
        error: null,
      }),
    ).toBe("loading");
  });

  it("shows an error instead of stale totals when the new range fails", () => {
    expect(
      overviewDisplayState({
        requestedRange: "5h",
        appliedRange: "7d",
        hasOverview: true,
        error: "HTTP 500",
      }),
    ).toBe("error");
  });

  it("returns to loading after a failed range once a newer request starts", () => {
    expect(
      overviewDisplayState({
        requestedRange: "1d",
        appliedRange: "7d",
        hasOverview: true,
        error: null,
      }),
    ).toBe("loading");
  });

  it("shows the overview only after it matches the requested range", () => {
    expect(
      overviewDisplayState({
        requestedRange: "5h",
        appliedRange: "5h",
        hasOverview: true,
        error: null,
      }),
    ).toBe("ready");
  });
});
