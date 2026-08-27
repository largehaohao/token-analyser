import { describe, expect, it, afterEach } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/store.ts";
import { startServer } from "../src/server.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

function waitPollAsS1(): string {
  return readFileSync(path.join(fixtures, "wait-poll.jsonl"), "utf8").replaceAll(
    '"s-poll"',
    '"s1"',
  );
}

function seedStore(store: SessionStore, dir: string): string {
  const rolloutPath = path.join(dir, "rollout-s1.jsonl");
  writeFileSync(rolloutPath, waitPollAsS1());
  store.refresh([rolloutPath]);
  return rolloutPath;
}

describe("startServer", () => {
  const homes: string[] = [];

  afterEach(() => {
    delete process.env.TOKEN_ANALYSER_HOME;
  });

  it("lists sessions, returns snapshot, patches toggles, imports ndjson, and streams SSE", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-"));
    process.env.TOKEN_ANALYSER_HOME = dir;
    homes.push(dir);

    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    seedStore(store, dir);

    const server = await startServer({ port: 0, store });

    try {
      const listRes = await fetch(`${server.url}/sessions`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { sessions: { id: string }[] };
      expect(listBody.sessions).toHaveLength(1);
      expect(listBody.sessions[0]!.id).toBe("s1");

      const snapRes = await fetch(`${server.url}/sessions/s1`);
      expect(snapRes.status).toBe(200);
      const snap = (await snapRes.json()) as { waste: { raw: number }; cost: { raw: number } };
      expect(snap.waste.raw).toBe(snap.cost.raw);

      const patchRes = await fetch(`${server.url}/sessions/s1/waste-toggles`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poll: false }),
      });
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as { waste: { raw: number } };
      expect(patched.waste.raw).toBe(0);

      const spawnCoord = readFileSync(
        path.join(fixtures, "spawn-coord.jsonl"),
        "utf8",
      );
      const importRes = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": "spawn-coord.jsonl",
        },
        body: spawnCoord,
      });
      expect(importRes.status).toBe(200);
      const imported = (await importRes.json()) as { id: string };
      expect(imported.id).toBe("s-coord");

      const listAfterImport = await fetch(`${server.url}/sessions`);
      const listAfterBody = (await listAfterImport.json()) as {
        sessions: { id: string }[];
      };
      expect(listAfterBody.sessions.map((s) => s.id)).toContain("s-coord");

      const events: string[] = [];
      const controller = new AbortController();
      const streamRes = await fetch(`${server.url}/stream`, {
        signal: controller.signal,
      });
      expect(streamRes.headers.get("content-type")).toContain("text/event-stream");

      const reader = streamRes.body!.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            events.push(decoder.decode(value));
          }
        } catch {
          // aborted
        }
      })();

      const extraPath = path.join(dir, "rollout-extra.jsonl");
      writeFileSync(
        extraPath,
        '{"timestamp":"2026-08-27T00:00:00.000Z","type":"session_meta","payload":{"id":"sse-1","session_id":"sse-1"}}\n',
      );
      store.ingestPath(extraPath);

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const joined = events.join("");
        if (joined.includes("session_added") || joined.includes("session_updated")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      controller.abort();

      expect(events.join("")).toMatch(/session_(added|updated)/);
    } finally {
      await server.close();
    }
  });

  it("returns 404 for unknown session", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-404-"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });

    try {
      const res = await fetch(`${server.url}/sessions/missing`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      await server.close();
    }
  });

  it("rejects invalid import paths", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });

    try {
      const res = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "relative.jsonl" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("streams session_error when import ingest fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-err-"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });

    try {
      const events: string[] = [];
      const controller = new AbortController();
      const streamRes = await fetch(`${server.url}/stream`, {
        signal: controller.signal,
      });
      const reader = streamRes.body!.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            events.push(decoder.decode(value));
          }
        } catch {
          // aborted
        }
      })();

      const missingPath = path.join(dir, "missing-rollout.jsonl");
      const importRes = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: missingPath }),
      });
      expect(importRes.status).toBe(500);
      expect(await importRes.json()).toEqual({ error: "ingest_failed" });

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        if (events.join("").includes("session_error")) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      controller.abort();

      expect(events.join("")).toContain("event: session_error");
      expect(events.join("")).toMatch(/"reason":/);
    } finally {
      await server.close();
    }
  });
});
