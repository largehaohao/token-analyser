import { openSync, readSync, closeSync, statSync } from "node:fs";
import { parseJsonlChunk } from "./parse-jsonl.ts";
import { analyseSession } from "./snapshot.ts";
import {
  cacheKey,
  isLive,
  readCache,
  writeCache,
} from "./cache.ts";
import type { ParseError, RolloutLine, SessionSnapshot } from "./types.ts";

export const READ_CHUNK_BYTES = 64 * 1024;

/** Exclusive end index of complete UTF-8 sequences in `buf`. */
function utf8CompleteEnd(buf: Buffer): number {
  if (buf.length === 0) return 0;

  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && (buf[i]! & 0b1100_0000) === 0b1000_0000) {
    cont++;
    i--;
    if (cont >= 3) break;
  }
  if (i < 0) return 0;

  const lead = buf[i]!;
  let expected = 0;
  if ((lead & 0b1000_0000) === 0) expected = 0;
  else if ((lead & 0b1110_0000) === 0b1100_0000) expected = 1;
  else if ((lead & 0b1111_0000) === 0b1110_0000) expected = 2;
  else if ((lead & 0b1111_1000) === 0b1111_0000) expected = 3;
  else return buf.length;

  if (cont < expected) return i;
  return buf.length;
}

export function readJsonlFile(
  filePath: string,
  opts?: { chunkBytes?: number },
): { events: RolloutLine[]; parse_errors: ParseError[] } {
  const events: RolloutLine[] = [];
  const parse_errors: ParseError[] = [];
  let lineRest = "";
  let utf8Rest = Buffer.alloc(0);
  let offset = 0;
  const chunkBytes = opts?.chunkBytes ?? READ_CHUNK_BYTES;

  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(chunkBytes);
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;

      const combinedBuf = Buffer.concat([utf8Rest, buf.subarray(0, n)]);
      const completeEnd = utf8CompleteEnd(combinedBuf);
      utf8Rest = combinedBuf.subarray(completeEnd);
      const complete = combinedBuf.subarray(0, completeEnd);
      const combined = lineRest + complete.toString("utf8");
      const result = parseJsonlChunk(combined, offset);
      events.push(...result.events);
      parse_errors.push(...result.errors);
      offset +=
        Buffer.byteLength(combined, "utf8") -
        Buffer.byteLength(result.rest, "utf8");
      lineRest = result.rest;
    }

    if (utf8Rest.length > 0) {
      const combined = lineRest + utf8Rest.toString("utf8");
      const result = parseJsonlChunk(combined, offset);
      events.push(...result.events);
      parse_errors.push(...result.errors);
      lineRest = result.rest;
    }
  } finally {
    closeSync(fd);
  }

  return { events, parse_errors };
}

export type IngestOptions = {
  cacheHome?: string;
};

export function ingestFile(
  filePath: string,
  opts?: IngestOptions,
): SessionSnapshot {
  const st = statSync(filePath);
  const live = isLive(st.mtimeMs);
  const key = cacheKey(filePath);

  if (!live) {
    const cached = readCache(key, opts?.cacheHome);
    if (cached) {
      return { ...cached, live, path: filePath };
    }
  }

  const { events, parse_errors } = readJsonlFile(filePath);
  const snapshot = analyseSession({
    events,
    path: filePath,
    live,
    parse_errors,
  });

  if (!live) {
    writeCache(key, snapshot, opts?.cacheHome);
  }

  return snapshot;
}
