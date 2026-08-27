import type { ParseError, RolloutLine } from "./types.ts";

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
      events.push(JSON.parse(line) as RolloutLine);
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
