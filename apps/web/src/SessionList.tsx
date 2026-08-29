import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "./api";
import { MixBar } from "./MixBar";
import {
  activityTimestamp,
  formatCompactTokens,
  formatCost,
  formatRelativeTime,
  formatAbsoluteTime,
  unpricedNote,
  wasteShare,
} from "./format";
import { useUnit } from "./UnitContext";
import { useNow } from "./useNow";
import {
  SESSION_PAGE_SIZE,
  nextSessionIndex,
  nextSessionLimit,
  pageLimitIncludingId,
  sessionListIdentity,
  shouldResetSessionLimit,
  visibleSessions,
} from "./session-page";
import { errorMessage } from "./app-errors";
import { readDroppedFile } from "./import-file";

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
  onImport: (filename: string, text: string) => void | Promise<void>;
};

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
  const now = useNow();
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [limit, setLimit] = useState(SESSION_PAGE_SIZE);
  const listIdentity = sessionListIdentity(sessions);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.id, s.nickname, s.cwd, s.model, s.effort]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  useEffect(() => {
    setLimit(pageLimitIncludingId(filtered, selectedId));
  }, [query]);

  const prevIdentity = useRef(listIdentity);
  useEffect(() => {
    if (shouldResetSessionLimit(prevIdentity.current, listIdentity)) {
      setLimit(pageLimitIncludingId(filtered, selectedId));
    }
    prevIdentity.current = listIdentity;
  }, [listIdentity]);

  const page = visibleSessions(filtered, limit);

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    try {
      const dropped = await readDroppedFile(file);
      await onImport(dropped.filename, dropped.text);
      setImportError(null);
    } catch (err) {
      setImportError(errorMessage(err, "导入失败"));
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragging(true);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (filtered.length === 0) return;
    e.preventDefault();
    const index = filtered.findIndex((s) => s.id === selectedId);
    const nextIndex = nextSessionIndex(
      filtered.length,
      index,
      e.key === "ArrowDown" ? "ArrowDown" : "ArrowUp",
    );
    const next = nextIndex >= 0 ? filtered[nextIndex] : undefined;
    if (next) {
      const needed = filtered.findIndex((s) => s.id === next.id) + 1;
      if (needed > limit) setLimit(nextSessionLimit(limit, filtered.length));
      onSelect(next.id);
    }
  }

  return (
    <aside
      className={`session-list${dragging ? " dragging" : ""}`}
      tabIndex={0}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={() => setDragging(true)}
      onDragLeave={() => setDragging(false)}
      onKeyDown={handleKeyDown}
    >
      <div className="session-list-head">
        <h2>会话</h2>
        <span className="session-count">
          {filtered.length}
          {filtered.length !== totalCount ? ` / ${totalCount}` : ""}
        </span>
      </div>
      {totalCount > 0 && (
        <input
          className="session-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选 id / 目录 / 模型"
          aria-label="筛选会话"
        />
      )}
      <p className={`drop-hint${dragging ? " active" : ""}`}>
        {dragging ? "放开以导入 JSONL" : "拖入 rollout JSONL 导入"}
      </p>
      {importError && (
        <p className="import-error" role="alert">
          {importError}
        </p>
      )}
      {totalCount === 0 ? (
        <p className="empty-copy">{EMPTY_COPY}</p>
      ) : filtered.length === 0 ? (
        <p className="empty-copy">
          {sessions.length === 0 ? EMPTY_RANGE_COPY : "没有匹配的会话"}
        </p>
      ) : (
        <>
          <ul>
            {page.map((s) => {
              const activity = activityTimestamp(s);
              return (
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
                        {s.parentId && <span className="badge child">子会话</span>}
                        {s.ledger_warning && (
                          <span className="badge warn">账本</span>
                        )}
                      </div>
                      <div className="session-meta" title={s.cwd ?? undefined}>
                        {s.cwd ?? "—"}
                      </div>
                      <div className="session-meta">
                        {s.model ?? "—"}
                        {s.effort ? ` · ${s.effort}` : ""}
                      </div>
                      <div
                        className="session-meta"
                        title={formatAbsoluteTime(activity)}
                      >
                        {formatRelativeTime(activity, now)}
                      </div>
                      <div className="session-costs">
                        <span>{formatCost(s.cost, unit)}</span>
                        <span className="waste-share">
                          waste {wasteShare(s.waste, s.cost, unit)}
                        </span>
                      </div>
                      {(s.unpricedRaw ?? 0) > 0 && (
                        <div className="session-meta">
                          {unpricedNote(s.unpricedRaw ?? 0)}
                        </div>
                      )}
                      <MixBar
                        className="waste-bar"
                        label={`浪费 ${wasteShare(s.waste, s.cost)}（按 token）`}
                        segments={[
                          {
                            key: "useful",
                            label: "有效",
                            value: Math.max(0, s.cost.raw - s.waste.raw),
                            className: "useful",
                          },
                          {
                            key: "waste",
                            label: "浪费",
                            value: s.waste.raw,
                            className: "waste",
                          },
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
              );
            })}
          </ul>
          {page.length < filtered.length && (
            <button
              type="button"
              className="load-more"
              data-testid="session-load-more"
              onClick={() =>
                setLimit(nextSessionLimit(limit, filtered.length))
              }
            >
              加载更多（还有 {filtered.length - page.length} 个会话）
            </button>
          )}
        </>
      )}
    </aside>
  );
}
