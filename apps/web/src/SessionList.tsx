import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "./api";
import { MixBar } from "./MixBar";
import {
  activityTimestamp,
  formatCompactTokens,
  formatCost,
  formatCostTitle,
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
import type { ImportStatus } from "./import-file";
import {
  readSessionListState,
  writeSessionListState,
} from "./session-navigation";
import { Button, Icon, SearchField, StatePanel } from "./ui";

const EMPTY_COPY =
  "在本机运行 Codex 后，会话会自动出现在这里。也可以选择或拖入已有的 JSONL 记录。";
const EMPTY_RANGE_COPY = "该时间范围内没有会话";

type ContextBucketId = "tools" | "skills";

type Props = {
  sessions: SessionListItem[];
  totalCount: number;
  selectedId: string | null;
  contextOpen: ContextBucketId | null;
  onSelect: (id: string) => void;
  onInspectContext: (id: string, bucket: ContextBucketId) => void;
  onImport: (file: File) => Promise<void>;
  importStatus: ImportStatus | null;
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
};

export function SessionList({
  sessions,
  totalCount,
  selectedId,
  contextOpen,
  onSelect,
  onInspectContext,
  onImport,
  importStatus,
  loaded,
  error,
  onRetry,
}: Props) {
  const { unit } = useUnit();
  const now = useNow();
  const [initialListState] = useState(readSessionListState);
  const [query, setQuery] = useState(initialListState.query);
  const [dragging, setDragging] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [limit, setLimit] = useState(initialListState.limit);
  const importing = importStatus?.state === "pending";
  const visibleImportError =
    importError ??
    (importStatus?.state === "error" ? importStatus.message : null);
  const previousImportStatus = useRef(importStatus);
  const dragDepth = useRef(0);
  const listRef = useRef<HTMLElement>(null);
  const restoredScroll = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listIdentity = sessionListIdentity(sessions);

  useEffect(() => {
    const justCompleted =
      importStatus?.state === "success" &&
      previousImportStatus.current !== importStatus;
    previousImportStatus.current = importStatus;
    if (!justCompleted) return;
    setQuery("");
    setLimit(SESSION_PAGE_SIZE);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [importStatus]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.id, s.nickname, s.cwd, s.model, s.effort]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  const previousQuery = useRef(query);
  useEffect(() => {
    if (previousQuery.current === query) return;
    previousQuery.current = query;
    setLimit(pageLimitIncludingId(filtered, selectedId));
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, filtered, selectedId]);

  useEffect(() => {
    if (loaded && !restoredScroll.current && listRef.current) {
      listRef.current.scrollTop = initialListState.scrollTop;
      restoredScroll.current = true;
    }
  }, [loaded, initialListState.scrollTop]);

  useEffect(() => {
    writeSessionListState({
      query,
      limit,
      scrollTop: listRef.current?.scrollTop ?? initialListState.scrollTop,
    });
  }, [query, limit, initialListState.scrollTop]);

  const prevIdentity = useRef(listIdentity);
  useEffect(() => {
    if (shouldResetSessionLimit(prevIdentity.current, listIdentity)) {
      setLimit(pageLimitIncludingId(filtered, selectedId));
    }
    prevIdentity.current = listIdentity;
  }, [listIdentity, filtered, selectedId]);

  const page = visibleSessions(filtered, limit);

  function importFile(file: File) {
    if (importing) return;
    setImportError(null);
    void onImport(file);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    dragDepth.current = 0;
    if (importing) return;
    if (e.dataTransfer.files.length > 1) {
      setImportError("一次只能导入一个文件，请选择一个 JSONL 会话记录。");
      return;
    }
    const file = e.dataTransfer.files[0];
    if (file) importFile(file);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!importing && e.dataTransfer.types.includes("Files")) setDragging(true);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return;
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
      requestAnimationFrame(() => {
        const button = listRef.current?.querySelector<HTMLButtonElement>(
          `button[data-session-index="${nextIndex}"]`,
        );
        button?.focus({ preventScroll: true });
        button?.scrollIntoView({ block: "nearest" });
      });
    }
  }

  return (
    <aside
      ref={listRef}
      className={`session-list${dragging ? " dragging" : ""}`}
      tabIndex={0}
      aria-label="会话列表"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        if (!importing) setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onKeyDown={handleKeyDown}
      onScroll={(event) =>
        writeSessionListState({
          query,
          limit,
          scrollTop: event.currentTarget.scrollTop,
        })
      }
    >
      <div className="session-list-head">
        <div>
          <span className="session-list-eyebrow">本地运行索引</span>
          <h2>会话</h2>
        </div>
        <span className="session-count" aria-label="会话数量">
          <strong>{filtered.length}</strong>
          {filtered.length !== totalCount ? ` / ${totalCount}` : ""}
        </span>
      </div>
      {totalCount > 0 && (
        <SearchField id="session-search" value={query} onChange={setQuery} />
      )}
      <div className="import-actions" aria-busy={importing || undefined}>
        <Icon name="upload" />
        <p className={`drop-hint${dragging ? " active" : ""}`}>
          {dragging ? "放开以导入 JSONL" : "拖入 JSONL / NDJSON"}
          <span>单文件 · 最大 256 MiB · 仅在本机处理</span>
        </p>
        <Button
          busy={importing}
          aria-describedby={
            visibleImportError ? "import-error" : "import-feedback"
          }
          onClick={() => fileInputRef.current?.click()}
        >
          选择文件
        </Button>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          tabIndex={-1}
          disabled={importing}
          aria-invalid={!!visibleImportError}
          aria-describedby={visibleImportError ? "import-error" : undefined}
          accept=".jsonl,.ndjson,application/x-ndjson"
          aria-label="选择 rollout JSONL 文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = "";
          }}
        />
      </div>
      <p
        id="import-feedback"
        className="import-feedback"
        role="status"
        aria-atomic="true"
      >
        {importStatus?.state === "pending"
          ? `正在导入 ${importStatus.filename}…`
          : importStatus?.state === "success" && !importError
            ? `已导入 ${importStatus.filename}，可在全部时间范围中查看。`
            : importStatus?.filename
              ? `所选文件：${importStatus.filename}`
              : ""}
      </p>
      {visibleImportError && (
        <p id="import-error" className="import-error" role="alert">
          {visibleImportError}
        </p>
      )}
      {error && totalCount > 0 && (
        <div className="list-error">
          <p role="alert">更新失败，保留上次的会话列表。</p>
          <Button onClick={onRetry}>重试</Button>
        </div>
      )}
      {query &&
        selectedId &&
        !filtered.some((session) => session.id === selectedId) && (
          <p className="list-selection-note">当前打开的会话不在筛选结果中。</p>
        )}
      {!loaded ? (
        <StatePanel
          compact
          kind={error ? "error" : "loading"}
          title={error ? "会话列表加载失败" : "正在读取本地会话"}
          description={
            error
              ? "请确认本地引擎正在运行，然后重试。"
              : "首次读取较大的记录可能需要一些时间。"
          }
        >
          {error && <Button onClick={onRetry}>重试</Button>}
        </StatePanel>
      ) : totalCount === 0 ? (
        <StatePanel
          compact
          kind="empty"
          title="还没有会话"
          description={EMPTY_COPY}
        />
      ) : filtered.length === 0 ? (
        <StatePanel
          compact
          kind="empty"
          title={sessions.length === 0 ? EMPTY_RANGE_COPY : "没有匹配的会话"}
          description={
            sessions.length === 0
              ? "试试页顶的「全部」时间范围。"
              : "换一个会话名称、目录或模型试试。"
          }
        >
          {query && (
            <Button
              onClick={() => {
                setQuery("");
                document.getElementById("session-search")?.focus();
              }}
            >
              清除搜索
            </Button>
          )}
        </StatePanel>
      ) : (
        <>
          <p className="list-result-summary" role="status">
            显示 {page.length} / {filtered.length} 个会话
          </p>
          <ul>
            {page.map((s, index) => {
              const activity = activityTimestamp(s);
              const tokenWaste = wasteShare(s.waste, s.cost, "tokens");
              const unitWaste = wasteShare(s.waste, s.cost, unit);
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
                      aria-pressed={selectedId === s.id}
                      data-session-index={index}
                      onClick={() => onSelect(s.id)}
                    >
                      <div className="row-top">
                        <span className="session-id" title={s.id}>
                          {s.nickname ?? s.id}
                        </span>
                        {s.live && <span className="badge live">LIVE</span>}
                        {s.parentId && (
                          <span className="badge child">子会话</span>
                        )}
                        {s.ledger_warning && (
                          <span className="badge warn">账本</span>
                        )}
                      </div>
                      <div className="session-meta" title={s.cwd ?? undefined}>
                        {s.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "—"}
                      </div>
                      <div className="session-meta session-meta-row">
                        <span
                          title={[s.model, s.effort]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          {s.model ?? "—"}
                        </span>
                        <span title={formatAbsoluteTime(activity)}>
                          {formatRelativeTime(activity, now)}
                        </span>
                      </div>
                      <div className="session-costs">
                        <span title={formatCostTitle(s.cost, unit)}>
                          {unit === "tokens"
                            ? `${formatCompactTokens(s.cost.raw)} tokens`
                            : formatCost(s.cost, unit)}
                        </span>
                        {(s.waste.raw > 0 || selectedId === s.id) && (
                          <span
                            className="waste-share"
                            title={formatCostTitle(s.waste, unit)}
                          >
                            浪费 {unitWaste}
                            {unit !== "tokens" && unitWaste !== tokenWaste && (
                              <span className="legend-note">
                                {" "}
                                · token {tokenWaste}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      {(s.unpricedRaw ?? 0) > 0 && (
                        <div className="session-meta">
                          {unpricedNote(s.unpricedRaw ?? 0)}
                        </div>
                      )}
                      {(s.waste.raw > 0 || selectedId === s.id) && (
                        <MixBar
                          className="waste-bar"
                          label={`浪费 ${tokenWaste}（按 token）`}
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
                      )}
                      {s.parse_error && s.parse_error_message != null && (
                        <div
                          className="session-meta parse-error-detail"
                          title={`offset ${s.parse_error_offset}: ${s.parse_error_message}`}
                        >
                          offset {s.parse_error_offset}: {s.parse_error_message}
                        </div>
                      )}
                    </button>
                    {selectedId === s.id && (
                      <div className="session-context-meta">
                        <button
                          type="button"
                          className={
                            selectedId === s.id && contextOpen === "skills"
                              ? "active"
                              : ""
                          }
                          aria-pressed={contextOpen === "skills"}
                          onClick={() => onInspectContext(s.id, "skills")}
                        >
                          技能 {formatCompactTokens(s.skillsChars ?? 0)}
                          {(s.skillsCount ?? 0) > 0
                            ? ` · ${s.skillsCount}`
                            : ""}
                        </button>
                        <button
                          type="button"
                          className={
                            selectedId === s.id && contextOpen === "tools"
                              ? "active"
                              : ""
                          }
                          aria-pressed={contextOpen === "tools"}
                          onClick={() => onInspectContext(s.id, "tools")}
                        >
                          工具 {formatCompactTokens(s.toolsChars ?? 0)}
                          {(s.toolsCount ?? 0) > 0 ? ` · ${s.toolsCount}` : ""}
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {page.length < filtered.length && (
            <Button
              className="load-more"
              data-testid="session-load-more"
              onClick={() => setLimit(nextSessionLimit(limit, filtered.length))}
            >
              加载更多（还有 {filtered.length - page.length} 个会话）
            </Button>
          )}
        </>
      )}
    </aside>
  );
}
