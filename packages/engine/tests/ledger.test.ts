import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";
import { LedgerBuilder, buildLedger } from "../src/ledger.ts";
import type { RolloutLine } from "../src/types.ts";

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

  it("drops copied prefix token_counts before child task_started", () => {
    const { turns, meta } = buildLedger(
      eventsFrom("child-prefix.jsonl"),
      "child-1",
      { isSubagent: true },
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].cost.raw).toBe(540);
    expect(turns[0].usage.input_tokens).toBe(500);
    expect(meta.parentId).toBe("parent-1");
    expect(meta.nickname).toBe("Plato");
  });

  it("would inflate totals if prefix were kept (guard)", () => {
    const { turns } = buildLedger(
      eventsFrom("child-prefix.jsonl"),
      "child-1",
      { isSubagent: false },
    );
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[0].cost.raw).toBe(1_000_000);
  });

  it("keeps tool output that arrives after the usage event attached to its turn", () => {
    const source = eventsFrom("reread-different-hash.jsonl");
    const firstOutputIndex = source.findIndex(
      (event) => event.type === "response_item" && event.payload?.type === "custom_tool_call_output",
    );
    const reordered = [...source];
    const [output] = reordered.splice(firstOutputIndex, 1);
    const tokenIndex = reordered.findIndex(
      (event) => event.type === "event_msg" && event.payload?.type === "token_count",
    );
    reordered.splice(tokenIndex + 1, 0, output!);
    const { turns } = buildLedger(reordered, "late-output", { isSubagent: false });
    expect(turns[0]!.tools[0]!.outputBytes).toBeGreaterThan(0);
  });

  it("carries the last user prompt into continuation turns", () => {
    const events = eventsFrom("duplicate-token-count.jsonl");
    const { turns } = buildLedger(events, "prompt-continuation", { isSubagent: false });
    expect(turns[1]!.prompt).toContain("hello");
  });

  it("accepts function-call command envelopes and canonicalizes tool aliases", () => {
    const source = eventsFrom("wait-poll.jsonl");
    const call = source.find((event) => event.type === "response_item" && event.payload?.type === "custom_tool_call");
    const output = source.find((event) => event.type === "response_item" && event.payload?.type === "custom_tool_call_output");
    expect(call).toBeDefined();
    expect(output).toBeDefined();
    call!.payload = { type: "function_call", name: "functions.exec_command", arguments: JSON.stringify({ cmd: "cat README.md" }), call_id: "envelope" };
    output!.payload = { type: "function_call_output", call_id: "envelope", output: "readme" };
    const { turns } = buildLedger(source, "function-envelope", { isSubagent: false });
    expect(turns[0]!.tools[0]!.name).toBe("exec");
    expect(turns[0]!.tools[0]!.input).toBe("cat README.md");
  });

  it("joins argv cmd envelopes into a shell command", () => {
    const source = eventsFrom("wait-poll.jsonl");
    const call = source.find((event) => event.type === "response_item" && event.payload?.type === "custom_tool_call");
    const output = source.find((event) => event.type === "response_item" && event.payload?.type === "custom_tool_call_output");
    call!.payload = {
      type: "function_call",
      name: "exec",
      arguments: JSON.stringify({ cmd: ["cat", "README.md"] }),
      call_id: "argv",
    };
    output!.payload = { type: "function_call_output", call_id: "argv", output: "readme" };
    const { turns } = buildLedger(source, "argv-cmd", { isSubagent: false });
    expect(turns[0]!.tools[0]!.input).toBe("cat README.md");
  });

  it("keeps bash -lc argv scripts as one command", () => {
    const source = eventsFrom("wait-poll.jsonl");
    const call = source.find((event) => event.type === "response_item" && event.payload?.type === "custom_tool_call");
    const output = source.find((event) => event.type === "response_item" && event.payload?.type === "custom_tool_call_output");
    call!.payload = {
      type: "function_call",
      name: "exec",
      arguments: JSON.stringify({ cmd: ["bash", "-lc", "cat README.md"] }),
      call_id: "argv-bash",
    };
    output!.payload = { type: "function_call_output", call_id: "argv-bash", output: "readme" };
    const { turns } = buildLedger(source, "argv-bash", { isSubagent: false });
    expect(turns[0]!.tools[0]!.input).toMatch(/cat README.md/);
    expect(turns[0]!.tools[0]!.input).not.toBe("bash -lc cat README.md");
  });

  it("prices every turn with Fast once the session records it", () => {
    const usage = (input: number, totalInput: number) => ({
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: input,
      },
      total_token_usage: {
        input_tokens: totalInput,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: totalInput,
      },
    });
    const events: RolloutLine[] = [
      { timestamp: "t0", type: "session_meta", payload: { id: "fast-s" } },
      {
        timestamp: "t1",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", fast_mode: true },
      },
      {
        timestamp: "t2",
        type: "event_msg",
        payload: { type: "token_count", info: usage(1_000_000, 1_000_000) },
      },
      {
        timestamp: "t3",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      },
      {
        timestamp: "t4",
        type: "event_msg",
        payload: { type: "token_count", info: usage(1_000_000, 2_000_000) },
      },
    ];
    const { turns, fastMode } = buildLedger(events, "fast-s", { isSubagent: false });
    expect(fastMode).toBe(true);
    expect(turns[0]!.cost.credits).toBeCloseTo(312.5, 5);
    expect(turns[1]!.cost.credits).toBeCloseTo(312.5, 5);
  });

  it("treats service_tier=fast as Fast mode", () => {
    const events: RolloutLine[] = [
      { timestamp: "t0", type: "session_meta", payload: { id: "tier" } },
      {
        timestamp: "t1",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", service_tier: "fast" },
      },
      {
        timestamp: "t2",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 1_000_000,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 1_000_000,
            },
            total_token_usage: {
              input_tokens: 1_000_000,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 1_000_000,
            },
          },
        },
      },
    ];
    const { turns, fastMode } = buildLedger(events, "tier", { isSubagent: false });
    expect(fastMode).toBe(true);
    expect(turns[0]!.cost.credits).toBeCloseTo(312.5, 5);
  });

  it("sets ledger_warning when last_token_usage sums diverge from total", () => {
    const events: RolloutLine[] = [
      { timestamp: "t0", type: "session_meta", payload: { id: "warn" } },
      {
        timestamp: "t1",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 0,
              total_tokens: 110,
            },
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 0,
              total_tokens: 110,
            },
          },
        },
      },
      {
        timestamp: "t2",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
              total_tokens: 55,
            },
            total_token_usage: {
              input_tokens: 9999,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 15,
              reasoning_output_tokens: 0,
              total_tokens: 10014,
            },
          },
        },
      },
    ];
    const { turns, ledger_warning } = buildLedger(events, "warn", {
      isSubagent: false,
    });
    expect(turns).toHaveLength(2);
    expect(ledger_warning).toBe(true);
  });

  it("does not warn when only reasoning counters drift", () => {
    const events: RolloutLine[] = [
      { timestamp: "t0", type: "session_meta", payload: { id: "slack" } },
      {
        timestamp: "t1",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 3,
              total_tokens: 110,
            },
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 99,
              total_tokens: 110,
            },
          },
        },
      },
    ];
    const { ledger_warning } = buildLedger(events, "slack", { isSubagent: false });
    expect(ledger_warning).toBe(false);
  });

  it("incremental consume matches a full rebuild", () => {
    const events = eventsFrom("duplicate-token-count.jsonl");
    const full = buildLedger(events, "s1", { isSubagent: false });
    const builder = new LedgerBuilder("s1", { isSubagent: false });
    builder.consume(events.slice(0, 4));
    builder.consume(events.slice(4));
    const split = builder.snapshot();
    expect(split.turns.map((turn) => turn.cost.raw)).toEqual(
      full.turns.map((turn) => turn.cost.raw),
    );
    expect(split.ledger_warning).toBe(full.ledger_warning);
  });
});
