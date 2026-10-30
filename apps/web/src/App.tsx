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
  updateModelPrices as requestModelPriceUpdate,
} from "./api";
import { errorMessage, isNotFound, streamErrorBanner } from "./app-errors";
import { UnitProvider, useUnit } from "./UnitContext";
import {
  formatCompactTokens,
  formatCost,
  formatCostTokens,
  formatPercent,
  type CostUnit,
} from "./format";
import { OverviewPage } from "./OverviewPage";
import { HardwarePowerPage } from "./HardwarePowerPage";
import { RangeSwitcher } from "./RangeSwitcher";
import { SessionList } from "./SessionList";
import { SourceSwitcher } from "./SourceSwitcher";
import {
  filterSessionsBySource,
  sourceCounts,
  sourceEmptyCopy,
  SESSION_SOURCES,
  type SessionSourceFilter,
} from "./session-source";
import { SessionView } from "./SessionView";
import { UnitSwitcher } from "./UnitSwitcher";
import { NowProvider, useNow } from "./useNow";
import { readUnitPref, writeUnitPref } from "./unit-pref";
import { SESSION_PAGE_SIZE, resolveSelectedSession } from "./session-page";
import { readDroppedFile, type ImportStatus } from "./import-file";
import { pricingUpdateNotice as buildPricingUpdateNotice } from "./pricing-notice";
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
  previousWindow,
  type SessionRangeId,
} from "./session-range";

