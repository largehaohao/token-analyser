import { describe, expect, it } from "vitest";
import type { SessionListItem } from "./api";
import { filterSessionsBySource, normalizeSourceFilter, sourceCounts, sourceEmptyCopy } from "./session-source";

const sessions = [{ id: "old-codex" }, { id: "c", source: "claude" }, { id: "u", source: "cursor" }, { id: "p", source: "pi" }] as SessionListItem[];
describe("session sources", () => {
  it("keeps all providers selectable and treats legacy records as Codex", () => {
    expect(filterSessionsBySource(sessions, "all")).toBe(sessions);
    expect(sourceCounts(sessions)).toEqual({ all: 4, codex: 1, claude: 1, cursor: 1, pi: 1 });
    for (const source of ["codex", "claude", "cursor", "pi"] as const) {
      expect(filterSessionsBySource(sessions, source)).toHaveLength(1);
    }
  });
  it("restores only known source preferences", () => {
    for (const source of ["all", "codex", "claude", "cursor", "pi"]) expect(normalizeSourceFilter(source)).toBe(source);
    for (const value of [null, undefined, "invalid", {}, 0]) expect(normalizeSourceFilter(value)).toBe("all");
  });
  it("explains missing data for the chosen provider", () => {
    expect(sourceEmptyCopy("claude")).toContain("未发现 Claude Code 会话记录");
    expect(sourceEmptyCopy("all")).toContain("拖入");
  });
});
