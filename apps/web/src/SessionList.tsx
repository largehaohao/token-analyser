import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "./api";
import { MixBar } from "./MixBar";
import {
  activityTimestamp,
  cacheHitRatio,
  formatCompactTokens,
  formatCostTokens,
  sourceLabel,
  usageNote,
  formatCost,
  formatCostTitle,
  formatPercent,
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
import { BareButton, Button, Icon, Panel, SearchField, StatePanel } from "./ui";
import { LegacyBadge as Badge } from "@/components/ui/legacy-badge";
import { sourceColor, sourceEmptyCopy, type SessionSourceFilter } from "./session-source";

const EMPTY_RANGE_COPY = "该时间范围内没有会话";

type ContextBucketId = "tools" | "skills";

type Props = {
  source: SessionSourceFilter;
  sessions: SessionListItem[];
  totalCount: number;
  selectedId: string | null;
  contextOpen: ContextBucketId | null;
  onSelect: (id: string) => void;
  onInspectContext: (id: string, bucket: ContextBucketId) => void;
  onDeleteSession?: (session: SessionListItem) => void;
  onNotify?: (message: string) => void;
  onImport: (file: File) => Promise<void>;
  importStatus: ImportStatus | null;
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  dayFilter: string | null;
  onClearDayFilter: () => void;
  behaviorLabel: string | null;
  onClearBehavior: () => void;
  environmentLabel?: string;
};

type SessionContextMenuState = {
  session: SessionListItem;
  x: number;
  y: number;
};

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy selection copy.
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function SessionList({
  source,
  sessions,
  totalCount,
  selectedId,
  contextOpen,
  onSelect,
  onInspectContext,
  onDeleteSession,
  onNotify,
  onImport,
  importStatus,
  loaded,
  error,
  onRetry,
  dayFilter,
  onClearDayFilter,
  behaviorLabel,
  onClearBehavior,
  environmentLabel,
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
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const listIdentity = useMemo(() => sessionListIdentity(sessions), [sessions]);

  useEffect(() => {
    if (!contextMenu) return;
    contextMenuRef.current?.focus({ preventScroll: true });
    function onPointerDown(event: PointerEvent) {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setContextMenu(null);
      }
    }
    function dismiss() {
      setContextMenu(null);
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [contextMenu]);

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
      [s.id, s.nickname, s.cwd, s.model, s.effort, sourceLabel(s.source)]
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
      onScroll={(event) => {
        if (contextMenu) setContextMenu(null);
        writeSessionListState({
          query,
          limit,
          scrollTop: event.currentTarget.scrollTop,
        });
      }}
    >
      <div className="sessions-tools">
        {totalCount > 0 && (
          <SearchField id="session-search" value={query} onChange={setQuery} />
        )}
        <div
          id="jsonl-dropzone"
          className={`dropzone import-actions${dragging ? " is-dragover active" : ""}`}
          aria-busy={importing || undefined}
          title="单文件 · 最大 256 MiB · 仅在本机处理"
        >
          <div className="dropzone-info">
            <Icon name="upload" />
            <span className="od-truncate">
              {dragging ? "放开以导入" : "拖入 JSONL 日志实时解析"}
            </span>
          </div>
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
            aria-label="选择会话 JSONL 文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = "";
            }}
          />
        </div>
        {(importStatus || visibleImportError) && (
          <>
            <p
              id="import-feedback"
              className="import-feedback"
              role="status"
              aria-atomic="true"
              style={{ margin: 0 }}
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
              <p id="import-error" className="import-error" role="alert" style={{ margin: 0 }}>
                {visibleImportError}
              </p>
            )}
          </>
        )}
        {(dayFilter || behaviorLabel) && (
          <div className="session-list-active-filters" role="region" aria-label="列表筛选条件">
            {dayFilter && (
              <button
                type="button"
                className="drill-chip"
                aria-label="清除日期筛选"
                onClick={onClearDayFilter}
              >
                <span>按日：{dayFilter}</span>
                <Icon name="close" />
              </button>
            )}
            {behaviorLabel && (
              <button
                type="button"
                className="drill-chip"
                aria-label="清除行为筛选"
                onClick={onClearBehavior}
              >
                <span>已选：{behaviorLabel}</span>
                <Icon name="close" />
              </button>
            )}
          </div>
        )}
      </div>
      {error && totalCount > 0 && (
        <div className="list-error" style={{ margin: "8px 12px 0" }}>
          <p role="alert">更新失败，保留上次的会话列表。</p>
          <Button onClick={onRetry}>重试</Button>
        </div>
      )}
      {query &&
        selectedId &&
        !filtered.some((session) => session.id === selectedId) && (
          <div className="list-selection-note" style={{ margin: "8px 12px 0" }}>
            <p>当前打开的会话不在筛选结果中。</p>
            <Button className="mobile-open-selection" onClick={() => onSelect(selectedId)}>
              查看当前会话 <Icon name="arrow" />
            </Button>
          </div>
        )}
      {!loaded ? (
        <StatePanel
          compact
          kind={error ? "error" : "loading"}
          title={error ? "会话列表加载失败" : environmentLabel && environmentLabel !== "本机" ? `正在读取 ${environmentLabel} 的会话` : "正在读取本地会话"}
          description={
            error
              ? environmentLabel && environmentLabel !== "本机"
                ? "请确认 192.168.1.102 在线，并且本机可以 SSH 登录，然后重试。"
                : "请确认本地引擎正在运行，然后重试。"
              : environmentLabel && environmentLabel !== "本机"
                ? "首次从这台机器同步会话可能需要一两分钟。"
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
          description={sourceEmptyCopy(source)}
        />
      ) : filtered.length === 0 ? (
        <StatePanel
          compact
          kind="empty"
          title={
            dayFilter && sessions.length === 0
              ? "当日没有活跃会话"
              : behaviorLabel && sessions.length === 0
                ? "该范围内没有此行为的会话"
                : sessions.length === 0
                  ? EMPTY_RANGE_COPY
                : "没有匹配的会话"
          }
          description={
            dayFilter && sessions.length === 0
              ? "该日没有会话活动。清除日期筛选查看全部会话。"
              : behaviorLabel && sessions.length === 0
                ? "可以清除行为筛选来查看该范围的所有会话。"
                : sessions.length === 0
                  ? "试试页顶的「全部」时间范围。"
                  : "换一个会话名称、目录或模型试试。"
          }
        >
          {dayFilter && (
            <Button onClick={onClearDayFilter}>清除日期筛选</Button>
          )}
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
          <div className="sessions-list-meta" role="status">
            <span>
              共 <strong className="mono">{filtered.length}</strong>
              {filtered.length !== totalCount ? ` / ${totalCount}` : ""} 条会话
            </span>
            <span>计量：{unit === "tokens" ? "Tokens" : unit === "credits" ? "Credits" : "USD"}</span>
          </div>
          <ul>
            {page.map((s, index) => {
              const activity = activityTimestamp(s);
              const tokenWaste = wasteShare(s.waste, s.cost, "tokens");
              const unitWaste = wasteShare(s.waste, s.cost, unit);
              const hit = cacheHitRatio(s.cost);
              const srcColor = sourceColor(s.source ?? "codex");
              const totalTok = Math.max(1, s.cost.raw);
              const pIn = ((100 * s.cost.uncached_input) / totalTok).toFixed(1);
              const pCache = ((100 * s.cost.cached_input) / totalTok).toFixed(1);
              const pOut = ((100 * s.cost.output) / totalTok).toFixed(1);
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
                  <Panel
                    className="session-card"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      const maxX = Math.max(8, window.innerWidth - 220);
                      const maxY = Math.max(8, window.innerHeight - 140);
                      setContextMenu({
                        session: s,
                        x: Math.max(8, Math.min(event.clientX, maxX)),
                        y: Math.max(8, Math.min(event.clientY, maxY)),
                      });
                    }}
                  >
                    <BareButton
                      type="button"
                      className="session-main"
                      aria-pressed={selectedId === s.id}
                      data-session-index={index}
                      onClick={() => onSelect(s.id)}
                    >
                      <div className="session-card-top">
                        <span className="session-card-badges">
                          <span className="source-pill">
                            <span
                              className="source-dot"
                              style={{ background: srcColor }}
                              aria-hidden="true"
                            />
                            <span>{sourceLabel(s.source)}</span>
                          </span>
                          {s.live && <Badge variant="outline" className="badge live">LIVE</Badge>}
                          {s.parentId && <Badge variant="outline" className="badge child">子会话</Badge>}
                          {s.ledger_warning && <Badge variant="outline" className="badge warn">账本</Badge>}
                        </span>
                        <span className="session-time" title={formatAbsoluteTime(activity)}>
                          {formatRelativeTime(activity, now)}
                        </span>
                      </div>
                      <div className="session-card-title session-id" title={s.id}>
                        {s.nickname ?? s.id}
                      </div>
                      <div
                        className="session-card-sub"
                        title={[s.cwd, s.model, s.effort].filter(Boolean).join(" · ")}
                      >
                        {[s.cwd?.split(/[\\/]/).filter(Boolean).pop(), s.model]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </div>
                      <div className="session-card-stats">
                        <span className="session-cost" title={formatCostTitle(s.cost, unit)}>
                          {unit === "tokens"
                            ? `${formatCostTokens(s.cost)} tokens`
                            : formatCost(s.cost, unit)}
                        </span>
                        <span className="od-row" style={{ "--od-gap": "6px" } as React.CSSProperties}>
                          {hit != null && (
                            <span className="session-cache" title="已缓存输入 ÷ 全部输入">
                              缓存 {formatPercent(100 * hit)}
                            </span>
                          )}
                          {(s.waste.raw > 0 || selectedId === s.id) && (
                            <span
                              className="cs-tag cs-tag--warn waste-share"
                              title={formatCostTitle(s.waste, unit)}
                            >
                              可优化 {unitWaste}
                              {unit !== "tokens" && unitWaste !== tokenWaste ? ` · ${tokenWaste}` : ""}
                            </span>
                          )}
                        </span>
                      </div>
                      {s.cost.raw > 0 && (
                        <>
                          <div className="mini-token-bar waste-bar" aria-hidden="true">
                            <span style={{ width: `${pIn}%`, background: "var(--color-input)" }} />
                            <span style={{ width: `${pCache}%`, background: "var(--color-cache)" }} />
                            <span style={{ width: `${pOut}%`, background: "var(--color-output)" }} />
                          </div>
                          <MixBar
                            className="visually-hidden"
                            label="Token 构成"
                            segments={[
                              { key: "cached", label: "已缓存", value: s.cost.cached_input, className: "cached" },
                              { key: "uncached", label: "未缓存", value: s.cost.uncached_input, className: "uncached" },
                              { key: "output", label: "输出", value: s.cost.output, className: "output" },
                            ]}
                          />
                        </>
                      )}
                      {s.cost.unmeasured ? (
                        <span className="session-meta" title={usageNote(s.cost)}>
                          用量未记录 · {s.cost.unmeasured} 次调用
                        </span>
                      ) : null}
                      {(s.unpricedRaw ?? 0) > 0 && (
                        <div className="session-meta">{unpricedNote(s.unpricedRaw ?? 0)}</div>
                      )}
                      {s.parse_error && s.parse_error_message != null && (
                        <div
                          className="session-meta parse-error-detail"
                          title={`offset ${s.parse_error_offset}: ${s.parse_error_message}`}
                        >
                          offset {s.parse_error_offset}: {s.parse_error_message}
                        </div>
                      )}
                    </BareButton>
                    {selectedId === s.id && (
                      <div className="session-context-meta">
                        <BareButton
                          type="button"
                          className={
                            selectedId === s.id && contextOpen === "skills"
                              ? "active"
                              : ""
                          }
                          aria-pressed={contextOpen === "skills"}
                          onClick={() => onInspectContext(s.id, "skills")}
                        >
                          <Icon name="sparkles" />
                          <span>
                            技能 {formatCompactTokens(s.skillsChars ?? 0)}
                            {(s.skillsCount ?? 0) > 0
                              ? ` · ${s.skillsCount}`
                              : ""}
                          </span>
                        </BareButton>
                        <BareButton
                          type="button"
                          className={
                            selectedId === s.id && contextOpen === "tools"
                              ? "active"
                              : ""
                          }
                          aria-pressed={contextOpen === "tools"}
                          onClick={() => onInspectContext(s.id, "tools")}
                        >
                          <Icon name="wrench" />
                          <span>
                            工具 {formatCompactTokens(s.toolsChars ?? 0)}
                            {(s.toolsCount ?? 0) > 0 ? ` · ${s.toolsCount}` : ""}
                          </span>
                        </BareButton>
                      </div>
                    )}
                  </Panel>
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
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="session-context-menu"
          role="menu"
          aria-label="会话操作"
          tabIndex={-1}
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <div className="session-context-menu-head" title={contextMenu.session.id}>
            <span className="od-truncate">{contextMenu.session.nickname ?? contextMenu.session.id}</span>
            <span className="mono">{contextMenu.session.id.slice(0, 8)}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            onClick={() => {
              const target = contextMenu.session;
              setContextMenu(null);
              void copyText(target.id).then((copied) => {
                onNotify?.(copied ? `已拷贝会话 ID：${target.id}` : `拷贝失败，请手动复制：${target.id}`);
              });
            }}
          >
            <Icon name="copy" />
            <span>拷贝会话 ID</span>
          </button>
          <div className="session-context-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="session-context-item is-danger"
            onClick={() => {
              const target = contextMenu.session;
              setContextMenu(null);
              onDeleteSession?.(target);
            }}
          >
            <Icon name="trash" />
            <span>删除会话</span>
          </button>
        </div>
      )}
    </aside>
  );
}
