import { describe, expect, it } from "vitest";
import { filterSessionsByRange, overviewQuery } from "./session-range";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function session(iso: string | null, lastEventAt: string | null = iso) {
  return { id: iso ?? "undated", startedAt: iso, lastEventAt };
}

describe("filterSessionsByRange", () => {
  it("keeps a session from 4 hours ago in the 5-hour window", () => {
    const sessions = [session("2026-08-28T08:00:00.000Z")];
    expect(filterSessionsByRange(sessions, "5h", NOW)).toEqual(sessions);
  });

  it("drops a session from 6 hours ago in the 5-hour window", () => {
    const sessions = [session("2026-08-28T05:30:00.000Z")];
    expect(filterSessionsByRange(sessions, "5h", NOW)).toEqual([]);
  });

  it("keeps 23 hours ago and drops 25 hours ago for 1 day", () => {
    const recent = session("2026-08-27T13:00:00.000Z");
    const old = session("2026-08-27T10:00:00.000Z");
    expect(filterSessionsByRange([recent, old], "1d", NOW)).toEqual([recent]);
  });

  it("keeps 6 days ago and drops 8 days ago for 7 days", () => {
    const recent = session("2026-08-22T12:00:00.000Z");
    const old = session("2026-08-20T12:00:00.000Z");
    expect(filterSessionsByRange([recent, old], "7d", NOW)).toEqual([recent]);
  });

  it("keeps 29 days ago and drops 31 days ago for 30 days", () => {
    const recent = session("2026-07-30T12:00:00.000Z");
    const old = session("2026-07-28T12:00:00.000Z");
    expect(filterSessionsByRange([recent, old], "30d", NOW)).toEqual([recent]);
  });

  it("falls back to lastEventAt when startedAt is missing", () => {
    const sessions = [session(null, "2026-08-28T10:00:00.000Z")];
    expect(filterSessionsByRange(sessions, "5h", NOW)).toEqual(sessions);
  });

  it("keeps a session that started before the window but is still active", () => {
    const longRunning = session(
      "2026-07-19T09:00:00.000Z",
      "2026-08-28T11:00:00.000Z",
    );
    expect(filterSessionsByRange([longRunning], "7d", NOW)).toEqual([
      longRunning,
    ]);
  });

  it("drops sessions with no timestamps from bounded ranges, keeps them in all", () => {
    const sessions = [session(null, null)];
    expect(filterSessionsByRange(sessions, "5h", NOW)).toEqual([]);
    expect(filterSessionsByRange(sessions, "all", NOW)).toEqual(sessions);
  });

  it("includes a session that starts exactly at the cutoff", () => {
    const sessions = [session("2026-08-28T07:00:00.000Z")];
    expect(filterSessionsByRange(sessions, "5h", NOW)).toEqual(sessions);
  });

  it("keeps sessions older than 30 days when range is all", () => {
    const old = session("2026-01-01T00:00:00.000Z");
    expect(filterSessionsByRange([old], "all", NOW)).toEqual([old]);
  });

  it("builds an overview query without since for all, and with since for 7 days", () => {
    expect(overviewQuery("all", NOW)).toEqual({ days: 30 });
    expect(overviewQuery("7d", NOW)).toEqual({
      days: 8,
      since: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it("spans two UTC days for a 5-hour window that can cross midnight", () => {
    expect(overviewQuery("5h", NOW).days).toBe(2);
    expect(overviewQuery("1d", NOW).days).toBe(2);
    expect(overviewQuery("30d", NOW).days).toBe(31);
  });
});
