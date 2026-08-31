import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";
import { buildLedger } from "../src/ledger.ts";
import { classifyTurns } from "../src/classify.ts";
import type { Turn } from "../src/types.ts";

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

function syntheticTurn(input: string, name = "exec"): Turn {
  return {
    id: `turn-${name}-${input.slice(0, 8)}`,
    sessionId: "synthetic",
    startedAt: "2026-08-27T00:00:00.000Z",
    endedAt: "2026-08-27T00:00:01.000Z",
    model: "test",
    effort: "medium",
    fastMode: false,
    prompt: "",
    tools: [
      {
        name,
        input,
        outputSha256: "hash",
        outputBytes: 0,
        outputPreview: "",
      },
    ],
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
      total_tokens: 12,
    },
    cost: {
      raw: 12,
      uncached_input: 10,
      cached_input: 0,
      output: 2,
      credits: 1,
      usd: 0.04,
    },
    bucket: "other",
    labels: [],
    hasPatchApply: false,
    collaborationMode: null,
  };
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
    expect(turns[0].bucket).toBe("reading");
    expect(turns[1].bucket).toBe("reread");
  });

  it("same path different hash is not reread", () => {
    const turns = classified("reread-different-hash.jsonl");
    expect(turns[1].bucket).not.toBe("reread");
  });

  it("extracts literal exec_command wrappers and hashes their payload output", () => {
    const text = readFileSync(
      path.join(fixtures, "reread-same-hash.jsonl"),
      "utf8",
    );
    const { events } = parseJsonlChunk(text.endsWith("\n") ? text : text + "\n", 0);
    for (const event of events) {
      if (event.payload?.type === "custom_tool_call") {
        event.payload.name = "functions.exec";
        event.payload.input =
          'const result = await tools.exec_command({cmd: "cat foo.ts"}); text(result);';
      }
      if (event.payload?.type === "custom_tool_call_output") {
        event.payload.output = JSON.stringify({
          chunk_id: "wrapper",
          output: "aaa",
        });
      }
    }

    const { turns } = buildLedger(events, "wrapped-exec", { isSubagent: false });
    const classifiedTurns = classifyTurns(turns);
    expect(classifiedTurns[0]!.bucket).not.toBe("reread");
    expect(classifiedTurns[1]!.bucket).toBe("reread");
    expect(classifiedTurns[1]!.tools[0]!.input).toBe("cat foo.ts");
    expect(classifiedTurns[1]!.tools[0]!.outputBytes).toBe(3);
  });

  it("splits verification, tooling, communication, and mutations from unknown", () => {
    const turns = classifyTurns([
      syntheticTurn("pnpm --filter engine test"),
      syntheticTurn("text(await tools.update_plan({plan: []}));"),
      syntheticTurn("send_user_message_async", "send_user_message_async"),
      syntheticTurn("rm -f /tmp/old-fixture"),
      syntheticTurn("unknown command --flag"),
    ]);

    expect(turns.map((turn) => turn.bucket)).toEqual([
      "verification",
      "tooling",
      "communication",
      "code",
      "other",
    ]);
  });

  it("treats chained inspection and validation as the dominant validation category", () => {
    const turn = syntheticTurn(
      "git diff --check && git status --short && pnpm test",
    );
    expect(classifyTurns([turn])[0]!.bucket).toBe("verification");
  });

  it("does not call a redirected read a reread", () => {
    const first = syntheticTurn("cat foo.ts");
    const redirected = syntheticTurn("cat foo.ts > /tmp/copy.ts");
    expect(classifyTurns([first, redirected]).map((turn) => turn.bucket)).toEqual([
      "reading",
      "code",
    ]);
  });

  it("plan-mode turns classify as planning even when they would otherwise be code", () => {
    const lines = [
      {
        timestamp: "2026-08-27T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "s-plan", session_id: "s-plan" },
      },
      {
        timestamp: "2026-08-27T00:00:01.000Z",
        type: "turn_context",
        payload: {
          model: "gpt-5.6-sol",
          collaboration_mode: {
            mode: "plan",
            settings: { reasoning_effort: "medium" },
          },
        },
      },
      {
        timestamp: "2026-08-27T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_started" },
      },
      {
        timestamp: "2026-08-27T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: "pnpm test",
          call_id: "c1",
        },
      },
      {
        timestamp: "2026-08-27T00:00:04.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
      },
      {
        timestamp: "2026-08-27T00:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
              total_tokens: 15,
            },
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
              total_tokens: 15,
            },
          },
        },
      },
    ];
    const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    const { events } = parseJsonlChunk(text, 0);
    const { turns } = buildLedger(events, "s-plan", { isSubagent: false });
    expect(turns[0]!.collaborationMode).toBe("plan");
    expect(classifyTurns(turns)[0]!.bucket).toBe("planning");
  });
});
