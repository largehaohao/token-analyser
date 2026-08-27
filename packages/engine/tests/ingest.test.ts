import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonlFile } from "../src/ingest.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

describe("readJsonlFile", () => {
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
});
