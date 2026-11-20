import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { buildTree } from "./tree.ts";
import { computeWaste } from "./waste.ts";
import {
  ingestFile,
  ingestSessions,
  pricingCacheContext,
  clearLiveReadState,
  pruneInactiveLiveReadStates,
  readMultiSessionEvents,
  snapshotFromEvents,
  type IngestOptions,
} from "./ingest.ts";
import { readCursorSessionsCooperative } from "./cursor-store.ts";
import { isLive, pruneStaleCache } from "./cache.ts";
import { isSessionFile } from "./session-files.ts";
import { summarizeSessions } from "./performance.ts";
import {
  DEFAULT_WASTE_TOGGLES,
  type SessionListItem,
  type SessionSnapshot,
  type WasteToggleId,
} from "./types.ts";
import { buildOverview, type Overview, type OverviewOptions } from "./overview.ts";
import {
  fileFingerprint,
  fingerprintsMatch,
  shouldDeferSqliteWalReparse,
  SQLITE_WAL_REPARSE_COOLDOWN_MS,
  readStoreDump,
  STORE_DUMP_VERSION,
  writeStoreDump,
  type FileFingerprint,
} from "./store-dump.ts";
import {
  deleteStoredToggles,
  readStoredToggles,
  writeStoredToggle,
} from "./store-db.ts";

/** Coalesce dump writes after ingest bursts so a crash loses at most ~2s. */
const DUMP_DEBOUNCE_MS = 2_000;

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
    if (turn.cost.credits == null && turn.cost.usd == null) raw += turn.cost.raw;
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
    // Task windows when the source records them, per-request timing otherwise.
    performance: summarizeSessions([derived]),
  };
}

