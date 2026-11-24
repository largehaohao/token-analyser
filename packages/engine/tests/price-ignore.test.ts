import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPriceSheet } from "../src/price-sheet.ts";
import { ignorePrice, isPriceIgnored, loadIgnoredPrices, restorePrice } from "../src/price-ignore.ts";

describe("price ignore support", () => {
  it("persists ignored models by group and hides them from the sheet", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "price-ignore-"));
    try {
      const filePath = path.join(dir, "ignored-prices.json");
      expect(buildPriceSheet(loadIgnoredPrices({ filePath })).groups
        .find((group) => group.id === "codex")?.rows
        .some((row) => row.id === "gpt-5.4")).toBe(true);

      ignorePrice({ group: "codex", model: "gpt-5.4" }, { filePath });
      const state = loadIgnoredPrices({ filePath });
      expect(isPriceIgnored(state, { group: "codex", model: "gpt-5.4" })).toBe(true);
      expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
        version: 1,
        models: ["gpt-5.4"],
        groups: { codex: ["gpt-5.4"] },
      });
      const hidden = buildPriceSheet(state);
      expect(hidden.groups
        .find((group) => group.id === "codex")?.rows
        .some((row) => row.id === "gpt-5.4")).toBe(false);
      expect(hidden.ignored).toEqual([{ group: "codex", label: "Codex", model: "gpt-5.4" }]);

      const restored = restorePrice({ group: "codex", model: "gpt-5.4" }, { filePath });
      expect(isPriceIgnored(restored, { group: "codex", model: "gpt-5.4" })).toBe(false);
      expect(buildPriceSheet(restored).groups
        .find((group) => group.id === "codex")?.rows
        .some((row) => row.id === "gpt-5.4")).toBe(true);
      expect(buildPriceSheet(restored).ignored).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
