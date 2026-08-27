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

const READ_CHUNK_BYTES = 64;

export function readJsonlFile(
  filePath: string,
): { events: RolloutLine[]; parse_errors: ParseError[] } {
  const events: RolloutLine[] = [];
  const parse_errors: ParseError[] = [];
  let rest = "";
  let offset = 0;

  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(READ_CHUNK_BYTES);
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;

      const combined = rest + buf.toString("utf8", 0, n);
      const result = parseJsonlChunk(combined, offset);
      events.push(...result.events);
      parse_errors.push(...result.errors);
      offset +=
        Buffer.byteLength(combined, "utf8") -
        Buffer.byteLength(result.rest, "utf8");
      rest = result.rest;
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
