import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { parseJsonlLine } from "./parse-jsonl.ts";
import type { ParseError, RolloutLine } from "./types.ts";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DeepSeek Harness writes concatenated zstd frames; Node only returns the first. */
export function decompressZstdFrames(raw: Buffer): Buffer {
  if (raw.length < 4 || !raw.subarray(0, 4).equals(ZSTD_MAGIC)) {
    throw new Error("not a zstd frame");
  }
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (
      offset + 4 > raw.length ||
      raw[offset] !== 0x28 ||
      raw[offset + 1] !== 0xb5 ||
      raw[offset + 2] !== 0x2f ||
      raw[offset + 3] !== 0xfd
    ) {
      throw new Error(`zstd frame magic missing at offset ${offset}`);
    }
    const ends: number[] = [];
    for (let i = offset + 4; i <= raw.length - 4; i++) {
      if (
        raw[i] === 0x28 &&
        raw[i + 1] === 0xb5 &&
        raw[i + 2] === 0x2f &&
        raw[i + 3] === 0xfd
      ) {
        ends.push(i);
      }
    }
    ends.push(raw.length);
    let decoded: Buffer | null = null;
    let consumed = 0;
    for (const end of ends) {
      try {
        decoded = zstdDecompressSync(raw.subarray(offset, end));
        consumed = end - offset;
        break;
      } catch {
        /* try the next candidate frame boundary */
      }
    }
    if (!decoded || consumed === 0) {
      throw new Error(`unable to decompress zstd frame at offset ${offset}`);
    }
    parts.push(decoded);
    offset += consumed;
  }
  return Buffer.concat(parts);
}

export function isZstdSessionFile(filePath: string): boolean {
  return /\.jsonl\.zstd$/i.test(filePath);
}

export function readZstdJsonlFile(
  filePath: string,
): { events: RolloutLine[]; parse_errors: ParseError[] } {
  const text = decompressZstdFrames(readFileSync(filePath)).toString("utf8");
  const events: RolloutLine[] = [];
  const parse_errors: ParseError[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      try {
        events.push(parseJsonlLine(line.replace(/\r$/, "")));
      } catch (err) {
        parse_errors.push({
          offset,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return { events, parse_errors };
}
