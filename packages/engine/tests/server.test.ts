import { describe, expect, it, afterEach } from "vitest";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  utimesSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/store.ts";
import { loadImportedSessions, startServer } from "../src/server.ts";

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

  it("restores imports after restart and never overwrites a same-name file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-restore-"));
    process.env.TOKEN_ANALYSER_HOME = dir;
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });

    try {
      const first = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": "session.ndjson",
        },
        body: readFileSync(path.join(fixtures, "spawn-coord.jsonl"), "utf8"),
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": "session.ndjson",
        },
        body: waitPollAsS1(),
      });
      expect(second.status).toBe(200);
    } finally {
      await server.close();
    }

    const importsDir = path.join(dir, "imports");
    expect(readdirSync(importsDir).sort()).toEqual([
      "session-2.ndjson",
      "session.ndjson",
    ]);

    const restarted = new SessionStore({ cacheDir: path.join(dir, "cache-2") });
    expect(loadImportedSessions(restarted, importsDir).sort()).toEqual([
      "s-coord",
      "s1",
    ]);
    expect(restarted.list().map((item) => item.id).sort()).toEqual([
      "s-coord",
      "s1",
    ]);
  });

  it("reserves a unique name when same-name uploads arrive concurrently", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-race-"));
    process.env.TOKEN_ANALYSER_HOME = dir;
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });
    const firstBody = waitPollAsS1().replaceAll('"s1"', '"race-one"');
    const secondBody = waitPollAsS1().replaceAll('"s1"', '"race-two"');

    let finishFirst!: () => void;
    let firstFinished = false;
    const firstResponse = new Promise<number>((resolve, reject) => {
      const url = new URL(`${server.url}/import`);
      const request = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/x-ndjson",
            "X-Filename": "race.ndjson",
            "Content-Length": Buffer.byteLength(firstBody),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.write(firstBody.slice(0, 1));
      finishFirst = () => {
        if (firstFinished) return;
        firstFinished = true;
        request.end(firstBody.slice(1));
      };
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondResponse = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": "race.ndjson",
        },
        body: secondBody,
      });
      await secondResponse.text();
      finishFirst();
      expect(await firstResponse).toBe(200);
      expect(secondResponse.status).toBe(200);

      const files = readdirSync(path.join(dir, "imports"))
        .filter((name) => name.startsWith("race"))
        .sort();
      expect(files).toEqual(["race-2.ndjson", "race.ndjson"]);
      expect(readFileSync(path.join(dir, "imports", files[0]!), "utf8")).toContain(
        '"race-one"',
      );
      expect(readFileSync(path.join(dir, "imports", files[1]!), "utf8")).toContain(
        '"race-two"',
      );
    } finally {
      finishFirst();
      await server.close();
    }
  });

  it("keeps a loaded canonical session when importing the same id over HTTP", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-canonical-http-"));
    process.env.TOKEN_ANALYSER_HOME = dir;
    const watchedPath = path.join(dir, "rollout-s1.jsonl");
    writeFileSync(watchedPath, waitPollAsS1());
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    store.refresh([watchedPath]);
    const before = store.get("s1")!;
    const server = await startServer({ port: 0, store });

    try {
      const response = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": "stale.ndjson",
        },
        body: waitPollAsS1().replace('"input_tokens":90', '"input_tokens":900'),
      });
      const imported = (await response.json()) as { id: string; path: string; cost: { raw: number } };
      expect(response.status).toBe(200);
      expect(imported.id).toBe("s1");
      expect(imported.path).toBe(watchedPath);
      expect(imported.cost.raw).toBe(before.cost.raw);
    } finally {
      await server.close();
    }
  });

  it("keeps a watched session canonical when an import has the same id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-duplicate-id-"));
    const importsDir = path.join(dir, "imports");
    mkdirSync(importsDir);
    const watchedPath = path.join(dir, "rollout-s1.jsonl");
    writeFileSync(watchedPath, waitPollAsS1());
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    store.refresh([watchedPath]);
    const importedPath = path.join(importsDir, "same-id.ndjson");
    writeFileSync(importedPath, waitPollAsS1().replace("100", "999"), {
      flag: "w",
    });

    loadImportedSessions(store, importsDir);

    expect(store.get("s1")?.path).toBe(watchedPath);
  });

  it("restores the newest copy when durable imports share a session id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-newest-"));
    const importsDir = path.join(dir, "imports");
    mkdirSync(importsDir);
    const older = path.join(importsDir, "older.ndjson");
    const newer = path.join(importsDir, "newer.ndjson");
    writeFileSync(older, waitPollAsS1());
    writeFileSync(
      newer,
      waitPollAsS1().replaceAll('"input_tokens":90', '"input_tokens":900'),
    );
    utimesSync(older, new Date(1_000), new Date(1_000));
    utimesSync(newer, new Date(2_000), new Date(2_000));

    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    loadImportedSessions(store, importsDir);

    expect(store.get("s1")?.path).toBe(newer);
    expect(store.get("s1")?.cost.raw).toBe(910);
  });

  it("rejects imported payloads whose filename is not JSONL or NDJSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-name-"));
    process.env.TOKEN_ANALYSER_HOME = dir;
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });
    try {
      const res = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": "session.txt",
        },
        body: waitPollAsS1(),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_filename" });
    } finally {
      await server.close();
    }
  });

  it("accepts percent-encoded UTF-8 import filenames", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-import-unicode-name-"));
    process.env.TOKEN_ANALYSER_HOME = dir;
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });

    try {
      const response = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": encodeURIComponent("会话.ndjson"),
        },
        body: waitPollAsS1(),
      });
      expect(response.status).toBe(200);
      expect(readdirSync(path.join(dir, "imports"))).toContain("会话.ndjson");
    } finally {
      await server.close();
    }
  });

  it("returns an overview of root sessions", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-overview-"));
    process.env.TOKEN_ANALYSER_HOME = dir;
    homes.push(dir);

    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    seedStore(store, dir);

    const server = await startServer({ port: 0, store });

    try {
      const res = await fetch(`${server.url}/overview`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionCount: number;
        turnCount: number;
        slices: { key: string; raw: number }[];
        rateCardAsOf: string;
      };
      expect(body.sessionCount).toBe(1);
      expect(body.turnCount).toBeGreaterThan(0);
      expect(body.slices.some((s) => s.key === "waiting" && s.raw > 0)).toBe(true);

      const emptyRes = await fetch(
        `${server.url}/overview?since=2099-01-01T00:00:00.000Z`,
      );
      expect(emptyRes.status).toBe(200);
      const emptyBody = (await emptyRes.json()) as { sessionCount: number };
      expect(emptyBody.sessionCount).toBe(0);
      expect(body.rateCardAsOf).toBe("2026-08-29");
    } finally {
      await server.close();
    }
  });

  it("answers CORS preflight with allowed headers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-cors-"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });
    try {
      const res = await fetch(`${server.url}/import`, {
        method: "OPTIONS",
      });
      expect(res.status).toBe(204);
      const allow = res.headers.get("access-control-allow-headers") ?? "";
      expect(allow.toLowerCase()).toContain("content-type");
      expect(allow.toLowerCase()).toContain("x-filename");
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

  it("rejects malformed JSON bodies without taking down the server", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-invalid-body-"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({ port: 0, store });

    try {
      const importRes = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
      expect(importRes.status).toBe(400);

      const toggleRes = await fetch(`${server.url}/sessions/missing/waste-toggles`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
      expect(toggleRes.status).toBe(404);

      const alive = await fetch(`${server.url}/sessions`);
      expect(alive.status).toBe(200);
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

  it("emits session_updated for the parent when a child is ingested", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-child-sse-"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const parentPath = path.join(dir, "rollout-parent.jsonl");
    const childPath = path.join(dir, "rollout-child.jsonl");
    writeFileSync(
      parentPath,
      waitPollAsS1().replaceAll('"s1"', '"parent-1"'),
    );
    writeFileSync(
      childPath,
      readFileSync(path.join(fixtures, "child-prefix.jsonl"), "utf8"),
    );
    store.refresh([parentPath]);

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

      store.ingestPath(childPath);

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const joined = events.join("");
        if (joined.includes("parent-1")) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      controller.abort();

      const joined = events.join("");
      expect(joined).toContain("event: session_updated");
      expect(joined).toContain('"id":"parent-1"');
      expect(joined).not.toMatch(/event: session_added[\s\S]*"id":"child-1"/);
    } finally {
      await server.close();
    }
  });

  it("rejects oversized import bodies with 413", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-413-"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({
      port: 0,
      store,
      maxImportBytes: 16,
    });
    try {
      const res = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Filename": "rollout-big.jsonl",
        },
        body: "x".repeat(64),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    } finally {
      await server.close();
    }
  });

  it("rejects oversized JSON import bodies with 413", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "server-413-json-"));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    const server = await startServer({
      port: 0,
      store,
      maxImportBytes: 16,
    });
    try {
      const res = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(64),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    } finally {
      await server.close();
    }
  });
});
