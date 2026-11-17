import { describe, expect, it } from "vitest";
import { easeOutCubic, lerp, sameGapPattern } from "./motion";

describe("easeOutCubic", () => {
  it("pins the endpoints and decelerates", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 6);
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.25);
  });
});

describe("lerp", () => {
  it("interpolates linearly", () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.5)).toBe(15);
    expect(lerp(-4, 4, 0.25)).toBe(-2);
  });
});

describe("sameGapPattern", () => {
  it("accepts equal grids with matching null positions", () => {
    expect(sameGapPattern([1, null, 3], [10, null, 30])).toBe(true);
    expect(sameGapPattern([1, 2], [3, 4])).toBe(true);
  });

  it("rejects differing lengths or gap positions", () => {
    expect(sameGapPattern([1, null], [1, 2, 3])).toBe(false);
    expect(sameGapPattern([1, null, 3], [1, 2, 3])).toBe(false);
    expect(sameGapPattern([1, 2, null], [1, null, 3])).toBe(false);
  });
});