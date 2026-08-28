import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { buildTree } from "./tree.ts";
import { computeWaste } from "./waste.ts";
import { ingestFile, type IngestOptions } from "./ingest.ts";
import { isLive, pruneStaleCache } from "./cache.ts";
import {
  DEFAULT_WASTE_TOGGLES,
  type SessionListItem,
  type SessionSnapshot,
  type WasteToggleId,
} from "./types.ts";
import { buildOverview, type Overview, type OverviewOptions } from "./overview.ts";

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
  return { ...snap, tree, cost: tree.cost, waste };
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

export type SessionIngestOptions = Pick<IngestOptions, "allowAppend">;

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
    pruneStaleCache(this.cacheHome);
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
    let changed = false;
    for (const [id, source] of this.sources) {
      let live = source.live;
      try {
        if (existsSync(source.path)) live = isLive(statSync(source.path).mtimeMs);
      } catch {
        // Keep the previous state when a file is being replaced.
      }
      if (live !== source.live) {
        this.sources.set(id, { ...source, live });
        changed = true;
      }
    }
    if (changed) this.rebuildAll();
  }

  refresh(paths: string[]): void {
    const ingested: SessionSnapshot[] = [];
    for (const p of paths) {
      if (!p.endsWith(".jsonl")) continue;
      const base = path.basename(p);
      if (!base.startsWith("rollout-")) continue;
      try {
        ingested.push(ingestFile(p, { cacheHome: this.cacheHome }));
      } catch {
        // A file can disappear between directory scan and ingestion.
        // Continue loading the remaining sessions.
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

  ingestPath(
    filePath: string,
    opts?: SessionIngestOptions,
  ): string | undefined {
    const snap = ingestFile(filePath, {
      cacheHome: this.cacheHome,
      allowAppend: opts?.allowAppend,
    });
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
