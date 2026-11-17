import { describe, expect, it } from "vitest";
import {
  filterSessionsByRange,
  filterSessionsByDay,
  overviewQuery,
  previousWindow,
} from "./session-range";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function session(iso: string | null, lastEventAt: string | null = iso) {
  return { id: iso ?? "undated", startedAt: iso, lastEventAt };
}

function localAt(day: string, hour: number): string {
  const date = new Date(`${day}T00:00:00`);
  date.setHours(hour);
  return date.toISOString();
}

describe("filterSessionsByDay", () => {
  it("uses calendar midnight across DST transitions", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // Spring forward: 2026-03-08 is 23 hours long; 04:30Z on Mar 9 is
      // already 00:30 local on Mar 9 and must not join the Mar 8 drill-down.
      const nextDayEarly = {
        id: "next",
        startedAt: "2026-03-09T04:30:00.000Z",
        lastEventAt: "2026-03-09T04:30:00.000Z",
      };
      expect(filterSessionsByDay([nextDayEarly], "2026-03-08")).toEqual([]);
      // Fall back: 2026-11-01 is 25 hours long; 04:30Z on Nov 2 is still
      // 23:30 local on Nov 1 and must join the Nov 1 drill-down.
      const lateFallBack = {
        id: "late",
        startedAt: "2026-11-02T04:30:00.000Z",
        lastEventAt: "2026-11-02T04:30:00.000Z",
      };
      expect(filterSessionsByDay([lateFallBack], "2026-11-01")).toEqual([lateFallBack]);
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it("keeps a session whose activity overlaps the day", () => {
    const spanning = {
      id: "span",
      startedAt: localAt("2026-08-26", 22),
      lastEventAt: localAt("2026-08-27", 9),
    };
    expect(filterSessionsByDay([spanning], "2026-08-27")).toEqual([spanning]);
  });

  it("keeps a session that starts on the day and ends later", () => {
    const starting = {
      id: "start",
      startedAt: localAt("2026-08-27", 8),
      lastEventAt: localAt("2026-08-28", 8),
    };
    expect(filterSessionsByDay([starting], "2026-08-27")).toEqual([starting]);
  });

  it("drops sessions entirely before or after the day", () => {
    const before = session(localAt("2026-08-26", 12));
    const after = session(localAt("2026-08-28", 12));
    expect(filterSessionsByDay([before, after], "2026-08-27")).toEqual([]);
  });

  it("drops undated sessions and ignores an invalid day", () => {
    const undated = session(null);
    expect(filterSessionsByDay([undated], "2026-08-27")).toEqual([]);
    const dated = session(localAt("2026-08-27", 12));
    expect(filterSessionsByDay([dated], "not-a-day")).toEqual([dated]);
  });
});

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

  it("spans two local days for a 5-hour window that can cross midnight", () => {
    expect(overviewQuery("5h", NOW).days).toBe(2);
    expect(overviewQuery("1d", NOW).days).toBe(2);
    expect(overviewQuery("30d", NOW).days).toBe(31);
  });

  it("advances the overview since cutoff when now moves", () => {
    const earlier = overviewQuery("7d", NOW);
    const later = overviewQuery("7d", NOW + 60_000);
    expect(later.since).not.toBe(earlier.since);
    expect(Date.parse(later.since!)).toBe(Date.parse(earlier.since!) + 60_000);
  });
});

const DAY = 24 * 60 * 60 * 1000;

describe("previousWindow", () => {
  it("returns the equal-length window right before a 7-day range", () => {
    expect(previousWindow("7d", NOW)).toEqual({
      sinceMs: NOW - 14 * DAY,
      untilMs: NOW - 7 * DAY,
      days: 8,
    });
  });

  it("ends the comparison for a rolling 5-hour window at its start", () => {
    const window = previousWindow("5h", NOW)!;
    expect(window.untilMs).toBe(NOW - 5 * 60 * 60 * 1000);
    expect(window.untilMs - window.sinceMs).toBe(5 * 60 * 60 * 1000);
  });

  it("does not invent a previous window for 全部", () => {
    expect(previousWindow("all", NOW)).toBeNull();
  });
});
