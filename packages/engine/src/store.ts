import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { buildTree } from "./tree.ts";
import { computeWaste } from "./waste.ts";
import {
  ingestFile,
  clearLiveReadState,
  pruneInactiveLiveReadStates,
  type IngestOptions,
} from "./ingest.ts";
import { isLive, pruneStaleCache } from "./cache.ts";
import { effectiveRateCard } from "./rate-card.ts";
import {
  DEFAULT_WASTE_TOGGLES,
  type SessionListItem,
  type SessionSnapshot,
  type WasteToggleId,
} from "./types.ts";
import { buildOverview, type Overview, type OverviewOptions } from "./overview.ts";

function latestActivityIso(session: SessionSnapshot): string | null {
  let best = session.lastEventAt ?? session.startedAt;
  let bestMs = best ? Date.parse(best) : Number.NaN;
  for (const child of session.children) {
    const childIso = latestActivityIso(child);
    const childMs = childIso ? Date.parse(childIso) : Number.NaN;
    if (Number.isFinite(childMs) && (!Number.isFinite(bestMs) || childMs > bestMs)) {
      best = childIso;
      bestMs = childMs;
    }
  }
  return best && Number.isFinite(bestMs) ? best : null;
}

function unpricedRawFromSession(session: SessionSnapshot): number {
  let raw = 0;
  for (const turn of session.turns) {
    if (turn.cost.credits == null) raw += turn.cost.raw;
  }
  for (const child of session.children) raw += unpricedRawFromSession(child);
  return raw;
}

function rebuildDerived(snap: SessionSnapshot): SessionSnapshot {
  const label = snap.nickname ?? snap.id;
  const tree = buildTree({
    sessionId: snap.id,
    label,
    turns: snap.turns,
    children: snap.children,
  });
  const { waste } = computeWaste({
    turns: snap.turns,
    children: snap.children,
    toggles: snap.toggles,
  });
  const derived = { ...snap, tree, cost: tree.cost, waste };
  return {
    ...derived,
    live: snap.live || snap.children.some((child) => child.live),
    lastEventAt: latestActivityIso(derived),
  };
}

function toListItem(snap: SessionSnapshot): SessionListItem {
  return {
    id: snap.id,
    parentId: snap.parentId,
    nickname: snap.nickname,
    cwd: snap.cwd,
    live: snap.live,
    model: snap.model,
    effort: snap.effort,
    startedAt: snap.startedAt,
    lastEventAt: snap.lastEventAt,
    cost: snap.cost,
    waste: snap.waste,
    unpricedRaw: unpricedRawFromSession(snap),
    parse_error: snap.parse_errors.length > 0,
    parse_error_offset: snap.parse_errors[0]?.offset,
    parse_error_message: snap.parse_errors[0]?.message,
    ledger_warning: snap.ledger_warning,
    toolsChars: snap.context?.tools.chars ?? 0,
    toolsCount: snap.context?.tools.items.length ?? 0,
    skillsChars: snap.context?.skills.chars ?? 0,
    skillsCount: snap.context?.skills.items.length ?? 0,
  };
}

export type SessionStoreOptions = {
  cacheDir?: string;
};

export type SessionIngestOptions = Pick<IngestOptions, "allowAppend"> & {
  /** Keep an already-loaded canonical session when an import has the same id. */
  skipExisting?: boolean;
};

export class SessionStore {
  /** Raw per-file snapshots. Children are attached only in `rebuildAll`. */
  private sources = new Map<string, SessionSnapshot>();
  private snapshots = new Map<string, SessionSnapshot>();
  private toggles = new Map<string, Record<WasteToggleId, boolean>>();
  private cacheHome?: string;

  constructor(opts?: SessionStoreOptions) {
    if (opts?.cacheDir) {
      this.cacheHome = path.dirname(opts.cacheDir);
    }
    pruneStaleCache(this.cacheHome, JSON.stringify(effectiveRateCard()));
  }

  private rebuildAll(): void {
    const childrenByParent = new Map<string, string[]>();
    for (const [id, source] of this.sources) {
      if (!source.parentId || !this.sources.has(source.parentId)) continue;
      const children = childrenByParent.get(source.parentId) ?? [];
      children.push(id);
      childrenByParent.set(source.parentId, children);
    }

    const rebuilt = new Map<string, SessionSnapshot>();
    const building = new Set<string>();

    const build = (id: string): SessionSnapshot => {
      const existing = rebuilt.get(id);
      if (existing) return existing;
      const source = this.sources.get(id)!;
      if (building.has(id)) {
        // A malformed cycle should not recurse forever or hide the session.
        return { ...source, children: [] };
      }

      building.add(id);
      const children = (childrenByParent.get(id) ?? []).map(build);
      building.delete(id);
      const snapshot = rebuildDerived({
        ...source,
        children,
        toggles: this.toggles.get(id) ?? DEFAULT_WASTE_TOGGLES,
      });
      rebuilt.set(id, snapshot);
      return snapshot;
    };

    for (const id of this.sources.keys()) build(id);
    this.snapshots = rebuilt;
  }

