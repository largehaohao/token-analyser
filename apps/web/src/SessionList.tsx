import { useEffect } from "react";
import type { SessionListItem } from "./api";
import { MixBar } from "./MixBar";
import { formatCompactTokens, formatCost, wasteShare } from "./format";
import { useUnit } from "./UnitContext";

const EMPTY_COPY =
  "No Codex sessions found. Run Codex locally, then sessions appear from ~/.codex/sessions/**/rollout-*.jsonl";
const EMPTY_RANGE_COPY = "该时间范围内没有会话";

type ContextBucketId = "tools" | "skills";

type Props = {
  sessions: SessionListItem[];
  totalCount: number;
  selectedId: string | null;
  contextOpen: ContextBucketId | null;
  onSelect: (id: string) => void;
  onInspectContext: (id: string, bucket: ContextBucketId) => void;
  onImport: (filename: string, text: string) => void;
};

function formatStart(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function SessionList({
  sessions,
  totalCount,
  selectedId,
  contextOpen,
  onSelect,
  onInspectContext,
  onImport,
}: Props) {
  const { unit } = useUnit();

  useEffect(() => {
    if (sessions.length === 0) return;
    if (selectedId && sessions.some((session) => session.id === selectedId)) {
      return;
    }
    onSelect(sessions[0].id);
  }, [sessions, selectedId, onSelect]);

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
      <h2>会话</h2>
      {totalCount === 0 ? (
        <p className="empty-copy">{EMPTY_COPY}</p>
      ) : sessions.length === 0 ? (
        <p className="empty-copy">{EMPTY_RANGE_COPY}</p>
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
              <div className="session-card">
                <button
                  type="button"
                  className="session-main"
                  onClick={() => onSelect(s.id)}
                >
                  <div className="row-top">
                    <span className="session-id">{s.nickname ?? s.id}</span>
                    {s.live && <span className="badge live">LIVE</span>}
                  </div>
                  <div className="session-meta">{s.cwd ?? "—"}</div>
                  <div className="session-meta">
                    {s.model ?? "—"} · {s.effort ?? "—"}
                  </div>
                  <div className="session-meta">{formatStart(s.startedAt)}</div>
                  <div className="session-costs">
                    <span>{formatCost(s.cost, unit)}</span>
                    <span className="waste-share">
                      waste {wasteShare(s.waste, s.cost)}
                    </span>
                  </div>
                  <MixBar
                    className="waste-bar"
                    label={`waste ${wasteShare(s.waste, s.cost)}`}
                    segments={[
                      {
                        key: "useful",
                        value: Math.max(0, s.cost.raw - s.waste.raw),
                        className: "useful",
                      },
                      { key: "waste", value: s.waste.raw, className: "waste" },
                    ]}
                  />
                  {s.parse_error && s.parse_error_message != null && (
                    <div
                      className="session-meta parse-error-detail"
                      title={`offset ${s.parse_error_offset}: ${s.parse_error_message}`}
                    >
                      offset {s.parse_error_offset}: {s.parse_error_message}
                    </div>
                  )}
                </button>
                <div className="session-context-meta">
                  <button
                    type="button"
                    className={
                      selectedId === s.id && contextOpen === "skills"
                        ? "active"
                        : ""
                    }
                    onClick={() => onInspectContext(s.id, "skills")}
                  >
                    技能 {formatCompactTokens(s.skillsChars ?? 0)}
                    {(s.skillsCount ?? 0) > 0 ? ` · ${s.skillsCount}` : ""}
                  </button>
                  <button
                    type="button"
                    className={
                      selectedId === s.id && contextOpen === "tools"
                        ? "active"
                        : ""
                    }
                    onClick={() => onInspectContext(s.id, "tools")}
                  >
                    工具 {formatCompactTokens(s.toolsChars ?? 0)}
                    {(s.toolsCount ?? 0) > 0 ? ` · ${s.toolsCount}` : ""}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
