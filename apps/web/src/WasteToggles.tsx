import { useRef, useState } from "react";
import type { WasteToggleId, SessionSnapshot } from "./api";
import { getSession, patchToggles } from "./api";
import { persistToggleError } from "./waste-toggles";

const TOGGLE_LABELS: { id: WasteToggleId; label: string }[] = [
  { id: "poll", label: "Waiting poll" },
  { id: "reread", label: "Duplicate reads" },
  { id: "compaction_loop", label: "Compaction loop" },
  { id: "idle_subagents", label: "Idle subagents" },
  { id: "coord", label: "Coordination (spawn/send)" },
  { id: "healthy_subagents", label: "Healthy subagent work" },
  { id: "planning", label: "Planning" },
  { id: "code", label: "Code" },
];

type Props = {
  snapshot: SessionSnapshot;
  onUpdate: (snap: SessionSnapshot) => void;
};

export function WasteToggles({ snapshot, onUpdate }: Props) {
  const latest = useRef(snapshot);
  const requestQueue = useRef(Promise.resolve());
  const [persistError, setPersistError] = useState<string | null>(null);

  // Keep the ref current during render so a selection change invalidates
  // responses from a previous session before another click can queue work.
  latest.current = snapshot;

  function handleChange(id: WasteToggleId, checked: boolean): void {
    const current = latest.current;
    const optimistic = {
      ...current,
      toggles: { ...current.toggles, [id]: checked },
    };
    latest.current = optimistic;
    onUpdate(optimistic);
    setPersistError(null);

    requestQueue.current = requestQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (latest.current.id !== current.id) return;
        try {
          const updated = await patchToggles(current.id, { [id]: checked });
          if (latest.current.id !== current.id) return;
          latest.current = updated;
          onUpdate(updated);
          setPersistError(null);
        } catch {
          try {
            const refreshed = await getSession(current.id);
            if (latest.current.id !== current.id) return;
            latest.current = refreshed;
            onUpdate(refreshed);
            setPersistError(null);
          } catch {
            if (latest.current.id !== current.id) return;
            setPersistError(persistToggleError(true, true));
          }
        }
      });
  }

  return (
    <div className="waste-toggles chart-card">
      <h3>浪费开关</h3>
      <p className="chart-desc">
        浪费是轮次集合，同一轮只计一次。默认打开可避免的异常，不是所有贵的工作。
      </p>
      {persistError && (
        <p className="toggle-error" role="alert">
          {persistError}
        </p>
      )}
      <div className="toggle-grid">
        {TOGGLE_LABELS.map(({ id, label }) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={snapshot.toggles[id]}
              onChange={(e) => handleChange(id, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
