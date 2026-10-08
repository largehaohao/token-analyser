import { describe, expect, it } from "vitest";
import { costValue, formatCost, formatCostTokens, formatCostTitle, sourceLabel, unpricedRawFromTurns, usageNote } from "./format";
import type { Cost } from "./api";

const missing: Cost = { raw: 0, uncached_input: 0, cached_input: 0, output: 0, credits: null, usd: null, unmeasured: 2 };
describe("native usage presentation", () => {
  it("distinguishes missing usage from measured zero and marks partial totals", () => {
    expect(costValue(missing, "tokens")).toBeNull(); expect(formatCost(missing, "tokens")).toBe("—");
    expect(formatCostTokens(missing)).toBe("—"); expect(usageNote(missing)).toContain("2 次调用");
    const partial = { ...missing, raw: 1234 };
    expect(formatCost(partial, "tokens")).toBe("≥ 1,234"); expect(formatCostTokens(partial)).toBe("≥ 1.2K");
    expect(formatCostTitle(partial, "tokens")).toContain("另有 2 次调用");
    expect(formatCost({ ...missing, unmeasured: undefined }, "tokens")).toBe("0");
  });
  it("does not label measured native USD as unpriced because it has no Codex credits", () => {
    expect(unpricedRawFromTurns([{ cost: { raw: 100, credits: null, usd: 0.01 } }, { cost: { raw: 20, credits: null, usd: null } }])).toBe(20);
  });
  it("uses recognizable source labels", () => {
    expect(sourceLabel()).toBe("Codex"); expect(sourceLabel("claude")).toBe("Claude Code");
    expect(sourceLabel("cursor")).toBe("Cursor"); expect(sourceLabel("pi")).toBe("pi");
  });
});
