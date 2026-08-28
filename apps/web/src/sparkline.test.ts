import { describe, expect, it } from "vitest";
import { downsampleValues, sparklinePoints } from "./sparkline";

describe("downsampleValues", () => {
  it("keeps short series intact", () => {
    expect(downsampleValues([1, 8, 3], 80)).toEqual([1, 8, 3]);
  });

  it("caps a 3000-point series and keeps the peak", () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i === 1999 ? 99 : 1));
    const sampled = downsampleValues(values, 80);
    expect(sampled).toHaveLength(80);
    expect(Math.max(...sampled)).toBe(99);
  });
});

describe("sparklinePoints", () => {
  it("returns no path for a single turn", () => {
    expect(sparklinePoints([4], 220, 36)).toBe("");
  });

  it("emits one coordinate per sample, not per raw turn", () => {
    const values = downsampleValues(
      Array.from({ length: 3000 }, (_, i) => i),
      80,
    );
    const points = sparklinePoints(values, 220, 36);
    expect(points.split(/\s+/)).toHaveLength(80);
  });
});
