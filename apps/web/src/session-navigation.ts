import {
  DEFAULT_SESSION_RANGE,
  SESSION_RANGES,
  type SessionRangeId,
} from "./session-range";
import { SESSION_PAGE_SIZE } from "./session-page";

export type SessionNavigationView = "overview" | "sessions";

export type SessionNavigation = {
  view: SessionNavigationView;
  selectedId: string | null;
  range: SessionRangeId;
};

const STORAGE_KEY = "token-analyser.navigation.v1";
const DEFAULT_NAVIGATION: SessionNavigation = {
  view: "overview",
  selectedId: null,
  range: DEFAULT_SESSION_RANGE,
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Storage can be unavailable in private browsing or when blocked by a
    // browser policy. Navigation still works without persistence.
    return null;
  }
}

export function readSessionNavigation(): SessionNavigation {
  let navigation = DEFAULT_NAVIGATION;
  try {
    const stored: unknown = JSON.parse(
      storage()?.getItem(STORAGE_KEY) ?? "null",
    );
    const historyState =
      typeof window === "undefined"
        ? null
        : window.history.state?.tokenAnalyser;
    const parsed = historyState ?? stored;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      navigation = {
        view: record.view === "sessions" ? "sessions" : "overview",
        selectedId:
          typeof record.selectedId === "string" && record.selectedId.length > 0
            ? record.selectedId
            : null,
        range:
          SESSION_RANGES.find((item) => item.id === record.range)?.id ??
          DEFAULT_SESSION_RANGE,
      };
    }
  } catch {
    // Corrupt history/storage must not prevent navigation.
  }
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  if (hash === "#overview" || hash === "#sessions")
    navigation = {
      ...navigation,
      view: hash.slice(1) as SessionNavigationView,
    };
  return navigation;
}

export function writeSessionNavigation(navigation: SessionNavigation): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(navigation));
  } catch {
    // A full or restricted storage area should not break the dashboard.
  }
  if (typeof window !== "undefined") {
    window.history.replaceState(
      { ...window.history.state, tokenAnalyser: navigation },
      "",
      `#${navigation.view}`,
    );
  }
}

export function pushSessionNavigation(navigation: SessionNavigation): void {
  if (typeof window !== "undefined") {
    window.history.pushState(
      { ...window.history.state, tokenAnalyser: navigation },
      "",
      `#${navigation.view}`,
    );
  }
}

type SessionListState = { query: string; limit: number; scrollTop: number };
const LIST_STORAGE_KEY = "token-analyser.session-list.v1";

export function readSessionListState(): SessionListState {
  const fallback = { query: "", limit: SESSION_PAGE_SIZE, scrollTop: 0 };
  try {
    const parsed = JSON.parse(storage()?.getItem(LIST_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return fallback;
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      limit:
        Number.isSafeInteger(parsed.limit) && parsed.limit >= SESSION_PAGE_SIZE
          ? parsed.limit
          : SESSION_PAGE_SIZE,
      scrollTop:
        Number.isFinite(parsed.scrollTop) && parsed.scrollTop >= 0
          ? parsed.scrollTop
          : 0,
    };
  } catch {
    return fallback;
  }
}

export function writeSessionListState(state: SessionListState): void {
  try {
    storage()?.setItem(LIST_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Tab-local preferences are best effort. */
  }
}
