import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bindSessionEnvironment,
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
import { HardwarePage } from "./HardwarePage";
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

function AppShell() {
  const now = useNow();
  const [initialNavigation] = useState(readSessionNavigation);
  const [view, setView] = useState<View>(initialNavigation.view);
  const [hardwareTab, setHardwareTab] = useState<HardwareTab>(
    initialNavigation.hardwareTab ?? "temps",
  );
  const [unit, setUnit] = useState<CostUnit>(readUnitPref);
  const [theme, setTheme] = useState<ThemePref>(readThemePref);
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
  const [refreshing, setRefreshing] = useState(false);
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
      detailRef.current?.scrollIntoView({ block: "start" });
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
      const heading = contentRef.current?.querySelector<HTMLElement>(selector);
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
    const requestedAt = Date.now();
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
    let timer: number | undefined;

    async function sync() {
      if (disposed || syncing || !queued || environmentRef.current !== "local") return;
      syncing = true;
      queued = false;
      // A connection event can race the initial read. Wait for that read, then
      // apply this event to the latest generation.
      await Promise.allSettled([listInFlight.current?.promise, overviewInFlight.current?.promise]);
      if (!disposed && environmentRef.current === "local") {
        const currentId = selectedIdRef.current;
        await Promise.allSettled([
          refreshList(),
          viewRef.current === "overview" ? refreshOverview() : undefined,
          currentId && viewRef.current === "sessions" ? refreshSession(currentId) : undefined,
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
      }, 80);
    }

    const close = openStream((event) => {
      if (environmentRef.current !== "local") return;
      const banner = streamErrorBanner(event);
      if (banner) setAppError(banner);
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
      const tab = next === "hardware" ? hardwareTab : undefined;
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
        setView(next);
      });
    }
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
              <BareButton asChild>
                <a
                  href="#overview"
                  className={view === "overview" ? "active" : ""}
                  aria-current={view === "overview" ? "page" : undefined}
                  onClick={(event) => navigate(event, "overview")}
                >
                  <Icon name="overview" />
                  成本总览
                </a>
              </BareButton>
              <BareButton asChild>
                <a
                  href="#sessions"
                  className={view === "sessions" ? "active" : ""}
                  aria-current={view === "sessions" ? "page" : undefined}
                  onClick={(event) => navigate(event, "sessions")}
                >
                  <Icon name="sessions" />
                  会话明细
                </a>
              </BareButton>
              <BareButton asChild>
                <a
                  href={`#hardware/${hardwareTab}`}
                  className={view === "hardware" ? "active" : ""}
                  aria-current={view === "hardware" ? "page" : undefined}
                  onClick={(event) => navigate(event, "hardware")}
                >
                  <Icon name="power" />
                  硬件
                </a>
              </BareButton>
            </nav>
          </div>
          <div className="header-right app-tools">
            {showSessionData && <div className="status-pills" role="status" aria-live="polite">
              <Badge asChild variant="outline">
                <span>
                  <i className={`dot ${(environment === "local" ? streamStatus === "error" : remoteSync?.failed)
                    ? "err"
                    : (environment === "local" ? streamStatus === "open" : remoteSync?.syncedAt != null)
                      ? "live" : "idle"}`} />
                  {environment === "local" ? STREAM_LABEL[streamStatus]
                    : remoteSync?.failed ? "同步中断" : remoteSync?.refreshing ? "正在同步镜像" : remoteSync?.syncedAt != null ? "已同步" : "正在同步"}
                </span>
              </Badge>
            </div>}
            <Button
              className="theme-toggle"
              emphasis="ghost"
              aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              onClick={() => {
                const next = theme === "dark" ? "light" : "dark";
                // Apply the palette inside the transition callback so the new
                // snapshot captures it; the effect below remains idempotent.
                withViewTransition(() => {
                  applyTheme(next);
                  setTheme(next);
                });
              }}
            >
              <Icon
                key={theme}
                name={theme === "dark" ? "sun" : "moon"}
                className="theme-glyph"
              />
            </Button>
            <Button
              className="refresh-button"
              busy={refreshing}
              onClick={refreshAll}
            >
              <Icon name="refresh" /> 刷新
            </Button>
            <span className="local-label"><Icon name="shield" /> {environment === "local" ? "本地运行" : environmentLabel(environment)}</span>
          </div>
        </header>
        {view !== "hardware" && (
        <Button
          className="mobile-filter-toggle"
          emphasis="ghost"
          aria-label={filtersOpen ? "收起筛选" : "展开筛选"}
          aria-expanded={filtersOpen}
          aria-controls="workspace-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <span className="mobile-filter-summary">
            {environmentLabel(environment)} · {SESSION_SOURCES.find((item) => item.id === source)?.label} · {rangeLabel} · {unit === "tokens" ? "Tokens" : unit === "credits" ? "Credits" : "USD"}
          </span>
          <span className="mobile-filter-action">筛选 <Icon name="chevron" /></span>
        </Button>
        )}
        {view !== "hardware" && (
        <div id="workspace-filters" className="workspace-filters" data-expanded={filtersOpen}>
        <EnvironmentSwitcher
          environment={environment}
          onChange={handleEnvironmentChange}
        />
        <SourceSwitcher
          source={source}
          counts={counts}
          loaded={sessionsLoaded}
          visibleCount={visibleSessions.length}
          rangeLabel={rangeLabel}
          onChange={handleSourceChange}
          onShowAllTime={() => { setBehavior(null); setDayFilter(null); setRange("all"); }}
        />
          <div className="scope-controls">
            <div className="filter-field">
              <span className="filter-label"><Icon name="clock" /> 时间范围</span>
              <RangeSwitcher
                range={range}
                onChange={(next) => {
                  setDayFilter(null);
                  setBehavior(null);
                  setRange(next);
                }}
              />
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
        {showSessionData && environment === "local" && indexing && (
          <div className="app-notice" role="status">
            正在更新会话索引 · 已处理 {indexing.completed} / {indexing.total} 个变更文件。当前统计会随读取进度更新。
          </div>
        )}
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
        <div
          ref={contentRef}
          id="main-content"
          className="app-content"
          tabIndex={-1}
        >
          {view === "hardware" ? (
            <HardwarePage
              tab={hardwareTab}
              onTabChange={handleHardwareTabChange}
              now={now}
              refreshKey={hardwareRefreshKey}
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
            <Icon name="shield" /> 数据仅在本机处理
          </span>
          <span>只读分析 · 不会修改原始会话记录</span>
        </footer>
      </div>
    </UnitProvider>
  );
}

function OverviewRail({
  topSessions,
  rangeLabel,
  onSelectSession,
  onOpenSessions,
}: {
  topSessions: NonNullable<Overview["topSessions"]>["tokens"];
  rangeLabel: string;
  onSelectSession: (id: string) => void;
  onOpenSessions: () => void;
}) {
  const { unit } = useUnit();
  const max = Math.max(...topSessions.map((session) => costValue(session.cost, unit) ?? 0), 0);
  return (
    <aside className="rail overview-rail" aria-label="总览侧栏" tabIndex={-1}>
      <Panel className="rail-panel">
        <h2 className="rail-title">用量最高的会话</h2>
        <p className="rail-meta">{rangeLabel} · 按 {unit === "usd" ? "USD" : unit === "credits" ? "Credits" : "Tokens"}</p>
        {topSessions.length === 0 ? (
          <p className="empty-copy">该范围内没有可排行的用量。</p>
        ) : (
          <div className="rail-ranks">
            {topSessions.map((session) => (
              <BareButton
                type="button"
                className="rail-rank"
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                title={`查看 ${session.nickname ?? session.id} 的费用明细`}
              >
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
                        width: `${max > 0 ? 100 * (costValue(session.cost, unit) ?? 0) / max : 0}%`,
                      }}
                    />
                  </span>
                </span>
              </BareButton>
            ))}
          </div>
        )}
        <Button className="rail-more" onClick={onOpenSessions}>
          查看全部会话 <Icon name="arrow" />
        </Button>
      </Panel>
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
