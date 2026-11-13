import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestSessions } from "../src/ingest.ts";
import { SessionStore } from "../src/store.ts";
import { fileFingerprint } from "../src/store-dump.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dirs: string[] = [];
function home() {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-sessions-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

function opencodeDb(dir: string) {
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY, parent_id text, directory text, title text,
      time_created integer, time_updated integer, model text
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY, session_id text, type text, time_created integer, data text
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text, session_id text, time_created integer, data text
    );
    CREATE TABLE credential (id text PRIMARY KEY, value text);
  `);
  db.prepare("INSERT INTO credential VALUES (?, ?)").run("acct", "super-secret-token");
  const session = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)");
  const message = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
  const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
  const created = 1_760_000_000_000;
  session.run("ses_parent", null, "/tmp/demo", "Parent", created, created + 5_000, null);
  session.run("ses_child", "ses_parent", "/tmp/demo", "Child", created + 6_000, created + 8_000, null);
  message.run("msg_user", "ses_parent", "user", created + 1_000, JSON.stringify({ text: "Read the README" }));
  message.run("msg_asst", "ses_parent", "assistant", created + 4_000, JSON.stringify({
    model: { id: "claude-sonnet-4-6", providerID: "opencode" },
    content: [],
  }));
  part.run("part_text", "msg_asst", "ses_parent", created + 2_000, JSON.stringify({
    type: "text", text: "Reviewed.",
  }));
  part.run("part_tool", "msg_asst", "ses_parent", created + 3_000, JSON.stringify({
    type: "tool", tool: "bash", callID: "call-1",
    state: { input: { command: "cat README.md" }, output: "Demo README", status: "completed" },
  }));
  part.run("part_finish", "msg_asst", "ses_parent", created + 4_000, JSON.stringify({
    type: "step-finish", cost: 0,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 }, total: 175 },
  }));
  message.run("msg_child", "ses_child", "assistant", created + 7_000, JSON.stringify({
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
    content: [{ type: "text", text: "Done." }],
  }));
  part.run("part_child", "msg_child", "ses_child", created + 7_000, JSON.stringify({
    type: "step-finish", cost: 1.25,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 12 },
  }));
  return { file, db };
}

describe("OpenCode sessions", () => {
  it("reads sqlite usage, tools, parent links, and estimates a priced model that logged zero cost", () => {
    const dir = home();
    const { file, db } = opencodeDb(dir);
    try {
      const snapshots = ingestSessions(file, { cacheHome: dir });
      const parent = snapshots.find((snap) => snap.id === "opencode:ses_parent");
      const child = snapshots.find((snap) => snap.id === "opencode:ses_child");
      expect(parent?.source).toBe("opencode");
      expect(parent?.nickname).toBe("Parent");
      expect(parent?.cwd).toBe("/tmp/demo");
      expect(parent?.turns).toHaveLength(1);
      expect(parent?.turns[0].prompt).toBe("Read the README");
      expect(parent?.turns[0].response).toBe("Reviewed.");
      expect(parent?.turns[0].model).toBe("claude-sonnet-4-6");
      expect(parent?.turns[0].usage).toMatchObject({
        input_tokens: 150, cached_input_tokens: 40, cache_write_input_tokens: 10,
        output_tokens: 25, reasoning_output_tokens: 5, total_tokens: 175,
      });
      expect(parent?.turns[0].tools[0]).toMatchObject({ name: "exec", input: "cat README.md", outputPreview: "Demo README" });
      expect(parent?.cost.credits).toBeNull();
      expect(parent?.cost.raw).toBe(175);
      expect(parent?.cost.usd).toBeCloseTo(0.0007245, 10);
      expect(parent?.turns[0].requestPerformance).toMatchObject({
        ttftMs: null, durationMs: null, outputTokensPerSecond: null,
      });
      expect(parent?.performance?.avgTtftMs).toBeNull();
      expect(parent?.performance?.outputTokensPerSecond).toBeNull();
      expect(child?.parentId).toBe("opencode:ses_parent");
      expect(child?.cost.usd).toBe(1.25);
      expect(child?.cost.credits).toBeNull();
      expect(JSON.stringify(snapshots)).not.toContain("super-secret-token");
      const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
      store.refresh([file]);
      expect(store.list().map((item) => item.id)).toEqual(["opencode:ses_parent"]);
      expect(store.get("opencode:ses_parent")?.children).toHaveLength(1);
    } finally { db.close(); }
  });

  it("keeps legacy sessions that are not in session_v2 and prefers session_v2 when both exist", () => {
    const dir = home();
    const file = path.join(dir, "opencode.db");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE session_v2 (
        id text PRIMARY KEY, parent_id text, directory text, title text,
        time_created integer, time_updated integer, model text
      );
      CREATE TABLE session (
        id text PRIMARY KEY, parent_id text, directory text, title text,
        time_created integer, time_updated integer
      );
      CREATE TABLE session_message (
        id text PRIMARY KEY, session_id text, type text, time_created integer, data text
      );
      CREATE TABLE message (
        id text PRIMARY KEY, session_id text, time_created integer, data text
      );
      CREATE TABLE part (
        id text PRIMARY KEY, message_id text, session_id text, time_created integer, data text
      );
    `);
    const created = 1_760_000_000_000;
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "ses_both", null, "/tmp/current", "Current", created, created, null,
    );
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
      "ses_both", null, "/tmp/stale", "Stale", created, created,
    );
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
      "ses_old", null, "/tmp/legacy", "Legacy", created, created,
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
      "msg_current", "ses_both", "assistant", created, JSON.stringify({
        model: { id: "custom-model", providerID: "opencode" }, content: [{ type: "text", text: "Current reply" }],
      }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
      "part_current", "msg_current", "ses_both", created, JSON.stringify({
        type: "step-finish", cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 2 },
      }),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "msg_old_user", "ses_old", created, JSON.stringify({ role: "user", text: "Legacy prompt" }),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "msg_old", "ses_old", created + 1, JSON.stringify({
        role: "assistant", modelID: "claude-sonnet-4-6", providerID: "opencode",
        tokens: { input: 8, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.2,
      }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
      "part_old", "msg_old", "ses_old", created + 1, JSON.stringify({ type: "text", text: "Legacy reply" }),
    );
    try {
      const snapshots = ingestSessions(file, { cacheHome: dir });
      const current = snapshots.find((snap) => snap.id === "opencode:ses_both");
      const legacy = snapshots.find((snap) => snap.id === "opencode:ses_old");
      expect(snapshots.filter((snap) => snap.id === "opencode:ses_both")).toHaveLength(1);
      expect(current?.nickname).toBe("Current");
      expect(current?.cwd).toBe("/tmp/current");
      expect(legacy?.nickname).toBe("Legacy");
      expect(legacy?.cwd).toBe("/tmp/legacy");
      expect(legacy?.turns[0].prompt).toBe("Legacy prompt");
      expect(legacy?.turns[0].response).toBe("Legacy reply");
      expect(legacy?.turns[0].usage).toMatchObject({ input_tokens: 8, output_tokens: 1 });
      expect(legacy?.cost.usd).toBe(0.2);
    } finally { db.close(); }
  });

  it("reads tokens and tools stored on the assistant message when parts are absent", () => {
    const dir = home();
    const file = path.join(dir, "opencode.db");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE session_v2 (
        id text PRIMARY KEY, parent_id text, directory text, title text,
        time_created integer, time_updated integer, model text
      );
      CREATE TABLE session_message (
        id text PRIMARY KEY, session_id text, type text, time_created integer, data text
      );
    `);
    const created = 1_760_000_000_000;
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "ses_inline", null, "/tmp/inline", "Inline", created, created, null,
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
      "msg_user", "ses_inline", "user", created, JSON.stringify({ text: "Read the README" }),
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
      "msg_asst", "ses_inline", "assistant", created + 1, JSON.stringify({
        model: { id: "claude-sonnet-4-6", providerID: "opencode" },
        cost: 0,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } },
        content: [
          { type: "reasoning", text: "Thinking out loud." },
          { type: "text", text: "Reviewed." },
          { type: "tool", id: "call-1", name: "shell", state: {
            input: { command: "cat README.md" },
            content: [{ type: "text", text: "Demo README" }],
            status: "completed",
          } },
        ],
      }),
    );
    try {
      const snap = ingestSessions(file, { cacheHome: dir }).find((item) => item.id === "opencode:ses_inline");
      expect(snap?.turns).toHaveLength(1);
      expect(snap?.turns[0].response).toBe("Reviewed.");
      expect(snap?.turns[0].usage).toMatchObject({
        input_tokens: 150, cached_input_tokens: 40, cache_write_input_tokens: 10,
        output_tokens: 25, reasoning_output_tokens: 5,
      });
      expect(snap?.turns[0].tools[0]).toMatchObject({
        name: "exec", input: "cat README.md", outputPreview: "Demo README",
      });
      expect(snap?.cost.usd).toBeCloseTo(0.0007245, 10);
    } finally { db.close(); }
  });

  it("derives TTFT and request duration from OpenCode message stream times", () => {
    const dir = home();
    const file = path.join(dir, "opencode.db");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE session_v2 (
        id text PRIMARY KEY, parent_id text, directory text, title text,
        time_created integer, time_updated integer, model text
      );
      CREATE TABLE session_message (
        id text PRIMARY KEY, session_id text, type text, time_created integer, data text
      );
    `);
    const created = 1_760_000_000_000;
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "ses_timing", null, "/tmp/timing", "Timing", created, created + 10_000, null,
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
      "msg_user", "ses_timing", "user", created, JSON.stringify({ text: "Go" }),
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
      "msg_asst", "ses_timing", "assistant", created + 1_000, JSON.stringify({
        model: { id: "claude-sonnet-4-6", providerID: "opencode" },
        cost: 0,
        time: { created: created + 1_000, streamed: created + 2_700, completed: created + 4_000 },
        tokens: { input: 10, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
        content: [
          { type: "reasoning", text: "plan", time: { created: created + 1_500, completed: created + 2_200 } },
          { type: "text", text: "done", time: { created: created + 2_200, completed: created + 2_700 } },
          { type: "tool", id: "call-1", name: "shell", time: { created: created + 2_700, completed: created + 4_000 },
            state: { input: { command: "true" }, content: [{ type: "text", text: "ok" }], status: "completed" } },
        ],
      }),
    );
    try {
      const snap = ingestSessions(file, { cacheHome: dir }).find((item) => item.id === "opencode:ses_timing");
      // Request window ends at streamed (model finished), not completed (tools included).
      // TTFT is first reasoning/text created − request created; tok/s is decode over the rest.
      expect(snap?.turns[0].requestPerformance).toMatchObject({
        ttftMs: 500, durationMs: 1_700, speedSource: "decode",
        outputTokensPerSecond: 12 * 1000 / 1_200,
      });
      expect(snap?.performance).toMatchObject({
        basis: "request", avgTtftMs: 500, ttftSampleCount: 1,
        outputTokensPerSecond: 12 * 1000 / 1_200, requestDurationMs: 1_700,
      });
    } finally { db.close(); }
  });

  it("includes the WAL sidecar in the OpenCode database fingerprint", () => {
    const dir = home();
    const file = path.join(dir, "opencode.db");
    writeFileSync(file, "");
    writeFileSync(`${file}-wal`, "x");
    expect(fileFingerprint(file).walSize).toBe(1);
  });
});
