import type { SessionListItem } from "./api";
import { useUnit } from "./UnitContext";
import { formatCost, wasteShare } from "./format";

const EMPTY_COPY =
  "No Codex sessions found. Run Codex locally, then sessions appear from ~/.codex/sessions/**/rollout-*.jsonl";

type Props = {
  sessions: SessionListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onImport: (filename: string, text: string) => void;
};

function formatStart(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function SessionList({ sessions, selectedId, onSelect, onImport }: Props) {
  const { unit } = useUnit();

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onImport(file.name, reader.result as string);
    };
    reader.readAsText(file);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  return (
    <aside
      className="session-list"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <h2>Sessions</h2>
      {sessions.length === 0 ? (
        <p className="empty-copy">{EMPTY_COPY}</p>
      ) : (
        <ul>
          {sessions.map((s) => (
            <li
              key={s.id}
              className={[
                selectedId === s.id ? "selected" : "",
                s.parse_error ? "parse-error" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <button type="button" onClick={() => onSelect(s.id)}>
                <div className="row-top">
                  <span className="session-id">{s.nickname ?? s.id}</span>
                  {s.live && <span className="badge live">LIVE</span>}
                </div>
                <div className="session-meta">{s.cwd ?? "—"}</div>
                <div className="session-meta">
                  {s.model ?? "—"} · {s.effort ?? "—"}
                </div>
                <div className="session-meta">
                  {formatStart(s.startedAt)}
                </div>
                <div className="session-costs">
                  <span>{formatCost(s.cost, unit)}</span>
                  <span className="waste-share">
                    waste {wasteShare(s.waste, s.cost)}
                  </span>
                </div>
                {s.parse_error && s.parse_error_message != null && (
                  <div
                    className="session-meta parse-error-detail"
                    title={`offset ${s.parse_error_offset}: ${s.parse_error_message}`}
                  >
                    offset {s.parse_error_offset}: {s.parse_error_message}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
