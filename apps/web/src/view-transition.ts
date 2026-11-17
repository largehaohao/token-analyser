type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/** Route change crossfade where supported; a plain update everywhere else. */
export function withViewTransition(update: () => void): void {
  const doc = document as ViewTransitionDocument;
  if (
    typeof doc.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  doc.startViewTransition(update);
}
