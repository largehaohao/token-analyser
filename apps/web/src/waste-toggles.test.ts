import { describe, expect, it } from "vitest";
import { persistToggleError, TOGGLE_PERSIST_FAILED } from "./waste-toggles";

describe("persistToggleError", () => {
  it("is silent when the PATCH succeeds or a refresh recovers", () => {
    expect(persistToggleError(false, true)).toBeNull();
    expect(persistToggleError(true, false)).toBeNull();
  });

  it("explains when both PATCH and refresh fail", () => {
    expect(persistToggleError(true, true)).toBe(TOGGLE_PERSIST_FAILED);
  });
});
