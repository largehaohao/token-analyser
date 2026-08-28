import { describe, expect, it } from "vitest";
import {
  TURN_PAGE_SIZE,
  highlightScrollBehavior,
  nextTurnLimit,
  visibleTurnWindow,
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

  it("skips smooth scrolling when the user prefers reduced motion", () => {
    expect(highlightScrollBehavior(true)).toBe("auto");
    expect(highlightScrollBehavior(false)).toBe("smooth");
  });

  it("does not mount thousands of rows to reach a highlighted turn", () => {
    const window = visibleTurnWindow(turns, TURN_PAGE_SIZE, "t2499");
    expect(window.length).toBe(TURN_PAGE_SIZE);
    expect(window.some((turn) => turn.id === "t2499")).toBe(true);
    expect(visibleTurnWindow(turns, TURN_PAGE_SIZE, "t0")[0]?.id).toBe("t0");
    expect(
      visibleTurnWindow(turns, TURN_PAGE_SIZE, "t2999").some(
        (turn) => turn.id === "t2999",
      ),
    ).toBe(true);
  });
});
