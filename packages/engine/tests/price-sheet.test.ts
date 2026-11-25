import { describe, expect, it } from "vitest";
import { buildPriceSheet } from "../src/price-sheet.ts";

describe("buildPriceSheet", () => {
  const sheet = buildPriceSheet({ version: 1, models: [], groups: {} });

  function group(id: string) {
    const found = sheet.groups.find((item) => item.id === id);
    expect(found, id).toBeDefined();
    return found!;
  }

  it("lists Codex credits and the declared API rates without catalog alias rows", () => {
    const codex = group("codex");
    expect(codex.unit).toBe("credits");
    expect(codex.rows.find((row) => row.id === "gpt-5.6-sol")?.input).toBe(100);

    const deepseek = group("deepseek");
    const flash = deepseek.rows.find((row) => row.id === "deepseek-flash");
    expect(flash).toMatchObject({ input: 0.3, cached: 0.006, output: 1.2 });
    expect(flash?.note).toContain("低峰 0.15");
    expect(deepseek.rows.some((row) => row.id === "deepseek-v4-flash")).toBe(false);

    const grok = group("grok").rows.find((row) => row.id === "grok-4.7");
    expect(grok?.note).toContain("≥200k 4 / 1 / 12");
    expect(group("gemini").rows.find((row) => row.id === "gemini-3.8-flash")?.input).toBe(0.75);
    expect(group("claude").rows.some((row) => row.id.startsWith("claude-"))).toBe(true);
    expect(group("qwen").rows.find((row) => row.id === "qwen3.8-flash-next")?.input).toBeGreaterThan(0);
  });

  it("prices each declared Qwen alias at the canonical rates", () => {
    const qwen = group("qwen");
    const canonical = qwen.rows.find((row) => row.id === "qwen3.8-flash-next")!;
    for (const id of [
      "swift-1.5-iq3_s",
      "qwen3.8-flash-next-unsloth-ud-iq2_xs",
      "qwen3.8-flash-next-unsloth-ud-iq3_xxs",
    ]) {
      const alias = qwen.rows.find((row) => row.id === id);
      expect(alias, id).toBeDefined();
      expect(alias).toMatchObject({
        aliasOf: "qwen3.8-flash-next",
        input: canonical.input,
        cached: canonical.cached,
        output: canonical.output,
      });
      expect(alias?.note).toContain("别名 → qwen3.8-flash-next");
    }
  });
});
