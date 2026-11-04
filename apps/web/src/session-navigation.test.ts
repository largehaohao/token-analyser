import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionNavigation, writeSessionNavigation } from "./session-navigation";

function fakeWindow(
  stored: unknown = null,
  state: unknown = null,
  hash = "#sessions",
) {
  const records = new Map<string, string>();
  if (stored) records.set("token-analyser.navigation.v1", JSON.stringify(stored));
  const target = {
    location: { hash },
    sessionStorage: {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
    },
    history: {
      state: state ? { tokenAnalyser: state } : null,
      replaceState: vi.fn(),
      pushState: vi.fn(),
    },
  };
  vi.stubGlobal("window", target);
  return target;
}
afterEach(() => vi.unstubAllGlobals());
describe("source navigation persistence", () => {
  it("keeps old saved navigation compatible and defaults to all sources", () => {
    fakeWindow({ view: "sessions", selectedId: "old", range: "all" });
    expect(readSessionNavigation()).toEqual({ view: "sessions", selectedId: "old", range: "all", source: "all" });
  });
  it("restores provider filters and prioritizes browser history", () => {
    fakeWindow({ range: "all", source: "pi" }, { range: "7d", source: "claude", selectedId: "claude:test" });
    expect(readSessionNavigation()).toEqual({ view: "sessions", selectedId: "claude:test", range: "7d", source: "claude" });
  });
  it("persists the selected source in both tab storage and history", () => {
    const win = fakeWindow();
    const navigation = { view: "sessions", selectedId: "cursor:test", range: "all", source: "cursor" } as const;
    writeSessionNavigation(navigation);
    expect(readSessionNavigation()).toEqual(navigation);
    expect(win.history.replaceState).toHaveBeenCalledWith({ tokenAnalyser: navigation }, "", "#sessions");
  });
});

describe("hardware navigation", () => {
  it("maps legacy #power hash to hardware power tab", () => {
    fakeWindow(null, null, "#power");
    expect(readSessionNavigation()).toMatchObject({
      view: "hardware",
      hardwareTab: "power",
    });
  });

  it.each(["#hardware", "#hardware/temps"])(
    "maps %s to hardware temps tab",
    (hash) => {
      fakeWindow(null, null, hash);
      expect(readSessionNavigation()).toMatchObject({
        view: "hardware",
        hardwareTab: "temps",
      });
    },
  );

  it("writes #hardware/power when pushing power tab", () => {
    const win = fakeWindow(null, null, "#overview");
    const navigation = {
      view: "hardware" as const,
      selectedId: null,
      range: "7d" as const,
      source: "all" as const,
      hardwareTab: "power" as const,
    };
    writeSessionNavigation(navigation);
    expect(win.history.replaceState).toHaveBeenCalledWith(
      { tokenAnalyser: navigation },
      "",
      "#hardware/power",
    );
  });

  it("migrates stored view power to hardware", () => {
    fakeWindow({ view: "power", selectedId: null, range: "7d" }, null, "");
    expect(readSessionNavigation()).toMatchObject({
      view: "hardware",
      hardwareTab: "power",
    });
  });
});
