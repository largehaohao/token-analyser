import { describe, expect, it } from "vitest";
import {
  SESSION_PAGE_SIZE,
  nextSessionLimit,
  resolveSelectedSession,
  visibleSessions,
} from "./session-page";

describe("session paging", () => {
  const sessions = Array.from({ length: 3000 }, (_, i) => ({ id: `s${i}` }));

  it("caps the first render at the page size", () => {
    expect(visibleSessions(sessions, SESSION_PAGE_SIZE)).toHaveLength(100);
  });

  it("loads another page without jumping to the full list", () => {
    expect(nextSessionLimit(100, 3000)).toBe(200);
    expect(nextSessionLimit(2950, 3000)).toBe(3000);
  });

  it("clears the leftover selection when the visible list is empty", () => {
    expect(resolveSelectedSession("s-old", [])).toBeNull();
  });

  it("keeps a still-visible session and otherwise selects the first", () => {
    expect(resolveSelectedSession("s2", sessions.slice(0, 3))).toBe("s2");
    expect(resolveSelectedSession("missing", sessions.slice(0, 3))).toBe("s0");
  });
});
