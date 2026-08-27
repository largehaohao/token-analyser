import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";
import { analyseSession } from "../src/snapshot.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

function eventsFrom(name: string) {
  const text = readFileSync(path.join(fixtures, name), "utf8");
  return parseJsonlChunk(text.endsWith("\n") ? text : text + "\n", 0).events;
}

describe("analyseSession", () => {
  it("wait-poll fixture is 100% waiting.poll and default waste equals that cost", () => {
    const snap = analyseSession({
      events: eventsFrom("wait-poll.jsonl"),
      path: "wait-poll.jsonl",
    });
    expect(snap.turns[0].bucket).toBe("waiting.poll");
    expect(snap.waste.raw).toBe(snap.cost.raw);
    expect(
      snap.tree.children.find((c) => c.label === "waiting")!.percentOfParent,
    ).toBeCloseTo(100, 5);
  });

  it("child-prefix with no children drops copied prefix (cost.raw === 540)", () => {
    const snap = analyseSession({
      events: eventsFrom("child-prefix.jsonl"),
      path: "child-prefix.jsonl",
    });
    expect(snap.cost.raw).toBe(540);
    expect(snap.id).toBe("child-1");
    expect(snap.parentId).toBe("parent-1");
    expect(snap.nickname).toBe("Plato");
  });
});
