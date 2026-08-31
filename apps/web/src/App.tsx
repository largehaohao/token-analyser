import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getOverview,
  getSession,
  importNdjson,
  listSessions,
  openStream,
  sessionSummary,
  type Overview,
  type SessionListItem,
  type SessionSnapshot,
  type StreamStatus,
} from "./api";
import { errorMessage, isNotFound, streamErrorBanner } from "./app-errors";
import { UnitProvider } from "./UnitContext";
import type { CostUnit } from "./format";
import { OverviewPage } from "./OverviewPage";
import { RangeSwitcher } from "./RangeSwitcher";
import { SessionList } from "./SessionList";
import { SessionView } from "./SessionView";
import { UnitSwitcher } from "./UnitSwitcher";
import { NowProvider, useNow } from "./useNow";
import { readUnitPref, writeUnitPref } from "./unit-pref";
import { SESSION_PAGE_SIZE, resolveSelectedSession } from "./session-page";
import { readDroppedFile, type ImportStatus } from "./import-file";
import { overviewDisplayState } from "./overview-state";
import { Button, Icon, LedgerMark, Notice, StatePanel } from "./ui";
import {
  readSessionNavigation,
  pushSessionNavigation,
  writeSessionListState,
  writeSessionNavigation,
  type SessionNavigationView,
} from "./session-navigation";
import {
  SESSION_RANGES,
  filterSessionsByRange,
  type SessionRangeId,
} from "./session-range";

type View = SessionNavigationView;

const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: "实时连接中",
  open: "实时已连接",
  error: "实时未连接",
};

