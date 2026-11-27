import path from "node:path";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { tokenAnalyserHome } from "./config.ts";
import { buildTree } from "./tree.ts";
import { prepareSource, type PreparedSource, type SessionIndex } from "./session-index.ts";
import { computeWaste } from "./waste.ts";
import {
  ingestSessions,
  pricingCacheContext,
  clearLiveReadState,
  pruneInactiveLiveReadStates,
  type IngestOptions,
} from "./ingest.ts";
import { withPricingLock } from "./pricing-lock.ts";
import { BackgroundIngest, type FileUpdate } from "./background-ingest.ts";
import { isLive } from "./cache.ts";
import { isSessionFile } from "./session-files.ts";
import { summarizeSessions } from "./performance.ts";
import {
  DEFAULT_WASTE_TOGGLES,
  addKnownCost,
  emptyMaybeCost,
  type AnalysisSession,
  type SessionListItem,
  type SessionSnapshot,
  type WasteToggleId,
} from "./types.ts";
import {
  behaviorSessionIds, buildOverview, type Overview, type OverviewOptions, type OverviewSliceKey,
} from "./overview.ts";
import {
  fileFingerprint,
  fingerprintsMatch,
  shouldDeferSqliteWalReparse,
  SQLITE_WAL_REPARSE_COOLDOWN_MS,
  readStoreIndex,
  STORE_DUMP_VERSION,
  type FileFingerprint,
} from "./store-dump.ts";
import {
  clearExcludedSessionId,
  deleteStoredToggles,
  excludeSessionId,
  readExcludedSessionIds,
  readStoredToggles,
  removeLinkedImport,
  writeStoredToggle,
  readSourceDetail,
  needsIndexBackfill,
  cachePruneDue,
  recordCachePrune,
  writeStoreChanges,
} from "./store-db.ts";

/** Coalesce dump writes after ingest bursts so a crash loses at most ~2s. */
const DUMP_DEBOUNCE_MS = 2_000;

function isSqliteFile(file: string): boolean {
  return file.endsWith(".vscdb") || path.basename(file) === "opencode.db";
}

function latestActivityIso(session: AnalysisSession): string | null {
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

function toListItem(snap: SessionIndex): SessionListItem {
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
    unpricedRaw: snap.unpricedRaw,
    parse_error: snap.parse_errors.length > 0,
    parse_error_offset: snap.parse_errors[0]?.offset,
    parse_error_message: snap.parse_errors[0]?.message,
    ledger_warning: snap.ledger_warning,
    toolsChars: snap.toolsChars,
    toolsCount: snap.toolsCount,
    skillsChars: snap.skillsChars,
    skillsCount: snap.skillsCount,
  };
}

export type SessionStoreOptions = {
  cacheDir?: string;
};

export type SessionIngestOptions = Pick<IngestOptions, "allowAppend" | "finalized"> & {
  reparse?: boolean;
  /** Stable discovery order for a partial startup reconciliation. */
  precedence?: ReadonlyMap<string, number>;
  /** Keep an already-loaded canonical session when an import has the same id. */
  skipExisting?: boolean;
  /** Clear a previous manual removal if explicitly re-imported. */
  allowExcludedReimport?: boolean;
};

class MissingDetail extends Error {
  constructor(readonly index: SessionIndex) { super("session_detail_changed"); }
}

export class SessionStore {
  /** Accounting stays in memory. Full turns are fetched only for the requested detail tree. */
  private sources = new Map<string, SessionIndex>();
  private snapshots = new Map<string, SessionIndex>();
  private joinedFrom = new Map<string, SessionIndex>();
  private detailViews = new Map<SessionIndex, SessionSnapshot>();
  private roots?: SessionIndex[];
  private pendingSources = new Map<string, PreparedSource>();
  private persistedRevisions = new Map<string, string>();
  private persistedFingerprints = new Map<string, FileFingerprint>();
  private hasPersistedBase = false;
  private accountedPrices = pricingCacheContext();
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
  private readonly parser = new BackgroundIngest();
  private batchedFlights = new Map<string, Promise<string | undefined>>();
  private batchedRefreshPending = new Set<string>();
  /** Last full scan of source mtimes; reads reuse it for up to one second. */
  private lastLiveFlagScanAt = 0;
  private revision = 0;
  private overviewCache = new Map<string, Overview>();
  private excludedIds = new Set<string>();

  get restoredIndex(): boolean {
    return this.hasPersistedBase;
  }

  get dataRevision(): number {
    return this.revision;
  }

