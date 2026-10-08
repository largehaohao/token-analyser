import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestFile, ingestSessions } from "../src/ingest.ts";
import { SessionStore } from "../src/store.ts";
import { collectSessionFiles } from "../src/session-files.ts";
import { watchSessions } from "../src/watch.ts";
import { nativeCost } from "../src/native-pricing.ts";
import { loadImportedSessions, startServer } from "../src/server.ts";

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures/native");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dirs: string[] = [];
function home() { const dir = mkdtempSync(path.join(tmpdir(), "native-sessions-")); dirs.push(dir); return dir; }
function fixture(name: string) { return readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8"); }
function write(dir: string, name: string, body: string) { const file = path.join(dir, name); writeFileSync(file, body); return file; }
afterEach(() => { delete process.env.TOKEN_ANALYSER_HOME; dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

describe("native session adapters", () => {
  it("combines Claude message snapshots and normalizes cache usage without charging Codex credits", () => {
    const dir = home();
    const snap = ingestFile(write(dir, "claude.jsonl", fixture("claude")), { cacheHome: dir });
    expect(snap.source).toBe("claude");
    expect(snap.id).toBe("claude:native-claude");
    expect(snap.turns).toHaveLength(1);
    expect(snap.cost).toMatchObject({ raw: 360, uncached_input: 150, cached_input: 200, output: 10, credits: null });
    expect(snap.cost.usd).toBeCloseTo(0.0006975, 10);
    expect(snap.turns[0].usage.cache_write_input_tokens).toBe(50);
    expect(snap.turns[0].pricing?.unit).toBe("usd");
    expect(snap.turns[0].tools[0].outputPreview).toBe("Demo README");
    expect(snap.turns[0].response).toBe("README reviewed.");
    expect(snap.performance?.avgTtftMs).toBeNull();
  });

  it("links Claude subagents by parent directory and isolates native IDs from Codex IDs", () => {
    const dir = home();
    const subdir = path.join(dir, "native-claude", "subagents"); mkdirSync(subdir, { recursive: true });
    const parent = write(dir, "claude.jsonl", fixture("claude"));
    const child = write(subdir, "agent-child.jsonl", fixture("claude").replaceAll("native-claude", "embedded-child-id"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    store.refresh([parent, child]);
    expect(store.list()).toHaveLength(1);
    expect(store.get("claude:native-claude")?.children[0].id).toBe("claude:native-claude:agent:child");
    expect(store.list()[0].cost.raw).toBe(720);
  });

  it("reads pi recorded USD, tools, branch context and usage-only entries", () => {
    const dir = home();
    const events = fixture("pi").trim().split("\n").map((line) => JSON.parse(line));
    events.push({ type: "message", id: "other-u", parentId: "u1", timestamp: "2026-10-08T00:01:00Z", message: { role: "user", content: "Different branch" } });
    events.push({ ...events[3], id: "branch-a", parentId: "u1" });
    events.push({ type: "usage", id: "usage", parentId: "branch-a", timestamp: "2026-10-08T00:02:00Z", provider: "anthropic", model: "claude-sonnet-4-6", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.12 } } });
    const snap = ingestFile(write(dir, "pi.jsonl", events.map((event) => JSON.stringify(event)).join("\n")), { cacheHome: dir });
    expect(snap.source).toBe("pi"); expect(snap.nickname).toBe("pi demo");
    expect(snap.turns).toHaveLength(3); expect(snap.turns[1].prompt).toBe("Read the README");
    expect(snap.cost.raw).toBe(723); expect(snap.cost.usd).toBeCloseTo(0.121395, 10);
    expect(snap.cost.credits).toBeNull(); expect(snap.turns[0].pricing).toBeNull();
    expect(snap.turns[0].tools[0].outputPreview).toBe("Demo README");
  });

  it("excludes inherited pi fork entries from total spend", () => {
    const dir = home(); const parent = write(dir, "parent.jsonl", fixture("pi"));
    const events = fixture("pi").trim().split("\n").map((line) => JSON.parse(line));
    events[0].id = "fork"; events[0].parentSession = parent;
    events.push({ ...events[3], id: "new-response", parentId: "r1" });
    const fork = write(dir, "fork.jsonl", events.map((event) => JSON.stringify(event)).join("\n"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") }); store.refresh([parent, fork]);
    expect(store.get("pi:fork")?.turns).toHaveLength(1);
    expect(store.overview({ watchPath: dir }).cost.raw).toBe(720);
  });

  it("keeps Cursor transcript conversations and tools without inventing tokens, costs or performance", () => {
    const dir = home(); const snap = ingestFile(write(dir, "cursor.jsonl", fixture("cursor")), { cacheHome: dir });
    expect(snap.source).toBe("cursor"); expect(snap.turns).toHaveLength(1);
    expect(snap.cost).toMatchObject({ raw: 0, unmeasured: 1, usd: null, credits: null });
    expect(snap.turns[0].usageRecorded).toBe(false);
    expect(snap.turns[0].prompt).toBe("Read the README"); expect(snap.turns[0].tools).toHaveLength(1);
    expect(snap.performance?.outputTokensPerSecond).toBeNull();
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") }); store.refresh([snap.path]);
    expect(store.overview({ watchPath: dir }).cost).toMatchObject({ unmeasured: 1, usd: null, credits: null });
  });

  it("prices cache writes at 1 hour rates and leaves unknown models/Fast rates unpriced", () => {
    const usage = { input_tokens: 350, cached_input_tokens: 200, cache_write_input_tokens: 50, output_tokens: 10, total_tokens: 360, reasoning_output_tokens: 0 };
    expect(nativeCost(usage, "claude-sonnet-4-6", { cacheWrite1h: 50 }).cost.usd).toBeCloseTo(0.00081, 10);
    expect(nativeCost(usage, "claude-sonnet-4-6", { fast: true }).cost.usd).toBeNull();
    expect(nativeCost(usage, "custom-model").cost.usd).toBeNull();
    expect(nativeCost(usage, "custom-model", { recordedUsd: 0 }).cost.usd).toBe(0);
  });
});

function cursorDb(dir: string) {
  const file = path.join(dir, "state.vscdb"); const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const put = db.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)");
  function session(id: string, parent = "", measured = false) {
    put.run(`composerData:${id}`, JSON.stringify({ composerId: id, name: `Cursor ${id}`, createdAt: Date.now() - 86400000, lastUpdatedAt: Date.now() - 86400000, subagentInfo: { parentComposerId: parent }, modelConfig: { selectedModels: [{ modelId: "selected-model" }] }, fullConversationHeadersOnly: [{ bubbleId: "user" }, { bubbleId: "assistant" }] }));
    put.run(`bubbleId:${id}:user`, JSON.stringify({ bubbleId: "user", type: 1, text: "Read README", createdAt: Date.now() - 86400000 }));
    put.run(`bubbleId:${id}:assistant`, JSON.stringify({ bubbleId: "assistant", type: 2, text: "Reviewed", createdAt: Date.now() - 86400000, tokenCount: { inputTokens: measured ? 100 : 0, outputTokens: measured ? 20 : 0 }, toolFormerData: { name: "read_file", toolCallId: "tool", params: '{"target_file":"README.md"}', result: "Demo README" } }));
  }
  session("parent"); session("child", "parent", true);
  return { file, db, session };
}

describe("Cursor database and multi-source integration", () => {
  it("reads a read-only SQLite database into multiple linked sessions, preserves zero placeholders as unknown, and removes all file sessions", () => {
    const dir = home(); const { file, db } = cursorDb(dir);
    try {
      const snapshots = ingestSessions(file); expect(snapshots).toHaveLength(2);
      const parent = snapshots.find((snap) => snap.id === "cursor:parent")!;
      expect(parent.model).toBe("selected-model"); expect(parent.turns[0].model).toBeNull();
      expect(parent.cost.unmeasured).toBe(1); expect(parent.turns[0].tools[0].outputPreview).toBe("Demo README");
      expect(parent.live).toBe(false); expect(parent.turns[0].tools).toHaveLength(1);
      const store = new SessionStore({ cacheDir: path.join(dir, "cache") }); store.refresh([file]);
      expect(store.list()).toHaveLength(1); expect(store.list()[0].cost.raw).toBe(120);
      expect(store.list()[0].cost.unmeasured).toBe(1); expect(store.list()[0].source).toBe("cursor");
      store.refreshPricing(); expect(store.get("cursor:parent")?.children).toHaveLength(1);
      store.removePath(file); expect(store.list()).toHaveLength(0);
    } finally { db.close(); }
  });

  it("discovers JSONL and DB file roots and updates Cursor sessions when only WAL changes", async () => {
    const dir = home(); const { file, db, session } = cursorDb(dir);
    const pi = write(dir, "pi.jsonl", fixture("pi"));
    expect(collectSessionFiles([dir, file])).toEqual(expect.arrayContaining([file, pi]));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") }); store.refresh([file, pi]);
    const stop = watchSessions(store, () => {}, { watchPaths: [file, dir], recursive: false });
    try {
      session("added");
      appendFileSync(pi, JSON.stringify({ type: "message", id: "appended", parentId: "r1", timestamp: new Date().toISOString(), message: { role: "assistant", model: "custom", content: "Another reply", usage: { input: 1, output: 2, cost: { total: 0.1 } } } }) + "\n");
      await expect.poll(() => store.get("cursor:added")?.source, { timeout: 3000 }).toBe("cursor");
      await expect.poll(() => store.get("pi:native-pi")?.cost.raw, { timeout: 3000 }).toBe(363);
    } finally { stop(); db.close(); }
  });

  it("imports all three native formats over HTTP, restores them after restart, and reports USD without unpriced false positives", async () => {
    const dir = home(); process.env.TOKEN_ANALYSER_HOME = dir;
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") }); const server = await startServer({ port: 0, store });
    try {
      for (const source of ["claude", "pi", "cursor"]) {
        const res = await fetch(`${server.url}/import`, { method: "POST", headers: { "Content-Type": "application/x-ndjson", "X-Filename": `${source}.jsonl` }, body: fixture(source) });
        expect(res.status).toBe(200);
        const imported = await res.json(); expect(imported.source).toBe(source);
        const detail = await fetch(`${server.url}/sessions/${encodeURIComponent(imported.id)}`);
        expect(detail.status).toBe(200); expect((await detail.json()).id).toBe(imported.id);
        const toggles = await fetch(`${server.url}/sessions/${encodeURIComponent(imported.id)}/waste-toggles`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"planning":true}' });
        expect(toggles.status).toBe(200);
      }
      const overview = await (await fetch(`${server.url}/overview`)).json();
      expect(overview.sessionCount).toBe(3); expect(overview.cost).toMatchObject({ raw: 720, credits: null, unmeasured: 1 });
      expect(overview.cost.usd).toBeCloseTo(0.001395, 10); expect(overview.unpricedRaw).toBe(0);
      const restored = new SessionStore({ cacheDir: path.join(dir, "cache") });
      loadImportedSessions(restored, path.join(dir, "imports")); expect(restored.list()).toHaveLength(3);
    } finally { await server.close(); }
  });
});
