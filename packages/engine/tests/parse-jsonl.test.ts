import { describe, expect, it } from "vitest";
import { parseJsonlChunk } from "../src/parse-jsonl.ts";

describe("parseJsonlChunk", () => {
  it("skips valid JSON values that are not rollout event objects", () => {
    const result = parseJsonlChunk(
      "null\n{\"timestamp\":\"2026-08-27T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{}}\n",
      0,
    );
    expect(result.events).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });
  it("parses complete lines and keeps an incomplete tail", () => {
    const chunk = '{"timestamp":"t","type":"session_meta","payload":{"id":"a"}}\n{"timestamp":"t2","type":"turn_context"';
    const result = parseJsonlChunk(chunk, 0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("session_meta");
    expect(result.rest).toBe('{"timestamp":"t2","type":"turn_context"');
    expect(result.errors).toEqual([]);
  });

  it("skips a corrupt line and continues", () => {
    const chunk = "{not json}\n{\"timestamp\":\"t\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}\n";
    const result = parseJsonlChunk(chunk, 100);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("event_msg");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].offset).toBe(100);
    expect(result.errors[0].message.length).toBeGreaterThan(0);
  });
});
