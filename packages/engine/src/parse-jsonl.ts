import type { ParseError, RolloutLine } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonlLine(line: string): RolloutLine {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("JSONL event must be an object with a string type");
  }
  if (value.payload !== undefined && !isRecord(value.payload)) {
    throw new Error("JSONL event payload must be an object");
  }
  return {
    timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
    type: value.type,
    ...(typeof value.ordinal === "number" ? { ordinal: value.ordinal } : {}),
    ...(value.payload !== undefined ? { payload: value.payload } : {}),
  };
}

export function parseJsonlChunk(
  chunk: string,
  byteOffsetStart: number,
): { events: RolloutLine[]; rest: string; errors: ParseError[] } {
  const events: RolloutLine[] = [];
  const errors: ParseError[] = [];
  let offset = byteOffsetStart;
  const parts = chunk.split("\n");
  const rest = parts.pop() ?? "";
  for (const line of parts) {
    if (line.trim() === "") {
      offset += line.length + 1;
      continue;
    }
    try {
      events.push(parseJsonlLine(line));
    } catch (err) {
      errors.push({
        offset,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return { events, rest, errors };
}
