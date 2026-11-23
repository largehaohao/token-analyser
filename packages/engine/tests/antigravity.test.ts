import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPriceCatalog } from "../src/price-catalog.ts";
import { ingestFile } from "../src/ingest.ts";
import { collectSessionFiles } from "../src/session-files.ts";
import { isTokenAnalyserEngineCommand } from "../src/server.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const transcript = [
  {
    step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-19T08:54:28Z",
    content: "<USER_REQUEST>\nRead the README\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>",
  },
  {
    step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "RUNNING", created_at: "2026-11-19T08:54:29Z",
    input_tokens: 10, cache_read_tokens: 0, output_tokens: 1,
    tool_calls: [{ name: "run_command", args: { CommandLine: "cat README.md", Cwd: "/tmp/demo" } }],
  },
  {
    step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-19T08:54:30Z",
    input_tokens: 100, cache_read_tokens: 40, output_tokens: 20, thinking: "look",
    tool_calls: [
      { name: "run_command", args: { CommandLine: "cat README.md", Cwd: "/tmp/demo" } },
      { name: "view_file", args: { AbsolutePath: "/tmp/demo/README.md" } },
    ],
  },
  {
    step_index: 2, source: "MODEL", type: "RUN_COMMAND", status: "DONE", created_at: "2026-11-19T08:54:31Z",
    content: "Created At: 2026-11-19T08:54:30Z\nCompleted At: 2026-11-19T08:54:31Z\n\nDemo README",
  },
  { step_index: 3, source: "MODEL", type: "VIEW_FILE", status: "DONE", created_at: "2026-11-19T08:54:32Z", content: "Demo README" },
  {
    step_index: 4, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-19T08:55:00Z",
    content: "<USER_REQUEST>\nThanks\n</USER_REQUEST>",
  },
  { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-19T08:55:02Z", content: "No usage on this one." },
  { step_index: 6, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-19T12:00:00Z", content: "<USER_REQUEST>\nLater\n</USER_REQUEST>" },
  { step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-19T14:00:00Z", input_tokens: 10, cache_read_tokens: 0, output_tokens: 10, content: "too late" },
].map((event) => JSON.stringify(event)).join("\n") + "\n";

describe("antigravity sessions", () => {
  it("reads token usage once per planner step and ignores duplicate logs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-"));
    dirs.push(root);
    const brain = path.join(root, "brain", "conv-1", ".system_generated", "logs");
    mkdirSync(path.join(brain, "chunks", "transcript"), { recursive: true });
    const transcriptPath = path.join(brain, "transcript.jsonl");
    writeFileSync(transcriptPath, transcript);
    writeFileSync(path.join(brain, "transcript_full.jsonl"), transcript);
    writeFileSync(path.join(brain, "chunks", "transcript", "00000000.jsonl"), transcript + JSON.stringify({
      step_index: 9, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-19T09:00:00Z",
      input_tokens: 99999, cache_read_tokens: 0, output_tokens: 99999, content: "do not count",
    }) + "\n");
    mkdirSync(path.join(root, "annotations"), { recursive: true });
    writeFileSync(path.join(root, "annotations", "conv-1.pbtxt"), 'title:"Antigravity demo" last_user_view_time:{seconds:1}\n');
    const dbPath = path.join(root, "conversation_summaries.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE conversation_summaries (conversation_id text primary key, title text, workspace_uris text, parent_conversation_id text)`);
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)").run(
      "conv-1", "from db", JSON.stringify(["file:///tmp/agy"]), "parent-1",
    );
    db.close();

    expect(collectSessionFiles([path.join(root, "brain")])).toEqual([transcriptPath]);
    const snap = ingestFile(transcriptPath, { cacheHome: root });
    expect(snap.source).toBe("antigravity");
    expect(snap.id).toBe("antigravity:conv-1");
    expect(snap.nickname).toBe("Antigravity demo");
    expect(snap.cwd).toBe(fileURLToPath("file:///tmp/agy"));
    expect(snap.parentId).toBe("antigravity:parent-1");
    expect(snap.turns).toHaveLength(3);
    expect(snap.turns[2]?.requestPerformance).toMatchObject({ ttftMs: null, durationMs: null, outputTokensPerSecond: null });
    expect(snap.turns[0]?.prompt).toBe("Read the README");
    expect(snap.turns[0]?.model).toBe("Gemini 3.8 Flash");
    expect(snap.turns[0]?.effort).toBe("high");
    expect(snap.turns[0]?.usage).toMatchObject({ input_tokens: 140, cached_input_tokens: 40, output_tokens: 20 });
    expect(snap.turns[0]?.tools[0]).toMatchObject({ name: "exec", input: "cat README.md", outputPreview: "Demo README" });
    // 08:54:28 user -> 08:54:30 planner is the request window. No first-token time exists.
    expect(snap.turns[0]?.requestPerformance).toMatchObject({
      ttftMs: null, durationMs: 2000, speedSource: "duration", outputTokensPerSecond: 10,
    });
    expect(snap.turns[1]?.usageRecorded).toBe(false);
    expect(snap.turns[1]?.requestPerformance?.ttftMs).toBeNull();
    expect(snap.cost.raw).toBe(180);
    expect(snap.cost.credits).toBeNull();
    const gemini = loadPriceCatalog().models["gemini-3.8-flash"]!;
    const expectedUsd = snap.turns.filter((turn) => turn.usageRecorded).reduce((total, turn) =>
      total + (turn.cost.uncached_input * gemini.input + turn.cost.cached_input * gemini.cached +
        turn.cost.output * gemini.output) / 1e6, 0);
    expect(snap.cost.usd).toBeCloseTo(expectedUsd, 10);
    expect(snap.cost.unmeasured).toBe(1);
    expect(snap.performance?.avgTtftMs).toBeNull();
    expect(snap.performance?.outputTokensPerSecond).toBe(10);
  });

  it("recognises this engine and not an unrelated server", () => {
    expect(isTokenAnalyserEngineCommand("/opt/homebrew/bin/node --use-env-proxy --import tsx src/server.ts")).toBe(true);
    expect(isTokenAnalyserEngineCommand("node ../../scripts/start-engine.mjs")).toBe(true);
    expect(isTokenAnalyserEngineCommand("node /repo/packages/engine/src/server.ts")).toBe(true);
    expect(isTokenAnalyserEngineCommand("node vitest run tests/server.test.ts")).toBe(false);
  });
});
