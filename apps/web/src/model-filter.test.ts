import { describe, expect, it } from "vitest";
import type { Overview } from "./api";
import {
  ALL_MODELS,
  modelOptions,
  overviewForModelFilter,
} from "./model-filter";

function overview(partial: Partial<Overview> & Pick<Overview, "cost">): Overview {
  return {
    sessionCount: 0,
    turnCount: 0,
    live: false,
    collecting: true,
    watchPath: "/tmp",
    waste: partial.cost,
    unpricedRaw: 0,
    rateCardAsOf: "2026-10-30",
    days: [],
    slices: [],
    ...partial,
  };
}

describe("modelOptions", () => {
  it("lists model names sorted for the selector", () => {
    expect(
      modelOptions([
        {
          model: "gpt-b",
          turnCount: 1,
          cost: {
            raw: 1,
            uncached_input: 0,
            cached_input: 0,
            output: 0,
            credits: 0,
            usd: 0,
          },
          unpricedRaw: 0,
        },
        {
          model: "gpt-a",
          turnCount: 1,
          cost: {
            raw: 1,
            uncached_input: 0,
            cached_input: 0,
            output: 0,
            credits: 0,
            usd: 0,
          },
          unpricedRaw: 0,
        },
      ]),
    ).toEqual(["gpt-a", "gpt-b"]);
  });
});

describe("overviewForModelFilter", () => {
  it("keeps the base overview until a filtered payload is ready", () => {
    const base = overview({
      cost: {
        raw: 6,
        uncached_input: 0,
        cached_input: 0,
        output: 0,
        credits: 0,
        usd: 0,
      },
    });
    const filtered = overview({
      cost: {
        raw: 1,
        uncached_input: 0,
        cached_input: 0,
        output: 0,
        credits: 0,
        usd: 0,
      },
    });
    expect(overviewForModelFilter(base, null, ALL_MODELS)).toBe(base);
    expect(overviewForModelFilter(base, null, "gpt-a")).toBe(base);
    expect(overviewForModelFilter(base, filtered, "gpt-a")).toBe(filtered);
  });
});
