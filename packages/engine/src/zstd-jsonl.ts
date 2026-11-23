import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { parseJsonlLine } from "./parse-jsonl.ts";
import type { ParseError, RolloutLine } from "./types.ts";

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50;

function isSkippable(magic: number): boolean {
  return magic >= SKIPPABLE_MAGIC && magic <= SKIPPABLE_MAGIC + 0xf;
}

/** Find one complete frame using the header and block lengths from RFC 8878. */
function frameEnd(raw: Buffer, start: number): number | undefined {
  const descriptor = raw[start + 4];
  if (descriptor == null || (descriptor & 0x08) !== 0) return undefined;
  const singleSegment = (descriptor & 0x20) !== 0;
  const sizeFlag = descriptor >> 6;
  const contentSizeBytes = sizeFlag === 0 ? Number(singleSegment) : 1 << sizeFlag;
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]!;
  let offset = start + 5 + Number(!singleSegment) + dictionaryBytes + contentSizeBytes;

  while (offset + 3 <= raw.length) {
    const header = raw.readUIntLE(offset, 3);
    const blockType = (header >> 1) & 0x03;
    if (blockType === 3) return undefined;
    offset += 3 + (blockType === 1 ? 1 : header >> 3);
    if ((header & 1) !== 0) {
      const end = offset + ((descriptor & 0x04) !== 0 ? 4 : 0);
      return end <= raw.length ? end : undefined;
    }
  }
  return undefined;
}

/**
 * Some Node versions return partial output for a short input. Detect frame
 * boundaries before decoding so appended or damaged tails have the same
 * behavior across supported runtimes.
 */
export function decompressZstdFrames(raw: Buffer): { data: Buffer; truncated: boolean } {
  if (raw.length < 4 || (raw.readUInt32LE(0) !== ZSTD_MAGIC && !isSkippable(raw.readUInt32LE(0)))) {
    throw new Error("not a zstd frame");
  }
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= raw.length) {
    const magic = raw.readUInt32LE(offset);
    if (isSkippable(magic)) {
      if (offset + 8 > raw.length) break;
      const end = offset + 8 + raw.readUInt32LE(offset + 4);
      if (end > raw.length) break;
      offset = end;
      continue;
    }
    if (magic !== ZSTD_MAGIC) break;
    const end = frameEnd(raw, offset);
    if (end == null) break;
    try {
      parts.push(zstdDecompressSync(raw.subarray(offset, end)));
    } catch {
      break;
    }
    offset = end;
  }
  return { data: Buffer.concat(parts), truncated: offset !== raw.length };
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