function toListItem(snap: SessionSnapshot): SessionListItem {
  return {
    id: snap.id,
    source: snap.source,
    sourceId: snap.sourceId,
    messageCount: snap.messageCount,
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
  /** Resolved path → fingerprint of the file used for the current source(s). */
  private fingerprints = new Map<string, FileFingerprint>();
  /** When we last parsed a large SQLite source (dump restore counts). */
  private sqliteIngestAt = new Map<string, number>();
  /** Resolved path → session ids (avoids O(sources) scans during refresh). */
  private sourcesByPath = new Map<string, string[]>();
  /** Last mtime used for the live flag, so list/overview do not stat every file. */
  private liveMtimeMs = new Map<string, number>();
  private cacheHome?: string;
  private dumpTimer: ReturnType<typeof setTimeout> | undefined;
  /** True after a mutation that should be persisted to the store dump. */
  private dumpDirty = false;
  /** Single-flight batched ingests per resolved path. */
  private batchedFlights = new Map<string, Promise<string | undefined>>();
  private batchedRefreshPending = new Set<string>();
  /** Last full scan of source mtimes; reads reuse it for up to one second. */
  private lastLiveFlagScanAt = 0;
  /** Dump generation fingerprint for incremental persistence. */
  private lastDumpSourceIds = "";
  private lastDumpFingerprintIds = "";

  constructor(opts?: SessionStoreOptions) {
    if (opts?.cacheDir) {
      this.cacheHome = path.dirname(opts.cacheDir);
    }
    // Prune is O(cache files × JSON parse). Defer so startup loadDump/refresh
    // is not blocked on reading every per-file cache entry.
    const home = this.cacheHome;
    const context = pricingCacheContext();
    setTimeout(() => {
      try {
        pruneStaleCache(home, context);
      } catch {
        // Best-effort cleanup; ingest still works without it.
      }
    }, 0).unref?.();
  }

  /** Queue a dump soon after mutations; coalesces watcher append storms. */
  scheduleDump(): void {
    this.dumpDirty = true;
    if (this.dumpTimer) clearTimeout(this.dumpTimer);
    this.dumpTimer = setTimeout(() => {
      this.dumpTimer = undefined;
      try {
        this.dump();
      } catch {
        // Dump is best-effort; the next interval/exit still retries.
      }
    }, DUMP_DEBOUNCE_MS);
    this.dumpTimer.unref?.();
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

  private reindexPaths(): void {
    this.sourcesByPath.clear();
    for (const [id, source] of this.sources) {
      const resolved = path.resolve(source.path);
      const ids = this.sourcesByPath.get(resolved);
      if (ids) ids.push(id);
      else this.sourcesByPath.set(resolved, [id]);
    }
  }

  private sourcesForPath(resolved: string): SessionSnapshot[] {
    const ids = this.sourcesByPath.get(resolved);
    if (!ids || ids.length === 0) return [];
    const out: SessionSnapshot[] = [];
    for (const id of ids) {
      const snap = this.sources.get(id);
      if (snap) out.push(snap);
    }
    return out;
  }

  private rememberFingerprint(filePath: string): void {
    try {
      const resolved = path.resolve(filePath);
      this.fingerprints.set(resolved, fileFingerprint(filePath));
      if (resolved.endsWith(".vscdb") || path.basename(resolved) === "opencode.db") {
        this.sqliteIngestAt.set(resolved, Date.now());
      }
    } catch {
      this.fingerprints.delete(path.resolve(filePath));
    }
  }

  private sqliteWalState(
    filePath: string,
    current: FileFingerprint,
  ): Parameters<typeof shouldDeferSqliteWalReparse>[0] {
    const resolved = path.resolve(filePath);
    let fileBytes = current.size;
    try {
      fileBytes = statSync(filePath).size;
    } catch {
      // Use fingerprint size when stat races with a delete.
    }
    return {
      recorded: this.fingerprints.get(resolved),
      current,
      fileBytes,
      lastIngestAt: this.sqliteIngestAt.get(resolved),
      hasSources: this.sourcesForPath(resolved).length > 0,
    };
  }

  /** Large Cursor/OpenCode DBs stay WAL-dirty while the app is open. */
  private shouldSkipSqliteWal(filePath: string, current: FileFingerprint): boolean {
    return shouldDeferSqliteWalReparse(this.sqliteWalState(filePath, current));
  }

  /**
   * Milliseconds until a deferred WAL-only SQLite change may be re-parsed, or
   * undefined when no deferral is pending. The watcher uses this to schedule
   * the eventual reparse: without it, a single WAL commit made while the engine
   * was stopped is skipped at warm start and never ingested.
   */
  sqliteWalReparseDelayMs(filePath: string): number | undefined {
    let current: FileFingerprint;
    try {
      current = fileFingerprint(filePath);
    } catch {
      return undefined;
    }
    const state = this.sqliteWalState(filePath, current);
    if (!shouldDeferSqliteWalReparse(state)) return undefined;
    const elapsed = Date.now() - (state.lastIngestAt ?? 0);
    return Math.max(0, SQLITE_WAL_REPARSE_COOLDOWN_MS - elapsed);
  }

  /**
   * Load a previous dump of parsed sessions. Call before `refresh` so unchanged
   * historical files can be reused without re-parsing.
   */
  loadDump(): number {
    // Preferences live independently of derived snapshots: they survive dump
    // version bumps, pricing changes and cache rebuilds.
    const storedToggles = readStoredToggles(this.cacheHome);
    const dump = readStoreDump(this.cacheHome, pricingCacheContext());
    if (!dump) {
      for (const [id, toggles] of Object.entries(storedToggles)) {
        this.toggles.set(id, { ...toggles });
      }
      return 0;
    }
    this.sources.clear();
    this.toggles.clear();
    this.fingerprints.clear();
    for (const snap of dump.sources) {
      if (!snap?.id || typeof snap.path !== "string") continue;
      this.sources.set(snap.id, { ...snap, children: [] });
    }
    for (const [id, toggles] of Object.entries(storedToggles)) {
      if (this.sources.has(id)) this.toggles.set(id, { ...toggles });
    }
    const restoredAt = Date.now();
    for (const [filePath, fingerprint] of Object.entries(dump.fingerprints)) {
      const resolved = path.resolve(filePath);
      this.fingerprints.set(resolved, fingerprint);
      if (resolved.endsWith(".vscdb") || path.basename(resolved) === "opencode.db") {
        this.sqliteIngestAt.set(resolved, restoredAt);
      }
    }
    this.reindexPaths();
    this.rebuildAll();
    return this.sources.size;
  }

  /** Persist parsed sources so the next startup can skip unchanged files. */
  dump(opts?: { force?: boolean }): void {
    if (this.dumpTimer) {
      clearTimeout(this.dumpTimer);
      this.dumpTimer = undefined;
    }
    if (!opts?.force && !this.dumpDirty) return;
    const sourceIds = [...this.sources.keys()].sort().join("|");
    const fingerprintIds = [...this.fingerprints.keys()].sort().join("|");
    if (
      !opts?.force &&
      sourceIds === this.lastDumpSourceIds &&
      fingerprintIds === this.lastDumpFingerprintIds
    ) {
      // Only preference metadata changed; preferences already have their own
      // durable table, so skip rewriting the full snapshot history.
      this.dumpDirty = false;
      return;
    }
    const fingerprints: Record<string, FileFingerprint> = {};
    for (const [filePath, fingerprint] of this.fingerprints) {
      fingerprints[filePath] = fingerprint;
    }
    const toggles: Record<string, Record<WasteToggleId, boolean>> = {};
    for (const [id, value] of this.toggles) {
      toggles[id] = { ...value };
    }
    writeStoreDump(
      {
        version: STORE_DUMP_VERSION,
        pricingContext: pricingCacheContext(),
        sources: [...this.sources.values()].map((snap) => ({
          ...snap,
          children: [],
        })),
        toggles,
        fingerprints,
      },
      this.cacheHome,
    );
    this.lastDumpSourceIds = sourceIds;
    this.lastDumpFingerprintIds = fingerprintIds;
    this.dumpDirty = false;
  }

  private keepSource(
    snap: SessionSnapshot,
    nextSources: Map<string, SessionSnapshot>,
    nextToggles: Map<string, Record<WasteToggleId, boolean>>,
    live?: boolean,
  ): void {
    // Prefer Cursor's state.vscdb over agent-transcript JSONL, including when
    // the vscdb row only exists in the dump and this refresh never opens it
    // (heavy .vscdb paths are deferred until after listen).
    const incumbent =
      nextSources.get(snap.id) ?? this.sources.get(snap.id);
    if (incumbent?.path.endsWith(".vscdb") && !snap.path.endsWith(".vscdb")) {
      return;
    }
    nextSources.set(snap.id, {
      ...snap,
      children: [],
      ...(live != null ? { live } : {}),
    });
    nextToggles.set(snap.id, this.toggles.get(snap.id) ?? { ...snap.toggles });
  }

  private liveReingestPending = new Set<string>();
  private liveReingestTimer: ReturnType<typeof setTimeout> | undefined;
  private liveReingestTail: Promise<void> = Promise.resolve();

  /** Re-read after a live→historical flip without blocking list()/get(). */
  private scheduleLiveReingest(filePath: string): void {
    this.liveReingestPending.add(filePath);
    if (this.liveReingestTimer) return;
    let resolveBatch!: () => void;
    const batch = new Promise<void>((resolve) => {
      resolveBatch = resolve;
    });
    this.liveReingestTail = this.liveReingestTail.then(() => batch);
    this.liveReingestTimer = setTimeout(() => {
      this.liveReingestTimer = undefined;
      const paths = [...this.liveReingestPending];
      this.liveReingestPending.clear();
      try {
        for (const pendingPath of paths) {
          try {
            this.ingestPath(pendingPath);
          } catch {
            // Watcher / next list will retry; never block the request path.
          }
        }
      } finally {
        resolveBatch();
      }
    }, 250);
    this.liveReingestTimer.unref?.();
  }

  /** Test hook: the deferred re-read has finished. */
  whenLiveReingestSettled(): Promise<void> {
    return this.liveReingestTail;
  }

  private refreshLiveFlags(): void {
    // A session GET used to stat every source file on every call. Batching
    // reads still detects final live→historical transitions within this
    // interval, and the changes themselves schedule their own re-ingest.
    const now = Date.now();
    if (now - this.lastLiveFlagScanAt < 1_000) return;
    this.lastLiveFlagScanAt = now;
    pruneInactiveLiveReadStates();
    let changed = false;
    for (const [id, source] of this.sources) {
      const resolved = path.resolve(source.path);
      if (source.path.endsWith(".vscdb") || path.basename(source.path) === "opencode.db") {
        const live = source.lastEventAt != null && isLive(Date.parse(source.lastEventAt));
        if (live !== source.live) { this.sources.set(id, { ...source, live }); changed = true; }
        continue;
      }
      let live = source.live;
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(source.path).mtimeMs;
        live = isLive(mtimeMs);
      } catch {
        // Keep the previous state when a file is being replaced.
      }
      const knownMtime = this.liveMtimeMs.get(resolved);
      if (mtimeMs != null && knownMtime === mtimeMs && live === source.live) continue;
      if (mtimeMs != null) this.liveMtimeMs.set(resolved, mtimeMs);
      if (live !== source.live) {
        this.sources.set(id, { ...source, live });
        changed = true;
        // Re-read off the request path. A live→historical flip can carry the
        // file's final events, and parsing them inside list()/get() blocks
        // every other session on the event loop.
        this.scheduleLiveReingest(source.path);
      }
    }
    if (changed) {
      this.reindexPaths();
      this.rebuildAll();
    }
  }

  refresh(
    paths: string[],
    opts?: { onError?: (filePath: string, err: Error) => void },
  ): void {
    const nextSources = new Map<string, SessionSnapshot>();
    const nextToggles = new Map<string, Record<WasteToggleId, boolean>>();
    const nextFingerprints = new Map<string, FileFingerprint>();
    const refreshedPaths = new Set<string>();
    let mutated = false;

    for (const p of paths) {
      if (!isSessionFile(p)) continue;
      const resolved = path.resolve(p);
      refreshedPaths.add(resolved);
      try {
        const current = fileFingerprint(p);
        const previous = this.sourcesForPath(resolved);
        const recorded = this.fingerprints.get(resolved);
        // Trust the fingerprint over the 2-minute isLive window. Cursor's
        // state.vscdb (~GB) stays "live" whenever the app is open; requiring
        // !isLive forced a full SQLite re-parse on every engine restart even
        // when inode/size/mtime/WAL were unchanged since the dump.
        // Empty previous is OK: Cursor JSONL dupes are fingerprint-only when
        // state.vscdb already owns those session ids.
        const unchanged = fingerprintsMatch(recorded, current);
        const deferredWal = !unchanged && this.shouldSkipSqliteWal(p, current);
        if (unchanged || deferredWal) {
          for (const snap of previous) {
            // vscdb live is derived from lastEventAt, not file mtime.
            const reusedLive = snap.path.endsWith(".vscdb") || path.basename(snap.path) === "opencode.db"
              ? snap.lastEventAt != null && isLive(Date.parse(snap.lastEventAt))
              : isLive(current.mtimeMs);
            this.keepSource(snap, nextSources, nextToggles, reusedLive);
          }
          // A deferred WAL-only change was NOT parsed. Keep the fingerprint of
          // the last real parse, otherwise the next refresh (and the on-disk
          // dump) would claim to have ingested WAL data it never read.
          nextFingerprints.set(
            resolved,
            deferredWal && recorded ? recorded : current,
          );
          continue;
        }

        mutated = true;
        const ingested = ingestSessions(p, {
          cacheHome: this.cacheHome,
          // Live JSONL may only have grown since the dump; allow append-state
          // when the watcher later continues the same file.
          allowAppend: isLive(current.mtimeMs),
        });
        for (const snap of ingested) {
          this.keepSource(snap, nextSources, nextToggles);
        }
        nextFingerprints.set(resolved, fileFingerprint(p));
      } catch (err) {
        // Transient stat/read failure: keep dump/memory for this path instead of
        // dropping sessions that were already restored.
        for (const snap of this.sourcesForPath(resolved)) {
          this.keepSource(snap, nextSources, nextToggles);
        }
        const recorded = this.fingerprints.get(resolved);
        if (recorded) nextFingerprints.set(resolved, recorded);
        opts?.onError?.(
          p,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    // Paths not in this refresh stay loaded when their files still exist
    // (imports after loadDump, or a partial refresh of one watch root).
    for (const [id, source] of this.sources) {
      if (nextSources.has(id)) continue;
      const resolved = path.resolve(source.path);
      if (refreshedPaths.has(resolved)) continue;
      if (!existsSync(source.path)) {
        mutated = true;
        continue;
      }
      this.keepSource(source, nextSources, nextToggles);
      const recorded = this.fingerprints.get(resolved);
      if (recorded) nextFingerprints.set(resolved, recorded);
      if (!nextToggles.has(id) && this.toggles.has(id)) {
        nextToggles.set(id, { ...this.toggles.get(id)! });
      }
    }

    // Fingerprint-only paths (e.g. Cursor JSONL covered by state.vscdb) must
    // survive partial refreshes that never mention them.
    for (const [filePath, fingerprint] of this.fingerprints) {
      if (refreshedPaths.has(filePath)) continue;
      if (nextFingerprints.has(filePath)) continue;
      nextFingerprints.set(filePath, fingerprint);
    }

    // Drop sources for refreshed paths that no longer produced a snapshot.
    for (const [id, source] of this.sources) {
      if (nextSources.has(id)) continue;
      if (!refreshedPaths.has(path.resolve(source.path))) continue;
      mutated = true;
    }

    const sameMembership =
      !mutated &&
      nextSources.size === this.sources.size &&
      [...nextSources.keys()].every((id) => this.sources.has(id));
    let liveChanged = false;
    if (sameMembership) {
      for (const [id, snap] of nextSources) {
        if (this.sources.get(id)?.live !== snap.live) {
          liveChanged = true;
          break;
        }
      }
    }

    let fingerprintsChanged = nextFingerprints.size !== this.fingerprints.size;
    if (!fingerprintsChanged) {
      for (const [filePath, fingerprint] of nextFingerprints) {
        if (!fingerprintsMatch(this.fingerprints.get(filePath), fingerprint)) {
          fingerprintsChanged = true;
          break;
        }
      }
    }

    this.sources = nextSources;
    this.toggles = nextToggles;
    this.fingerprints = nextFingerprints;
    this.reindexPaths();
    if (sameMembership && !liveChanged) {
      // Skip rebuildAll; still persist when fingerprints were learned/updated.
      if (fingerprintsChanged) this.scheduleDump();
      return;
    }
    this.rebuildAll();
    if (!sameMembership || fingerprintsChanged) this.scheduleDump();
  }

  refreshPricing(): number {
    const refreshedSources = new Map<string, SessionSnapshot>();
    const refreshedToggles = new Map<string, Record<WasteToggleId, boolean>>();
    const refreshedFingerprints = new Map<string, FileFingerprint>();

    for (const filePath of new Set([...this.sources.values()].map((source) => source.path))) {
      for (const refreshed of ingestSessions(filePath, { cacheHome: this.cacheHome })) {
        if (refreshedSources.get(refreshed.id)?.path.endsWith(".vscdb") && !filePath.endsWith(".vscdb")) continue;
        refreshedSources.set(refreshed.id, { ...refreshed, children: [] });
        refreshedToggles.set(
          refreshed.id,
          this.toggles.get(refreshed.id) ?? { ...refreshed.toggles },
        );
      }
      try {
        refreshedFingerprints.set(path.resolve(filePath), fileFingerprint(filePath));
      } catch {
        // Source may have disappeared during a pricing refresh.
      }
    }

    this.sources = refreshedSources;
    this.toggles = refreshedToggles;
    this.fingerprints = refreshedFingerprints;
    this.reindexPaths();
    this.rebuildAll();
    this.scheduleDump();
    return refreshedSources.size;
  }

  removePath(filePath: string): { id: string; parentId: string | null } | undefined {
    const resolved = path.resolve(filePath);
    let removed: { id: string; parentId: string | null } | undefined;
    for (const [id, source] of this.sources) {
      if (path.resolve(source.path) !== resolved) continue;
      const parentId = source.parentId;
      this.sources.delete(id);
      this.toggles.delete(id);
      clearLiveReadState(source.path);
      removed ??= { id, parentId };
    }
    this.fingerprints.delete(resolved);
    if (removed) {
      this.reindexPaths();
      this.rebuildAll();
      this.scheduleDump();
    }
    return removed;
  }

  private installSnapshots(
    filePath: string,
    snapshots: SessionSnapshot[],
    opts?: SessionIngestOptions,
  ): string | undefined {
    const resolved = path.resolve(filePath);
    const ids = new Set(snapshots.map((snap) => snap.id));
    const removedIds: string[] = [];
    for (const [id, source] of this.sources) {
      if (ids.has(id)) continue;
      if (path.resolve(source.path) !== resolved) continue;
      this.sources.delete(id);
      this.toggles.delete(id);
      removedIds.push(id);
    }
    for (const snap of snapshots) {
      const existing = this.sources.get(snap.id);
      if (opts?.skipExisting && existing) continue;
      if (existing?.path.endsWith(".vscdb") && !filePath.endsWith(".vscdb")) continue;
      if (!this.toggles.has(snap.id)) this.toggles.set(snap.id, { ...snap.toggles });
      this.sources.set(snap.id, { ...snap, children: [] });
    }
    if (removedIds.length > 0) deleteStoredToggles(this.cacheHome, removedIds);
    this.rememberFingerprint(filePath);
    this.reindexPaths();
    this.rebuildAll();
    this.scheduleDump();
    return snapshots[0]?.id;
  }

  ingestPath(
    filePath: string,
    opts?: SessionIngestOptions,
  ): string | undefined {
    const resolved = path.resolve(filePath);
    try {
      const current = fileFingerprint(filePath);
      if (
        fingerprintsMatch(this.fingerprints.get(resolved), current) ||
        this.shouldSkipSqliteWal(filePath, current)
      ) {
        // Unchanged since last ingest/dump — skip the (possibly multi‑MB) parse.
        const existing = this.sourcesForPath(resolved);
        if (opts?.skipExisting && existing[0]) return existing[0].id;
        if (existing[0]) return existing[0].id;
      }
    } catch {
      // Fall through to a real ingest attempt when stat fails.
    }
    const snapshots = ingestSessions(filePath, {
      cacheHome: this.cacheHome,
      allowAppend: opts?.allowAppend,
    });
    return this.installSnapshots(filePath, snapshots, opts);
  }

  /**
   * Ingest a multi-session DB without blocking the HTTP loop for the whole file.
   * OpenCode/Cursor stores are analysed in batches with a tick between each.
   */
  async ingestPathBatched(
    filePath: string,
    opts?: SessionIngestOptions & {
      batchSize?: number;
      onBatch?: (ids: string[]) => void;
    },
  ): Promise<string | undefined> {
    const resolved = path.resolve(filePath);
    const flight = this.batchedFlights.get(resolved);
    if (flight) return flight;
    const run = this.runBatchedIngest(filePath, resolved, opts);
    this.batchedFlights.set(resolved, run);
    try {
      return await run;
    } finally {
      this.batchedFlights.delete(resolved);
    }
  }

  private async runBatchedIngest(
    filePath: string,
    resolved: string,
    opts?: SessionIngestOptions & {
      batchSize?: number;
      onBatch?: (ids: string[]) => void;
    },
  ): Promise<string | undefined> {
    try {
      const current = fileFingerprint(filePath);
      if (
        fingerprintsMatch(this.fingerprints.get(resolved), current) ||
        this.shouldSkipSqliteWal(filePath, current)
      ) {
        const existing = this.sourcesForPath(resolved);
        if (existing[0]) return existing[0].id;
      }
    } catch {
      // Fall through.
    }
    let startFingerprint: FileFingerprint | undefined;
    try {
      startFingerprint = fileFingerprint(filePath);
    } catch {
      // Missing file: the parse below reports the failure.
    }
    const groups = filePath.endsWith(".vscdb")
      ? await readCursorSessionsCooperative(filePath)
      : readMultiSessionEvents(filePath);
    if (!groups) return this.ingestPath(filePath, opts);
    const batchSize = Math.max(1, opts?.batchSize ?? 20);
    const previousIds = new Set(this.sourcesByPath.get(resolved) ?? []);
    // Sources are replaced batch by batch; toggles stay until reconciliation
    // so a refresh never resets preferences for sessions that survive it.
    for (const [id, source] of this.sources) {
      if (path.resolve(source.path) !== resolved) continue;
      this.sources.delete(id);
    }
    let firstId: string | undefined;
    const surviving = new Set<string>();
    for (let offset = 0; offset < groups.length; offset += batchSize) {
      const batchIds: string[] = [];
      for (const events of groups.slice(offset, offset + batchSize)) {
        const snap = snapshotFromEvents(events, filePath);
        if (opts?.skipExisting && this.sources.has(snap.id)) {
          surviving.add(snap.id);
          continue;
        }
        if (!this.toggles.has(snap.id)) this.toggles.set(snap.id, { ...snap.toggles });
        this.sources.set(snap.id, { ...snap, children: [] });
        surviving.add(snap.id);
        batchIds.push(snap.id);
        firstId ??= snap.id;
      }
      this.reindexPaths();
      this.rebuildAll();
      opts?.onBatch?.(batchIds);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Finalize even when the database yielded zero sessions, so stale
    // snapshots cannot outlive an emptied source.
    this.reindexPaths();
    this.rebuildAll();
    const removedIds = [...previousIds].filter((id) => !surviving.has(id));
    for (const id of removedIds) this.toggles.delete(id);
    if (removedIds.length > 0) deleteStoredToggles(this.cacheHome, removedIds);
    let changedDuringRun = startFingerprint == null;
    try {
      changedDuringRun =
        startFingerprint == null ||
        !fingerprintsMatch(startFingerprint, fileFingerprint(filePath));
    } catch {
      changedDuringRun = true;
    }
    if (changedDuringRun) {
      // Commits landed while batches were processing: keep the input
      // fingerprint so the change is detected. A live SQLite WAL never sits
      // still, so an immediate refresh parses the same database forever and
      // session requests wait behind it. The cooldown is the same one the
      // watcher already uses.
      if (startFingerprint) this.fingerprints.set(resolved, startFingerprint);
      else this.fingerprints.delete(resolved);
      const sqlite = resolved.endsWith(".vscdb") || path.basename(resolved) === "opencode.db";
      if (sqlite) this.sqliteIngestAt.set(resolved, Date.now());
      this.scheduleBatchedRefresh(filePath, opts, sqlite ? SQLITE_WAL_REPARSE_COOLDOWN_MS : 0);
    } else {
      this.rememberFingerprint(filePath);
    }
    this.scheduleDump();
    return firstId;
  }

  private scheduleBatchedRefresh(
    filePath: string,
    opts?: SessionIngestOptions & {
      batchSize?: number;
      onBatch?: (ids: string[]) => void;
    },
    delayMs = 0,
  ): void {
    const resolved = path.resolve(filePath);
    if (this.batchedRefreshPending.has(resolved)) return;
    this.batchedRefreshPending.add(resolved);
    const timer = setTimeout(() => {
      this.batchedRefreshPending.delete(resolved);
      void this.ingestPathBatched(filePath, opts).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
  }

  /** True when dump/refresh already knows this file — startup watch can skip re-parse. */
  knowsPath(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return this.fingerprints.has(resolved) || this.sourcesForPath(resolved).length > 0;
  }

  /** Skip the first watch scan when the dump is still a valid read of this file. */
  canSkipStartupIngest(filePath: string): boolean {
    if (!this.knowsPath(filePath)) return false;
    try {
      const current = fileFingerprint(filePath);
      return (
        fingerprintsMatch(this.fingerprints.get(path.resolve(filePath)), current) ||
        this.shouldSkipSqliteWal(filePath, current)
      );
    } catch {
      return false;
    }
  }

  /** Root session ids without refreshLiveFlags — safe inside ingest wrappers. */
  peekRootIds(): string[] {
    return [...this.sources.values()]
      .filter((snap) => snap.parentId == null || !this.sources.has(snap.parentId))
      .map((snap) => snap.id);
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
    opts: Omit<OverviewOptions, "now">,
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
    // Persist preferences immediately on their own lifecycle; the derived
    // snapshot dump may be rebuilt or invalidated without touching them.
    writeStoredToggle(this.cacheHome, id, this.toggles.get(id)!);
    this.rebuildAll();
    this.scheduleDump();
  }
}

export { DEFAULT_WASTE_TOGGLES };
