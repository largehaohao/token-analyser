import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Tailwind's theme/utilities are layered; the unlayered STRATA stylesheet wins
// on equal specificity, so existing component styling stays authoritative.
import "./shadcn.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
