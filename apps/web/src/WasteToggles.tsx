import { useEffect, useRef, useState } from "react";
import type { WasteToggleId, SessionSnapshot } from "./api";
import { getSession, patchToggles } from "./api";
import { nextToggleState, persistToggleError } from "./waste-toggles";
import { Button } from "./ui";

const TOGGLE_LABELS: {
  id: WasteToggleId;
  label: string;
  onByDefault: boolean;
}[] = [
  { id: "poll", label: "轮询等待", onByDefault: true },
  { id: "reread", label: "重复读取", onByDefault: true },
  { id: "compaction_loop", label: "压缩回读", onByDefault: true },
  { id: "idle_subagents", label: "空转子 Agent", onByDefault: true },
  { id: "coord", label: "协调 spawn/send", onByDefault: false },
  { id: "healthy_subagents", label: "正常子 Agent 工作", onByDefault: false },
  { id: "planning", label: "规划与思考", onByDefault: false },
  { id: "code", label: "代码与执行", onByDefault: false },
];

type Props = {
  snapshot: SessionSnapshot;
  onUpdate: (snap: SessionSnapshot) => void;
};

export function WasteToggles({ snapshot, onUpdate }: Props) {
  const latest = useRef(snapshot);
  const requestQueue = useRef(Promise.resolve());
  const mutationRevision = useRef(0);
  const mounted = useRef(true);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const inFlight = useRef(false);
  const lastAttempt = useRef<{ id: WasteToggleId; checked: boolean } | null>(
    null,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationRevision.current += 1;
    };
  }, []);

  // Keep the ref current during render so a selection change invalidates
  // responses from a previous session before another click can queue work.
  latest.current = snapshot;

  function handleChange(id: WasteToggleId, checked: boolean): void {
    if (inFlight.current) return;
    inFlight.current = true;
    lastAttempt.current = { id, checked };
    const current = latest.current;
    const optimistic = {
      ...current,
      toggles: nextToggleState(current.toggles, id, checked),
    };
    latest.current = optimistic;
    const revision = ++mutationRevision.current;
    onUpdate(optimistic);
    setPersistError(null);
    setPending((count) => count + 1);

    requestQueue.current = requestQueue.current
      .catch(() => undefined)
      .then(async () => {
        try {
          if (!mounted.current || latest.current.id !== current.id) return;
          // Persist the complete state captured by this click. If an earlier
          // queued request fails, a later request still carries every newer
          // optimistic choice instead of silently losing one toggle.
          const updated = await patchToggles(current.id, optimistic.toggles);
          if (
            !mounted.current ||
            latest.current.id !== current.id ||
            mutationRevision.current !== revision
          )
            return;
          latest.current = updated;
          onUpdate(updated);
          setPersistError(null);
        } catch {
          if (
            !mounted.current ||
            latest.current.id !== current.id ||
            mutationRevision.current !== revision
          )
            return;
          try {
            const refreshed = await getSession(current.id);
            if (
              !mounted.current ||
              latest.current.id !== current.id ||
              mutationRevision.current !== revision
            )
              return;
            latest.current = refreshed;
            onUpdate(refreshed);
            const confirmed = Object.entries(optimistic.toggles).every(
              ([key, value]) =>
                refreshed.toggles[key as WasteToggleId] === value,
            );
            setPersistError(
              confirmed ? null : "规则未能保存，已恢复之前的设置。请重试。",
            );
          } catch {
            if (!mounted.current || latest.current.id !== current.id) return;
            setPersistError(persistToggleError(true, true));
          }
        } finally {
          inFlight.current = false;
          if (mounted.current) {
            setPending((count) => Math.max(0, count - 1));
          }
        }
      });
  }

  return (
    <div
      className="waste-toggles chart-card"
      aria-busy={pending > 0 || undefined}
    >
      <div className="toggle-head">
        <h3>浪费开关</h3>
        <span
          className={pending > 0 ? "toggle-status saving" : "toggle-status"}
          role="status"
        >
          {pending > 0 ? "正在保存…" : persistError ? "保存未确认" : "已保存"}
        </span>
      </div>
      <p className="chart-desc">
        浪费是轮次集合，同一轮只计一次。默认打开可避免的异常，不是所有贵的工作。
      </p>
      {persistError && (
        <div className="toggle-error">
          <p role="alert">{persistError}</p>
          <Button
            disabled={pending > 0}
            onClick={() => {
              const attempt = lastAttempt.current;
              if (attempt) handleChange(attempt.id, attempt.checked);
            }}
          >
            重试保存
          </Button>
        </div>
      )}
      <div className="toggle-grid" role="group" aria-label="浪费计算规则">
        {TOGGLE_LABELS.map(({ id, label, onByDefault }) => (
          <label key={id}>
            <input
              type="checkbox"
              aria-label={label}
              checked={snapshot.toggles[id]}
              disabled={pending > 0}
              onChange={(e) => handleChange(id, e.target.checked)}
            />
            <span>{label}</span>
            {onByDefault && <span className="toggle-default">默认开</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
