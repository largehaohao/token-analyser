import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";
import { buildLedger } from "../src/ledger.ts";
import { classifyTurns } from "../src/classify.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

function classified(name: string) {
  const text = readFileSync(path.join(fixtures, name), "utf8");
  const { events } = parseJsonlChunk(text.endsWith("\n") ? text : text + "\n", 0);
  const sessionId = name.replace(".jsonl", "");
  const { turns } = buildLedger(events, sessionId, { isSubagent: false });
  return classifyTurns(turns);
}

describe("classifyTurns", () => {
  it("wait_agent only → waiting.poll", () => {
    expect(classified("wait-poll.jsonl")[0].bucket).toBe("waiting.poll");
  });

  it("spawn_agent → waiting.coord", () => {
    expect(classified("spawn-coord.jsonl")[0].bucket).toBe("waiting.coord");
  });

  it("same path same hash second read → reread", () => {
    const turns = classified("reread-same-hash.jsonl");
    expect(turns[0].bucket).not.toBe("reread");
    expect(turns[1].bucket).toBe("reread");
  });

  it("same path different hash is not reread", () => {
    const turns = classified("reread-different-hash.jsonl");
    expect(turns[1].bucket).not.toBe("reread");
  });
});
