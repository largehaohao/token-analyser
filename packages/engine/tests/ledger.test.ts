import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";
import { buildLedger } from "../src/ledger.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

function eventsFrom(name: string) {
  const text = readFileSync(path.join(fixtures, name), "utf8");
  return parseJsonlChunk(text.endsWith("\n") ? text : text + "\n", 0).events;
}

describe("buildLedger", () => {
  it("keeps genuine last_token_usage deltas and drops duplicate snapshots", () => {
    const { turns, ledger_warning } = buildLedger(
      eventsFrom("duplicate-token-count.jsonl"),
      "s1",
      { isSubagent: false },
    );
    expect(turns).toHaveLength(2);
    expect(turns[0].usage.input_tokens).toBe(1000);
    expect(turns[0].cost.raw).toBe(1050);
    expect(turns[1].usage.cached_input_tokens).toBe(800);
    expect(turns[1].cost.uncached_input).toBe(1200);
    expect(turns[1].tools[0].name).toBe("wait_agent");
    expect(turns[0].prompt).toContain("hello");
    expect(ledger_warning).toBe(false);
    const rawSum = turns[0].cost.raw + turns[1].cost.raw;
    expect(rawSum).toBe(1050 + 2020);
  });
});
