import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";
import { buildLedger } from "../src/ledger.ts";
import { classifyTurns } from "../src/classify.ts";
import { detect } from "../src/detect.ts";
import type { Bucket, Cost, ToolCall, Turn } from "../src/types.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

function cost(raw: number, credits = raw): Cost {
  return {
    raw,
    uncached_input: 0,
    cached_input: 0,
    output: 0,
    credits,
    usd: 0,
  };
}

function pollTurn(id: string, endedAt: string, tools: ToolCall[] = []): Turn {
  return {
    id,
    sessionId: "s1",
    startedAt: endedAt,
    endedAt,
    model: null,
    effort: null,
    fastMode: false,
    prompt: "",
    tools,
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    },
    cost: cost(100),
    bucket: "waiting.poll" as Bucket,
    labels: [],
    hasPatchApply: false,
    collaborationMode: null,
  };
}

function classifiedFromFixture(name: string) {
  const text = readFileSync(path.join(fixtures, name), "utf8");
  const { events } = parseJsonlChunk(text.endsWith("\n") ? text : text + "\n", 0);
  const sessionId = name.replace(".jsonl", "");
  const { turns } = buildLedger(events, sessionId, { isSubagent: false });
  return { turns: classifyTurns(turns), events };
}

describe("detect", () => {
  it("labels three poll turns 30s apart as poll_spin with one suggestion", () => {
    const waitAgent: ToolCall = {
      name: "wait_agent",
      input: "{}",
      outputSha256: "abc",
      outputBytes: 3,
      outputPreview: "ok",
    };
    const turns = [
      pollTurn("p1", "2026-08-27T00:00:00.000Z", [waitAgent]),
      pollTurn("p2", "2026-08-27T00:00:30.000Z", [waitAgent]),
      pollTurn("p3", "2026-08-27T00:01:00.000Z", [waitAgent]),
    ];

    const { turns: labeled, suggestions } = detect(turns, []);

    expect(labeled.every((t) => t.labels.includes("poll_spin"))).toBe(true);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].id).toBe("poll-spin-1");
    expect(suggestions[0].kind).toBe("poll_spin");
    expect(suggestions[0].title).toContain("wait_agent");
    expect(suggestions[0].body).toMatch(/原始 token/);
    expect(suggestions[0].body).toMatch(/credits/);
    expect(suggestions[0].turnIds).toEqual(["p1", "p2", "p3"]);
  });

  it("does not label two poll turns 30s apart as poll_spin", () => {
    const turns = [
      pollTurn("p1", "2026-08-27T00:00:00.000Z"),
      pollTurn("p2", "2026-08-27T00:00:30.000Z"),
    ];

    const { turns: labeled, suggestions } = detect(turns, []);

    expect(labeled.some((t) => t.labels.includes("poll_spin"))).toBe(false);
    expect(suggestions.filter((s) => s.kind === "poll_spin")).toHaveLength(0);
  });

  it("labels post-compact identical reread as compaction_loop", () => {
    const { turns, events } = classifiedFromFixture("compacted-reread.jsonl");
    const { turns: labeled, suggestions } = detect(turns, events);

    expect(labeled[0].labels).not.toContain("compaction_loop");
    expect(labeled[1].labels).toContain("compaction_loop");
    expect(suggestions[0]?.title).toMatch(/压缩循环/);
    expect(suggestions[0]?.body).toMatch(/上下文已压缩/);
  });

  it("treats event_msg.context_compacted as a compact boundary", () => {
    const { turns, events } = classifiedFromFixture("compacted-reread.jsonl");
    const rewritten = events.map((event) =>
      event.type === "compacted"
        ? {
            ...event,
            type: "event_msg",
            payload: { ...event.payload, type: "context_compacted" },
          }
        : event,
    );
    const { turns: labeled } = detect(turns, rewritten);
    expect(labeled[1]!.labels).toContain("compaction_loop");
  });

  it("labels hash-equal rereads as reread_repeat", () => {
    const { turns, events } = classifiedFromFixture("reread-same-hash.jsonl");
    const { turns: labeled, suggestions } = detect(turns, events);
    expect(labeled[0]!.labels).not.toContain("reread_repeat");
    expect(labeled[1]!.labels).toContain("reread_repeat");
    expect(suggestions.some((item) => item.kind === "reread_repeat")).toBe(true);
  });

  it("escalates to compaction_loop_heavy when rereads dominate between compacts", () => {
    const reread = pollTurn("r1", "2026-08-27T00:00:30.000Z");
    reread.bucket = "reread";
    reread.cost = cost(80);
    const planning = pollTurn("p0", "2026-08-27T00:00:40.000Z");
    planning.bucket = "planning";
    planning.cost = cost(10);
    const { suggestions } = detect(
      [reread, planning],
      [
        {
          timestamp: "2026-08-27T00:00:10.000Z",
          type: "compacted",
          payload: { window_id: "w1" },
        },
        {
          timestamp: "2026-08-27T00:01:00.000Z",
          type: "compacted",
          payload: { window_id: "w2" },
        },
      ],
    );
    expect(suggestions[0]?.kind).toBe("compaction_loop_heavy");
  });
});
