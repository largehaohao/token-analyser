import { describe, expect, it } from "vitest";
import {
  TURN_PAGE_SIZE,
  highlightScrollBehavior,
  limitIncludingId,
  nextTurnLimit,
  visibleTurns,
} from "./turn-page";

describe("turn paging", () => {
  const turns = Array.from({ length: 3000 }, (_, i) => ({ id: `t${i}` }));

  it("keeps the DOM prefix at the page size", () => {
    expect(visibleTurns(turns, TURN_PAGE_SIZE)).toHaveLength(200);
    expect(visibleTurns(turns, TURN_PAGE_SIZE)[0]?.id).toBe("t0");
  });

  it("loads another page without jumping to the full list", () => {
    expect(nextTurnLimit(200, 3000)).toBe(400);
    expect(nextTurnLimit(2900, 3000)).toBe(3000);
  });

  it("expands the prefix far enough to include a highlighted turn", () => {
    expect(limitIncludingId(turns, 200, "t249")).toBe(400);
    expect(limitIncludingId(turns, 200, "t10")).toBe(200);
  });

  it("skips smooth scrolling when the user prefers reduced motion", () => {
    expect(highlightScrollBehavior(true)).toBe("auto");
    expect(highlightScrollBehavior(false)).toBe("smooth");
  });
});
