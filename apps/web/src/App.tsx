import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bindSessionEnvironment,
  deleteSession,
  getBehaviorSessions,
  getOverview,
  getSession,
  importNdjson,
  listSessions,
  openStream,
  sessionSummary,
  type EnvironmentSync,
  type IndexProgress,
  type Overview,
  type SessionListItem,
  type SessionSnapshot,
  type StreamStatus,
  updateModelPrices as requestModelPriceUpdate,
} from "./api";
import { EnvironmentSwitcher } from "./EnvironmentSwitcher";
import {
  environmentLabel,
  type SessionEnvironmentId,
} from "./session-environment";
import { errorMessage, isNotFound, streamErrorBanner } from "./app-errors";
import { UnitProvider, useUnit } from "./UnitContext";
import {
  costValue,
  formatAbsoluteTime,
  formatCost,
  formatCostTokens,
  type CostUnit,
} from "./format";
import { OverviewPage } from "./OverviewPage";
import { HardwarePage, type HardwareTopMeta } from "./HardwarePage";
import { RangeSwitcher } from "./RangeSwitcher";
import { SessionList } from "./SessionList";
import { SourceSwitcher } from "./SourceSwitcher";
import {
  filterSessionsBySource,
  sourceColor,
  sourceCounts,
  sourceEmptyCopy,
  SESSION_SOURCES,
  type SessionSourceFilter,
} from "./session-source";
import { SLICE_META, type SliceKey } from "./buckets";
import { UnitSwitcher } from "./UnitSwitcher";
import { NowProvider, useNow } from "./useNow";
import { readUnitPref, writeUnitPref } from "./unit-pref";
import {
  applyTheme,
  readThemePref,
  writeThemePref,
  type ThemePref,
} from "./theme-pref";
import { withViewTransition } from "./view-transition";
import { SESSION_PAGE_SIZE, resolveSelectedSession } from "./session-page";
import { readDroppedFile, type ImportStatus } from "./import-file";
import { pricingUpdateNotice as buildPricingUpdateNotice } from "./pricing-notice";
import { overviewDisplayState } from "./overview-state";
import { LegacyBadge as Badge } from "@/components/ui/legacy-badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  BareButton,
  Button,
  Icon,
  LedgerMark,
  Notice,
  Panel,
  StatePanel,
} from "./ui";
import {
  readSessionNavigation,
  pushSessionNavigation,
  writeSessionListState,
  writeSessionNavigation,
  type HardwareTab,
  type SessionNavigationView,
} from "./session-navigation";
import {
  SESSION_RANGES,
  filterSessionsByRange,
  filterSessionsByDay,
  previousWindow,
  type SessionRangeId,
} from "./session-range";

const SessionView = lazy(() => import("./SessionView").then((module) => ({ default: module.SessionView })));

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

