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

  it("reads DeepSeek Harness zstd sessions with usage, tools and titles", () => {
    const dir = home();
    const zstd = path.join(fixtures, "dsh.jsonl.zstd");
    const target = path.join(dir, ".dsh", "sessions", "proj", "dsh-demo", "session.v4.jsonl.zstd");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(zstd));
    const snap = ingestFile(target, { cacheHome: dir });
    expect(snap.source).toBe("dsh");
    expect(snap.id).toBe("dsh:dsh-demo");
    expect(snap.nickname).toBe("DSH demo");
    expect(snap.cwd).toBe("/tmp/demo");
    expect(snap.turns).toHaveLength(1);
    expect(snap.turns[0].prompt).toBe("Read the README");
    expect(snap.turns[0].usage).toMatchObject({
      input_tokens: 150, cached_input_tokens: 50, output_tokens: 20,
    });
    expect(snap.turns[0].tools[0].outputPreview).toBe("Demo README");
    // TTFT/duration from step/start → stream; tok/s is decode = output/(duration−TTFT).
    expect(snap.turns[0].requestPerformance).toMatchObject({
      ttftMs: 500, durationMs: 1700, outputTokensPerSecond: 20 * 1000 / 1200, speedSource: "decode",
    });
    expect(snap.performance).toMatchObject({
      basis: "request", avgTtftMs: 500, ttftSampleCount: 1, outputTokensPerSecond: 20 * 1000 / 1200,
    });
    expect(snap.cost.raw).toBe(170);
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
    expect(snap.turns[0].requestPerformance?.durationMs).toBe(2000);
    expect(snap.performance).toMatchObject({ basis: "request", avgTtftMs: null, ttftSampleCount: 0, outputTokensPerSecond: 5 });
  });

  it("times pi requests from the request-timing extension and reports the decode rate", () => {
    const dir = home();
    const snap = ingestFile(write(dir, "pi-request-timing.jsonl", fixture("pi-request-timing")), { cacheHome: dir });
    expect(snap.turns).toHaveLength(5);
    // The entry's TTFT joins by messageEntryId; pi's own durationMs wins over
    // the entry's copy, and tok/s drops the first-token wait -> decode rate.
    expect(snap.turns[0].requestPerformance).toMatchObject({
      ttftMs: 4720, durationMs: 5342, speedSource: "decode",
      outputTokensPerSecond: 63 * 1000 / (5342 - 4720),
    });
    // An assistant entry with no durationMs takes the entry's measured window.
    expect(snap.turns[1].requestPerformance).toMatchObject({
      ttftMs: 598, durationMs: 1115, speedSource: "decode",
      outputTokensPerSecond: 46 * 1000 / (1115 - 598),
    });
    // A first-token time past the logged window stays a valid measurement;
    // only the decode window is lost, so no speed is invented.
    expect(snap.turns[2].requestPerformance).toMatchObject({
      ttftMs: 1200, durationMs: 1000, outputTokensPerSecond: null, speedSource: null,
    });
    // A turn whose entry has no messageEntryId joins by responseId.
    expect(snap.turns[3].requestPerformance).toMatchObject({
      ttftMs: 800, durationMs: 2000, speedSource: "decode", outputTokensPerSecond: 10,
    });
    // With the extension off the request keeps the full-window rate, labelled
    // separately so the two denominators are never read as one number.
    expect(snap.turns[4].requestPerformance).toMatchObject({
      ttftMs: null, durationMs: 4000, speedSource: "duration", outputTokensPerSecond: 5,
    });
    // Session summary pools only requests that have a generation window, and
    // averages TTFT over the requests that recorded one.
    expect(snap.performance).toMatchObject({
      basis: "request", ttftSampleCount: 4, avgTtftMs: (4720 + 598 + 1200 + 800) / 4,
      speedSampleCount: 4,
      outputTokensPerSecond: (63 + 46 + 12 + 20) * 1000 / (622 + 517 + 1200 + 4000),
    });
    // Performance figures never leak into the token ledger: usage and recorded
    // USD come from the assistant entries alone.
    expect(snap.turns.map((turn) => turn.usage.output_tokens)).toEqual([63, 46, 20, 12, 20]);
    expect(snap.cost.usd).toBeCloseTo(0.0021, 10);
  });

  it("joins extension-recorded pi request timing onto its model call", () => {
    const dir = home();
    const events = fixture("pi").trim().split("\n").map((line) => JSON.parse(line));
    events.push({ type: "custom", customType: "request_timing", id: "t1", parentId: "a1", timestamp: "2026-10-08T00:02:00Z",
      data: { version: 1, messageEntryId: "a1", responseId: null, ttft_ms: 500, piDurationMs: 2000, attempts: 1 } });
    const snap = ingestFile(write(dir, "pi.jsonl", events.map((event) => JSON.stringify(event)).join("\n")), { cacheHome: dir });
    const call = snap.turns[0].requestPerformance;
    expect(call?.ttftMs).toBe(500);
    // pi's own durationMs stays authoritative, and tok/s drops the first-token wait.
    expect(call?.durationMs).toBe(2000);
    expect(call?.speedSource).toBe("decode");
    expect(call?.outputTokensPerSecond).toBeCloseTo(10 * 1000 / 1500, 6);
    expect(snap.performance).toMatchObject({ basis: "request", avgTtftMs: 500, ttftSampleCount: 1 });

    // Requests whose turn never emitted an entry id join by responseId instead.
    const orphan = fixture("pi").trim().split("\n").map((line) => JSON.parse(line));
    orphan[3].message.responseId = "resp-a1";
    orphan.push({ type: "custom", customType: "request_timing", id: "t2", parentId: "a1", timestamp: "2026-10-08T00:02:00Z",
      data: { version: 1, messageEntryId: null, responseId: "resp-a1", ttft_ms: 800, piDurationMs: 2000 } });
    const fallback = ingestFile(write(dir, "pi-orphan.jsonl", orphan.map((event) => JSON.stringify(event)).join("\n")), { cacheHome: dir });
    expect(fallback.turns[0].requestPerformance?.ttftMs).toBe(800);
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
    expect(snap.contextMeasurement).toMatchObject({
      usedTokens: 24_556, limitTokens: 200_000, usagePercent: 12, source: "cursor",
      categories: [{ id: "conversation", label: "会话", tokens: 6_057 }, { id: "tools", label: "工具定义", tokens: 7_424 }],
    });
    expect(snap.cost.raw).toBe(0);
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
    put.run(`composerData:${id}`, JSON.stringify({ composerId: id, name: `Cursor ${id}`, createdAt: Date.now() - 86400000, lastUpdatedAt: Date.now() - 86400000, subagentInfo: { parentComposerId: parent }, modelConfig: { selectedModels: [{ modelId: "selected-model" }] }, contextTokensUsed: measured ? 24_000 : null, contextTokenLimit: measured ? 200_000 : null, contextUsagePercent: measured ? 12 : null, promptTokenBreakdown: measured ? { totalUsedTokens: 24_556, maxTokens: 200_000, categories: [{ id: "conversation", label: "Conversation", estimatedTokens: 6_057 }] } : undefined, fullConversationHeadersOnly: [{ bubbleId: "user" }, { bubbleId: "assistant" }] }));
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

  it("deduplicates the same Cursor sessions discovered in global and workspace stores and retains request timing", () => {
    const dir = home();
    const globalDir = path.join(dir, "globalStorage");
    const workspaceDir = path.join(dir, "workspaceStorage", "workspace");
    mkdirSync(globalDir, { recursive: true }); mkdirSync(workspaceDir, { recursive: true });
    const first = cursorDb(globalDir); const second = cursorDb(workspaceDir);
    try {
      const row = second.db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get("bubbleId:parent:assistant")!;
      const bubble = JSON.parse(String(row.value));
      bubble.request_performance = { ttft_ms: 120, duration_ms: 1000, tokens_per_second: 15 };
      second.db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify(bubble), "bubbleId:parent:assistant");
      const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
      store.refresh(collectSessionFiles([globalDir, path.join(dir, "workspaceStorage")]));
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0].cost.raw).toBe(120);
      expect(store.get("cursor:parent")?.turns[0].requestPerformance).toMatchObject({ ttftMs: 120, outputTokensPerSecond: 15 });
    } finally { first.db.close(); second.db.close(); }
  });

  it("reports Cursor's own context meter as a measurement, never as billable tokens", () => {
    const dir = home();
    const { file, db } = cursorDb(dir);
    try {
      const snapshots = ingestSessions(file);
      const child = snapshots.find((snap) => snap.id === "cursor:child")!;
      expect(child.contextMeasurement).toMatchObject({
        usedTokens: 24_000, limitTokens: 200_000, usagePercent: 12, source: "cursor",
        categories: [{ id: "conversation", label: "Conversation", tokens: 6_057 }],
      });
      expect(child.cost.raw).toBe(120);
      const parent = snapshots.find((snap) => snap.id === "cursor:parent")!;
      expect(parent.contextMeasurement).toBeNull();
      const store = new SessionStore({ cacheDir: path.join(dir, "cache") }); store.refresh([file]);
      expect(store.overview({ watchPath: dir }).cost.raw).toBe(120);
    } finally { db.close(); }
  });

  // A state.vscdb is re-ingested on a 5s debounce (Cursor rewrites its WAL
  // continuously), so this needs a longer budget than the default 5s test.
  it("discovers JSONL and DB file roots and updates Cursor sessions when only WAL changes", async () => {
    const dir = home(); const { file, db, session } = cursorDb(dir);
    const pi = write(dir, "pi.jsonl", fixture("pi"));
    expect(collectSessionFiles([dir, file])).toEqual(expect.arrayContaining([file, pi]));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") }); store.refresh([file, pi]);
    const stop = watchSessions(store, () => {}, { watchPaths: [file, dir], recursive: false });
    try {
      session("added");
      appendFileSync(pi, JSON.stringify({ type: "message", id: "appended", parentId: "r1", timestamp: new Date().toISOString(), message: { role: "assistant", model: "custom", content: "Another reply", usage: { input: 1, output: 2, cost: { total: 0.1 } } } }) + "\n");
      await expect.poll(() => store.get("cursor:added")?.source, { timeout: 8_000 }).toBe("cursor");
      await expect.poll(() => store.get("pi:native-pi")?.cost.raw, { timeout: 8_000 }).toBe(363);
    } finally { stop(); db.close(); }
  }, 20_000);

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
      for (const source of ["claude", "pi", "cursor", "codex"]) {
        const filtered = await (await fetch(`${server.url}/overview?source=${source}`)).json();
        expect(filtered.sessionCount).toBe(source === "codex" ? 0 : 1);
        expect(filtered.cost.raw).toBe(source === "claude" || source === "pi" ? 360 : 0);
        expect(filtered.cost.unmeasured ?? 0).toBe(source === "cursor" ? 1 : 0);
      }
      const ranged = await (await fetch(`${server.url}/overview?source=pi&since=2026-10-09T00:00:00Z`)).json();
      expect(ranged.sessionCount).toBe(0); expect(ranged.cost.raw).toBe(0);
      expect((await fetch(`${server.url}/overview?source=invalid`)).status).toBe(400);
      const restored = new SessionStore({ cacheDir: path.join(dir, "cache") });
      loadImportedSessions(restored, path.join(dir, "imports")); expect(restored.list()).toHaveLength(3);
    } finally { await server.close(); }
  });

  it("preserves explicit per-request timings in all native formats", () => {
    const dir = home();
    for (const source of ["claude", "pi", "cursor"]) {
      const events = fixture(source).trim().split("\n").map((line) => JSON.parse(line));
      const replies = events.filter((event) => event.message?.role === "assistant" || event.role === "assistant");
      const reply = replies.at(-1)!;
      reply.message.request_performance = { ttft_ms: 300, duration_ms: 1000, tokens_per_second: 10 };
      const snap = ingestFile(write(dir, `timing-${source}.jsonl`, events.map((event) => JSON.stringify(event)).join("\n")), { cacheHome: dir });
      expect(snap.turns[0].requestPerformance).toEqual({ ttftMs: 300, durationMs: 1000, outputTokensPerSecond: 10, speedSource: "recorded" });
    }
  });
});
