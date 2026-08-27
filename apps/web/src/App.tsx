import { useCallback, useEffect, useState } from "react";
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

  const refreshList = useCallback(async () => {
    const list = await listSessions();
    setSessions(list);
    return list;
  }, []);

  const refreshSession = useCallback(async (id: string) => {
    const snap = await getSession(id);
    setSnapshot(snap);
    return snap;
  }, []);

  useEffect(() => {
    refreshList().then((list) => {
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0]!.id);
      }
    });
  }, [refreshList, selectedId]);

  useEffect(() => {
    if (selectedId) {
      refreshSession(selectedId);
    } else {
      setSnapshot(null);
    }
  }, [selectedId, refreshSession]);

  useEffect(() => {
    return openStream(({ id }) => {
      refreshList();
      if (id === selectedId) {
        refreshSession(id);
      }
    });
  }, [selectedId, refreshList, refreshSession]);

  async function handleImport(filename: string, text: string) {
    const snap = await importNdjson(filename, text);
    await refreshList();
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
