import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { parseJsonlLine } from "./parse-jsonl.ts";
import type { ParseError, RolloutLine } from "./types.ts";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * DeepSeek Harness writes concatenated zstd frames; Node only returns the
 * first. A live file can end mid-frame: keep the valid prefix and report the
 * incomplete tail instead of failing the whole read.
 */
export function decompressZstdFrames(raw: Buffer): { data: Buffer; truncated: boolean } {
  if (raw.length < 4 || !raw.subarray(0, 4).equals(ZSTD_MAGIC)) {
    throw new Error("not a zstd frame");
  }
  // Discover candidate boundaries once. The previous loop rescanned the
  // remaining buffer for magic bytes for every frame (quadratic in frames).
  const candidates: number[] = [];
  for (let index = 4; index <= raw.length - 4; index += 1) {
    if (
      raw[index] === 0x28 &&
      raw[index + 1] === 0xb5 &&
      raw[index + 2] === 0x2f &&
      raw[index + 3] === 0xfd
    ) {
      candidates.push(index);
    }
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
      return { data: Buffer.concat(parts), truncated: true };
    }
    const ends = [...candidates.filter((candidate) => candidate > offset), raw.length];
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
      return { data: Buffer.concat(parts), truncated: true };
    }
    parts.push(decoded);
    offset += consumed;
  }
  return { data: Buffer.concat(parts), truncated: false };
}

export function isZstdSessionFile(filePath: string): boolean {
  return /\.(jsonl|ndjson)\.zstd$/i.test(filePath);
}

export function readZstdJsonlFile(
  filePath: string,
): { events: RolloutLine[]; parse_errors: ParseError[]; truncated: boolean; truncatedAt: number } {
  const { data, truncated } = decompressZstdFrames(readFileSync(filePath));
  const text = data.toString("utf8");
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
  return { events, parse_errors, truncated, truncatedAt: data.length };
}
