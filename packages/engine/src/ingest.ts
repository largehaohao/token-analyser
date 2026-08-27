import { readFileSync, statSync } from "node:fs";
import { parseJsonlChunk } from "./parse-jsonl.ts";
import { analyseSession } from "./snapshot.ts";
import {
  cacheKey,
  isLive,
  readCache,
  writeCache,
} from "./cache.ts";
import type { ParseError, RolloutLine, SessionSnapshot } from "./types.ts";

export function readJsonlFile(
  filePath: string,
): { events: RolloutLine[]; parse_errors: ParseError[] } {
  const text = readFileSync(filePath, "utf8");
  const result = parseJsonlChunk(text, 0);
  return { events: result.events, parse_errors: result.errors };
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
