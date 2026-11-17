import { useEffect, useRef, useState } from "react";

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Two recorded grids can morph only when they share a shape: equal length and
 * an identical gap pattern (a missing reading stays missing, never appears or
 * disappears mid-animation). Both canvas and SVG charts use this guard.
 */
export function sameGapPattern(
  from: readonly (number | null | undefined)[],
  to: readonly (number | null | undefined)[],
): boolean {
  return (
    from.length === to.length &&
    to.every((value, i) => (from[i] == null) === (value == null))
  );
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * rAF count-up toward `target`. Mounts animate from zero; later changes
 * retarget from the currently displayed value so live refreshes stay smooth.
 * Reduced motion and null targets resolve immediately.
 */
export function useAnimatedNumber(
  target: number | null,
  duration = 450,
): number | null {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState<number | null>(() =>
    reduced || target == null ? target : 0,
  );
  const fromRef = useRef<number | null>(reduced ? target : 0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (target == null) {
      fromRef.current = null;
      setDisplay(null);
      return;
    }
    const from = fromRef.current;
    // 后台标签页里 rAF 被暂停：直接落位，避免数字停在 0。
    if (
      reduced ||
      from == null ||
      from === target ||
      document.visibilityState === "hidden"
    ) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const start = performance.now();
    const tick = (time: number) => {
      const progress = Math.min(1, (time - start) / duration);
      const value = lerp(from, target, easeOutCubic(progress));
      fromRef.current = value;
      setDisplay(value);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
        setDisplay(target);
      }
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration, reduced]);

  return display;
}

/**
 * One-shot highlight when a value changes (never on mount). Event-driven
 * feedback for live data, not a perpetual animation.
 */
export function useFlashOnChange(value: number | null | undefined): boolean {
  const reduced = useReducedMotion();
  const [flash, setFlash] = useState(false);
  const previous = useRef(value);
  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    if (reduced) return;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 720);
    return () => window.clearTimeout(timer);
  }, [value, reduced]);
  return flash;
}