const SIDEBAR_COLLAPSED_KEY = "token-analyser:sidebar-collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function AppShell() {
  const now = useNow();
  const [initialNavigation] = useState(readSessionNavigation);
  const [view, setView] = useState<View>(initialNavigation.view);
  const [hardwareTab, setHardwareTab] = useState<HardwareTab>(
    initialNavigation.hardwareTab ?? "temps",
  );
  const [unit, setUnit] = useState<CostUnit>(readUnitPref);
  const [theme, setTheme] = useState<ThemePref>(readThemePref);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [previousOverview, setPreviousOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [appliedScope, setAppliedScope] = useState<string | null>(null);
  const [appliedAt, setAppliedAt] = useState(now);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [listIndexing, setListIndexing] = useState<IndexProgress | null>(null);
  const [remoteSync, setRemoteSync] = useState<EnvironmentSync | null>(null);
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
  const [dayFilter, setDayFilter] = useState<string | null>(initialNavigation.day ?? null);
  const [behavior, setBehavior] = useState(initialNavigation.behavior ?? null);
  const [behaviorResult, setBehaviorResult] = useState<{ scope: string; ids: Set<string> } | null>(null);
  const [behaviorError, setBehaviorError] = useState<string | null>(null);
  const [hardwareRefreshKey, setHardwareRefreshKey] = useState(0);
  const [source, setSource] = useState<SessionSourceFilter>(
    initialNavigation.source,
  );
  const [environment, setEnvironment] = useState<SessionEnvironmentId>(
    initialNavigation.environment ?? "local",
  );
  bindSessionEnvironment(environment);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [appError, setAppError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [pricingUpdateNotice, setPricingUpdateNotice] =
    useState<PricingUpdateNotice | null>(null);
  const [updatingModelPrices, setUpdatingModelPrices] = useState(false);
  const [priceSheetOpen, setPriceSheetOpen] = useState(false);
  const [hardwareTopMeta, setHardwareTopMeta] = useState<HardwareTopMeta>({});
  const [refreshing, setRefreshing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const readonlyDialogRef = useRef<HTMLDialogElement>(null);
  const lastDialogTriggerRef = useRef<HTMLElement | null>(null);
  const importInFlight = useRef(false);
  const importedSnapshot = useRef<SessionSnapshot | null>(null);
  const listRequest = useRef(0);
  const sessionRequest = useRef(0);
  /** Bumped by confirmed mutations so older in-flight reads cannot roll them back. */
  const sessionMutationRev = useRef(0);
  const overviewRequest = useRef(0);
  const listInFlight = useRef<{
    environment: SessionEnvironmentId;
    controller: AbortController;
    promise: Promise<SessionListItem[]>;
  } | null>(null);
  const sessionInFlight = useRef<{
    id: string;
    requestId: number;
    controller: AbortController;
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
  const environmentRef = useRef<SessionEnvironmentId>(environment);
  selectedIdRef.current = selectedId;
  viewRef.current = view;
  rangeRef.current = range;
  sourceRef.current = source;
  environmentRef.current = environment;

  useEffect(() => {
    writeUnitPref(unit);
  }, [unit]);

  useEffect(() => {
    applyTheme(theme);
    writeThemePref(theme);
  }, [theme]);

  useEffect(() => {
    // A one-shot class lets surface colors ease once after a theme change;
    // it is removed so ordinary hover/state transitions keep their own timing.
    const root = document.documentElement;
    root.classList.add("theme-crossfade");
    const timer = window.setTimeout(() => root.classList.remove("theme-crossfade"), 260);
    return () => window.clearTimeout(timer);
  }, [theme]);

  useEffect(() => {
    if (view !== "sessions" || mobileSessionPane !== "detail" ||
        !window.matchMedia("(max-width: 780px)").matches) return;
    const frame = requestAnimationFrame(() => {
      // Context shortcuts have their own scroll/focus target in SessionView.
      if (mobileContextTarget.current) return;
      detailRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, mobileSessionPane]);

  useEffect(() => {
    writeSessionNavigation({
      view,
      selectedId,
      range,
      source,
      environment,
      ...(view === "hardware" ? { hardwareTab } : {}),
      ...(view === "sessions" && dayFilter ? { day: dayFilter } : {}),
      ...(view === "sessions" && behavior ? { behavior } : {}),
    });
  }, [selectedId, view, range, source, environment, hardwareTab, dayFilter, behavior]);

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    window.scrollTo(0, 0);
    const frame = requestAnimationFrame(() => {
      const selector = view === "sessions" && mobileSessionPane === "list" &&
        window.matchMedia("(max-width: 780px)").matches
        ? ".session-list h2" : "h1";
      const heading = contentRef.current?.querySelector<HTMLElement>(selector)
        ?? document.querySelector<HTMLElement>(selector);
      (heading ?? contentRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, mobileSessionPane]);

  const changeEnvironment = useCallback((next: SessionEnvironmentId) => {
    if (next === environmentRef.current) return;
    environmentRef.current = next;
    bindSessionEnvironment(next);
    setEnvironment(next);
    listRequest.current += 1;
    listInFlight.current?.controller.abort();
    listInFlight.current = null;
    overviewRequest.current += 1;
    overviewInFlight.current = null;
    sessionRequest.current += 1;
    sessionInFlight.current?.controller.abort();
    sessionInFlight.current = null;
    setSessions([]);
    setSessionsLoaded(false);
    setSessionsError(null);
    setRemoteSync(null);
    setListIndexing(null);
    setOverview(null);
    setPreviousOverview(null);
    setSnapshot(null);
  }, []);

  useEffect(() => {
    function restoreNavigation() {
      withViewTransition(() => {
        mobileContextTarget.current = false;
        const next = readSessionNavigation();
        changeEnvironment(next.environment);
        rangeRef.current = next.range;
        sourceRef.current = next.source;
        selectedIdRef.current = next.selectedId;
        preferredSessionIdRef.current = next.selectedId;
        setDayFilter(next.day ?? null);
        setBehavior(next.behavior ?? null);
        setMobileSessionPane("list");
        setView(next.view);
        setHardwareTab(next.hardwareTab ?? "temps");
        setSelectedId(next.selectedId);
        setRange(next.range);
        setSource(next.source);
        setSelectedNodeId(null);
        setContextOpen(null);
      });
    }
    window.addEventListener("popstate", restoreNavigation);
    return () => window.removeEventListener("popstate", restoreNavigation);
  }, [changeEnvironment]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = undefined;
      setToastMessage(null);
    }, 2400);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      const target = e.target;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      const isSlash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !inEditable;
      const isCmdK = e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !inEditable;
      if (!isSlash && !isCmdK) return;
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
  const behaviorScope = behavior ? `${environment}:${source}:${range}:${behavior.key}:${behavior.asOf}` : null;
  const behaviorIds = behaviorResult?.scope === behaviorScope ? behaviorResult?.ids : undefined;
  const listAsOf = behavior?.asOf ?? (view === "overview" && appliedScope === `${environment}:${source}:${range}` ? appliedAt : now);
  const visibleSessions = useMemo(() => {
    // Behavior evidence comes directly from windowed turns, including children.
    if (behaviorScope) return behaviorIds ? matchingSource.filter((session) => behaviorIds.has(session.id)) : [];
    const ranged = filterSessionsByRange(matchingSource, range, listAsOf);
    return dayFilter ? filterSessionsByDay(ranged, dayFilter) : ranged;
  }, [matchingSource, range, listAsOf, dayFilter, behaviorScope, behaviorIds]);

  useEffect(() => {
    if (!behavior || !behaviorScope || !sessionsLoaded || view !== "sessions") return;
    const controller = new AbortController();
    setBehaviorError(null);
    void getBehaviorSessions(behavior.key, range, behavior.asOf, source, controller.signal)
      .then((ids) => {
        if (!controller.signal.aborted) setBehaviorResult({ scope: behaviorScope, ids: new Set(ids) });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setBehaviorError(errorMessage(error, "加载行为筛选失败"));
      });
    return () => controller.abort();
  }, [behavior, behaviorScope, sessions, sessionsLoaded, view, range, source]);

  const rangeLabel =
    SESSION_RANGES.find((item) => item.id === range)?.label ?? range;

  const fetchOverviewForModel = useCallback(
    (model: string) => getOverview(range, appliedAt, source, undefined, model),
    [range, appliedAt, source, environment],
  );

  const refreshOverview = useCallback(async (force = false) => {
    const requestedRange = rangeRef.current;
    const requestedSource = sourceRef.current;
    const requestedEnv = environmentRef.current;
    const requestedScope = `${requestedEnv}:${requestedSource}:${requestedRange}`;
    const active = overviewInFlight.current;
    if (!force && active?.scope === requestedScope) return active.promise;
    const requestId = ++overviewRequest.current;
    setOverviewError(null);
    const requestedAt = Math.ceil(Date.now() / 15_000) * 15_000;
    const promise = (async () => {
      try {
        const data = await getOverview(
          requestedRange,
          requestedAt,
          requestedSource,
          undefined,
          undefined,
          force,
        );
        if (requestId !== overviewRequest.current) return data;
        setOverview(data);
        setAppliedScope(requestedScope);
        setAppliedAt(requestedAt);
        setPreviousOverview(null);
        setOverviewError(null);
        // The ledger strip compares the window with the equal-length window
        // right before it. 全部 has no previous window, so nothing is guessed.
        const comparison = data.indexing ? null : previousWindow(requestedRange, requestedAt);
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
    const requestedEnv = environmentRef.current;
    const active = listInFlight.current;
    if (!force && active?.environment === requestedEnv) return active.promise;
    active?.controller.abort();
    const controller = new AbortController();
    const requestId = ++listRequest.current;
    const promise = (async () => {
      try {
        const { sessions: list, sync, indexing } = await listSessions({ refresh: force, signal: controller.signal });
        if (requestId === listRequest.current) {
          setSessions(list);
          setSessionsLoaded(!indexing || list.length > 0);
          setSessionsError(null);
          setListIndexing(indexing ?? null);
          setRemoteSync(sync ?? null);
        }
        return list;
      } catch (err) {
        if (requestId === listRequest.current && !controller.signal.aborted) {
          setSessionsError(errorMessage(err, "加载会话列表失败"));
        }
        throw err;
      }
    })();
    listInFlight.current = { environment: requestedEnv, controller, promise };
    function clearFlight() {
      if (listInFlight.current?.promise === promise) listInFlight.current = null;
    }
    void promise.then(clearFlight, clearFlight);
    return promise;
  }, []);

  const refreshSession = useCallback(async (id: string) => {
    const active = sessionInFlight.current;
    if (active?.id === id && active.requestId === sessionRequest.current) {
      return active.promise;
    }
    active?.controller.abort();
    const controller = new AbortController();
    const requestId = ++sessionRequest.current;
    const mutationRev = sessionMutationRev.current;
    setSessionLoad((current) =>
      current?.id === id && current.status === "error"
        ? current
        : { id, status: "loading" },
    );
    const promise = (async () => {
      try {
        const snap = await getSession(id, controller.signal);
        if (
          requestId === sessionRequest.current &&
          selectedIdRef.current === id
        ) {
          // A waste-toggle PATCH may have committed while this read was in
          // flight; its server-confirmed snapshot outranks this older read.
          if (mutationRev === sessionMutationRev.current) {
            setSnapshot(snap);
          }
          setSessionLoad({ id, status: "ready" });
        }
        return snap;
      } catch (err) {
        if (
          requestId !== sessionRequest.current ||
          selectedIdRef.current !== id ||
          mutationRev !== sessionMutationRev.current
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
    sessionInFlight.current = { id, requestId, controller, promise };
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

  const showSessionData = view !== "hardware";
  useEffect(() => {
    if (view === "overview") void refreshOverview().catch(() => undefined);
  }, [range, source, environment, view, refreshOverview]);

  useEffect(() => {
    if (showSessionData) void refreshList().catch(() => undefined);
  }, [environment, showSessionData, refreshList]);

  useEffect(() => {
    if (view !== "overview" || environment !== "local") return;
    const refreshOnResume = () => {
      if (document.visibilityState !== "visible") return;
      void refreshOverview().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", refreshOnResume);
    return () => document.removeEventListener("visibilitychange", refreshOnResume);
  }, [view, environment, refreshOverview]);

  useEffect(() => {
    if (view !== "overview" || environment !== "local" || document.visibilityState === "hidden") return;
    if (range === "all" && new Date(appliedAt).toDateString() === new Date(now).toDateString()) return;
    if (now > appliedAt) void refreshOverview().catch(() => undefined);
  }, [now, appliedAt, range, view, environment, refreshOverview]);

  useEffect(() => {
    if (!sessionsError || !showSessionData) return;
    // A hung engine can keep a request in flight for the full 45s timeout.
    // Wait for each retry to settle so polling cannot stack up a dozen
    // overlapping /sessions requests against a recovering engine.
    let retryInFlight = false;
    const timer = setInterval(() => {
      if (retryInFlight) return;
      retryInFlight = true;
      void refreshList(true).then(
        () => { retryInFlight = false; },
        () => { retryInFlight = false; },
      );
    }, 3_000);
    return () => clearInterval(timer);
  }, [sessionsError, showSessionData, refreshList]);

  useEffect(() => {
    if (view !== "sessions" || (behaviorScope && !behaviorIds)) return;
    const preferredId = preferredSessionIdRef.current;
    if (preferredId) {
      if (!sessionsLoaded || (listIndexing && !visibleSessions.some((item) => item.id === preferredId))) return;
      preferredSessionIdRef.current = null;
    }
    const nextId = resolveSelectedSession(selectedId, visibleSessions);
    if (nextId === selectedId) return;
    setSelectedId(nextId);
    setSelectedNodeId(null);
    setContextOpen(null);
    if (!nextId) setSnapshot(null);
  }, [visibleSessions, sessionsLoaded, selectedId, view, behaviorScope, behaviorIds, listIndexing]);

  useEffect(() => {
    if (selectedId && view === "sessions") {
      void refreshSession(selectedId).catch(() => undefined);
    } else {
      // Invalidate a request for the previous selection when leaving the
      // detail view. `refreshSession` performs the invalidation itself when a
      // new selection is loaded, so doing it before that call would also
      // invalidate a request that is about to be coalesced.
      sessionRequest.current += 1;
      sessionInFlight.current?.controller.abort();
      sessionInFlight.current = null;
      if (!selectedId) setSnapshot(null);
    }
  }, [selectedId, refreshSession, view]);

  useEffect(() => {
    if (!showSessionData || environment !== "local") return;
    let disposed = false;
    let syncing = false;
    let queued = false;
    const pendingIds = new Set<string>();
    let timer: number | undefined;

    async function sync() {
      if (disposed || syncing || !queued || environmentRef.current !== "local") return;
      syncing = true;
      queued = false;
      const changedIds = new Set(pendingIds);
      pendingIds.clear();
      // A connection event can race the initial read. Wait for that read, then
      // apply this event to the latest generation.
      await Promise.allSettled([
        listInFlight.current?.promise,
        overviewInFlight.current?.promise,
        sessionInFlight.current?.promise,
      ]);
      if (!disposed && environmentRef.current === "local") {
        const currentId = selectedIdRef.current;
        const shouldRefreshDetail =
          currentId != null &&
          viewRef.current === "sessions" &&
          (changedIds.has("*") || changedIds.has(currentId));
        await Promise.allSettled([
          refreshList(),
          viewRef.current === "overview" ? refreshOverview() : undefined,
          shouldRefreshDetail ? refreshSession(currentId) : undefined,
        ]);
      }
      syncing = false;
      if (queued && !disposed) scheduleSync();
    }

    function scheduleSync() {
      if (syncing || timer != null) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void sync();
      }, 60);
    }

    const close = openStream((event) => {
      if (environmentRef.current !== "local") return;
      const banner = streamErrorBanner(event);
      if (banner) setAppError(banner);
      pendingIds.add(event.id || "*");
      queued = true;
      scheduleSync();
    }, setStreamStatus);
    return () => {
      disposed = true;
      close();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [showSessionData, environment, refreshList, refreshOverview, refreshSession]);

  useEffect(() => {
    if (environment === "local" || !showSessionData) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshList().catch(() => undefined);
      if (viewRef.current === "overview") void refreshOverview().catch(() => undefined);
      const currentId = selectedIdRef.current;
      if (currentId && viewRef.current === "sessions") {
        void refreshSession(currentId).catch(() => undefined);
      }
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [environment, showSessionData, refreshList, refreshOverview, refreshSession]);

  function openImportedSession(snap: SessionSnapshot) {
    mobileContextTarget.current = false;
    setDayFilter(null);
    setBehavior(null);
    if (viewRef.current !== "sessions")
      pushSessionNavigation({
        view: "sessions",
        selectedId: snap.id,
        range: "all",
        source: snap.source ?? "codex",
        environment,
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
      // Imports land in the local store. Show that machine, not the remote mirror.
      changeEnvironment("local");
      // A list read started before the import must not erase the confirmed record.
      listRequest.current += 1;
      listInFlight.current?.controller.abort();
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
      if (viewRef.current === "overview") void refreshOverview().catch(() => undefined);
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
    const select = () => {
      setSelectedId(id);
      setSelectedNodeId(null);
      setContextOpen(null);
      setMobileSessionPane("detail");
    };
    if (view !== "sessions") {
      withViewTransition(() => {
        pushSessionNavigation({ view: "sessions", selectedId: id, range, source, environment });
        setBehavior(null);
        setDayFilter(null);
        setView("sessions");
        select();
      });
      return;
    }
    select();
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

  function handleEnvironmentChange(next: SessionEnvironmentId) {
    if (next === environment) return;
    pushSessionNavigation({ view, selectedId: null, range, source, environment: next });
    changeEnvironment(next);
    preferredSessionIdRef.current = null;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedNodeId(null);
    setContextOpen(null);
    setMobileSessionPane("list");
    setDayFilter(null);
    setBehavior(null);
  }

  function handleSourceChange(next: SessionSourceFilter) {
    if (next === source) return;
    setDayFilter(null);
    setBehavior(null);
    const nextId = resolveSelectedSession(
      null,
      filterSessionsByRange(filterSessionsBySource(sessions, next), range, now),
    );
    pushSessionNavigation({ view, selectedId: nextId, range, source: next, environment });
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

  async function handleDeleteSession(target: SessionListItem) {
    try {
      await deleteSession(target.id);
      const remainingVisible = visibleSessions.filter((item) => item.id !== target.id);
      setSessions((current) => current.filter((item) => item.id !== target.id));
      if (selectedIdRef.current === target.id) {
        const nextId = remainingVisible[0]?.id ?? null;
        selectedIdRef.current = nextId;
        preferredSessionIdRef.current = nextId;
        setSelectedId(nextId);
        setSnapshot(null);
        setSelectedNodeId(null);
        setContextOpen(null);
        setSessionLoad(nextId ? { id: nextId, status: "loading" } : null);
        if (!nextId) setMobileSessionPane("list");
      }
      showToast(`已移除会话：${target.nickname ?? target.id}`);
      void Promise.allSettled([
        refreshList(),
        view === "overview" ? refreshOverview() : undefined,
      ]);
    } catch (err) {
      showToast(errorMessage(err, "删除会话失败"));
    }
  }

  const overviewState = overviewDisplayState({
    requestedRange: `${environment}:${source}:${range}`,
    appliedRange: appliedScope,
    hasOverview: overview != null,
    error: overviewError,
  });

  const indexing = view === "overview" ? overview?.indexing : listIndexing;

  function refreshAll() {
    if (view === "hardware") {
      setHardwareRefreshKey((value) => value + 1);
      return;
    }
    setRefreshing(true);
    void Promise.allSettled([
      view === "overview" ? refreshOverview(true) : undefined,
      refreshList(true),
      view === "sessions" && selectedId ? refreshSession(selectedId) : undefined,
    ]).finally(() => setRefreshing(false));
  }

  function inspectSlice(key: SliceKey) {
    const filter = { key, asOf: appliedAt };
    mobileContextTarget.current = false;
    writeSessionListState({ query: "", limit: SESSION_PAGE_SIZE, scrollTop: 0 });
    withViewTransition(() => {
      pushSessionNavigation({ view: "sessions", selectedId: null, range, source, environment, behavior: filter });
      setSelectedId(null);
      setSelectedNodeId(null);
      setContextOpen(null);
      setDayFilter(null);
      setBehavior(filter);
      setView("sessions");
      setMobileSessionPane("list");
    });
  }

  function drillToDay(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    mobileContextTarget.current = false;
    setContextOpen(null);
    setDayFilter(date);
    setBehavior(null);
    rangeRef.current = "all";
    setRange("all");
    writeSessionListState({ query: "", limit: SESSION_PAGE_SIZE, scrollTop: 0 });
    const pool = filterSessionsByDay(
      filterSessionsBySource(sessions, source),
      date,
    );
    const nextId = resolveSelectedSession(null, pool);
    withViewTransition(() => {
      pushSessionNavigation({
        view: "sessions",
        selectedId: nextId,
        range: "all",
        source,
        environment,
        day: date,
      });
      setView("sessions");
      setMobileSessionPane("list");
      setSelectedId(nextId);
    });
  }

  function openSessions() {
    mobileContextTarget.current = false;
    setContextOpen(null);
    const nextId = resolveSelectedSession(selectedId, visibleSessions);
    withViewTransition(() => {
      if (view !== "sessions") {
        pushSessionNavigation({ view: "sessions", selectedId: nextId, range, source, environment });
        setDayFilter(null);
        setBehavior(null);
      }
      setView("sessions");
      setMobileSessionPane("list");
      setSelectedId(nextId);
    });
  }

  function navigate(
    event: React.MouseEvent<HTMLAnchorElement>,
    next: View,
    nextHardwareTab?: HardwareTab,
  ) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (next === view && (next !== "hardware" || !nextHardwareTab || nextHardwareTab === hardwareTab)) return;
    if (next === "sessions") openSessions();
    else {
      const tab = next === "hardware" ? (nextHardwareTab ?? hardwareTab) : undefined;
      withViewTransition(() => {
        pushSessionNavigation({
          view: next,
          selectedId,
          range,
          source,
          environment,
          ...(tab ? { hardwareTab: tab } : {}),
        });
        setDayFilter(null);
        setBehavior(null);
        if (tab) setHardwareTab(tab);
        setView(next);
      });
    }
  }

  function openReadonlyDialog(trigger: HTMLElement) {
    lastDialogTriggerRef.current = trigger;
    const dialog = readonlyDialogRef.current;
    if (dialog && typeof dialog.showModal === "function" && !dialog.open) {
      dialog.showModal();
    }
  }

  function closeReadonlyDialog() {
    readonlyDialogRef.current?.close();
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    withViewTransition(() => {
      applyTheme(next);
      setTheme(next);
    });
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Ignore storage errors in private browsing.
      }
      return next;
    });
  }

  function handleHardwareTabChange(tab: HardwareTab) {
    if (tab === hardwareTab) return;
    withViewTransition(() => {
      setHardwareTab(tab);
      pushSessionNavigation({
        view: "hardware",
        selectedId,
        range,
        source,
        environment,
        hardwareTab: tab,
      });
    });
  }

  useEffect(() => {
    const page =
      view === "overview"
        ? "成本总览"
        : view === "sessions"
          ? "会话明细"
          : hardwareTab === "power"
            ? "硬件用电"
            : "硬件温度";
    document.title = `${page}${view === "overview" && overviewState === "error" ? " · 加载失败" : ""} · Token Analyser`;
  }, [view, hardwareTab, overviewState]);

  const pageTitleText =
    view === "overview"
      ? "成本总览"
      : view === "sessions"
        ? "会话明细"
        : hardwareTab === "power"
          ? "硬件监控 · 用电"
          : "硬件监控 · 温度";
  const statusDotClass = (environment === "local" ? streamStatus === "error" : remoteSync?.failed)
    ? "is-err"
    : (environment === "local" ? streamStatus === "open" : remoteSync?.syncedAt != null)
      ? ""
      : "is-idle";
  const statusText = environment === "local"
    ? `${STREAM_LABEL[streamStatus]} · 本机只读`
    : remoteSync?.failed
      ? "同步中断 · 缓存数据"
      : remoteSync?.refreshing
        ? "正在同步镜像"
        : remoteSync?.syncedAt != null
          ? "远端已同步 · 只读"
          : "正在同步远端";

  return (
    <UnitProvider unit={unit} setUnit={setUnit}>
      <div className={sidebarCollapsed ? "app-shell is-sidebar-collapsed" : "app-shell"}>
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

        <aside className="sidebar" aria-label="主导航" aria-hidden={sidebarCollapsed || undefined}>
          <div className="brand-header">
            <div className="brand-mark" aria-hidden="true">
              <LedgerMark />
            </div>
            <div className="od-field od-fill">
              <span className="brand-title">Token Analyser</span>
              <span className="brand-subtitle">用量与硬件工作台</span>
            </div>
            <button
              type="button"
              className="sidebar-collapse-btn"
              aria-label="收起侧边栏"
              title="收起侧边栏"
              aria-expanded={!sidebarCollapsed}
              onClick={toggleSidebar}
            >
              <Icon name="sidebarCollapse" />
            </button>
          </div>

          <nav className="sidebar-nav" aria-label="视图">
            <div className="nav-group-label">用量分析</div>
            <a
              href="#sessions"
              aria-label="会话明细"
              className={`nav-item${view === "sessions" ? " is-active" : ""}`}
              aria-current={view === "sessions" ? "page" : undefined}
              onClick={(event) => navigate(event, "sessions")}
            >
              <Icon name="sessions" />
              <span>会话明细</span>
              <span className="nav-badge" aria-hidden="true">{sessions.length}</span>
            </a>
            <a
              href="#overview"
              className={`nav-item${view === "overview" ? " is-active" : ""}`}
              aria-current={view === "overview" ? "page" : undefined}
              onClick={(event) => navigate(event, "overview")}
            >
              <Icon name="overview" />
              <span>成本总览</span>
            </a>

            <div className="nav-group-label">硬件监控</div>
            <a
              href="#hardware/temps"
              className={`nav-item${view === "hardware" && hardwareTab === "temps" ? " is-active" : ""}`}
              aria-current={view === "hardware" && hardwareTab === "temps" ? "page" : undefined}
              onClick={(event) => navigate(event, "hardware", "temps")}
            >
              <Icon name="temps" />
              <span>温度监控</span>
            </a>
            <a
              href="#hardware/power"
              className={`nav-item${view === "hardware" && hardwareTab === "power" ? " is-active" : ""}`}
              aria-current={view === "hardware" && hardwareTab === "power" ? "page" : undefined}
              onClick={(event) => navigate(event, "hardware", "power")}
            >
              <Icon name="power" />
              <span>用电监控</span>
            </a>
          </nav>

          <div className="sidebar-dock">
            <EnvironmentSwitcher
              environment={environment}
              onChange={handleEnvironmentChange}
            />
            <div className="dock-actions">
              <button
                type="button"
                className="theme-toggle theme-toggle-btn"
                aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                onClick={toggleTheme}
              >
                <Icon name={theme === "dark" ? "sun" : "moon"} className={theme === "dark" ? "is-sun" : ""} />
                <span>{theme === "dark" ? "浅色" : "深色"}</span>
              </button>
              <button
                type="button"
                className="theme-toggle-btn dock-refresh-btn"
                aria-label="刷新"
                title="刷新数据"
                disabled={refreshing}
                onClick={refreshAll}
              >
                <Icon name="refresh" className={refreshing ? "spinner" : ""} />
                <span>刷新</span>
              </button>
            </div>
            <button
              type="button"
              className="readonly-status-btn"
              onClick={(event) => openReadonlyDialog(event.currentTarget)}
            >
              <span className={`status-dot ${statusDotClass}`} aria-hidden="true" />
              <span className="od-truncate">
                {view === "hardware"
                  ? hardwareTab === "temps"
                    ? "Prometheus · 2s 轮询"
                    : "Prometheus · 实时功率"
                  : statusText}
              </span>
              <span className="readonly-status-trailing" aria-hidden="true">
                <Icon name={view === "hardware" ? (hardwareTab === "temps" ? "activity" : "power") : "info"} />
              </span>
            </button>
          </div>
        </aside>

        <div className="main-column">
          <header className="topbar app-header">
            <div className="topbar-row">
              <div className="topbar-title-wrap">
                {sidebarCollapsed && (
                  <button
                    type="button"
                    className="btn btn-sm sidebar-expand-btn"
                    aria-label="展开侧边栏"
                    title="展开侧边栏"
                    aria-expanded={!sidebarCollapsed}
                    onClick={toggleSidebar}
                  >
                    <Icon name="sidebarExpand" />
                  </button>
                )}
                <span className="mobile-brand-dot" aria-hidden="true">
                  <LedgerMark />
                </span>
                <h1 className="page-title" tabIndex={-1}>{pageTitleText}</h1>
                {view === "overview" && (
                  <span className="page-meta-pill">
                    <Icon name="clock" />
                    <span>{range === "all" ? "全部时间" : `近 ${rangeLabel}`}</span>
                  </span>
                )}
                {view === "hardware" && hardwareTab === "temps" && (
                  <span className="page-meta-pill">
                    {hardwareTopMeta.devicePill ?? "2 × GPU + CPU"}
                  </span>
                )}
                {view === "hardware" && hardwareTab === "power" && (
                  <span className="page-meta-pill mono">
                    {hardwareTopMeta.windowPill ?? "近 24 小时"}
                  </span>
                )}
                <span className={`page-meta-pill mono${view === "overview" || view === "hardware" ? " is-brand" : ""}`}>
                  <span className="meta-pill-dot" aria-hidden="true" />
                  {view === "hardware"
                    ? (hardwareTopMeta.hostPill ?? (environment === "local" ? "本机节点" : environmentLabel(environment)))
                    : view === "sessions" && theme === "dark"
                      ? `深色主题 · ${environment === "local" ? "本机节点" : environmentLabel(environment)}`
                      : environment === "local"
                        ? "本机节点"
                        : environmentLabel(environment)}
                </span>
              </div>

              <div className="mobile-utility-controls">
                <EnvironmentSwitcher
                  id="mobile-env-select"
                  compact
                  environment={environment}
                  onChange={handleEnvironmentChange}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                  onClick={toggleTheme}
                >
                  <Icon name={theme === "dark" ? "sun" : "moon"} />
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label="刷新"
                  disabled={refreshing}
                  onClick={refreshAll}
                >
                  <Icon name="refresh" />
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label="本机只读与数据说明"
                  onClick={(event) => openReadonlyDialog(event.currentTarget)}
                >
                  <Icon name="info" />
                </button>
              </div>

              <div className="topbar-controls">
                {view !== "hardware" ? (
                  <div className="od-cluster topbar-actions-group" style={{ "--od-gap": "10px" } as React.CSSProperties}>
                    <RangeSwitcher
                      range={range}
                      onChange={(next) => {
                        setDayFilter(null);
                        setBehavior(null);
                        setRange(next);
                      }}
                    />
                    <UnitSwitcher />
                    {view === "overview" && (
                      <>
                        <Button
                          className="topbar-outline-btn"
                          aria-expanded={priceSheetOpen}
                          aria-controls="price-sheet"
                          onClick={() => setPriceSheetOpen((open) => !open)}
                        >
                          <Icon name="layers" />
                          模型价格
                        </Button>
                        <Button
                          emphasis="solid"
                          intent="brand"
                          className="topbar-cta-btn"
                          onClick={() => openSessions()}
                        >
                          <span>查看会话</span>
                          <Icon name="arrowUpRight" />
                        </Button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="od-cluster topbar-actions-group" style={{ "--od-gap": "12px" } as React.CSSProperties}>
                    <div className="hardware-live-pill" role="status">
                      <span className="status-dot" aria-hidden="true" />
                      <span>
                        {hardwareTab === "temps"
                          ? (hardwareTopMeta.statusText ?? "实时采样 · 2s 轮询")
                          : (hardwareTopMeta.statusText ?? "Prometheus 已接入 · 电费不计入 Token 成本")}
                      </span>
                    </div>
                    <nav className="segmented-control hardware-tab-switch" role="tablist" aria-label="硬件监控视图">
                      <a
                        role="tab"
                        href="#hardware/temps"
                        aria-selected={hardwareTab === "temps"}
                        className={hardwareTab === "temps" ? "active" : ""}
                        onClick={(event) => navigate(event, "hardware", "temps")}
                      >
                        <Icon name="temps" />
                        <span>温度</span>
                      </a>
                      <a
                        role="tab"
                        href="#hardware/power"
                        aria-selected={hardwareTab === "power"}
                        className={hardwareTab === "power" ? "active" : ""}
                        onClick={(event) => navigate(event, "hardware", "power")}
                      >
                        <Icon name="power" />
                        <span>用电</span>
                      </a>
                    </nav>
                  </div>
                )}
              </div>
            </div>

            {view !== "hardware" && (
              <SourceSwitcher
                source={source}
                counts={counts}
                loaded={sessionsLoaded}
                visibleCount={visibleSessions.length}
                rangeLabel={rangeLabel}
                onChange={handleSourceChange}
                onShowAllTime={() => { setBehavior(null); setDayFilter(null); setRange("all"); }}
              />
            )}
          </header>

        <div
          ref={contentRef}
          id="main-content"
          className="workspace-content"
          tabIndex={-1}
        >
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
        {showSessionData && environment === "local" && indexing && (() => {
          const pct = indexing.total > 0
            ? Math.min(100, Math.round((indexing.completed / indexing.total) * 100))
            : 0;
          return (
            <div className="app-notice" role="status">
              <div className="indexing-notice">
                <div className="indexing-notice-head">
                  <span className="indexing-notice-label">
                    <i className="dot live" aria-hidden="true" />
                    正在更新会话索引 · 已处理 {indexing.completed} / {indexing.total} 个变更文件
                  </span>
                  <span className="indexing-notice-pct">{pct}%</span>
                </div>
                <div className="indexing-progress-track" aria-hidden="true">
                  <span className="indexing-progress-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            </div>
          );
        })()}
        {showSessionData && environment !== "local" && remoteSync?.failed && (
          <div className="app-notice">
            <Notice tone="warning">
              远端同步中断，正在显示缓存会话。
              {remoteSync.syncedAt != null && `上次成功同步于 ${formatAbsoluteTime(new Date(remoteSync.syncedAt).toISOString())}。`}
            </Notice>
          </div>
        )}
        {showSessionData && appError && (
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
        {view === "sessions" && (dayFilter || behavior) && (
          <div className="drill-banner" role="region" aria-label="当前下钻筛选条件">
            <div className="drill-chips">
              <span>已应用下钻筛选：</span>
              {dayFilter && (
                <span className="drill-chip">
                  <span>日期 {dayFilter}</span>
                  <button
                    type="button"
                    className="drill-chip-remove"
                    aria-label="移除日期筛选"
                    onClick={() => setDayFilter(null)}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              )}
              {behavior && (
                <span className="drill-chip">
                  <span>行为 · {SLICE_META[behavior.key].label}</span>
                  <button
                    type="button"
                    className="drill-chip-remove"
                    aria-label="移除行为筛选"
                    onClick={() => setBehavior(null)}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              )}
            </div>
            <Button
              onClick={() => {
                setDayFilter(null);
                setBehavior(null);
              }}
            >
              清除筛选
            </Button>
          </div>
        )}
          {view === "hardware" ? (
            <HardwarePage
              tab={hardwareTab}
              onTabChange={handleHardwareTabChange}
              now={now}
              refreshKey={hardwareRefreshKey}
              onTopMeta={setHardwareTopMeta}
            />
          ) : view === "overview" ? (
            overviewState === "ready" && overview && !(overview.indexing && overview.sessionCount === 0) ? (
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
                  topSessions={
                    <OverviewRail
                      topSessions={overview.topSessions?.[unit] ?? []}
                      rangeLabel={rangeLabel}
                      sourceById={new Map(sessions.map((item) => [item.id, item.source]))}
                      onSelectSession={handleSelectSession}
                      onOpenSessions={openSessions}
                    />
                  }
                  onDrillDay={drillToDay}
                  rangeLabel={
                    range === "all"
                      ? `${rangeLabel}（趋势为近 30 个本地日）`
                      : rangeLabel
                  }
                  filterScope={`${environment}:${source}:${range}:${appliedAt}`}
                  fetchOverviewForModel={fetchOverviewForModel}
                  priceSheetOpen={priceSheetOpen}
                  onTogglePriceSheet={setPriceSheetOpen}
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
                <div className="loading-reserve" aria-hidden="true">
                  <div className="reserve-strip">
                    {[0, 1, 2, 3].map((index) => (
                      <div className="reserve-cell" key={index} />
                    ))}
                  </div>
                  <div className="reserve-panels">
                    {[0, 1].map((index) => (
                      <div className="reserve-panel" key={index}>
                        <div className="reserve-line short" />
                        <div className="reserve-line medium" />
                        <div className="reserve-block" />
                      </div>
                    ))}
                  </div>
                </div>
                <StatePanel
                  kind="loading"
                  title={environment === "local" ? "正在汇总本地用量" : `正在汇总 ${environmentLabel(environment)} 的用量`}
                  description={`${rangeLabel} · ${environment === "local" ? "首次读取较大的会话记录可能需要一些时间。" : "首次从这台机器同步会话可能需要一两分钟。"}`}
                />
              </main>
            )
          ) : (
            <div className="layout sessions-layout" data-mobile-pane={mobileSessionPane}>
              <SessionList
                key={`${environment}:${source}`}
                source={source}
                environmentLabel={environmentLabel(environment)}
                sessions={visibleSessions}
                totalCount={matchingSource.length}
                dayFilter={dayFilter}
                onClearDayFilter={() => setDayFilter(null)}
                behaviorLabel={behavior ? SLICE_META[behavior.key].label : null}
                onClearBehavior={() => setBehavior(null)}
                selectedId={selectedId}
                contextOpen={contextOpen}
                onSelect={handleSelectSession}
                onInspectContext={handleInspectContext}
                onDeleteSession={(target) => void handleDeleteSession(target)}
                onNotify={showToast}
                onImport={handleImport}
                importStatus={importStatus}
                loaded={sessionsLoaded && (!behaviorScope || !!behaviorIds)}
                error={behaviorScope ? behaviorError ?? sessionsError : sessionsError}
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
                    <Suspense fallback={<StatePanel kind="loading" title="正在加载会话详情" />}>
                      <SessionView
                        key={snapshot.id}
                        snapshot={snapshot}
                        selectedNodeId={selectedNodeId}
                        onSelectNode={setSelectedNodeId}
                        onUpdate={(next) => {
                          sessionMutationRev.current += 1;
                          setSnapshot((current) => current?.id === next.id ? next : current);
                        }}
                        onNotify={showToast}
                        contextOpen={contextOpen}
                        onContextOpen={setContextOpen}
                      />
                    </Suspense>
                  </>
                ) : selectedId && listIndexing && !sessions.some((session) => session.id === selectedId) ? (
                  <StatePanel kind="loading" title="正在索引所选会话" description="读取完成后会自动显示详情。" />
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
            <Icon name="shield" /> 本机只读解析
          </span>
          <span>不上传外部网络</span>
        </footer>
        </div>

        <nav className="mobile-nav" aria-label="移动主导航">
          <a
            href="#sessions"
            aria-label="会话明细"
            className={`mobile-nav-btn${view === "sessions" ? " is-active" : ""}`}
            aria-current={view === "sessions" ? "page" : undefined}
            onClick={(event) => navigate(event, "sessions")}
          >
            <Icon name="sessions" />
            <span>会话</span>
          </a>
          <a
            href="#overview"
            aria-label="成本总览"
            className={`mobile-nav-btn${view === "overview" ? " is-active" : ""}`}
            aria-current={view === "overview" ? "page" : undefined}
            onClick={(event) => navigate(event, "overview")}
          >
            <Icon name="overview" />
            <span>总览</span>
          </a>
          <a
            href="#hardware/temps"
            className={`mobile-nav-btn${view === "hardware" && hardwareTab === "temps" ? " is-active" : ""}`}
            aria-current={view === "hardware" && hardwareTab === "temps" ? "page" : undefined}
            onClick={(event) => navigate(event, "hardware", "temps")}
          >
            <Icon name="temps" />
            <span>温度</span>
          </a>
          <a
            href="#hardware/power"
            className={`mobile-nav-btn${view === "hardware" && hardwareTab === "power" ? " is-active" : ""}`}
            aria-current={view === "hardware" && hardwareTab === "power" ? "page" : undefined}
            onClick={(event) => navigate(event, "hardware", "power")}
          >
            <Icon name="power" />
            <span>用电</span>
          </a>
        </nav>

        <dialog
          ref={readonlyDialogRef}
          className="od-dialog"
          aria-labelledby="readonly-dialog-title"
          onClose={() => {
            lastDialogTriggerRef.current?.focus();
          }}
        >
          <div className="dialog-head">
            <div className="dialog-title-wrap">
              <span className="dialog-title-icon" aria-hidden="true">
                <Icon name="shield" />
              </span>
              <h2 className="cs-card-title" id="readonly-dialog-title">本机只读模式与数据说明</h2>
            </div>
            <button
              type="button"
              className="dialog-close-btn"
              aria-label="关闭弹窗"
              onClick={closeReadonlyDialog}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="dialog-body">
            <p style={{ margin: 0 }}>
              Token Analyser 采用<strong>本机只读采集</strong>架构，仅解析各 AI 编码代理（Codex、Claude Code、Cursor、pi、DeepSeek Harness、OpenCode、Antigravity）的本地会话日志与硬件遥测快照，不向外部上传提示词或源代码。
            </p>
            <p style={{ margin: 0 }}>
              当前状态：{statusText}。可在「会话明细」页直接拖入或选择本地 <code className="mono">.jsonl</code> 文件进行即时解析。
            </p>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-primary dialog-confirm-btn" onClick={closeReadonlyDialog}>
              知道了
            </button>
          </div>
        </dialog>

        <div className="toast-region" aria-live="polite" aria-atomic="true">
          {toastMessage && <div className="toast">{toastMessage}</div>}
        </div>
      </div>
    </UnitProvider>
  );
}

function OverviewRail({
  topSessions,
  rangeLabel,
  sourceById,
  onSelectSession,
  onOpenSessions,
}: {
  topSessions: NonNullable<Overview["topSessions"]>["tokens"];
  rangeLabel: string;
  sourceById?: Map<string, SessionListItem["source"]>;
  onSelectSession: (id: string) => void;
  onOpenSessions: () => void;
}) {
  const { unit } = useUnit();
  const max = Math.max(...topSessions.map((session) => costValue(session.cost, unit) ?? 0), 0);
  return (
    <aside className="cs-card rail overview-rail" aria-label="总览侧栏" tabIndex={-1}>
      <div className="cs-card-header">
        <div>
          <h2 className="cs-card-title">高用量会话排行</h2>
          <p className="cs-card-subtitle">{rangeLabel} · {unit === "usd" ? "USD" : unit === "credits" ? "Credits" : "Tokens"}</p>
        </div>
      </div>
      {topSessions.length === 0 ? (
        <p className="empty-copy">该范围内没有可排行的用量。</p>
      ) : (
        <div className="top-sessions-list">
          {topSessions.map((session, index) => {
            const dotColor = sourceColor(sourceById?.get(session.id) ?? "codex");
            return (
              <button
                type="button"
                className="top-session-item rail-rank"
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                title={`查看 ${session.nickname ?? session.id} 的费用明细`}
              >
                <div className="od-row" style={{ justifyContent: "space-between", width: "100%" }}>
                  <span className="source-pill">
                    <span className="mono" style={{ color: "var(--text-muted)" }}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span
                      className="source-dot"
                      style={{ background: dotColor }}
                      aria-hidden="true"
                    />
                    <span className="od-truncate">{session.nickname ?? session.id}</span>
                  </span>
                  <strong className="mono od-nowrap" style={{ fontSize: "12px" }}>
                    {unit === "tokens"
                      ? formatCostTokens(session.cost)
                      : formatCost(session.cost, unit)}
                  </strong>
                </div>
                <div className="top-session-bar">
                  <span
                    style={{
                      width: `${max > 0 ? Math.max(6, (100 * (costValue(session.cost, unit) ?? 0)) / max) : 0}%`,
                      background: dotColor,
                    }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
      <Button className="rail-more" style={{ marginTop: "12px", width: "100%" }} onClick={onOpenSessions}>
        <span>查看全部会话</span>
        <Icon name="chevron" />
      </Button>
    </aside>
  );
}

export function App() {
  return (
    <TooltipProvider>
      <NowProvider>
        <AppShell />
      </NowProvider>
    </TooltipProvider>
  );
}
