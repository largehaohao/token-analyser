import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

export type TooltipPosition = { left: number; top: number };

type ChartTooltipProps = HTMLAttributes<HTMLSpanElement> & {
  position: TooltipPosition;
  children: ReactNode;
};

export function ChartTooltip({
  position,
  className = "",
  children,
  ...rest
}: ChartTooltipProps) {
  return (
    <span
      className={`chart-tooltip chart-tooltip-fixed${className ? ` ${className}` : ""}`}
      style={{ left: position.left, top: position.top }}
      {...rest}
    >
      {children}
    </span>
  );
}

export function useChartTooltip(hideDelay = 150) {
  const [active, setActive] = useState<string | null>(null);
  const [position, setPosition] = useState<TooltipPosition>({ left: 8, top: 8 });
  const anchorRef = useRef<HTMLElement | null>(null);
  const hideTimer = useRef<number | null>(null);

  const reposition = useCallback(() => {
    const target = anchorRef.current;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(rect.left + rect.width / 2 - 100, window.innerWidth - 208),
      ),
      top: Math.max(8, Math.min(rect.top + 8, window.innerHeight - 180)),
    });
  }, []);

  const cancelHide = useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const show = useCallback(
    (key: string, target: HTMLElement) => {
      cancelHide();
      anchorRef.current = target;
      reposition();
      setActive(key);
    },
    [cancelHide, reposition],
  );

  const hide = useCallback(() => {
    cancelHide();
    setActive(null);
  }, [cancelHide]);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setActive(null), hideDelay);
  }, [cancelHide, hideDelay]);

  useEffect(() => {
    window.addEventListener("scroll", reposition, { passive: true });
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
      cancelHide();
    };
  }, [reposition, cancelHide]);

  return { active, position, show, hide, scheduleHide, cancelHide, reposition };
}
