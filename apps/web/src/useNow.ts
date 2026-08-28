import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const NowContext = createContext<number | null>(null);

function useTickingNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

export function NowProvider({
  children,
  intervalMs = 30_000,
}: {
  children: ReactNode;
  intervalMs?: number;
}) {
  const now = useTickingNow(intervalMs, true);
  return createElement(NowContext.Provider, { value: now }, children);
}

export function useNow(intervalMs = 30_000): number {
  const shared = useContext(NowContext);
  const local = useTickingNow(intervalMs, shared == null);
  return shared ?? local;
}
