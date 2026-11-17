export type ThemePref = "light" | "dark";

export const THEME_PREF_KEY = "token-analyser:theme";
export const THEME_CHANGE_EVENT = "token-analyser:themechange";

export function parseThemePref(raw: string | null | undefined): ThemePref | null {
  if (raw === "light" || raw === "dark") return raw;
  return null;
}

/** Stored choice wins; a first visit follows the operating system. */
export function readThemePref(): ThemePref {
  try {
    const stored = parseThemePref(localStorage.getItem(THEME_PREF_KEY));
    if (stored) return stored;
  } catch {
    // Private mode / quota: fall through to the system preference.
  }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function writeThemePref(theme: ThemePref): void {
  try {
    localStorage.setItem(THEME_PREF_KEY, theme);
  } catch {
    // The in-memory theme still works without persistence.
  }
}

export function applyTheme(theme: ThemePref): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // shadcn's dark custom-variant keys off the `.dark` class.
  root.classList.toggle("dark", theme === "dark");
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}