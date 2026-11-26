import { describe, expect, it } from "vitest";
import {
  TURN_PAGE_SIZE,
  highlightScrollBehavior,
  nextTurnLimit,
  sortTurnsAscending,
  sortTurnsDescending,
  turnTimestamp,
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

  it("grows the highlighted window when the user loads more", () => {
    const first = visibleTurnWindow(turns, TURN_PAGE_SIZE, "t2499");
    const next = visibleTurnWindow(
      turns,
      nextTurnLimit(TURN_PAGE_SIZE, turns.length),
      "t2499",
    );
    expect(first).toHaveLength(200);
    expect(next).toHaveLength(400);
    expect(next.some((turn) => turn.id === "t2499")).toBe(true);
    expect(next.length).toBeGreaterThan(first.length);
  });

  it("sorts turns within a shared prompt newest-first by endedAt", () => {
    const sharedPrompt = "2026-11-26T09:38:30.501Z";
    const sample = [
      { id: "older-prompt", startedAt: "2026-11-26T09:37:00.000Z", endedAt: "2026-11-26T09:37:58.000Z" },
      { id: "step-1", startedAt: sharedPrompt, endedAt: "2026-11-26T09:38:40.000Z" },
      { id: "step-2", startedAt: sharedPrompt, endedAt: "2026-11-26T09:50:33.000Z" },
      { id: "step-3", startedAt: sharedPrompt, endedAt: "2026-11-26T09:54:31.000Z" },
      { id: "step-3-tie", startedAt: sharedPrompt, endedAt: "2026-11-26T09:54:31.000Z" },
    ];
    expect(sortTurnsDescending(sample).map((t) => t.id)).toEqual([
      "step-3-tie",
      "step-3",
      "step-2",
      "step-1",
      "older-prompt",
    ]);
    expect(sortTurnsAscending(sample).map((t) => t.id)).toEqual([
      "older-prompt",
      "step-1",
      "step-2",
      "step-3",
      "step-3-tie",
    ]);
    expect(turnTimestamp({ startedAt: sharedPrompt, endedAt: "" })).toBe(sharedPrompt);
    expect(turnTimestamp({ startedAt: sharedPrompt, endedAt: "2026-11-26T09:54:31.000Z" })).toBe(
      "2026-11-26T09:54:31.000Z",
    );
  });
});
