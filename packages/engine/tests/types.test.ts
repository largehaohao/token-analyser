import { describe, expect, it } from "vitest";
import { addKnownCost, emptyCost, emptyMaybeCost } from "../src/types.ts";

const priced = {
  raw: 100,
  uncached_input: 100,
  cached_input: 0,
  output: 0,
  credits: 1,
  usd: 0.04,
};

const unknown = {
  raw: 50,
  uncached_input: 50,
  cached_input: 0,
  output: 0,
  credits: null,
  usd: null,
};

describe("addKnownCost", () => {
  it("keeps priced money when merged with an emptyCost identity", () => {
    const merged = addKnownCost(emptyCost(), unknown);
    expect(merged.raw).toBe(50);
    expect(merged.credits).toBeNull();
    expect(merged.usd).toBeNull();
  });

  it("keeps known money when merging emptyMaybeCost with a priced cost", () => {
    const merged = addKnownCost(emptyMaybeCost(), priced);
    expect(merged.credits).toBe(1);
    expect(merged.raw).toBe(100);
  });
});
