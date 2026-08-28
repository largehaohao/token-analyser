import { openSync, readSync, closeSync, statSync } from "node:fs";
import { parseJsonlLine } from "./parse-jsonl.ts";
import { analyseSession } from "./snapshot.ts";
import {
  cacheKey,
  isLive,
  readCache,
  writeCache,
} from "./cache.ts";
import type { ParseError, RolloutLine, SessionSnapshot } from "./types.ts";
import { effectiveRateCard } from "./rate-card.ts";

export const READ_CHUNK_BYTES = 64 * 1024;

type JsonlReadDetails = {
  events: RolloutLine[];
  parse_errors: ParseError[];
  /** Byte offset at which `rest` starts. */
  offset: number;
  rest: Buffer<ArrayBufferLike>;
};

function readJsonlFileDetailed(
  filePath: string,
  startOffset = 0,
  initialRest: Buffer<ArrayBufferLike> = Buffer.alloc(0),
  chunkBytes = READ_CHUNK_BYTES,
): JsonlReadDetails {
  const events: RolloutLine[] = [];
  const parse_errors: ParseError[] = [];
  let offset = startOffset;
  let pending = initialRest;
  let position = startOffset + initialRest.length;

  const consumeCompleteLines = (): void => {
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline === -1) return;
      const lineBytes = pending.subarray(0, newline);
      const line = lineBytes.toString("utf8");
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
      offset += newline + 1;
      pending = pending.subarray(newline + 1);
    }
  };

  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(chunkBytes);
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, position);
      if (n === 0) break;
      position += n;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      consumeCompleteLines();
    }
  } finally {
    closeSync(fd);
  }

  // A complete JSON object is valid without a trailing newline. A failed
  // parse is kept as a tail because a live writer may still append to it.
  if (pending.length > 0 && pending[pending.length - 1] !== 0x0a) {
    try {
      events.push(parseJsonlLine(pending.toString("utf8").replace(/\r$/, "")));
      offset += pending.length;
      pending = Buffer.alloc(0);
    } catch {
      // Wait for the next write to complete the final line.
    }
  }

  return { events, parse_errors, offset, rest: pending };
}

export function readJsonlFile(
  filePath: string,
  opts?: { chunkBytes?: number },
): { events: RolloutLine[]; parse_errors: ParseError[] } {
  const details = readJsonlFileDetailed(
    filePath,
    0,
    Buffer.alloc(0),
    opts?.chunkBytes ?? READ_CHUNK_BYTES,
  );
  return { events: details.events, parse_errors: details.parse_errors };
}

export type IngestOptions = {
  cacheHome?: string;
  /** The watcher observes append-only rollout files. Direct imports default to a full reread. */
  allowAppend?: boolean;
};

type LiveReadState = JsonlReadDetails & {
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const liveReadStates = new Map<string, LiveReadState>();

export function ingestFile(
  filePath: string,
  opts?: IngestOptions,
): SessionSnapshot {
  const st = statSync(filePath);
  const live = isLive(st.mtimeMs);
  const key = cacheKey(filePath, JSON.stringify(effectiveRateCard()));

  if (!live) {
    const cached = readCache(key, opts?.cacheHome);
    if (cached) {
      return { ...cached, live, path: filePath };
    }
  }

  let events: RolloutLine[];
  let parse_errors: ParseError[];
  if (live && opts?.allowAppend) {
    const previous = liveReadStates.get(filePath);
    const canAppend =
      previous &&
      previous.inode === st.ino &&
      st.size >= previous.offset + previous.rest.length &&
      (st.size > previous.size ||
        (st.mtimeMs === previous.mtimeMs && st.ctimeMs === previous.ctimeMs));
    const details = canAppend
      ? readJsonlFileDetailed(filePath, previous.offset, previous.rest)
      : readJsonlFileDetailed(filePath);
    events = previous && canAppend
      ? [...previous.events, ...details.events]
      : details.events;
    parse_errors = previous && canAppend
      ? [...previous.parse_errors, ...details.parse_errors]
      : details.parse_errors;
    liveReadStates.set(filePath, {
      ...details,
      events,
      parse_errors,
      inode: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
    });
  } else {
    liveReadStates.delete(filePath);
    const details = readJsonlFileDetailed(filePath);
    events = details.events;
    parse_errors = details.parse_errors;
  }
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
