import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, writeFileSync, mkdtempSync, utimesSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestFile,
  hasLiveReadState,
  readJsonlFile,
} from "../src/ingest.ts";
import { SessionStore } from "../src/store.ts";
import { isZstdSessionFile } from "../src/zstd-jsonl.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

describe("readJsonlFile", () => {
  afterEach(() => {
    delete process.env.TOKEN_ANALYSER_HOME;
  });
  it("returns complete events when file ends with an incomplete line", () => {
    const waitPoll = readFileSync(
      path.join(fixtures, "wait-poll.jsonl"),
      "utf8",
    );
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-"));
    const filePath = path.join(dir, "rollout-incomplete.jsonl");
    writeFileSync(filePath, waitPoll + '{"timestamp":');

    const { events, parse_errors } = readJsonlFile(filePath);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("session_meta");
    expect(parse_errors).toEqual([]);
  });

  it("records parse_errors for a corrupt middle line and continues", () => {
    const waitPoll = readFileSync(
      path.join(fixtures, "wait-poll.jsonl"),
      "utf8",
    );
    const lines = waitPoll.trimEnd().split("\n");
    lines.splice(2, 0, "{not json}");
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-"));
    const filePath = path.join(dir, "rollout-corrupt.jsonl");
    writeFileSync(filePath, lines.join("\n") + "\n");

    const { events, parse_errors } = readJsonlFile(filePath);
    expect(events.length).toBeGreaterThan(0);
    expect(parse_errors).toHaveLength(1);
    expect(parse_errors[0]!.message.length).toBeGreaterThan(0);
  });

  it("handles a trailing incomplete line split across read chunks", () => {
    const waitPoll = readFileSync(
      path.join(fixtures, "wait-poll.jsonl"),
      "utf8",
    );
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-"));
    const filePath = path.join(dir, "rollout-chunked.jsonl");
    // Force the incomplete tail to span a 64-byte read boundary.
    const payload = waitPoll + '{"timestamp":"2026-08-27T00:99:00.000Z"';
    writeFileSync(filePath, payload);

    const { events, parse_errors } = readJsonlFile(filePath);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("session_meta");
    expect(parse_errors).toEqual([]);
  });

  it("resumes a live file after a line longer than the read chunk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-long-line-"));
    const filePath = path.join(dir, "rollout-long.jsonl");
    const pad = "a".repeat(70_000);
    const first = `{"type":"session_meta","payload":{"id":"long","pad":"${pad}"}}\n`;
    const second = '{"type":"event_msg","timestamp":"2026-11-20T00:00:00.000Z","payload":{"type":"token_count"}}\n';
    writeFileSync(filePath, first);
    const initial = ingestFile(filePath, { allowAppend: true });
    expect(initial.parse_errors).toEqual([]);
    appendFileSync(filePath, second);
    const appended = ingestFile(filePath, { allowAppend: true });
    expect(appended.parse_errors).toEqual([]);
  });

  it("parses a JSONL line whose non-ASCII character sits on a 64-byte chunk boundary", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-utf8-"));
    const filePath = path.join(dir, "rollout-utf8.jsonl");
    const head = '{"type":"session_meta","payload":{"id":"u8","pad":"';
    const tail = '"}}\n';
    const headLen = Buffer.byteLength(head, "utf8");
    const pad = "a".repeat(63 - headLen);
    const line = head + pad + "€" + tail;
    expect(Buffer.byteLength(head + pad, "utf8")).toBe(63);

    writeFileSync(filePath, line);
    const { events, parse_errors } = readJsonlFile(filePath, { chunkBytes: 64 });
    expect(parse_errors).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("session_meta");
    expect((events[0]!.payload as { pad: string }).pad).toContain("€");
  });

  it("parses a complete final JSONL event without a trailing newline", () => {
    const waitPoll = readFileSync(
      path.join(fixtures, "wait-poll.jsonl"),
      "utf8",
    );
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-final-line-"));
    const filePath = path.join(dir, "rollout-final.jsonl");
    writeFileSync(filePath, waitPoll.trimEnd());
    const { events, parse_errors } = readJsonlFile(filePath);
    expect(parse_errors).toEqual([]);
    expect(events.length).toBe(
      waitPoll.trimEnd().split("\n").length,
    );
  });

  it("reads appended live bytes without reparsing the existing prefix", () => {
    const waitPoll = readFileSync(
      path.join(fixtures, "wait-poll.jsonl"),
      "utf8",
    );
    const [first, ...rest] = waitPoll.trimEnd().split("\n");
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-live-"));
    const filePath = path.join(dir, "rollout-live.jsonl");
    writeFileSync(filePath, first);
    expect(ingestFile(filePath, { allowAppend: true }).turns).toHaveLength(0);
    appendFileSync(filePath, `\n${rest.join("\n")}`);
    expect(ingestFile(filePath, { allowAppend: true }).turns.length).toBeGreaterThan(0);
  });

  it("evicts live append state when the store drops the path", () => {
    const waitPoll = readFileSync(
      path.join(fixtures, "wait-poll.jsonl"),
      "utf8",
    );
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-evict-"));
    const filePath = path.join(dir, "rollout-live.jsonl");
    writeFileSync(filePath, waitPoll.split("\n")[0]!);
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    store.ingestPath(filePath, { allowAppend: true });
    expect(hasLiveReadState(filePath)).toBe(true);
    store.removePath(filePath);
    expect(hasLiveReadState(filePath)).toBe(false);
  });

  it("evicts live append state once the file is no longer active", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-expire-"));
    const filePath = path.join(dir, "rollout-expire.jsonl");
    writeFileSync(
      filePath,
      '{"timestamp":"2026-08-27T00:00:00.000Z","type":"session_meta","payload":{"id":"expire"}}\n',
    );
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    store.ingestPath(filePath, { allowAppend: true });
    expect(hasLiveReadState(filePath)).toBe(true);

    const old = new Date(Date.now() - 180_000);
    utimesSync(filePath, old, old);
    expect(store.list()[0]!.live).toBe(false);
    expect(hasLiveReadState(filePath)).toBe(false);
  });

  it("invalidates the historical cache when the effective rate card changes", () => {
    const waitPoll = readFileSync(path.join(fixtures, "wait-poll.jsonl"), "utf8");
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-cache-rate-"));
    const filePath = path.join(dir, "rollout-cache-rate.jsonl");
    writeFileSync(filePath, waitPoll);
    const old = new Date(Date.now() - 600_000);
    utimesSync(filePath, old, old);
    process.env.TOKEN_ANALYSER_HOME = dir;
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ usd_per_credit: 0.04 }));
    const first = ingestFile(filePath, { cacheHome: dir });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ usd_per_credit: 1 }));
    const second = ingestFile(filePath, { cacheHome: dir });
    expect(second.cost.usd).toBeGreaterThan(first.cost.usd!);
  });
});

