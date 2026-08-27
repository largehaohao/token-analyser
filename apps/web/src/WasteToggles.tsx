import type { WasteToggleId, SessionSnapshot } from "./api";
import { patchToggles } from "./api";

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
  async function handleChange(id: WasteToggleId, checked: boolean) {
    const updated = await patchToggles(snapshot.id, { [id]: checked });
    onUpdate(updated);
  }

  return (
    <div className="waste-toggles">
      <h3>Waste toggles</h3>
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