  constructor(opts?: SessionStoreOptions) {
    if (opts?.cacheDir) {
      this.cacheHome = path.dirname(opts.cacheDir);
    }
    this.excludedIds = readExcludedSessionIds(this.cacheHome);
  }

  async restoreForStartup(): Promise<number> {
    const prices = pricingCacheContext();
    if (needsIndexBackfill(this.cacheHome, { version: STORE_DUMP_VERSION, pricingContext: prices })) {
      await this.parser.maintain("migrate", this.cacheHome, prices);
    }
    return this.loadDump();
  }

  async pruneCache(): Promise<void> {
    if (!cachePruneDue(this.cacheHome)) return;
    await this.parser.maintain("prune", this.cacheHome, pricingCacheContext());
    recordCachePrune(this.cacheHome);
  }

  /** Queue a dump soon after mutations; coalesces watcher append storms. */
  scheduleDump(): void {
    this.dumpDirty = true;
    if (this.dumpTimer) return;
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

    const rebuilt = new Map<string, SessionIndex>();
    const building = new Set<string>();

    const build = (id: string): SessionIndex => {
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
      const toggles = this.toggles.get(id) ?? DEFAULT_WASTE_TOGGLES;
      const old = this.snapshots.get(id);
      if (old && this.joinedFrom.get(id) === source && old.toggles === toggles &&
          children.length === old.children.length && children.every((child, i) => child === old.children[i])) {
        rebuilt.set(id, old);
        return old;
      }
      const childCost = children.reduce((sum, child) => addKnownCost(sum, child.cost), emptyMaybeCost());
      const { waste } = computeWaste({ turns: source.turns, children, toggles });
      const snapshot: SessionIndex = {
        ...source, children, toggles, waste,
        cost: addKnownCost(source.cost, childCost),
        unpricedRaw: children.reduce((sum, child) => sum + child.unpricedRaw, source.unpricedRaw),
        live: source.live || children.some((child) => child.live),
      };
      snapshot.lastEventAt = latestActivityIso(snapshot);
      rebuilt.set(id, snapshot);
      return snapshot;
    };

    for (const id of this.sources.keys()) build(id);
    this.snapshots = rebuilt;
    this.joinedFrom = new Map(this.sources);
    this.roots = undefined;
    this.revision += 1;
    this.overviewCache.clear();
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

  private sourcesForPath(resolved: string): SessionIndex[] {
    const ids = this.sourcesByPath.get(resolved);
    if (!ids || ids.length === 0) return [];
    const out: SessionIndex[] = [];
    for (const id of ids) {
      const snap = this.sources.get(id);
      if (snap) out.push(snap);
    }
    return out;
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
    this.accountedPrices = pricingCacheContext();
    const dump = readStoreIndex(this.cacheHome, this.accountedPrices);
    const storedToggles = dump?.toggles ?? readStoredToggles(this.cacheHome);
    if (!dump) {
      for (const [id, toggles] of Object.entries(storedToggles)) {
        this.toggles.set(id, { ...toggles });
      }
      return 0;
    }
    this.sources.clear();
    this.toggles.clear();
    this.fingerprints.clear();
    this.pendingSources.clear();
    this.persistedRevisions.clear();
    this.excludedIds = readExcludedSessionIds(this.cacheHome);
    for (const snap of dump.sources) {
      if (!snap?.id || typeof snap.path !== "string" || this.excludedIds.has(snap.id)) continue;
      this.sources.set(snap.id, snap);
      this.persistedRevisions.set(snap.id, snap.revision);
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
    this.hasPersistedBase = true;
    this.persistedFingerprints = new Map(this.fingerprints);
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
    const removedIds = [...this.persistedRevisions.keys()].filter((id) => !this.sources.has(id));
    const removedPaths = [...this.persistedFingerprints.keys()].filter((file) => !this.fingerprints.has(file));
    const updates = [...this.pendingSources.values()].filter(({ index }) =>
      this.sources.get(index.id)?.revision === index.revision &&
      this.persistedRevisions.get(index.id) !== index.revision);
    const fingerprints = [...this.fingerprints].filter(([file, value]) =>
      !fingerprintsMatch(this.persistedFingerprints.get(file), value));
    writeStoreChanges(this.cacheHome, {
      version: STORE_DUMP_VERSION,
      pricingContext: this.accountedPrices,
      replace: !this.hasPersistedBase,
      sources: updates,
      fingerprints,
      removedIds,
      removedPaths,
    });
    this.hasPersistedBase = true;
    for (const id of removedIds) this.persistedRevisions.delete(id);
    for (const { index } of updates) this.persistedRevisions.set(index.id, index.revision);
    this.persistedFingerprints = new Map(this.fingerprints);
    this.pendingSources.clear();
    this.dumpDirty = false;
  }

  private keepSource(
    snap: SessionSnapshot | SessionIndex,
    nextSources: Map<string, SessionIndex>,
    nextToggles: Map<string, Record<WasteToggleId, boolean>>,
    live?: boolean,
  ): void {
    if (this.excludedIds.has(snap.id)) return;
    // Prefer Cursor's state.vscdb over agent-transcript JSONL, including when
    // the vscdb row only exists in the dump and this refresh never opens it
    // (heavy .vscdb paths are deferred until after listen).
    const incumbent =
      nextSources.get(snap.id) ?? this.sources.get(snap.id);
    if (incumbent?.path.endsWith(".vscdb") && !snap.path.endsWith(".vscdb")) {
      return;
    }
    const index = "tree" in snap ? this.prepare(snap) : snap;
    nextSources.set(index.id, live == null || live === index.live ? index : { ...index, live });
    nextToggles.set(snap.id, this.toggles.get(snap.id) ?? { ...snap.toggles });
  }

  private prepare(snap: SessionSnapshot): SessionIndex {
    const prepared = prepareSource(snap);
    this.pendingSources.set(snap.id, prepared);
    return prepared.index;
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
      void Promise.allSettled(paths.map((pendingPath) =>
        this.ingestPathBatched(pendingPath, { reparse: true }),
      )).then(resolveBatch);
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
      if (source.finalized) continue;
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
    opts?: {
      onError?: (filePath: string, err: Error) => void;
      /** If provided, paths outside this full scan and its deferred/linked files are obsolete. */
      retainPaths?: readonly string[];
    },
  ): void {
    let mutated = false;
    if (opts?.retainPaths) {
      const retained = new Set([...paths, ...opts.retainPaths].map((file) => path.resolve(file)));
      for (const [id, source] of this.sources) {
        if (retained.has(path.resolve(source.path))) continue;
        this.sources.delete(id);
        this.toggles.delete(id);
        clearLiveReadState(source.path);
        mutated = true;
      }
      for (const file of this.fingerprints.keys()) {
        if (retained.has(file)) continue;
        this.fingerprints.delete(file);
        this.sqliteIngestAt.delete(file);
        this.liveMtimeMs.delete(file);
        mutated = true;
      }
      if (mutated) this.reindexPaths();
    }
    const nextSources = new Map<string, SessionIndex>();
    const nextToggles = new Map<string, Record<WasteToggleId, boolean>>();
    const nextFingerprints = new Map<string, FileFingerprint>();
    const refreshedPaths = new Set<string>();

    for (const p of paths) {
      if (!isSessionFile(p)) continue;
      const resolved = path.resolve(p);
      refreshedPaths.add(resolved);
      try {
        const current = fileFingerprint(p);
        const previous = this.sourcesForPath(resolved);
        const finalized = previous.some((snap) => snap.finalized);
        const recorded = this.fingerprints.get(resolved);
        // Trust the fingerprint over the 2-minute isLive window. Cursor's
        // state.vscdb (~GB) stays "live" whenever the app is open; requiring
        // !isLive forced a full SQLite re-parse on every engine restart even
        // when inode/size/mtime/WAL were unchanged since the dump.
        // Empty previous is OK: Cursor JSONL dupes are fingerprint-only when
        // state.vscdb already owns those session ids.
        const isSqlite = p.endsWith(".vscdb") || path.basename(p) === "opencode.db";
        const expiredLiveFile = !isSqlite && !isLive(current.mtimeMs) && previous.some((snap) => snap.live);
        const unchanged = !expiredLiveFile && fingerprintsMatch(recorded, current);
        const deferredWal = !unchanged && this.shouldSkipSqliteWal(p, current);
        if (unchanged || deferredWal) {
          for (const snap of previous) {
            // vscdb live is derived from lastEventAt, not file mtime.
            const reusedLive = !snap.finalized && (isSqlite
              ? snap.lastEventAt != null && isLive(Date.parse(snap.lastEventAt))
              : isLive(current.mtimeMs));
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
          finalized,
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
    const prices = pricingCacheContext();
    const refreshedSources = new Map<string, SessionIndex>();
    const updated = new Map<string, PreparedSource>();
    const refreshedToggles = new Map<string, Record<WasteToggleId, boolean>>();
    const refreshedFingerprints = new Map<string, FileFingerprint>();

    for (const filePath of new Set([...this.sources.values()].map((source) => source.path))) {
      const finalized = this.sourcesForPath(path.resolve(filePath)).some((snap) => snap.finalized);
      for (const refreshed of ingestSessions(filePath, { cacheHome: this.cacheHome, finalized })) {
        if (refreshedSources.get(refreshed.id)?.path.endsWith(".vscdb") && !filePath.endsWith(".vscdb")) continue;
        const prepared = prepareSource(refreshed);
        refreshedSources.set(refreshed.id, prepared.index);
        updated.set(refreshed.id, prepared);
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

    this.accountedPrices = prices;
    this.pendingSources = updated;
    this.sources = refreshedSources;
    this.toggles = refreshedToggles;
    this.fingerprints = refreshedFingerprints;
    this.reindexPaths();
    this.rebuildAll();
    this.scheduleDump();
    return refreshedSources.size;
  }

  /** Called inside the price-card transaction. Reads keep using the previous
   * complete ledger until all files have been priced successfully. */
  async repriceInBackground(): Promise<number> {
    const prices = pricingCacheContext();
    if (prices === this.accountedPrices) {
      this.overviewCache.clear(); // publication dates may have changed
      return this.sources.size;
    }
    const previous = new Map(this.sources);
    const next = new Map<string, SessionIndex>();
    const details = new Map(this.pendingSources);
    const fingerprints = new Map(this.fingerprints);
    const changedWhileReading: string[] = [];
    for (const file of new Set([...previous.values()].map((source) => source.path))) {
      const resolved = path.resolve(file);
      const stored = this.sourcesForPath(resolved);
      const input = fileFingerprint(file);
      const update = await this.parser.read(file, {
        cacheHome: this.cacheHome, finalized: stored.some((snap) => snap.finalized),
      }, new Map(stored.map((snap) => [snap.id, snap.revision])), prices);
      if (!update) throw new Error("prices_changed_during_recalculation");
      const updates = new Map(update.updated.map((item) => [item.index.id, item]));
      for (const id of update.ids) {
        if (next.get(id)?.path.endsWith(".vscdb") && !file.endsWith(".vscdb")) continue;
        const prepared = updates.get(id);
        const index = prepared?.index ?? previous.get(id);
        if (!index) throw new Error("session_changed_during_recalculation");
        next.set(id, index);
        if (prepared) details.set(id, prepared);
      }
      fingerprints.set(resolved, input);
      if (!fingerprintsMatch(input, fileFingerprint(file))) changedWhileReading.push(file);
    }
    if (prices !== pricingCacheContext() || previous.size !== this.sources.size ||
        [...previous].some(([id, old]) => this.sources.get(id)?.revision !== old.revision)) {
      throw new Error("session_changed_during_recalculation");
    }
    this.accountedPrices = prices;
    this.pendingSources = details;
    this.sources = next;
    this.fingerprints = fingerprints;
    for (const [id, source] of next) {
      if (!this.toggles.has(id)) this.toggles.set(id, { ...source.toggles });
    }
    this.reindexPaths();
    this.rebuildAll();
    this.scheduleDump();
    for (const file of changedWhileReading) this.scheduleBatchedRefresh(file, { reparse: true });
    return next.size;
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

  /**
   * Remove a session from the workbench index and remember its ID so local
   * auto-discovery does not immediately restore it. Never deletes external agent logs.
   */
  removeSession(id: string): boolean {
    const existing = this.sources.get(id);
    if (!existing) return false;
    this.excludedIds.add(id);
    excludeSessionId(this.cacheHome, id);
    this.sources.delete(id);
    this.pendingSources.delete(id);
    this.toggles.delete(id);
    this.detailViews.delete(existing);
    deleteStoredToggles(this.cacheHome, [id]);

    const resolved = path.resolve(existing.path);
    this.reindexPaths();
    if (!(this.sourcesByPath.get(resolved)?.length)) {
      const importsRoot = path.resolve(path.join(this.cacheHome ?? tokenAnalyserHome(), "imports"));
      if (resolved.startsWith(`${importsRoot}${path.sep}`)) {
        try {
          unlinkSync(resolved);
        } catch {
          // Already removed or read-only.
        }
        this.fingerprints.delete(resolved);
      }
      removeLinkedImport(resolved, this.cacheHome);
    }
    this.rebuildAll();
    this.dumpDirty = true;
    this.dump({ force: true });
    return true;
  }

  private installFile(
    file: string,
    update: FileUpdate,
    input: FileFingerprint,
    opts?: SessionIngestOptions,
  ): string | undefined {
    const resolved = path.resolve(file);
    const ids = new Set(update.ids);
    const removedIds = (this.sourcesByPath.get(resolved) ?? []).filter((id) => !ids.has(id));
    for (const id of removedIds) {
      this.sources.delete(id);
      this.pendingSources.delete(id);
      this.toggles.delete(id);
    }
    let changed = removedIds.length > 0;
    for (const prepared of update.updated) {
      const snap = prepared.index;
      if (opts?.allowExcludedReimport && this.excludedIds.delete(snap.id)) {
        clearExcludedSessionId(this.cacheHome, snap.id);
      }
      if (this.excludedIds.has(snap.id)) continue;
      const existing = this.sources.get(snap.id);
      if (opts?.skipExisting && existing) continue;
      if (existing?.revision === snap.revision &&
          (this.persistedRevisions.get(snap.id) === snap.revision ||
           this.pendingSources.get(snap.id)?.index.revision === snap.revision)) continue;
      if (existing && existing.path !== snap.path && opts?.precedence &&
          !(snap.path.endsWith(".vscdb") && !existing.path.endsWith(".vscdb")) &&
          (opts.precedence.get(existing.path) ?? Infinity) > (opts.precedence.get(snap.path) ?? Infinity)) continue;
      if (existing?.path.endsWith(".vscdb") && !file.endsWith(".vscdb")) continue;
      if (!this.toggles.has(snap.id)) this.toggles.set(snap.id, { ...snap.toggles });
      this.sources.set(snap.id, snap);
      this.pendingSources.set(snap.id, prepared);
      changed = true;
    }
    if (removedIds.length) deleteStoredToggles(this.cacheHome, removedIds);
    const fingerprintChanged = !fingerprintsMatch(this.fingerprints.get(resolved), input);
    this.fingerprints.set(resolved, input);
    if (isSqliteFile(resolved)) this.sqliteIngestAt.set(resolved, Date.now());
    if (changed) {
      this.reindexPaths();
      this.rebuildAll();
    }
    if (changed || fingerprintChanged) this.scheduleDump();
    return update.ids.find((id) => !this.excludedIds.has(id));
  }

  ingestPath(
    filePath: string,
    opts?: SessionIngestOptions,
  ): string | undefined {
    const resolved = path.resolve(filePath);
    try {
      const current = fileFingerprint(filePath);
      if (!opts?.reparse && (
        fingerprintsMatch(this.fingerprints.get(resolved), current) ||
        this.shouldSkipSqliteWal(filePath, current)
      )) {
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
      finalized: opts?.finalized,
    });
    return this.installFile(filePath, {
      ids: snapshots.map((snap) => snap.id),
      updated: snapshots.map((snap) => prepareSource(snap)),
    }, fileFingerprint(filePath), opts);
  }

  /**
   * Parse away from the HTTP thread, then publish one consistent file generation.
   */
  async ingestPathBatched(
    filePath: string,
    opts?: SessionIngestOptions,
  ): Promise<string | undefined> {
    const resolved = path.resolve(filePath);
    const flight = this.batchedFlights.get(resolved);
    if (flight) return flight;
    const run = withPricingLock(() => this.runBatchedIngest(filePath, resolved, opts));
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
    opts?: SessionIngestOptions,
  ): Promise<string | undefined> {
    const input = fileFingerprint(filePath);
    if (!opts?.reparse && (fingerprintsMatch(this.fingerprints.get(resolved), input) ||
        this.shouldSkipSqliteWal(filePath, input))) {
      // A matched fingerprint can legitimately contribute zero sessions.
      return this.sourcesByPath.get(resolved)?.[0];
    }
    const known = new Map(this.sourcesForPath(resolved).map((source) => [source.id, source.revision]));
    const prices = pricingCacheContext();
    const update = await this.parser.read(filePath, {
      cacheHome: this.cacheHome, allowAppend: opts?.allowAppend, finalized: opts?.finalized,
    }, known, prices);
    if (!existsSync(filePath)) {
      this.removePath(filePath);
      return undefined;
    }
    const current = fileFingerprint(filePath);
    const changedDuringRun = !fingerprintsMatch(input, current);
    if (!update || prices !== pricingCacheContext() ||
        known.size !== (this.sourcesByPath.get(resolved)?.length ?? 0) ||
        [...known].some(([id, version]) => this.sources.get(id)?.revision !== version)) {
      this.scheduleBatchedRefresh(filePath, { ...opts, reparse: true });
      return this.sourcesByPath.get(resolved)?.[0];
    }
    const firstId = this.installFile(filePath, update, input, opts);
    if (changedDuringRun) {
      this.scheduleBatchedRefresh(filePath, opts, isSqliteFile(filePath) ? SQLITE_WAL_REPARSE_COOLDOWN_MS : 0);
    }
    return firstId;
  }

  private scheduleBatchedRefresh(
    filePath: string,
    opts?: SessionIngestOptions,
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

  sourceOwners(): Map<string, string> {
    return new Map([...this.sources].map(([id, source]) => [id, source.path]));
  }

  needsStartupIngest(file: string, imported = false): boolean {
    const resolved = path.resolve(file);
    try {
      const current = fileFingerprint(file);
      if (!fingerprintsMatch(this.fingerprints.get(resolved), current)) return true;
      const previous = this.sourcesForPath(resolved);
      if (imported && previous.length === 0) return true;
      return !isSqliteFile(file) && !isLive(current.mtimeMs) && previous.some((source) => source.live && !source.finalized);
    } catch {
      return true;
    }
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

  /** Session ids currently indexed for a given source file path. */
  idsForPath(filePath: string): string[] {
    return [...(this.sourcesByPath.get(path.resolve(filePath)) ?? [])];
  }

  private rootSnapshots(): SessionIndex[] {
    this.refreshLiveFlags();
    if (this.roots) return this.roots;
    const roots = [...this.snapshots.values()].filter(
      (s) => s.parentId == null || !this.sources.has(s.parentId),
    );
    roots.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      const aTime = a.lastEventAt ?? "";
      const bTime = b.lastEventAt ?? "";
      return bTime.localeCompare(aTime);
    });
    this.roots = roots;
    return roots;
  }

  list(): SessionListItem[] {
    return this.rootSnapshots().map(toListItem);
  }

  overview(opts: OverviewOptions): Overview {
    this.refreshLiveFlags();
    if (!opts.now) return buildOverview(this.rootSnapshots(), opts);
    const key = JSON.stringify(opts);
    const cached = this.overviewCache.get(key);
    if (cached) return cached;
    const result = buildOverview(this.rootSnapshots(), opts);
    if (this.overviewCache.size >= 12) {
      const oldest = this.overviewCache.keys().next().value;
      if (oldest != null) this.overviewCache.delete(oldest);
    }
    this.overviewCache.set(key, result);
    return result;
  }

  behaviorSessions(
    behavior: OverviewSliceKey,
    opts: Pick<OverviewOptions, "source" | "sinceMs" | "untilMs">,
  ): string[] {
    return behaviorSessionIds(this.rootSnapshots(), behavior, opts);
  }

  hasSession(id: string): boolean {
    return this.sources.has(id);
  }

  parentOf(id: string): string | null {
    return this.sources.get(id)?.parentId ?? null;
  }

  private detail(index: SessionIndex): SessionSnapshot {
    const cached = this.detailViews.get(index);
    if (cached) return cached;
    const pending = this.pendingSources.get(index.id);
    const raw: SessionSnapshot | undefined = pending?.index.revision === index.revision
      ? JSON.parse(pending.json) : readSourceDetail(this.cacheHome, index);
    if (!raw) throw new MissingDetail(index);
    const snapshot = rebuildDerived({
      ...raw,
      live: index.live,
      toggles: index.toggles,
      children: index.children.map((child) => this.detail(child)),
    });
    this.detailViews.set(index, snapshot);
    if (this.detailViews.size > 8) {
      const oldest = this.detailViews.keys().next().value;
      if (oldest) this.detailViews.delete(oldest);
    }
    return snapshot;
  }

  get(id: string): SessionSnapshot | undefined {
    this.refreshLiveFlags();
    const repaired = new Set<string>();
    for (;;) {
      const index = this.snapshots.get(id);
      if (!index) return undefined;
      try {
        return this.detail(index);
      } catch (error) {
        if (!(error instanceof MissingDetail) || repaired.has(error.index.path)) throw error;
        repaired.add(error.index.path);
        this.persistedRevisions.delete(error.index.id);
        // Never join evidence written by another process to an older parent.
        this.ingestPath(error.index.path, { reparse: true, finalized: error.index.finalized });
      }
    }
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
  }
}

export { DEFAULT_WASTE_TOGGLES };
