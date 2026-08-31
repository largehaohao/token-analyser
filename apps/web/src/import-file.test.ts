import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_BYTES,
  isImportableFilename,
  readDroppedFile,
} from "./import-file";

describe("isImportableFilename", () => {
  it("accepts jsonl and ndjson, case-insensitive", () => {
    expect(isImportableFilename("rollout.jsonl")).toBe(true);
    expect(isImportableFilename("notes.NDJSON")).toBe(true);
    expect(isImportableFilename("notes.txt")).toBe(false);
  });
});

describe("readDroppedFile", () => {
  it("rejects oversized files before reading them into memory", async () => {
    let read = false;
    await expect(
      readDroppedFile({
        name: "large.jsonl",
        size: MAX_IMPORT_BYTES + 1,
        text: async () => {
          read = true;
          return "";
        },
      }),
    ).rejects.toThrow(/256 MiB/);
    expect(read).toBe(false);
  });

  it("rejects an empty or whitespace-only session", async () => {
    await expect(
      readDroppedFile({ name: "empty.jsonl", text: async () => " \n\t" }),
    ).rejects.toThrow(/文件没有内容/);
  });
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