type View = SessionNavigationView;
type PricingUpdateNotice = {
  tone: "info" | "warning" | "error" | "success";
  message: string;
};

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
  const [previousOverview, setPreviousOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [appliedScope, setAppliedScope] = useState<string | null>(null);
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
  const [mobileSessionPane, setMobileSessionPane] = useState<"list" | "detail">("list");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [range, setRange] = useState<SessionRangeId>(initialNavigation.range);
  const [source, setSource] = useState<SessionSourceFilter>(
    initialNavigation.source,
  );
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [appError, setAppError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [pricingUpdateNotice, setPricingUpdateNotice] =
    useState<PricingUpdateNotice | null>(null);
  const [updatingModelPrices, setUpdatingModelPrices] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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
    scope: string;
    promise: Promise<Overview>;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const mobileContextTarget = useRef(false);
  const previousView = useRef(view);
  const selectedIdRef = useRef<string | null>(null);
  const preferredSessionIdRef = useRef<string | null>(
    initialNavigation.view === "sessions" ? initialNavigation.selectedId : null,
  );
  const viewRef = useRef<View>(view);
  const rangeRef = useRef<SessionRangeId>(range);
  const sourceRef = useRef<SessionSourceFilter>(source);
  selectedIdRef.current = selectedId;
  viewRef.current = view;
  rangeRef.current = range;
  sourceRef.current = source;

  useEffect(() => {
    writeUnitPref(unit);
  }, [unit]);

  useEffect(() => {
    if (view !== "sessions" || mobileSessionPane !== "detail" ||
        !window.matchMedia("(max-width: 780px)").matches) return;
    const frame = requestAnimationFrame(() => {
      // Context shortcuts have their own scroll/focus target in SessionView.
      if (mobileContextTarget.current) return;
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, mobileSessionPane]);

  useEffect(() => {
    writeSessionNavigation({ view, selectedId, range, source });
  }, [selectedId, view, range, source]);

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    window.scrollTo(0, 0);
    const frame = requestAnimationFrame(() => {
      const selector = view === "sessions" && mobileSessionPane === "list" &&
        window.matchMedia("(max-width: 780px)").matches
        ? ".session-list h2" : "h1";
      const heading = contentRef.current?.querySelector<HTMLElement>(selector);
      (heading ?? contentRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, mobileSessionPane]);

  useEffect(() => {
    function restoreNavigation() {
      mobileContextTarget.current = false;
      const next = readSessionNavigation();
      preferredSessionIdRef.current = next.selectedId;
      setView(next.view);
      setSelectedId(next.selectedId);
      setRange(next.range);
      setSource(next.source);
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
      setContextOpen(null);
      setMobileSessionPane("list");
      requestAnimationFrame(() => document.getElementById("session-search")?.focus());
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matchingSource = useMemo(
    () => filterSessionsBySource(sessions, source),
    [sessions, source],
  );
  const counts = useMemo(() => sourceCounts(sessions), [sessions]);
  const visibleSessions = useMemo(
    () => filterSessionsByRange(matchingSource, range, now),
    [matchingSource, range, now],
  );
  const rangeLabel =
    SESSION_RANGES.find((item) => item.id === range)?.label ?? range;

  const fetchOverviewForModel = useCallback(
    (model: string) => getOverview(range, now, source, undefined, model),
    [range, now, source],
  );

  const refreshOverview = useCallback(async (force = false) => {
    const requestedRange = rangeRef.current;
    const requestedSource = sourceRef.current;
    const requestedScope = `${requestedSource}:${requestedRange}`;
    const active = overviewInFlight.current;
    if (!force && active?.scope === requestedScope) return active.promise;
    const requestId = ++overviewRequest.current;
    setOverviewError(null);
    const requestedAt = Date.now();
    const promise = (async () => {
      try {
        const data = await getOverview(requestedRange, requestedAt, requestedSource);
        if (requestId !== overviewRequest.current) return data;
        setOverview(data);
        setAppliedScope(requestedScope);
        setPreviousOverview(null);
        setOverviewError(null);
        // The ledger strip compares the window with the equal-length window
        // right before it. 全部 has no previous window, so nothing is guessed.
        const comparison = previousWindow(requestedRange, requestedAt);
        if (comparison)
          void getOverview(
            requestedRange,
            requestedAt,
            requestedSource,
            comparison,
          )
            .then((data2) => {
              if (requestId === overviewRequest.current) setPreviousOverview(data2);
            })
            .catch(() => {
              if (requestId === overviewRequest.current) setPreviousOverview(null);
            });
        return data;
      } catch (err) {
        if (requestId !== overviewRequest.current) throw err;
        setOverviewError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    })();
    overviewInFlight.current = { scope: requestedScope, promise };
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

  const refreshList = useCallback(async (force = false) => {
    if (!force && listInFlight.current) return listInFlight.current;
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
        // backend error look like the user lost their selection. Still reject
        // so callers that await success (price update) can warn honestly.
        throw err;
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

  const updateModelPrices = useCallback(async () => {
    setUpdatingModelPrices(true);
    setPricingUpdateNotice({
      tone: "info",
      message: "正在从 OpenAI Codex 与千问官方价格页读取模型价格…",
    });
    try {
      const result = await requestModelPriceUpdate();
      const openSessionId = selectedIdRef.current;
      const detailRefresh =
        openSessionId && viewRef.current === "sessions"
          ? refreshSession(openSessionId).then(
              () => true,
              () => false,
            )
          : Promise.resolve(true);
      const [overviewRefreshed, sessionsRefreshed, detailRefreshed] =
        await Promise.all([
          refreshOverview(true).then(
            () => true,
            () => false,
          ),
          refreshList(true).then(
            () => true,
            () => false,
          ),
          detailRefresh,
        ]);
      setPricingUpdateNotice(
        buildPricingUpdateNotice(
          result,
          !overviewRefreshed
            ? "none"
            : !sessionsRefreshed
              ? "overview"
              : !detailRefreshed
                ? "detail"
                : "all",
        ),
      );
    } catch (error) {
      setPricingUpdateNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "模型价格更新失败。",
      });
    } finally {
      setUpdatingModelPrices(false);
    }
  }, [refreshList, refreshOverview, refreshSession]);

  useEffect(() => {
    void refreshOverview().catch(() => undefined);
  }, [range, source, now, refreshOverview]);

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
    mobileContextTarget.current = false;
    if (viewRef.current !== "sessions")
      pushSessionNavigation({
        view: "sessions",
        selectedId: snap.id,
        range: "all",
        source: snap.source ?? "codex",
      });
    sessionRequest.current += 1;
    preferredSessionIdRef.current = snap.id;
    selectedIdRef.current = snap.id;
    rangeRef.current = "all";
    sourceRef.current = snap.source ?? "codex";
    setRange("all");
    setSource(snap.source ?? "codex");
    setView("sessions");
    setMobileSessionPane("detail");
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
    mobileContextTarget.current = false;
    preferredSessionIdRef.current = null;
    if (view !== "sessions") {
      pushSessionNavigation({ view: "sessions", selectedId: id, range, source });
      setView("sessions");
    }
    setSelectedId(id);
    setSelectedNodeId(null);
    setContextOpen(null);
    setMobileSessionPane("detail");
  }

  function returnToSessionList() {
    setContextOpen(null);
    setMobileSessionPane("list");
    requestAnimationFrame(() => {
      const selected = contentRef.current?.querySelector<HTMLElement>(
        '.session-main[aria-pressed="true"]',
      );
      const target = selected ?? contentRef.current?.querySelector<HTMLElement>(".session-list");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    });
  }

  function handleSourceChange(next: SessionSourceFilter) {
    if (next === source) return;
    const nextId = resolveSelectedSession(
      null,
      filterSessionsByRange(filterSessionsBySource(sessions, next), range, now),
    );
    pushSessionNavigation({ view, selectedId: nextId, range, source: next });
    writeSessionListState({ query: "", limit: SESSION_PAGE_SIZE, scrollTop: 0 });
    sourceRef.current = next;
    preferredSessionIdRef.current = null;
    setSource(next);
    setSelectedId(nextId);
    setSelectedNodeId(null);
    setContextOpen(null);
    setMobileSessionPane("list");
  }

  function handleInspectContext(id: string, bucket: "tools" | "skills") {
    mobileContextTarget.current = true;
    preferredSessionIdRef.current = null;
    setSelectedId(id);
    setSelectedNodeId(null);
    setContextOpen(bucket);
    setMobileSessionPane("detail");
  }

  const overviewState = overviewDisplayState({
    requestedRange: `${source}:${range}`,
    appliedRange: appliedScope,
    hasOverview: overview != null,
    error: overviewError,
  });

  function refreshAll() {
    setRefreshing(true);
    void Promise.all([
      refreshOverview(true),
      refreshList(true),
      selectedId ? refreshSession(selectedId) : Promise.resolve(),
    ])
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }

  function inspectSlice(key: string, label: string) {
    // The overview ranking answers "which sessions did this"; the session list
    // is the only surface that can answer it, so hand the question over.
    openSessions();
    setAppError(`已切到会话明细：按「${label}」查看会话，可在列表里搜索关键词。`);
    void key;
  }

  function openSessions() {
    mobileContextTarget.current = false;
    setContextOpen(null);
    const nextId = resolveSelectedSession(selectedId, visibleSessions);
    if (view !== "sessions")
      pushSessionNavigation({ view: "sessions", selectedId: nextId, range, source });
    setView("sessions");
    setMobileSessionPane("list");
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
      pushSessionNavigation({ view: next, selectedId, range, source });
      setView(next);
    }
  }

  useEffect(() => {
    const page =
      view === "overview" ? "成本总览" : view === "sessions" ? "会话明细" : "硬件用电";
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
        <header className="app-header" data-layout="workspace">
          <div className="header-primary">
            <div className="brand">
              <LedgerMark />
              <div>
                <p className="brand-name">Token Analyser</p>
                <p className="crumb">AI 用量工作台</p>
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
              <a
                href="#power"
                className={view === "power" ? "active" : ""}
                aria-current={view === "power" ? "page" : undefined}
                onClick={(event) => navigate(event, "power")}
              >
                <Icon name="power" />
                硬件用电
              </a>
            </nav>
          </div>
          <div className="header-right app-tools">
            <div className="status-pills" role="status" aria-live="polite">
              <span>
                <i
                  className={`dot ${streamStatus === "open" ? "live" : streamStatus === "error" ? "err" : "idle"}`}
                />
                {STREAM_LABEL[streamStatus]}
              </span>
            </div>
            <Button
              className="refresh-button"
              busy={refreshing}
              onClick={refreshAll}
            >
              <Icon name="refresh" /> 刷新
            </Button>
            <span className="local-label"><Icon name="shield" /> 本地运行</span>
          </div>
        </header>
        {view !== "power" && (
        <Button
          className="mobile-filter-toggle"
          emphasis="ghost"
          aria-label={filtersOpen ? "收起筛选" : "展开筛选"}
          aria-expanded={filtersOpen}
          aria-controls="workspace-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <span className="mobile-filter-summary">
            {SESSION_SOURCES.find((item) => item.id === source)?.label} · {rangeLabel} · {unit === "tokens" ? "Tokens" : unit === "credits" ? "Credits" : "USD"}
          </span>
          <span className="mobile-filter-action">筛选 <Icon name="chevron" /></span>
        </Button>
        )}
        {view !== "power" && (
        <div id="workspace-filters" className="workspace-filters" data-expanded={filtersOpen}>
        <SourceSwitcher
          source={source}
          counts={counts}
          loaded={sessionsLoaded}
          visibleCount={visibleSessions.length}
          rangeLabel={rangeLabel}
          onChange={handleSourceChange}
          onShowAllTime={() => setRange("all")}
        />
          <div className="scope-controls">
            <div className="filter-field">
              <span className="filter-label"><Icon name="clock" /> 时间范围</span>
              <RangeSwitcher range={range} onChange={setRange} />
            </div>
            <div className="filter-field">
              <span className="filter-label">显示单位</span>
              <UnitSwitcher />
            </div>
          </div>
        </div>
        )}
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
          {view === "power" ? (
            <HardwarePowerPage now={now} />
          ) : view === "overview" ? (
            overviewState === "ready" && overview ? (
              <div className="layout overview-layout">
                <OverviewPage
                  overview={overview}
                  previous={previousOverview}
                  previousLabel={
                    range === "all"
                      ? null
                      : `上一 ${rangeLabel}`
                  }
                  onOpenSessions={openSessions}
                  onUpdateModelPrices={() => void updateModelPrices()}
                  updatingModelPrices={updatingModelPrices}
                  pricingUpdateNotice={pricingUpdateNotice}
                  refreshError={overviewError != null}
                  onRetry={() => void refreshOverview().catch(() => undefined)}
                  onInspectSlice={inspectSlice}
                  rangeLabel={
                    range === "all"
                      ? `${rangeLabel}（趋势为近 30 个本地日）`
                      : rangeLabel
                  }
                  filterScope={`${source}:${range}:${overview.sessionCount}:${overview.turnCount}:${overview.cost.raw}`}
                  fetchOverviewForModel={fetchOverviewForModel}
                />
                <OverviewRail
                  overview={overview}
                  topSessions={[...visibleSessions]
                    .sort((a, b) => b.cost.raw - a.cost.raw)
                    .slice(0, 5)}
                  onSelectSession={handleSelectSession}
                  onOpenSessions={openSessions}
                  watchPath={overview.watchPath}
                />
              </div>
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
            <div className="layout sessions-layout" data-mobile-pane={mobileSessionPane}>
              <SessionList
                key={source}
                source={source}
                sessions={visibleSessions}
                totalCount={matchingSource.length}
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
              <main className="main-panel" ref={detailRef} tabIndex={-1} aria-label="会话详情">
                <Button className="mobile-session-return" onClick={returnToSessionList}>
                  <Icon name="arrow" /> 返回会话列表
                </Button>
                {snapshot && selectedId === snapshot.id ? (
                  <>
                    {sessionLoad?.id === selectedId &&
                      sessionLoad.status === "error" && (
                        <Notice
                          tone="error"
                          action={
                            <Button
                              onClick={() =>
                                void refreshSession(selectedId).catch(
                                  () => undefined,
                                )
                              }
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
                    <Button
                      onClick={() =>
                        void refreshSession(selectedId).catch(() => undefined)
                      }
                    >
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
                      matchingSource.length > 0
                        ? "当前时间范围没有会话，可以切换为全部时间。"
                        : sourceEmptyCopy(source)
                    }
                  />
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

/**
 * The overview rail answers "is this number trustworthy, and which sessions are
 * biggest" without leaving the page. It is supporting context, so it collapses
 * away on narrow screens.
 */
function OverviewRail({
  overview,
  topSessions,
  onSelectSession,
  onOpenSessions,
  watchPath,
}: {
  overview: Overview;
  topSessions: SessionListItem[];
  onSelectSession: (id: string) => void;
  onOpenSessions: () => void;
  watchPath: string;
}) {
  const { unit } = useUnit();
  const quality = overview.quality;
  const issueCount =
    (quality?.ledgerWarningSessions ?? 0) + (quality?.parseErrors ?? 0);
  const coverage =
    overview.cost.raw > 0 && quality
      ? formatPercent((100 * quality.pricedRaw) / overview.cost.raw)
      : null;
  const max = Math.max(...topSessions.map((session) => session.cost.raw), 1);
  return (
    <aside className="rail overview-rail" aria-label="总览侧栏" tabIndex={-1}>
      <div className="rail-panel">
        <h2 className="rail-title">账本状态</h2>
        <div className="dq-list">
          <div className={`dq ${overview.unpricedRaw > 0 ? "warn" : "ok"}`}>
            <span className="dot" aria-hidden="true" />
            <div>
              <b>
                {overview.unpricedRaw > 0
                  ? "部分用量未定价"
                  : "定价覆盖完整"}
              </b>
              <span>
                {overview.unpricedRaw > 0
                  ? `${formatCompactTokens(overview.unpricedRaw)} tokens 未计入费用`
                  : coverage == null
                    ? "该范围没有用量"
                    : `定价覆盖 ${coverage}`}
              </span>
            </div>
          </div>
          <div className={`dq ${issueCount > 0 ? "warn" : "ok"}`}>
            <span className="dot" aria-hidden="true" />
            <div>
              <b>{issueCount > 0 ? `${issueCount} 项异常需核对` : "账本校验通过"}</b>
              <span>
                解析错误 {quality?.parseErrors ?? 0} · 账本警告{" "}
                {quality?.ledgerWarningSessions ?? 0}
              </span>
            </div>
          </div>
          <div className="dq">
            <span className="dot" aria-hidden="true" />
            <div>
              <b>{overview.live ? "有实时会话" : "静态账本"}</b>
              <span>
                {overview.collecting ? "正在采集本地会话" : "未开启自动采集"} ·{" "}
                {overview.sessionCount.toLocaleString("en-US")} 个会话
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="rail-panel">
        <h2 className="rail-title">范围 Top 会话</h2>
        {topSessions.length === 0 ? (
          <p className="empty-copy">该范围内没有会话。</p>
        ) : (
          <div className="rail-ranks">
            {topSessions.map((session, index) => (
              <button
                type="button"
                className="rail-rank"
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                title={`查看 ${session.nickname ?? session.id} 的费用明细`}
              >
                <span className="rk">{index + 1}</span>
                <span className="rail-rank-main">
                  <span className="rail-rank-top">
                    <span className="rail-rank-name">
                      {session.nickname ?? session.id}
                    </span>
                    <span className="num">
                      {unit === "tokens"
                        ? formatCostTokens(session.cost)
                        : formatCost(session.cost, unit)}
                    </span>
                  </span>
                  <span className="rail-rank-bar">
                    <i
                      style={{
                        width: `${(100 * session.cost.raw) / max}%`,
                      }}
                    />
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        <Button className="rail-more" onClick={onOpenSessions}>
          查看全部会话 <Icon name="arrow" />
        </Button>
      </div>
      <div className="rail-panel">
        <h2 className="rail-title">数据源</h2>
        <p className="rail-meta">采集目录：{watchPath}</p>
        <p className="rail-meta">
          时区：{Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区"}
        </p>
        <p className="rail-meta">价格快照：{overview.rateCardAsOf}</p>
      </div>
    </aside>
  );
}

export function App() {
  return (
    <NowProvider>
      <AppShell />
    </NowProvider>
  );
}
