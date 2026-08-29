import { describe, expect, it } from "vitest";
import type { WasteToggleId } from "./api";
import {
  nextToggleState,
  persistToggleError,
  TOGGLE_PERSIST_FAILED,
} from "./waste-toggles";

const defaults: Record<WasteToggleId, boolean> = {
  poll: true,
  reread: true,
  compaction_loop: true,
  idle_subagents: true,
  coord: false,
  healthy_subagents: false,
  planning: false,
  code: false,
};

describe("persistToggleError", () => {
  it("is silent when the PATCH succeeds or a refresh recovers", () => {
    expect(persistToggleError(false, true)).toBeNull();
    expect(persistToggleError(true, false)).toBeNull();
  });

  it("explains when both PATCH and refresh fail", () => {
    expect(persistToggleError(true, true)).toBe(TOGGLE_PERSIST_FAILED);
  });
});

describe("nextToggleState", () => {
  it("keeps prior optimistic choices in the next full-state PATCH", () => {
    const first = nextToggleState(defaults, "planning", true);
    const second = nextToggleState(first, "code", true);
    expect(second.planning).toBe(true);
    expect(second.code).toBe(true);
    expect(defaults.planning).toBe(false);
  });
});
