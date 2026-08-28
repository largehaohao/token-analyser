import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, writeFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestFile, readJsonlFile } from "../src/ingest.ts";

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
