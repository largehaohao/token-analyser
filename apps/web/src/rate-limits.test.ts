import { describe, expect, it } from "vitest";
import { formatResetAt, formatWindow, parseRateLimits } from "./rate-limits";

describe("parseRateLimits", () => {
  it("reads nested plan windows with used_percent and window_duration_mins", () => {
    const gauges = parseRateLimits({
      codex: {
        primary: { used_percent: 27, window_duration_mins: 300 },
        secondary: { used_percent: 4, window_duration_mins: 100 },
      },
    });
    expect(gauges).toEqual([
      {
        id: "codex.primary",
        group: "codex",
        label: "primary",
        usedPercent: 27,
        windowMinutes: 300,
        resetsAt: null,
      },
      {
        id: "codex.secondary",
        group: "codex",
        label: "secondary",
        usedPercent: 4,
        windowMinutes: 100,
        resetsAt: null,
      },
    ]);
  });

  it("returns an empty list when rate limits are missing", () => {
    expect(parseRateLimits(null)).toEqual([]);
    expect(parseRateLimits("nope")).toEqual([]);
  });

  it("reads the live Codex token_count snapshot shape", () => {
    const gauges = parseRateLimits({
      limit_id: "codex",
      primary: { used_percent: 26, window_minutes: 300, resets_at: 1787895092 },
      secondary: {
        used_percent: 4,
        window_minutes: 10080,
        resets_at: 1788481892,
      },
      credits: { has_credits: false, unlimited: false, balance: "0" },
      plan_type: "plus",
    });
    expect(gauges.map((g) => g.label)).toEqual(["primary", "secondary"]);
    expect(gauges[0]?.windowMinutes).toBe(300);
    expect(gauges[1]?.windowMinutes).toBe(10080);
    expect(gauges[0]?.resetsAt).toBe(1787895092);
  });
});

describe("formatResetAt", () => {
  it("formats unix seconds as a locale timestamp", () => {
    expect(formatResetAt(1_700_000_000)).toMatch(/2023|2024/);
  });
});

describe("formatWindow", () => {
  it("formats minute windows as compact durations", () => {
    expect(formatWindow(300)).toBe("5h");
    expect(formatWindow(10080)).toBe("7d");
    expect(formatWindow(100)).toBe("1h 40m");
    expect(formatWindow(45)).toBe("45m");
  });
});
