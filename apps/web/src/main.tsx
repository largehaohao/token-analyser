import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readThemePref } from "./theme-pref";
// Tailwind's theme/utilities are layered; the unlayered STRATA stylesheet wins
// on equal specificity, so existing component styling stays authoritative.
import "./shadcn.css";
import "./styles.css";

// Resolve the theme before first paint so a dark preference never flashes light.
applyTheme(readThemePref());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
