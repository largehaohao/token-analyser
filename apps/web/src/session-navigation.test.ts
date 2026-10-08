import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionNavigation, writeSessionNavigation } from "./session-navigation";

function fakeWindow(stored: unknown = null, state: unknown = null) {
  const records = new Map<string, string>();
  if (stored) records.set("token-analyser.navigation.v1", JSON.stringify(stored));
  const target = { location: { hash: "#sessions" },
    sessionStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
    history: { state: state ? { tokenAnalyser: state } : null, replaceState: vi.fn(), pushState: vi.fn() } };
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
