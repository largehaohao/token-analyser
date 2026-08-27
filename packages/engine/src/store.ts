import path from "node:path";
import { buildTree } from "./tree.ts";
import { computeWaste } from "./waste.ts";
import { ingestFile } from "./ingest.ts";
import {
  DEFAULT_WASTE_TOGGLES,
  type SessionListItem,
  type SessionSnapshot,
  type WasteToggleId,
} from "./types.ts";

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
  };
}

export type SessionStoreOptions = {
  cacheDir?: string;
};

export class SessionStore {
  private snapshots = new Map<string, SessionSnapshot>();
  private cacheHome?: string;

  constructor(opts?: SessionStoreOptions) {
    if (opts?.cacheDir) {
      this.cacheHome = path.dirname(opts.cacheDir);
    }
  }

  refresh(paths: string[]): void {
    const ingested: SessionSnapshot[] = [];
    for (const p of paths) {
      if (!p.endsWith(".jsonl")) continue;
      const base = p.split("/").pop() ?? p;
      if (!base.startsWith("rollout-")) continue;
      ingested.push(ingestFile(p, { cacheHome: this.cacheHome }));
    }

    this.snapshots.clear();
    for (const snap of ingested) {
      this.snapshots.set(snap.id, { ...snap, children: [] });
    }

    for (const snap of ingested) {
      if (snap.parentId && this.snapshots.has(snap.parentId)) {
        const parent = this.snapshots.get(snap.parentId)!;
        const child = this.snapshots.get(snap.id)!;
        parent.children.push(child);
      }
    }

    for (const snap of this.snapshots.values()) {
      if (snap.children.length > 0) {
        const rebuilt = rebuildDerived(snap);
        this.snapshots.set(snap.id, rebuilt);
        for (const child of rebuilt.children) {
          this.snapshots.set(child.id, child);
        }
      }
    }
  }

  ingestPath(filePath: string): string | undefined {
    const snap = ingestFile(filePath, { cacheHome: this.cacheHome });
    const existing = this.snapshots.get(snap.id);
    const next: SessionSnapshot = {
      ...snap,
      children: existing?.children ?? [],
    };
    this.snapshots.set(next.id, next);

    if (next.parentId && this.snapshots.has(next.parentId)) {
      const parent = this.snapshots.get(next.parentId)!;
      const idx = parent.children.findIndex((c) => c.id === next.id);
      if (idx === -1) {
        parent.children.push(next);
      } else {
        parent.children[idx] = next;
      }
      const rebuilt = rebuildDerived(parent);
      this.snapshots.set(parent.id, rebuilt);
      for (const c of rebuilt.children) {
        this.snapshots.set(c.id, c);
      }
    } else if (next.children.length > 0) {
      const rebuilt = rebuildDerived(next);
      this.snapshots.set(rebuilt.id, rebuilt);
      for (const c of rebuilt.children) {
        this.snapshots.set(c.id, c);
      }
    }

    return next.id;
  }

  list(): SessionListItem[] {
    const roots = [...this.snapshots.values()].filter((s) => s.parentId == null);
    roots.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      const aTime = a.lastEventAt ?? "";
      const bTime = b.lastEventAt ?? "";
      return bTime.localeCompare(aTime);
    });
    return roots.map(toListItem);
  }

  get(id: string): SessionSnapshot | undefined {
    const snap = this.snapshots.get(id);
    if (!snap) return undefined;
    if (snap.children.length > 0) {
      return {
        ...snap,
        children: snap.children.map(
          (c) => this.snapshots.get(c.id) ?? c,
        ),
      };
    }
    return snap;
  }

  setToggles(id: string, toggles: Record<WasteToggleId, boolean>): void {
    const snap = this.snapshots.get(id);
    if (!snap) return;

    const updated = rebuildDerived({ ...snap, toggles });
    this.snapshots.set(id, updated);
  }
}

export { DEFAULT_WASTE_TOGGLES };
