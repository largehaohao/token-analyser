import { openSync, readSync, closeSync, statSync } from "node:fs";
import path from "node:path";
import { parseJsonlLine } from "./parse-jsonl.ts";
import { analyseSession, extractSessionInfo } from "./snapshot.ts";
import { LedgerBuilder } from "./ledger.ts";
import {
  cacheKey,
  isLive,
  readCache,
  writeCache,
} from "./cache.ts";
import type { ParseError, RolloutLine, SessionSnapshot } from "./types.ts";
import { effectiveRateCard } from "./rate-card.ts";
import { loadApiPrices } from "./native-pricing.ts";
import { loadPriceCatalog } from "./price-catalog.ts";
import { detectSource } from "./session-adapters.ts";
import { readCursorSessions } from "./cursor-store.ts";
import { readOpenCodeSessions } from "./opencode-store.ts";
import { isZstdSessionFile, readZstdJsonlFile } from "./zstd-jsonl.ts";

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
  let position = startOffset + initialRest.length;
  // Keep chunks separately and remember how far each was scanned. Concatenating
  // the whole pending line on every read made large tool-output records
  // quadratic in both copying and newline search.
  const chunks: Buffer<ArrayBufferLike>[] = initialRest.length > 0 ? [initialRest] : [];
  let scannedInLast = 0;
  let pendingLength = initialRest.length;

  const consumeCompleteLines = (): void => {
    while (true) {
      let newline = -1;
      let newlineInChunk = -1;
      for (let index = 0; index < chunks.length; index += 1) {
        const found = chunks[index]!.indexOf(0x0a, index === 0 ? scannedInLast : 0);
        if (found !== -1) {
          newline = found;
          newlineInChunk = index;
          break;
        }
      }
      if (newline === -1) return;
      const lineBytes = Buffer.concat(chunks.slice(0, newlineInChunk).concat(chunks[newlineInChunk]!.subarray(0, newline)));
      chunks.splice(0, newlineInChunk);
      chunks[0] = chunks[0]!.subarray(newline + 1);
      pendingLength -= lineBytes.length + 1;
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
      offset += lineBytes.length + 1;
      scannedInLast = 0;
    }
  };

  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(chunkBytes);
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, position);
      if (n === 0) break;
      position += n;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pendingLength += n;
      consumeCompleteLines();
    }
  } finally {
    closeSync(fd);
  }

  // A complete JSON object is valid without a trailing newline. A failed
  // parse is kept as a tail because a live writer may still append to it.
  if (pendingLength > 0) {
    const pending = Buffer.concat(chunks);
    try {
      events.push(parseJsonlLine(pending.toString("utf8").replace(/\r$/, "")));
      offset += pending.length;
      chunks.length = 0;
      pendingLength = 0;
    } catch {
      // Wait for the next write to complete the final line.
    }
  }

  return { events, parse_errors, offset, rest: Buffer.concat(chunks) };
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
  builder?: LedgerBuilder;
};

const liveReadStates = new Map<string, LiveReadState>();

export function clearLiveReadState(filePath: string): void {
  liveReadStates.delete(filePath);
}

export function hasLiveReadState(filePath: string): boolean {
  return liveReadStates.has(filePath);
}

export function pruneInactiveLiveReadStates(): void {
  for (const [filePath, state] of liveReadStates) {
    let mtimeMs = state.mtimeMs;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      liveReadStates.delete(filePath);
      continue;
    }
    if (!isLive(mtimeMs)) liveReadStates.delete(filePath);
  }
}

export function ingestFile(
  filePath: string,
  opts?: IngestOptions,
): SessionSnapshot {
  const st = statSync(filePath);
  const live = isLive(st.mtimeMs);
  const key = cacheKey(filePath, pricingCacheContext());

  if (!live) {
    const cached = readCache(key, opts?.cacheHome);
    if (cached) {
      return { ...cached, live, path: filePath };
    }
  }

  let events: RolloutLine[];
  let parse_errors: ParseError[];
  let builder: LedgerBuilder | undefined;
  // DSH session files are concatenated zstd frames; always reread the whole file.
  if (isZstdSessionFile(filePath)) {
    liveReadStates.delete(filePath);
    const read = readZstdJsonlFile(filePath);
    events = read.events;
    parse_errors = read.parse_errors;
    if (read.truncated && !live) {
      // A closed file with an incomplete final frame is corrupt; a live tail
      // is a normal write-in-progress and completes on the next update.
      parse_errors.push({ offset: read.truncatedAt, message: "zstd_frame_incomplete" });
    }
    const snapshot = analyseSession({ events, path: filePath, live, parse_errors });
    if (!live && !read.truncated) writeCache(key, snapshot, opts?.cacheHome);
    return snapshot;
  }
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
    const info = extractSessionInfo(events);
    const codex = (detectSource(events, filePath) ?? "codex") === "codex";
    if (codex && canAppend && previous.builder) {
      const prev = previous.builder.identity();
      if (prev.id === info.id && prev.isSubagent === info.isSubagent) {
        previous.builder.consume(details.events);
        builder = previous.builder;
      } else {
        builder = new LedgerBuilder(info.id, { isSubagent: info.isSubagent });
        builder.consume(events);
      }
    } else if (codex) {
      builder = new LedgerBuilder(info.id, { isSubagent: info.isSubagent });
      builder.consume(events);
    }
    liveReadStates.set(filePath, {
      ...details,
      events,
      parse_errors,
      inode: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      builder,
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
    ...(builder ? { ledgerBuilder: builder } : {}),
  });

  // A pi fork's inherited spend depends on whether its parent file exists.
  // Caching the child alone can make a parent arriving later invisible forever.
  const dependsOnParent = snapshot.forkedFrom != null;
  if (!live && !dependsOnParent) {
    writeCache(key, snapshot, opts?.cacheHome);
  }

  return snapshot;
}

export function pricingCacheContext(): string {
  const card = effectiveRateCard();
  const prices = loadApiPrices();
  const catalog = loadPriceCatalog();
  // Dates and page URLs are audit metadata. Only the numbers that change a
  // quote belong in the cache key, or a daily refresh reparses every session.
  return JSON.stringify([
    card.usd_per_credit,
    card.fast_multiplier,
    card.models,
    prices.models,
    catalog.models,
    catalog.aliases,
  ]);
}

/** A Cursor or OpenCode database contains many sessions; JSONL contains one. */
export function readMultiSessionEvents(filePath: string): RolloutLine[][] | null {
  if (filePath.endsWith(".vscdb")) return readCursorSessions(filePath);
  if (path.basename(filePath) === "opencode.db") return readOpenCodeSessions(filePath);
  return null;
}

export function snapshotFromEvents(
  events: RolloutLine[],
  filePath: string,
): SessionSnapshot {
  const snapshot = analyseSession({ events, path: filePath, live: false, parse_errors: [] });
  return {
    ...snapshot,
    live: snapshot.lastEventAt != null && isLive(Date.parse(snapshot.lastEventAt)),
  };
}

export function ingestSessions(filePath: string, opts?: IngestOptions): SessionSnapshot[] {
  const eventsForFile = readMultiSessionEvents(filePath);
  if (!eventsForFile) return [ingestFile(filePath, opts)];
  return eventsForFile.map((events) => snapshotFromEvents(events, filePath));
}