describe("live LedgerBuilder", () => {
  it("rebuilds when session_meta arrives after an empty first parse", () => {
    const full = readFileSync(path.join(fixtures, "child-prefix.jsonl"), "utf8");
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-child-live-"));
    const filePath = path.join(dir, "rollout-child.jsonl");
    writeFileSync(filePath, "");
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    store.ingestPath(filePath, { allowAppend: true });
    appendFileSync(filePath, full);
    const id = store.ingestPath(filePath, { allowAppend: true });
    expect(id).toBe("child-1");
    expect(store.list().some((item) => item.id === "unknown")).toBe(false);
    expect(store.get("unknown")).toBeUndefined();
    const snap = store.get("child-1");
    expect(snap?.turns).toHaveLength(1);
    expect(snap?.cost.raw).toBe(540);
  });
});

describe("compressed session files", () => {
  function ageFile(filePath: string): void {
    const aged = (Date.now() - 600_000) / 1000;
    utimesSync(filePath, aged, aged);
  }

  it("dispatches .ndjson.zstd to the zstd reader and keeps valid frames on an incomplete tail", () => {
    expect(isZstdSessionFile("/tmp/session.ndjson.zstd")).toBe(true);
    expect(isZstdSessionFile("/tmp/session.jsonl.zstd")).toBe(true);
    const lines = readFileSync(path.join(fixtures, "wait-poll.jsonl"), "utf8")
      .trim()
      .split("\n");
    const half = Math.ceil(lines.length / 2);
    const frame1 = zstdCompressSync(Buffer.from(lines.slice(0, half).join("\n") + "\n"));
    const frame2 = zstdCompressSync(Buffer.from(lines.slice(half).join("\n") + "\n"));
    const dir = mkdtempSync(path.join(tmpdir(), "ingest-zstd-"));

    const complete = path.join(dir, "complete.ndjson.zstd");
    writeFileSync(complete, Buffer.concat([frame1, frame2]));
    ageFile(complete);
    const full = ingestFile(complete, { cacheHome: dir });
    expect(full.parse_errors).toEqual([]);
    expect(full.turns.length).toBeGreaterThan(0);

    const truncated = path.join(dir, "truncated.ndjson.zstd");
    writeFileSync(truncated, Buffer.concat([frame1, frame2.subarray(0, 5)]));
    ageFile(truncated);
    const partial = ingestFile(truncated, { cacheHome: dir });
    // The valid prefix survives instead of the whole read failing.
    expect(partial.id).toBeTruthy();
    expect(partial.parse_errors.some((err) => err.message === "zstd_frame_incomplete")).toBe(true);

    const live = path.join(dir, "live.ndjson.zstd");
    writeFileSync(live, Buffer.concat([frame1, frame2.subarray(0, 5)]));
    const livePartial = ingestFile(live, { cacheHome: dir });
    expect(livePartial.live).toBe(true);
    expect(livePartial.parse_errors).toEqual([]);
  });
});
