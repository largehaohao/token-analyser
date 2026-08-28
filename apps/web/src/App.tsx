import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getOverview,
  getSession,
  importNdjson,
  listSessions,
  openStream,
  type Overview,
  type SessionListItem,
  type SessionSnapshot,
  type StreamStatus,
} from "./api";
import { UnitProvider } from "./UnitContext";
import type { CostUnit } from "./format";
import { OverviewPage } from "./OverviewPage";
import { RangeSwitcher } from "./RangeSwitcher";
import { SessionList } from "./SessionList";
import { SessionView } from "./SessionView";
import { UnitSwitcher } from "./UnitSwitcher";
import { NowProvider, useNow } from "./useNow";
import { resolveSelectedSession } from "./session-page";
import { overviewDisplayState } from "./overview-state";
import {
  DEFAULT_SESSION_RANGE,
  SESSION_RANGES,
  filterSessionsByRange,
  type SessionRangeId,
} from "./session-range";

type View = "overview" | "sessions";

const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: "连接中",
  open: "已连接",
  error: "未连接",
};

function AppShell() {
  const now = useNow();
  const [view, setView] = useState<View>("overview");
  const [unit, setUnit] = useState<CostUnit>("tokens");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [appliedRange, setAppliedRange] = useState<SessionRangeId | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState<"tools" | "skills" | null>(
    null,
  );
  const [range, setRange] = useState<SessionRangeId>(DEFAULT_SESSION_RANGE);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const listRequest = useRef(0);
  const sessionRequest = useRef(0);
  const overviewRequest = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const viewRef = useRef<View>(view);
  const rangeRef = useRef<SessionRangeId>(range);
  selectedIdRef.current = selectedId;
  viewRef.current = view;
  rangeRef.current = range;

  const visibleSessions = useMemo(
    () => filterSessionsByRange(sessions, range, now),
    [sessions, range, now],
  );
  const rangeLabel =
    SESSION_RANGES.find((item) => item.id === range)?.label ?? range;

  const refreshOverview = useCallback(async () => {
    const requestId = ++overviewRequest.current;
    const requestedRange = rangeRef.current;
    setOverviewError(null);
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
  }, []);

  const refreshList = useCallback(async () => {
    const requestId = ++listRequest.current;
    const list = await listSessions();
    if (requestId === listRequest.current) {
      setSessions(list);
    }
    return list;
  }, []);

  const refreshSession = useCallback(async (id: string) => {
    const requestId = ++sessionRequest.current;
    const snap = await getSession(id);
    if (
      requestId === sessionRequest.current &&
      selectedIdRef.current === id
    ) {
      setSnapshot(snap);
    }
    return snap;
  }, []);

  useEffect(() => {
    void refreshOverview().catch(() => undefined);
  }, [range, now, refreshOverview]);

  useEffect(() => {
    void refreshList().catch(() => undefined);
  }, [refreshList]);

  useEffect(() => {
    if (view !== "sessions") return;
    const nextId = resolveSelectedSession(selectedId, visibleSessions);
    if (nextId === selectedId) return;
    setSelectedId(nextId);
    setSelectedNodeId(null);
    setContextOpen(null);
    if (!nextId) setSnapshot(null);
  }, [visibleSessions, selectedId, view]);

  useEffect(() => {
    sessionRequest.current += 1;
    if (selectedId && view === "sessions") {
      void refreshSession(selectedId).catch(() => undefined);
    } else if (!selectedId) {
      setSnapshot(null);
    }
  }, [selectedId, refreshSession, view]);

  useEffect(() => {
    return openStream(
      () => {
        void refreshOverview().catch(() => undefined);
        void refreshList().catch(() => undefined);
        const currentId = selectedIdRef.current;
        if (currentId && viewRef.current === "sessions") {
          void refreshSession(currentId).catch(() => undefined);
        }
      },
      setStreamStatus,
    );
  }, [refreshList, refreshOverview, refreshSession]);

  async function handleImport(filename: string, text: string) {
    const snap = await importNdjson(filename, text);
    await refreshList();
    await refreshOverview().catch(() => undefined);
    sessionRequest.current += 1;
    selectedIdRef.current = snap.id;
    setView("sessions");
    setSelectedId(snap.id);
    setSnapshot(snap);
    setContextOpen(null);
  }

  function handleSelectSession(id: string) {
    setSelectedId(id);
    setSelectedNodeId(null);
    setContextOpen(null);
  }

  function handleInspectContext(id: string, bucket: "tools" | "skills") {
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
    setView("sessions");
    setSelectedId((current) =>
      resolveSelectedSession(current, visibleSessions),
    );
  }

  return (
    <UnitProvider unit={unit} setUnit={setUnit}>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <p className="brand-name">Token Analyser</p>
            <p className="crumb">
              工作空间 /{" "}
              <strong>{view === "overview" ? "成本总览" : "会话明细"}</strong>
            </p>
          </div>
          <div className="header-right">
            <div className="status-pills">
              <span>
                <i
                  className={`dot ${streamStatus === "open" ? "live" : streamStatus === "error" ? "err" : "idle"}`}
                />
                {STREAM_LABEL[streamStatus]}
              </span>
              {overview?.live && (
                <span>
                  <i className="dot live" />
                  实时采集
                </span>
              )}
            </div>
            <div className="nav-pills">
              <button
                type="button"
                className={view === "overview" ? "active" : ""}
                onClick={() => setView("overview")}
              >
                成本总览
              </button>
              <button
                type="button"
                className={view === "sessions" ? "active" : ""}
                onClick={openSessions}
              >
                会话明细
              </button>
            </div>
            <RangeSwitcher range={range} onChange={setRange} />
            <UnitSwitcher />
          </div>
        </header>
        {view === "overview" ? (
          overviewState === "ready" && overview ? (
            <OverviewPage
              overview={overview}
              onOpenSessions={openSessions}
              rangeLabel={
                range === "all" ? `${rangeLabel}（趋势为近 30 天 UTC）` : rangeLabel
              }
            />
          ) : (
            <div className="overview">
              <p className="empty-main">
                {overviewState === "error"
                  ? `总览加载失败：${overviewError}`
                  : "加载中…"}
              </p>
            </div>
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
            />
            <main className="main-panel">
              {snapshot && selectedId === snapshot.id ? (
                <SessionView
                  snapshot={snapshot}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                  onUpdate={setSnapshot}
                  contextOpen={contextOpen}
                  onContextOpen={setContextOpen}
                />
              ) : (
                <p className="empty-main">选择一个会话查看费用。</p>
              )}
            </main>
          </div>
        )}
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