  private refreshLiveFlags(): void {
    pruneInactiveLiveReadStates();
    let changed = false;
    for (const [id, source] of this.sources) {
      let live = source.live;
      try {
        if (existsSync(source.path)) live = isLive(statSync(source.path).mtimeMs);
      } catch {
        // Keep the previous state when a file is being replaced.
      }
      if (live !== source.live) {
        try {
          // A watcher event can be missed just before a session becomes
          // historical. Re-read once on the transition so the final events
          // are not stranded in an empty or partial in-memory snapshot.
          const refreshed = ingestFile(source.path, {
            cacheHome: this.cacheHome,
          });
          const currentToggles = this.toggles.get(id);
          if (refreshed.id !== id) {
            this.sources.delete(id);
            this.toggles.delete(id);
            if (currentToggles) this.toggles.set(refreshed.id, currentToggles);
          }
          if (!this.toggles.has(refreshed.id)) {
            this.toggles.set(refreshed.id, { ...refreshed.toggles });
          }
          this.sources.set(refreshed.id, { ...refreshed, children: [] });
          changed = true;
          continue;
        } catch {
          // Keep the live transition even if a file is temporarily unreadable.
        }
        this.sources.set(id, { ...source, live });
        changed = true;
      }
    }
    if (changed) this.rebuildAll();
  }

  refresh(
    paths: string[],
    opts?: { onError?: (filePath: string, err: Error) => void },
  ): void {
    const ingested: SessionSnapshot[] = [];
    for (const p of paths) {
      if (!p.endsWith(".jsonl")) continue;
      const base = path.basename(p);
      if (!base.startsWith("rollout-")) continue;
      try {
        ingested.push(ingestFile(p, { cacheHome: this.cacheHome }));
      } catch (err) {
        opts?.onError?.(
          p,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    const ids = new Set(ingested.map((snap) => snap.id));
    for (const id of this.toggles.keys()) {
      if (!ids.has(id)) this.toggles.delete(id);
    }
    this.sources.clear();
    for (const snap of ingested) {
      this.sources.set(snap.id, { ...snap, children: [] });
    }
    this.rebuildAll();
  }

  removePath(filePath: string): { id: string; parentId: string | null } | undefined {
    const resolved = path.resolve(filePath);
    for (const [id, source] of this.sources) {
      if (path.resolve(source.path) !== resolved) continue;
      const parentId = source.parentId;
      this.sources.delete(id);
      this.toggles.delete(id);
      clearLiveReadState(source.path);
      this.rebuildAll();
      return { id, parentId };
    }
    return undefined;
  }

  ingestPath(
    filePath: string,
    opts?: SessionIngestOptions,
  ): string | undefined {
    const snap = ingestFile(filePath, {
      cacheHome: this.cacheHome,
      allowAppend: opts?.allowAppend,
    });
    if (opts?.skipExisting && this.sources.has(snap.id)) return snap.id;
    const resolved = path.resolve(filePath);
    for (const [id, source] of this.sources) {
      if (id === snap.id) continue;
      if (path.resolve(source.path) !== resolved) continue;
      this.sources.delete(id);
      this.toggles.delete(id);
    }
    const currentToggles = this.toggles.get(snap.id);
    if (!currentToggles) this.toggles.set(snap.id, { ...snap.toggles });
    this.sources.set(snap.id, { ...snap, children: [] });
    this.rebuildAll();
    return snap.id;
  }

  private rootSnapshots(): SessionSnapshot[] {
    this.refreshLiveFlags();
    const roots = [...this.snapshots.values()].filter(
      (s) => s.parentId == null || !this.sources.has(s.parentId),
    );
    roots.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      const aTime = a.lastEventAt ?? "";
      const bTime = b.lastEventAt ?? "";
      return bTime.localeCompare(aTime);
    });
    return roots;
  }

  list(): SessionListItem[] {
    return this.rootSnapshots().map(toListItem);
  }

  overview(
    opts: Pick<OverviewOptions, "watchPath" | "collecting" | "sinceMs" | "dayCount">,
  ): Overview {
    return buildOverview(this.rootSnapshots(), opts);
  }

  get(id: string): SessionSnapshot | undefined {
    this.refreshLiveFlags();
    const snap = this.snapshots.get(id);
    if (!snap) return undefined;
    return snap;
  }

  setToggles(
    id: string,
    toggles: Partial<Record<WasteToggleId, boolean>>,
  ): void {
    if (!this.sources.has(id)) return;
    const previous = this.toggles.get(id) ?? { ...DEFAULT_WASTE_TOGGLES };
    this.toggles.set(id, { ...previous, ...toggles });
    this.rebuildAll();
  }
}

export { DEFAULT_WASTE_TOGGLES };
