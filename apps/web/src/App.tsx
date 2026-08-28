import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSession,
  importNdjson,
  listSessions,
  openStream,
  type SessionListItem,
  type SessionSnapshot,
} from "./api";
import { UnitProvider } from "./UnitContext";
import type { CostUnit } from "./format";
import { SessionList } from "./SessionList";
import { SessionView } from "./SessionView";
import { UnitSwitcher } from "./UnitSwitcher";

export function App() {
  const [unit, setUnit] = useState<CostUnit>("tokens");
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const listRequest = useRef(0);
  const sessionRequest = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const refreshList = useCallback(async () => {
    const requestId = ++listRequest.current;
    const list = await listSessions();
    if (requestId === listRequest.current) {
      setSessions(list);
      setSelectedId((current) => {
        if (current && list.some((session) => session.id === current)) {
          return current;
        }
        return list[0]?.id ?? null;
      });
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
    void refreshList().catch(() => undefined);
  }, [refreshList]);

  useEffect(() => {
    sessionRequest.current += 1;
    if (selectedId) {
      void refreshSession(selectedId).catch(() => undefined);
    } else {
      setSnapshot(null);
    }
  }, [selectedId, refreshSession]);

  useEffect(() => {
    return openStream(() => {
      void refreshList().catch(() => undefined);
      const currentId = selectedIdRef.current;
      if (currentId) {
        void refreshSession(currentId).catch(() => undefined);
      }
    });
  }, [refreshList, refreshSession]);

  async function handleImport(filename: string, text: string) {
    const snap = await importNdjson(filename, text);
    await refreshList();
    sessionRequest.current += 1;
    selectedIdRef.current = snap.id;
    setSelectedId(snap.id);
    setSnapshot(snap);
  }

  function handleSelectSession(id: string) {
    setSelectedId(id);
    setSelectedNodeId(null);
  }

  return (
    <UnitProvider unit={unit} setUnit={setUnit}>
      <div className="app">
        <header className="top-bar">
          <h1>Token Analyser</h1>
          <UnitSwitcher />
        </header>
        <div className="layout">
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            onSelect={handleSelectSession}
            onImport={handleImport}
          />
          <main className="main-panel">
            {snapshot ? (
              <SessionView
                snapshot={snapshot}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                onUpdate={setSnapshot}
              />
            ) : (
              <p className="empty-main">Select a session to inspect costs.</p>
            )}
          </main>
        </div>
      </div>
    </UnitProvider>
  );
}
