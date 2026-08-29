import { describe, expect, it } from "vitest";
import { isImportableFilename, readDroppedFile } from "./import-file";

describe("isImportableFilename", () => {
  it("accepts jsonl and ndjson, case-insensitive", () => {
    expect(isImportableFilename("rollout.jsonl")).toBe(true);
    expect(isImportableFilename("notes.NDJSON")).toBe(true);
    expect(isImportableFilename("notes.txt")).toBe(false);
  });
});

describe("readDroppedFile", () => {
  it("rejects non-jsonl drops before reading", async () => {
    await expect(
      readDroppedFile({
        name: "secret.txt",
        text: async () => "should-not-read",
      }),
    ).rejects.toThrow(/只支持/);
  });

  it("returns the filename and file text", async () => {
    await expect(
      readDroppedFile({
        name: "rollout-s1.jsonl",
        text: async () => '{"type":"session_meta"}\n',
      }),
    ).resolves.toEqual({
      filename: "rollout-s1.jsonl",
      text: '{"type":"session_meta"}\n',
    });
  });
});