function AppShell() {
  const now = useNow();
  const [initialNavigation] = useState(readSessionNavigation);
  const [view, setView] = useState<View>(initialNavigation.view);
  const [unit, setUnit] = useState<CostUnit>(readUnitPref);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [appliedRange, setAppliedRange] = useState<SessionRangeId | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionLoad, setSessionLoad] = useState<{
    id: string;
    status: "loading" | "ready" | "missing" | "error";
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialNavigation.selectedId,
  );
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState<"tools" | "skills" | null>(
    null,
  );
  const [range, setRange] = useState<SessionRangeId>(initialNavigation.range);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [appError, setAppError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const importInFlight = useRef(false);
  const importedSnapshot = useRef<SessionSnapshot | null>(null);
  const listRequest = useRef(0);
  const sessionRequest = useRef(0);
  const overviewRequest = useRef(0);
  const listInFlight = useRef<Promise<SessionListItem[]> | null>(null);
  const sessionInFlight = useRef<{
    id: string;
    requestId: number;
    promise: Promise<SessionSnapshot | undefined>;
  } | null>(null);
  const overviewInFlight = useRef<{
    range: SessionRangeId;
    promise: Promise<Overview>;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  const selectedIdRef = useRef<string | null>(null);
  const preferredSessionIdRef = useRef<string | null>(
    initialNavigation.view === "sessions" ? initialNavigation.selectedId : null,
  );
  const viewRef = useRef<View>(view);
  const rangeRef = useRef<SessionRangeId>(range);
  selectedIdRef.current = selectedId;
  viewRef.current = view;
  rangeRef.current = range;

  useEffect(() => {
    writeUnitPref(unit);
  }, [unit]);

  useEffect(() => {
    writeSessionNavigation({ view, selectedId, range });
  }, [selectedId, view, range]);

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    window.scrollTo(0, 0);
    const frame = requestAnimationFrame(() => {
      const heading = contentRef.current?.querySelector<HTMLElement>("h1");
      (heading ?? contentRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);

  useEffect(() => {
    function restoreNavigation() {
      const next = readSessionNavigation();
      preferredSessionIdRef.current = next.selectedId;
      setView(next.view);
      setSelectedId(next.selectedId);
      setRange(next.range);
      setSelectedNodeId(null);
      setContextOpen(null);
    }
    window.addEventListener("popstate", restoreNavigation);
    return () => window.removeEventListener("popstate", restoreNavigation);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.isComposing ||
        e.key.toLowerCase() !== "k" ||
        !(e.metaKey || e.ctrlKey) ||
        e.altKey
      )
        return;
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (viewRef.current !== "sessions") return;
      e.preventDefault();
      document.getElementById("session-search")?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visibleSessions = useMemo(
    () => filterSessionsByRange(sessions, range, now),
    [sessions, range, now],
  );
  const rangeLabel =
    SESSION_RANGES.find((item) => item.id === range)?.label ?? range;

  const refreshOverview = useCallback(async () => {
    const requestedRange = rangeRef.current;
    const active = overviewInFlight.current;
    if (active?.range === requestedRange) return active.promise;
    const requestId = ++overviewRequest.current;
    setOverviewError(null);
    const promise = (async () => {
      try {
        const data = await getOverview(requestedRange, Date.now());
        if (requestId !== overviewRequest.current) return data;
        setOverview(data);
        setAppliedRange(requestedRange);
        setOverviewError(null);
        return data;
      } catch (err) {
        if (requestId !== overviewRequest.current) throw err;
        setOverviewError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    })();
    overviewInFlight.current = { range: requestedRange, promise };
    void promise.then(
      () => {
        if (overviewInFlight.current?.promise === promise) {
          overviewInFlight.current = null;
        }
      },
      () => {
        if (overviewInFlight.current?.promise === promise) {
          overviewInFlight.current = null;
        }
      },
    );
    return promise;
  }, []);

  const refreshList = useCallback(async () => {
    if (listInFlight.current) return listInFlight.current;
    const requestId = ++listRequest.current;
    const promise = (async () => {
      try {
        const list = await listSessions();
        if (requestId === listRequest.current) {
          setSessions(list);
          setSessionsLoaded(true);
          setSessionsError(null);
        }
        return list;
      } catch (err) {
        if (requestId === listRequest.current) {
          setSessionsError(errorMessage(err, "加载会话列表失败"));
        }
        throw err;
      }
    })();
    listInFlight.current = promise;
    void promise.then(
      () => {
        if (listInFlight.current === promise) listInFlight.current = null;
      },
      () => {
        if (listInFlight.current === promise) listInFlight.current = null;
      },
    );
    return promise;
  }, []);

  const refreshSession = useCallback(async (id: string) => {
    const active = sessionInFlight.current;
    if (active?.id === id && active.requestId === sessionRequest.current) {
      return active.promise;
    }
    const requestId = ++sessionRequest.current;
    setSessionLoad((current) =>
      current?.id === id && current.status === "error"
        ? current
        : { id, status: "loading" },
    );
    const promise = (async () => {
      try {
        const snap = await getSession(id);
        if (
          requestId === sessionRequest.current &&
          selectedIdRef.current === id
        ) {
          setSnapshot(snap);
          setSessionLoad({ id, status: "ready" });
        }
        return snap;
      } catch (err) {
        if (
          requestId !== sessionRequest.current ||
          selectedIdRef.current !== id
        ) {
          return;
        }
        if (isNotFound(err)) {
          setSnapshot(null);
          setSessionLoad({ id, status: "missing" });
          return;
        }
        setSessionLoad({ id, status: "error" });
        // Keep the last known detail visible while a live/periodic refresh is
        // temporarily unavailable. Clearing it makes a transient network or
        // backend error look like the user lost their selection.
      }
    })();
    sessionInFlight.current = { id, requestId, promise };
    void promise.then(
      () => {
        if (sessionInFlight.current?.promise === promise) {
          sessionInFlight.current = null;
        }
      },
      () => {
        if (sessionInFlight.current?.promise === promise) {
          sessionInFlight.current = null;
        }
      },
    );
    return promise;
  }, []);

  useEffect(() => {
    void refreshOverview().catch(() => undefined);
  }, [range, now, refreshOverview]);

  useEffect(() => {
    void refreshList().catch(() => undefined);
    const currentId = selectedIdRef.current;
    if (currentId && viewRef.current === "sessions") {
      void refreshSession(currentId).catch(() => undefined);
    }
  }, [now, refreshList, refreshSession]);

  useEffect(() => {
    if (view !== "sessions") return;
    const preferredId = preferredSessionIdRef.current;
    if (preferredId) {
      if (!sessionsLoaded) return;
      preferredSessionIdRef.current = null;
    }
    const nextId = resolveSelectedSession(selectedId, visibleSessions);
    if (nextId === selectedId) return;
    setSelectedId(nextId);
    setSelectedNodeId(null);
    setContextOpen(null);
    if (!nextId) setSnapshot(null);
  }, [visibleSessions, sessions, sessionsLoaded, selectedId, view]);

  useEffect(() => {
    if (selectedId && view === "sessions") {
      void refreshSession(selectedId).catch(() => undefined);
    } else {
      // Invalidate a request for the previous selection when leaving the
      // detail view. `refreshSession` performs the invalidation itself when a
      // new selection is loaded, so doing it before that call would also
      // invalidate a request that is about to be coalesced.
      sessionRequest.current += 1;
      if (!selectedId) setSnapshot(null);
    }
  }, [selectedId, refreshSession, view]);

  useEffect(() => {
    return openStream((event) => {
      const banner = streamErrorBanner(event);
      if (banner) setAppError(banner);
      void refreshOverview().catch(() => undefined);
      void refreshList().catch(() => undefined);
      const currentId = selectedIdRef.current;
      if (currentId && viewRef.current === "sessions") {
        void refreshSession(currentId).catch(() => undefined);
      }
    }, setStreamStatus);
  }, [refreshList, refreshOverview, refreshSession]);

  function openImportedSession(snap: SessionSnapshot) {
    if (viewRef.current !== "sessions")
      pushSessionNavigation({
        view: "sessions",
        selectedId: snap.id,
        range: "all",
      });
    sessionRequest.current += 1;
    preferredSessionIdRef.current = snap.id;
    selectedIdRef.current = snap.id;
    rangeRef.current = "all";
    setRange("all");
    setView("sessions");
    setSelectedId(snap.id);
    setSelectedNodeId(null);
    setSnapshot(snap);
    setContextOpen(null);
    setAppError(null);
    setSessionLoad({ id: snap.id, status: "ready" });
  }

  async function handleImport(file: File) {
    if (importInFlight.current) return;
    importInFlight.current = true;
    setImportStatus({ state: "pending", filename: file.name });
    try {
      const { filename, text } = await readDroppedFile(file);
      const snap = await importNdjson(filename, text);
      importedSnapshot.current = snap;
      // A list read started before the import must not erase the confirmed record.
      listRequest.current += 1;
      listInFlight.current = null;
      setSessions((current) => [
        sessionSummary(snap),
        ...current.filter((session) => session.id !== snap.id),
      ]);
      setSessionsLoaded(true);
      writeSessionListState({
        query: "",
        limit: SESSION_PAGE_SIZE,
        scrollTop: 0,
      });
      if (viewRef.current === "sessions") openImportedSession(snap);
      setImportStatus({ state: "success", filename });
      void refreshList().catch(() => undefined);
      void refreshOverview().catch(() => undefined);
    } catch (err) {
      setImportStatus({
        state: "error",
        filename: file.name,
        message: errorMessage(err, "导入失败"),
      });
    } finally {
      importInFlight.current = false;
    }
  }

  function handleSelectSession(id: string) {
    preferredSessionIdRef.current = null;
    setSelectedId(id);
    setSelectedNodeId(null);
    setContextOpen(null);
  }

  function handleInspectContext(id: string, bucket: "tools" | "skills") {
    preferredSessionIdRef.current = null;
    setSelectedId(id);
    setSelectedNodeId(null);
    setContextOpen(bucket);
  }

  const overviewState = overviewDisplayState({
    requestedRange: range,
    appliedRange,
    hasOverview: overview != null,
    error: overviewError,
  });

  function openSessions() {
    const nextId = resolveSelectedSession(selectedId, visibleSessions);
    if (view !== "sessions")
      pushSessionNavigation({ view: "sessions", selectedId: nextId, range });
    setView("sessions");
    setSelectedId(nextId);
  }

  function navigate(event: React.MouseEvent<HTMLAnchorElement>, next: View) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (next === view) return;
    if (next === "sessions") openSessions();
    else {
      pushSessionNavigation({ view: "overview", selectedId, range });
      setView("overview");
    }
  }

  useEffect(() => {
    const page = view === "overview" ? "成本总览" : "会话明细";
    document.title = `${page}${view === "overview" && overviewState === "error" ? " · 加载失败" : ""} · Token Analyser`;
  }, [view, overviewState]);

  return (
    <UnitProvider unit={unit} setUnit={setUnit}>
      <div className="app">
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
            contentRef.current?.scrollIntoView({ block: "start" });
          }}
        >
          跳到主要内容
        </a>
        <header className="app-header">
          <div className="header-primary">
            <div className="brand">
              <LedgerMark />
              <div>
                <p className="brand-name">Token Analyser</p>
                <p className="crumb">Codex 本地用量账本</p>
              </div>
            </div>
            <nav className="nav-pills primary-nav" aria-label="视图">
              <a
                href="#overview"
                className={view === "overview" ? "active" : ""}
                aria-current={view === "overview" ? "page" : undefined}
                onClick={(event) => navigate(event, "overview")}
              >
                <Icon name="overview" />
                成本总览
              </a>
              <a
                href="#sessions"
                className={view === "sessions" ? "active" : ""}
                aria-current={view === "sessions" ? "page" : undefined}
                onClick={(event) => navigate(event, "sessions")}
              >
                <Icon name="sessions" />
                会话明细
              </a>
            </nav>
          </div>
          <div className="header-right">
            <div className="status-pills" role="status" aria-live="polite">
              <span>
                <i
                  className={`dot ${streamStatus === "open" ? "live" : streamStatus === "error" ? "err" : "idle"}`}
                />
                {STREAM_LABEL[streamStatus]}
              </span>
            </div>
            <div className="header-controls">
              <RangeSwitcher range={range} onChange={setRange} />
              <UnitSwitcher />
            </div>
          </div>
        </header>
        {view === "overview" && importStatus && (
          <div className="app-notice">
            <Notice
              tone={
                importStatus.state === "pending" ? "info" : importStatus.state
              }
              action={
                importStatus.state === "success" && (
                  <Button
                    onClick={() => {
                      if (importedSnapshot.current)
                        openImportedSession(importedSnapshot.current);
                    }}
                  >
                    查看导入的会话
                  </Button>
                )
              }
            >
              {importStatus.state === "pending"
                ? `正在导入 ${importStatus.filename}，可以继续浏览总览。`
                : importStatus.state === "success"
                  ? `已导入 ${importStatus.filename}。`
                  : `${importStatus.filename}：${importStatus.message}`}
            </Notice>
          </div>
        )}
        {appError && (
          <div className="app-notice">
            <Notice
              tone="error"
              action={
                <Button emphasis="ghost" onClick={() => setAppError(null)}>
                  关闭
                </Button>
              }
            >
              {appError}
            </Notice>
          </div>
        )}
        <div
          ref={contentRef}
          id="main-content"
          className="app-content"
          tabIndex={-1}
        >
          {view === "overview" ? (
            overviewState === "ready" && overview ? (
              <OverviewPage
                overview={overview}
                onOpenSessions={openSessions}
                refreshError={overviewError != null}
                onRetry={() => void refreshOverview().catch(() => undefined)}
                rangeLabel={
                  range === "all"
                    ? `${rangeLabel}（趋势为近 30 个本地日）`
                    : rangeLabel
                }
              />
            ) : overviewState === "error" ? (
              <main className="overview">
                <StatePanel
                  kind="error"
                  title="总览加载失败"
                  description="请确认本地引擎正在运行。你的会话记录不会丢失。"
                >
                  <Button
                    onClick={() =>
                      void refreshOverview().catch(() => undefined)
                    }
                  >
                    <Icon name="refresh" />
                    重试
                  </Button>
                </StatePanel>
              </main>
            ) : (
              <main className="overview">
                <StatePanel
                  kind="loading"
                  title="正在汇总本地用量"
                  description={`${rangeLabel} · 首次读取较大的会话记录可能需要一些时间。`}
                />
              </main>
            )
          ) : (
            <div className="layout">
              <SessionList
                sessions={visibleSessions}
                totalCount={sessions.length}
                selectedId={selectedId}
                contextOpen={contextOpen}
                onSelect={handleSelectSession}
                onInspectContext={handleInspectContext}
                onImport={handleImport}
                importStatus={importStatus}
                loaded={sessionsLoaded}
                error={sessionsError}
                onRetry={() => void refreshList().catch(() => undefined)}
              />
              <main className="main-panel">
                {snapshot && selectedId === snapshot.id ? (
                  <>
                    {sessionLoad?.id === selectedId &&
                      sessionLoad.status === "error" && (
                        <Notice
                          tone="error"
                          action={
                            <Button
                              onClick={() => void refreshSession(selectedId)}
                            >
                              重试
                            </Button>
                          }
                        >
                          会话更新失败，当前显示上次成功读取的数据。
                        </Notice>
                      )}
                    <SessionView
                      key={snapshot.id}
                      snapshot={snapshot}
                      selectedNodeId={selectedNodeId}
                      onSelectNode={setSelectedNodeId}
                      onUpdate={(next) =>
                        setSnapshot((current) =>
                          current?.id === next.id ? next : current,
                        )
                      }
                      contextOpen={contextOpen}
                      onContextOpen={setContextOpen}
                    />
                  </>
                ) : selectedId &&
                  sessionLoad?.id === selectedId &&
                  sessionLoad.status === "missing" ? (
                  <StatePanel
                    kind="missing"
                    title="找不到这个会话"
                    description="记录可能已移动或删除。刷新列表，或选择其他会话。"
                  >
                    <Button
                      onClick={() => void refreshList().catch(() => undefined)}
                    >
                      刷新列表
                    </Button>
                  </StatePanel>
                ) : selectedId &&
                  sessionLoad?.id === selectedId &&
                  sessionLoad.status === "error" ? (
                  <StatePanel
                    kind="error"
                    title="会话加载失败"
                    description="请确认本地引擎正在运行，然后重试。"
                  >
                    <Button onClick={() => void refreshSession(selectedId)}>
                      重试
                    </Button>
                  </StatePanel>
                ) : !sessionsLoaded && sessionsError ? (
                  <StatePanel
                    kind="error"
                    title="暂时无法读取会话"
                    description="请确认本地引擎正在运行，再刷新会话列表。"
                  >
                    <Button
                      onClick={() => void refreshList().catch(() => undefined)}
                    >
                      刷新列表
                    </Button>
                  </StatePanel>
                ) : selectedId || !sessionsLoaded ? (
                  <StatePanel
                    kind="loading"
                    title="正在读取会话明细"
                    description="会话列表仍可操作，可以继续选择其他会话。"
                  />
                ) : (
                  <StatePanel
                    kind="empty"
                    title="选择一个会话查看费用。"
                    description={
                      sessions.length > 0
                        ? "当前时间范围没有会话，可以切换为全部时间。"
                        : "运行 Codex 或导入 JSONL 记录，开始查看用量。"
                    }
                  >
                    {sessions.length > 0 && (
                      <Button onClick={() => setRange("all")}>
                        查看全部时间
                      </Button>
                    )}
                  </StatePanel>
                )}
              </main>
            </div>
          )}
        </div>
        <footer className="app-footer">
          <span>
            <Icon name="shield" /> 数据仅在本机处理
          </span>
          <span>只读分析 · 不会修改原始会话记录</span>
        </footer>
      </div>
    </UnitProvider>
  );
}

export function App() {
  return (
    <NowProvider>
      <AppShell />
    </NowProvider>
  );
}
