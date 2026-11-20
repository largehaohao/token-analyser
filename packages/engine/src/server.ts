import "./node-guard.ts";
import http from "node:http";
import { execFile } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUserConfig, tokenAnalyserHome } from "./config.ts";
import {
  restoreRateCard,
  updateRateCardFromOfficial,
  type PricingUpdateOptions,
} from "./pricing-update.ts";
import {
  restoreApiPrices,
  startQwenPriceAutoRefresh,
  updateQwenPricesFromOfficial,
  type QwenPricingUpdateOptions,
} from "./qwen-pricing.ts";
import {
  restorePriceCatalog,
  startCatalogAutoRefresh,
  updateCatalogFromOfficial,
  type CatalogUpdateOptions,
} from "./price-catalog.ts";
import { buildPriceSheet } from "./price-sheet.ts";
import { SessionStore, type SessionIngestOptions } from "./store.ts";
import {
  EnvironmentRequestError,
  RemoteEnvironmentHub,
  SESSION_ENVIRONMENTS,
  type SessionEnvironmentSource,
} from "./environments.ts";
import { withPricingLock } from "./pricing-lock.ts";
import { fetchPowerRange } from "./power.ts";
import { fetchTempSnapshot, fetchTempHistory } from "./temps.ts";
import { watchSessions } from "./watch.ts";
import { collectSessionFiles } from "./session-files.ts";
import { resolveImportTarget } from "./import-path.ts";
import { isLoopbackHost, isStateChangeAllowed } from "./request-guard.ts";
import { powerPreviewEnabled } from "./runtime-config.ts";
import type { SessionSnapshot, WasteToggleId } from "./types.ts";

const CORS_ORIGIN = "http://127.0.0.1:7788";
const HOST = "127.0.0.1";
const DEFAULT_PORT = 7789;
const HEARTBEAT_MS = 15_000;
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

type SseEvent = "session_added" | "session_updated" | "session_error";


export function isTokenAnalyserEngineCommand(command: string): boolean {
  return (
    command.includes("start-engine.mjs") ||
    command.includes("packages/engine/src/server.ts") ||
    command.includes("--import tsx src/server.ts") ||
    command.includes("--import tsx src\\server.ts")
  );
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000 }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

/** A previous engine that never exited holds the port and the store lock. */
export async function signalStaleEngine(port: number): Promise<string[]> {
  if (process.platform === "win32") return [];
  const stopped: string[] = [];
  const listed = await execFileText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  for (const pid of listed.split("\n").map((item) => item.trim()).filter(Boolean)) {
    if (pid === String(process.pid) || pid === String(process.ppid)) continue;
    const command = (await execFileText("ps", ["-p", pid, "-o", "command="])).trim();
    if (!isTokenAnalyserEngineCommand(command)) continue;
    try {
      process.kill(Number(pid), "SIGTERM");
      stopped.push(pid);
      console.error(`token-analyser restart: stopping previous engine pid ${pid}`);
    } catch {
      // It already exited.
    }
  }
  return stopped;
}

async function waitForExit(pids: string[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.error("token-analyser restart: previous engine is still exiting; continuing");
}

const WASTE_TOGGLE_IDS = new Set<WasteToggleId>([
  "poll",
  "reread",
  "compaction_loop",
  "idle_subagents",
  "coord",
  "healthy_subagents",
  "planning",
  "code",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,PATCH,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Filename",
    ...extra,
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

async function readBody(
  req: http.IncomingMessage,
  limit = MAX_IMPORT_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      const err = new Error("payload_too_large") as Error & { status?: number };
      err.status = 413;
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parsePathname(url: string | undefined): string {
  return new URL(url ?? "/", "http://localhost").pathname;
}

function isImportFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".jsonl") || lower.endsWith(".ndjson");
}

function decodeImportFilename(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function collectImportFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isImportFilename(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      files.push({ path: filePath, mtimeMs: statSync(filePath).mtimeMs });
    } catch {
      // Skip a file removed while the directory is being scanned.
    }
  }
  return files
    // Newest first: when several durable imports contain the same session id,
    // `skipExisting` keeps the most recent copy and ignores stale duplicates.
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
    .map((entry) => entry.path);
}

export function loadImportedSessions(
  store: SessionStore,
  importsDir: string,
  onError?: (filePath: string, err: Error) => void,
): string[] {
  const loaded: string[] = [];
  for (const filePath of collectImportFiles(importsDir)) {
    try {
      const id = store.ingestPath(filePath, { skipExisting: true });
      if (id) loaded.push(id);
    } catch (err) {
      onError?.(
        filePath,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
  return loaded;
}

function uniqueImportPath(importsDir: string, filename: string): string {
  const safe = path.basename(filename);
  const parsed = path.parse(safe);
  let candidate = path.join(importsDir, safe);
  for (let suffix = 2; existsSync(candidate); suffix += 1) {
    candidate = path.join(importsDir, `${parsed.name}-${suffix}${parsed.ext}`);
  }
  return candidate;
}

function removeFailedImport(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // The failed copy may already have been removed by another process.
  }
}

function errorIdFromPath(filePath: string): string {
  const base = path.basename(filePath);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function wireStoreChangeEvents(
  store: SessionStore,
  onChange: (id: string, isNew: boolean) => void,
  onError: (id: string, reason: string) => void,
): void {
  const marker = "__changeEventsWired" as const;
  const tagged = store as SessionStore & { [marker]?: boolean };
  if (tagged[marker]) return;
  tagged[marker] = true;

  const notifyIngested = (id: string | undefined, idsBefore: Set<string>) => {
    if (!id) return;
    const snap = store.get(id);
    const parentId = snap?.parentId;
    const isRoot = parentId == null || !store.get(parentId);
    const isNew = isRoot && !idsBefore.has(id);
    onChange(id, isNew);
    if (snap?.parentId) onChange(snap.parentId, false);
  };

  const origIngest = store.ingestPath.bind(store);
  store.ingestPath = (filePath: string, ingestOptions?: SessionIngestOptions) => {
    try {
      // Avoid store.list() here: it runs refreshLiveFlags and can re-enter ingest.
      const idsBefore = new Set(store.peekRootIds());
      const id = origIngest(filePath, ingestOptions);
      notifyIngested(id, idsBefore);
      return id;
    } catch (err) {
      onError(
        errorIdFromPath(filePath),
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  };

  const origBatched = store.ingestPathBatched.bind(store);
  store.ingestPathBatched = async (filePath, ingestOptions) => {
    try {
      const idsBefore = new Set(store.peekRootIds());
      const id = await origBatched(filePath, {
        ...ingestOptions,
        onBatch: (ids) => {
          ingestOptions?.onBatch?.(ids);
          for (const batchId of ids) notifyIngested(batchId, idsBefore);
        },
      });
      return id;
    } catch (err) {
      onError(
        errorIdFromPath(filePath),
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  };

  const origSetToggles = store.setToggles.bind(store);
  store.setToggles = (
    id: string,
    toggles: Partial<Record<WasteToggleId, boolean>>,
  ) => {
    if (!store.get(id)) return;
    origSetToggles(id, toggles);
    onChange(id, false);
  };

  const origRemove = store.removePath.bind(store);
  store.removePath = (filePath: string) => {
    const removed = origRemove(filePath);
    if (removed) {
      onChange(removed.id, false);
      if (removed.parentId) onChange(removed.parentId, false);
    }
    return removed;
  };
}

async function handleImport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SessionStore,
  maxImportBytes = MAX_IMPORT_BYTES,
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.startsWith("application/x-ndjson")) {
    const encodedFilename = req.headers["x-filename"];
    if (!encodedFilename || Array.isArray(encodedFilename)) {
      sendJson(res, 400, { error: "missing_filename" });
      return;
    }
    const filename = decodeImportFilename(encodedFilename);
    if (!filename) {
      sendJson(res, 400, { error: "invalid_filename" });
      return;
    }
    if (!isImportFilename(filename)) {
      sendJson(res, 400, { error: "invalid_filename" });
      return;
    }

    const body = await readBody(req, maxImportBytes);
    const importsDir = path.join(tokenAnalyserHome(), "imports");
    mkdirSync(importsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(importsDir, 0o700);
    } catch {
      // Best-effort tightening of a pre-existing directory.
    }
    const dest = uniqueImportPath(importsDir, filename);
    writeFileSync(dest, body, { mode: 0o600 });

    const id = store.ingestPath(dest, { skipExisting: true });
    if (!id) {
      removeFailedImport(dest);
      sendJson(res, 500, { error: "ingest_failed" });
      return;
    }
    const snap = store.get(id);
    sendJson(res, 200, snap);
    return;
  }

  if (contentType.includes("application/json")) {
    let body: { path?: string };
    try {
      body = JSON.parse((await readBody(req, maxImportBytes)).toString("utf8")) as {
        path?: string;
      };
    } catch (err) {
      if ((err as { status?: number }).status === 413) throw err;
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    const requestedPath = body && typeof body.path === "string" ? body.path : undefined;
    if (!requestedPath) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }
    const resolved = resolveImportTarget(requestedPath);
    if (!resolved.ok) {
      sendJson(res, 400, { error: resolved.error });
      return;
    }

    const id = store.ingestPath(resolved.path);
    if (!id) {
      sendJson(res, 500, { error: "ingest_failed" });
      return;
    }
    const snap = store.get(id);
    sendJson(res, 200, snap);
    return;
  }

  if (contentType.startsWith("multipart/form-data")) {
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      sendJson(res, 400, { error: "invalid_multipart" });
      return;
    }

    const boundary = boundaryMatch[1]!;
    const raw = (await readBody(req, maxImportBytes)).toString("binary");
    const parts = raw.split(`--${boundary}`);
    let filename: string | undefined;
    let fileData = "";

    for (const part of parts) {
      if (!part || part === "--\r\n" || part === "--") continue;
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd);
      const data = part.slice(headerEnd + 4).replace(/\r\n$/, "");
      const nameMatch = headers.match(/name="([^"]+)"/);
      const fileMatch = headers.match(/filename="([^"]+)"/);
      if (nameMatch?.[1] === "file" && fileMatch?.[1]) {
        filename = path.basename(fileMatch[1]);
        fileData = data;
        break;
      }
    }

    if (!filename) {
      sendJson(res, 400, { error: "missing_file" });
      return;
    }
    if (!isImportFilename(filename)) {
      sendJson(res, 400, { error: "invalid_filename" });
      return;
    }

    const importsDir = path.join(tokenAnalyserHome(), "imports");
    mkdirSync(importsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(importsDir, 0o700);
    } catch {
      // Best-effort tightening of a pre-existing directory.
    }
    const dest = uniqueImportPath(importsDir, filename);
    writeFileSync(dest, fileData, { encoding: "binary", mode: 0o600 });

    const id = store.ingestPath(dest, { skipExisting: true });
    if (!id) {
      removeFailedImport(dest);
      sendJson(res, 500, { error: "ingest_failed" });
      return;
    }
    const snap = store.get(id);
    sendJson(res, 200, snap);
    return;
  }

  sendJson(res, 400, { error: "unsupported_content_type" });
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  staticDir: string,
): boolean {
  const pathname = parsePathname(req.url);
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const resolved = path.resolve(staticDir, rel);

  const staticRoot = path.resolve(staticDir);
  const relative = path.relative(staticRoot, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }

  let filePath = resolved;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(staticDir, "index.html");
  }

  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  const ext = path.extname(filePath);
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };

  res.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": types[ext] ?? "application/octet-stream",
  });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    // The file can disappear between the existence check and the read.
    if (!res.headersSent) sendJson(res, 404, { error: "not_found" });
    else res.destroy();
  });
  res.on("error", () => stream.destroy());
  stream.pipe(res);
  return true;
}

type PricingSourceResult = {
  status: string;
  asOf?: string;
  modelCount?: number;
};

/**
 * Refresh the Codex credit card and the Qwen API rates from their official
 * sources. Each source is independent: one unreachable publisher must not
 * discard the other's fresh rates, and a recalculation failure rolls both
 * config files back.
 */
async function runPricingUpdate(
  store: SessionStore,
  pricingUpdate?: PricingUpdateOptions,
  qwenPricingUpdate?: QwenPricingUpdateOptions,
  catalogUpdate?: CatalogUpdateOptions,
): Promise<{ error?: string; body?: Record<string, unknown> }> {
  const catalogEnabled = catalogUpdate?.enabled !== false;
  const [codexUpdate, qwenUpdate, catalogUpdateResult] = await Promise.all([
    (async () => {
      try {
        const result = await updateRateCardFromOfficial(pricingUpdate);
        return {
          source: { status: "ok", asOf: result.asOf, modelCount: result.modelCount } satisfies PricingSourceResult,
          previous: result.previousContent,
        };
      } catch (err) {
        return {
          source: {
            status: err instanceof Error && err.message
              ? err.message
              : "official_pricing_unavailable",
          } satisfies PricingSourceResult,
          previous: undefined,
        };
      }
    })(),
    (async () => {
      try {
        const result = await updateQwenPricesFromOfficial(qwenPricingUpdate);
        return {
          source: { status: "ok", asOf: result.asOf, modelCount: result.modelCount } satisfies PricingSourceResult,
          previous: result.previousContent,
        };
      } catch (err) {
        return {
          source: {
            status: err instanceof Error && err.message
              ? err.message
              : "qwen_pricing_unavailable",
          } satisfies PricingSourceResult,
          previous: undefined,
        };
      }
    })(),
    (async () => {
      if (!catalogEnabled) return null;
      try {
        return await updateCatalogFromOfficial(catalogUpdate);
      } catch (err) {
        return {
          failed: err instanceof Error && err.message ? err.message : "catalog_read_failed",
        };
      }
    })(),
  ]);

  const codex = codexUpdate.source;
  const qwen = qwenUpdate.source;
  const catalogSources = catalogUpdateResult && "sources" in catalogUpdateResult
    ? catalogUpdateResult.sources
    : [];
  const catalogOk = catalogSources.some((source) => source.status === "ok");
  if (codex.status !== "ok" && qwen.status !== "ok" && !catalogOk) {
    const catalogStatus = catalogUpdateResult && "failed" in catalogUpdateResult
      ? catalogUpdateResult.failed
      : catalogSources.find((source) => source.status !== "ok")?.status;
    return { error: codex.status !== "ok" ? codex.status : catalogStatus ?? qwen.status };
  }

  try {
    store.refreshPricing();
  } catch {
    try {
      if (codexUpdate.previous) restoreRateCard(codexUpdate.previous, pricingUpdate?.rateCardPath);
      if (qwenUpdate.previous) restoreApiPrices(qwenUpdate.previous, qwenPricingUpdate?.apiPricesPath);
      if (catalogUpdateResult && "previousContent" in catalogUpdateResult && catalogUpdateResult.changed) {
        restorePriceCatalog(catalogUpdateResult.previousContent, catalogUpdate?.catalogPath);
      }
    } catch {
      return { error: "pricing_recalculation_rollback_failed" };
    }
    return { error: "pricing_recalculation_failed" };
  }

  const body: Record<string, unknown> = {
    asOf: codex.asOf ?? "",
    modelCount: codex.modelCount ?? 0,
    codex,
    qwen,
  };
  if (catalogEnabled) {
    body.sources = [
      { id: "codex", label: "Codex", ...codex },
      { id: "qwen", label: "千问", ...qwen },
      ...catalogSources,
    ];
  }
  return { body };
}

export async function startServer(opts?: {
  port?: number;
  store?: SessionStore;
  /** Remote session mirrors. Tests inject a hub that does not open SSH. */
  environmentHub?: SessionEnvironmentSource;
  staticDir?: string;
  maxImportBytes?: number;
  pricingUpdate?: PricingUpdateOptions;
  qwenPricingUpdate?: QwenPricingUpdateOptions;
  catalogUpdate?: CatalogUpdateOptions;
  /** Retry bind when the previous process still holds the port during dump. */
  listenRetry?: { retries?: number; retryMs?: number };
}): Promise<{
  url: string;
  close: () => Promise<void>;
  onIngestError: (id: string, reason: string) => void;
}> {
  const store = opts?.store ?? new SessionStore();
  const environmentHub = opts?.environmentHub ?? new RemoteEnvironmentHub();

  async function resolveSessionStore(reqUrl: string | undefined): Promise<SessionStore> {
    const env = new URL(reqUrl ?? "/", "http://localhost").searchParams.get("env");
    if (env == null || env === "" || env === "local") return store;
    try {
      const force = new URL(reqUrl ?? "/", "http://localhost").searchParams.get("refresh") === "1";
      return await environmentHub.prepare(env, { force });
    } catch (err) {
      if (err instanceof EnvironmentRequestError) throw err;
      console.error(
        `environment ${env}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new EnvironmentRequestError(502, "environment_unavailable");
    }
  }
  const staticDir = opts?.staticDir;
  const maxImportBytes = opts?.maxImportBytes ?? MAX_IMPORT_BYTES;
  const port =
    opts?.port ??
    (process.env.PORT ? Number.parseInt(process.env.PORT, 10) : DEFAULT_PORT);
  const listenRetries =
    opts?.listenRetry?.retries ?? (port === 0 ? 0 : 40);
  const listenRetryMs = opts?.listenRetry?.retryMs ?? 250;

  const sseClients = new Set<http.ServerResponse>();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function broadcast(event: SseEvent, data: { id: string; reason?: string }): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      // write() returning false does not throw: a client that stops reading
      // must be disconnected instead of buffering updates without bound.
      if (client.writableLength > MAX_SSE_BUFFER_BYTES) {
        sseClients.delete(client);
        client.destroy();
        continue;
      }
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
        client.destroy();
      }
    }
  }

  const notifySessionError = (id: string, reason: string): void => {
    broadcast("session_error", { id, reason });
  };

  wireStoreChangeEvents(
    store,
    (id, isNew) => {
      broadcast(isNew ? "session_added" : "session_updated", { id });
    },
    notifySessionError,
  );

  const server = http.createServer(async (req, res) => {
    try {
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS" &&
      !isStateChangeAllowed(req.headers)
    ) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const pathname = parsePathname(req.url);
    let parts: string[];
    try { parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); }
    catch { sendJson(res, 400, { error: "invalid_path" }); return; }

    if (req.method === "GET" && parts[0] === "config" && parts.length === 1) {
      sendJson(res, 200, { powerPreview: powerPreviewEnabled() });
      return;
    }

    if (req.method === "GET" && parts[0] === "environments" && parts.length === 1) {
      sendJson(res, 200, { environments: SESSION_ENVIRONMENTS });
      return;
    }

    if (req.method === "GET" && parts[0] === "prices" && parts.length === 1) {
      sendJson(res, 200, buildPriceSheet());
      return;
    }

    if (req.method === "GET" && parts[0] === "sessions" && parts.length === 1) {
      const active = await resolveSessionStore(req.url);
      sendJson(res, 200, { sessions: active.list() });
      return;
    }

    if (
      req.method === "POST" &&
      parts[0] === "pricing" &&
      parts[1] === "update" &&
      parts.length === 2
    ) {
      const origin = req.headers.origin;
      const contentType = req.headers["content-type"] ?? "";
      if (
        (origin && origin !== CORS_ORIGIN) ||
        !contentType.startsWith("application/json")
      ) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const update = await withPricingLock(() =>
        runPricingUpdate(store, opts?.pricingUpdate, opts?.qwenPricingUpdate, opts?.catalogUpdate),
      );

      if (update.error) {
        const unavailable = update.error.endsWith("_unavailable");
        sendJson(res, unavailable ? 502 : 500, { error: update.error });
        return;
      }

      sendJson(res, 200, update.body);
      return;
    }

    if (req.method === "GET" && parts[0] === "overview" && parts.length === 1) {
      const config = loadUserConfig();
      const url = new URL(req.url ?? "/", "http://localhost");
      const sinceRaw = url.searchParams.get("since");
      const untilRaw = url.searchParams.get("until");
      const daysRaw = url.searchParams.get("days");
      const source = url.searchParams.get("source");
      if (source != null && source !== "all" && source !== "codex" && source !== "claude" && source !== "cursor" && source !== "pi" && source !== "dsh" && source !== "opencode" && source !== "antigravity") {
        sendJson(res, 400, { error: "invalid_source" });
        return;
      }
      const timezoneRaw = url.searchParams.get("timezone_offset_minutes");
      const timezone = url.searchParams.get("timezone")?.trim();
      const modelRaw = url.searchParams.get("model")?.trim();
      const sinceMs = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
      const untilMs = untilRaw ? Date.parse(untilRaw) : Number.NaN;
      const dayCount = daysRaw ? Number(daysRaw) : Number.NaN;
      const timezoneOffsetMinutes = timezoneRaw
        ? Number(timezoneRaw)
        : Number.NaN;
      const active = await resolveSessionStore(req.url);
      const env = url.searchParams.get("env");
      sendJson(
        res,
        200,
        active.overview({
          ...(source && source !== "all" ? { source } : {}),
          watchPath: env && env !== "local" ? env : config.watch_paths.join("\n"),
          collecting: process.env.FIXTURE_DIR == null,
          ...(Number.isFinite(sinceMs) ? { sinceMs } : {}),
          ...(Number.isFinite(untilMs) && Number.isFinite(sinceMs) && untilMs > sinceMs
            ? { untilMs }
            : {}),
          ...(Number.isFinite(dayCount) && dayCount > 0
            ? { dayCount: Math.min(60, Math.floor(dayCount)) }
            : {}),
          ...(Number.isFinite(timezoneOffsetMinutes) &&
          timezoneOffsetMinutes >= -840 &&
          timezoneOffsetMinutes <= 840
            ? { timezoneOffsetMinutes: Math.trunc(timezoneOffsetMinutes) }
            : {}),
          ...(timezone && timezone.length <= 100 && isValidTimezone(timezone)
            ? { timezone }
            : {}),
          ...(modelRaw && modelRaw.length <= 200 ? { model: modelRaw } : {}),
        }),
      );
      return;
    }

    if (req.method === "GET" && parts[0] === "power" && parts.length === 1) {
      // 硬件用电：向 Prometheus 拉取所选范围的功率采样。采集源不可达时
      // 返回 connected:false，由前端回退到演示数据，绝不伪造读数。
      const url = new URL(req.url ?? "/", "http://localhost");
      const startMs = Number(url.searchParams.get("start"));
      const endMs = Number(url.searchParams.get("end"));
      const stepMs = Number(url.searchParams.get("step"));
      if (
        !Number.isFinite(startMs) || !Number.isFinite(endMs) ||
        !Number.isFinite(stepMs) || endMs <= startMs || stepMs <= 0 ||
        endMs - startMs > 31 * 86_400_000 ||
        (endMs - startMs) / stepMs > 20_000
      ) {
        sendJson(res, 400, { error: "invalid_range" });
        return;
      }
      const config = loadUserConfig();
      const result = await fetchPowerRange({
        config: config.power,
        startMs,
        endMs,
        stepMs,
      });
      if (result.ok) {
        sendJson(res, 200, {
          source: "prometheus",
          connected: true,
          url: result.config.prometheus_url,
          startMs,
          endMs,
          stepMs,
          samples: result.samples,
        });
      } else {
        sendJson(res, 200, {
          source: "prometheus",
          connected: false,
          url: result.config.prometheus_url,
          error: result.error,
          startMs,
          endMs,
          stepMs,
          samples: [],
        });
      }
      return;
    }

    if (req.method === "GET" && parts[0] === "temps" && parts.length === 1) {
      const config = loadUserConfig();
      const result = await fetchTempSnapshot({ config: config.power });
      if (result.ok) {
        sendJson(res, 200, {
          source: "prometheus",
          connected: true,
          url: result.config.prometheus_url,
          ...result.sample,
        });
      } else {
        sendJson(res, 200, {
          source: "prometheus",
          connected: false,
          url: result.config.prometheus_url,
          error: result.error,
          timestamp: Date.now() / 1000,
          cpu: {
            name: "未识别 CPU",
            status: "missing",
            temperatures: {
              tctl: { value: null },
              tccd1: { value: null },
            },
          },
          gpus: [],
        });
      }
      return;
    }

    if (
      req.method === "GET" &&
      parts[0] === "temps" &&
      parts[1] === "history" &&
      parts.length === 2
    ) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const seconds = Number(url.searchParams.get("seconds"));
      if (!Number.isFinite(seconds)) {
        sendJson(res, 400, { error: "invalid_range" });
        return;
      }
      const config = loadUserConfig();
      const result = await fetchTempHistory({
        config: config.power,
        seconds,
      });
      if (result.ok) {
        sendJson(res, 200, {
          source: "prometheus",
          connected: true,
          url: result.config.prometheus_url,
          seconds: result.seconds,
          step: result.step,
          samples: result.samples,
        });
      } else {
        sendJson(res, 200, {
          source: "prometheus",
          connected: false,
          url: result.config.prometheus_url,
          error: result.error,
          seconds: result.seconds,
          step: result.step,
          samples: [],
        });
      }
      return;
    }

    if (req.method === "GET" && parts[0] === "sessions" && parts.length === 2) {
      const active = await resolveSessionStore(req.url);
      const snap = active.get(parts[1]!);
      if (!snap) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      sendJson(res, 200, snap);
      return;
    }

    if (
      req.method === "PATCH" &&
      parts[0] === "sessions" &&
      parts.length === 3 &&
      parts[2] === "waste-toggles"
    ) {
      const id = parts[1]!;
      const active = await resolveSessionStore(req.url);
      const snap = active.get(id);
      if (!snap) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }

      let partial: Partial<Record<WasteToggleId, boolean>>;
      try {
        const parsed: unknown = JSON.parse((await readBody(req)).toString("utf8"));
        if (!isRecord(parsed)) throw new Error("toggle patch must be an object");
        for (const [key, value] of Object.entries(parsed)) {
          if (!WASTE_TOGGLE_IDS.has(key as WasteToggleId) || typeof value !== "boolean") {
            throw new Error("invalid toggle");
          }
        }
        partial = parsed as Partial<Record<WasteToggleId, boolean>>;
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      active.setToggles(id, partial);
      sendJson(res, 200, active.get(id));
      return;
    }

    if (req.method === "GET" && parts[0] === "stream" && parts.length === 1) {
      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      res.on("error", () => sseClients.delete(res));
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === "POST" && parts[0] === "import" && parts.length === 1) {
      await handleImport(req, res, store, maxImportBytes);
      return;
    }

    if (staticDir && req.method === "GET") {
      if (serveStatic(req, res, staticDir)) return;
    }

    sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : undefined);
      } else if (err instanceof EnvironmentRequestError) {
        sendJson(res, err.status, { error: err.code });
      } else if ((err as { status?: number }).status === 413) {
        sendJson(res, 413, { error: "payload_too_large" });
      } else {
        sendJson(res, 500, { error: "internal_error" });
      }
    }
  });

  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, HOST);
      });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || attempt >= listenRetries) {
        if (code === "EADDRINUSE") {
          throw new Error(
            `token-analyser cannot listen on 127.0.0.1:${port} because the address is already in use. ` +
            "Stop the process holding the port and start again.",
          );
        }
        throw err;
      }
      if (attempt === 0) await signalStaleEngine(port);
      await new Promise((resolve) => setTimeout(resolve, listenRetryMs));
    }
  }

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  const url = `http://${HOST}:${actualPort}`;

  heartbeatTimer = setInterval(() => {
    for (const client of sseClients) {
      if (client.writableLength > MAX_SSE_BUFFER_BYTES) {
        sseClients.delete(client);
        client.destroy();
        continue;
      }
      try {
        client.write(": heartbeat\n\n");
      } catch {
        sseClients.delete(client);
        client.destroy();
      }
    }
  }, HEARTBEAT_MS);

  return {
    url,
    onIngestError: notifySessionError,
    close: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      // Drop keep-alive / SSE sockets so close() resolves and the port frees
      // immediately — restart must not wait on a multi-second store.dump().
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function collectFixtureFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));
}

const STORE_DUMP_INTERVAL_MS = 60_000;

/**
 * Stop accepting connections before persisting the dump so a restart can bind
 * the same port while the (potentially multi-second) dump still runs.
 */
export async function gracefulShutdown(opts: {
  close: () => Promise<void>;
  dump: () => void | Promise<void>;
  exit: (code: number) => void;
  code?: number;
}): Promise<void> {
  const code = opts.code ?? 0;
  try {
    await opts.close();
  } catch (err) {
    console.error(
      `server close failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await opts.dump();
  } catch (err) {
    console.error(
      `store dump failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  opts.exit(code);
}

async function main(): Promise<void> {
  const config = loadUserConfig();
  const store = new SessionStore();
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const ingestErrors: { id: string; reason: string }[] = [];
  /** Cursor state.vscdb paths deferred until after listen when dump is warm. */
  let deferredVscdb: string[] = [];

  const fixtureDir = process.env.FIXTURE_DIR;
  if (fixtureDir) {
    const root = path.isAbsolute(fixtureDir)
      ? fixtureDir
      : path.resolve(repoRoot, fixtureDir);
    for (const file of collectFixtureFiles(root)) {
      try {
        store.ingestPath(file);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ingestErrors.push({ id: errorIdFromPath(file), reason });
        console.error(`ingest failed ${file}: ${reason}`);
      }
    }
  } else {
    const listenPort = process.env.PORT
      ? Number.parseInt(process.env.PORT, 10) || DEFAULT_PORT
      : DEFAULT_PORT;
    // The previous process owns store.db. Stop it and wait until its dump
    // finishes, or this start dies with "database is locked".
    await waitForExit(await signalStaleEngine(listenPort));
    // Warm start: restore dump first so the UI has sessions immediately.
    // Cursor's state.vscdb is often hundreds of MB and stays dirty while the
    // app is open — defer that re-parse until after the server is listening
    // when a dump already has Cursor sessions.
    const bootStarted = Date.now();
    const dumpRestored = store.loadDump();
    if (dumpRestored > 0) {
      console.log(`store dump restored ${dumpRestored} session(s)`);
    }
    const onRefreshError = (filePath: string, err: Error) => {
      ingestErrors.push({ id: errorIdFromPath(filePath), reason: err.message });
      console.error(`ingest failed ${filePath}: ${err.message}`);
    };
    const allFiles = collectSessionFiles(config.watch_paths);
    // Large / often-dirty sources (Cursor DB, OpenCode DB, multi‑MB live JSONL)
    // block the HTTP loop if parsed synchronously. Always defer them until after
    // listen so the UI can paint within a few seconds even on a cold dump.
    const DEFER_BYTES = 10 * 1024 * 1024;
    const heavyFiles: string[] = [];
    const lightFiles: string[] = [];
    for (const filePath of allFiles) {
      let defer = path.basename(filePath) === "state.vscdb" || path.basename(filePath) === "opencode.db";
      if (!defer) {
        try {
          defer = statSync(filePath).size >= DEFER_BYTES;
        } catch {
          defer = false;
        }
      }
      (defer ? heavyFiles : lightFiles).push(filePath);
    }
    // Prefer OpenCode before Cursor's often-GB state.vscdb so timing metrics
    // show up first.
    heavyFiles.sort((a, b) => {
      const rank = (filePath: string) =>
        path.basename(filePath) === "opencode.db" ? 0
          : filePath.endsWith(".vscdb") ? 2
          : 1;
      return rank(a) - rank(b);
    });
    store.refresh(lightFiles, { onError: onRefreshError });
    deferredVscdb = heavyFiles;
    loadImportedSessions(
      store,
      path.join(tokenAnalyserHome(), "imports"),
      (filePath, err) => {
        ingestErrors.push({ id: errorIdFromPath(filePath), reason: err.message });
        console.error(`import ingest failed ${filePath}: ${err.message}`);
      },
    );
    // Do not force a synchronous 100MB+ dump on the listen path; refresh
    // scheduleDump() persists shortly after, and exit hooks still dump.
    console.log(
      `startup session load (pre-listen): ${Date.now() - bootStarted}ms` +
        (deferredVscdb.length > 0
          ? ` · deferring ${deferredVscdb.length} heavy source refresh`
          : ""),
    );
  }

  const webDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../apps/web/dist",
  );
  const serveUi = process.env.SERVE_UI === "1" && existsSync(webDist);
  const configuredPort = process.env.PORT
    ? Number.parseInt(process.env.PORT, 10)
    : 7788;
  const { url, onIngestError, close } = await startServer({
    store,
    ...(serveUi
      ? { staticDir: webDist, port: configuredPort || 7788 }
      : {}),
  });
  for (const item of ingestErrors) {
    onIngestError(item.id, item.reason);
  }
  console.log(`token-analyser engine listening on ${url}`);

    if (!fixtureDir) {
    if (deferredVscdb.length > 0) {
      const heavyFiles = deferredVscdb;
      const heavyStarted = Date.now();
      // Wait for the first UI /sessions paint, then check one heavy file at a
      // time. Unchanged files return from their fingerprint; a parse cannot
      // stall the HTTP event loop for the whole batch. A warm dump is not a
      // reason to skip this: files committed while the engine was stopped
      // would otherwise stay out of memory until the next watcher event.
      const refreshNext = (index: number): void => {
        if (index >= heavyFiles.length) {
          try {
            store.dump();
          } catch (err) {
            console.error(
              `store dump failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          console.log(
            `heavy source refresh finished in ${Date.now() - heavyStarted}ms` +
              ` (${heavyFiles.length} file(s))`,
          );
          return;
        }
        const filePath = heavyFiles[index]!;
        const finish = () => setTimeout(() => refreshNext(index + 1), 0);
        const run = path.basename(filePath) === "opencode.db" || filePath.endsWith(".vscdb")
          ? store.ingestPathBatched(filePath, {
            batchSize: path.basename(filePath) === "opencode.db" ? 25 : 8,
          })
          : Promise.resolve(store.ingestPath(filePath));
        void run.then(finish, (err) => {
          const reason = err instanceof Error ? err.message : String(err);
          onIngestError(errorIdFromPath(filePath), reason);
          console.error(`ingest failed ${filePath}: ${reason}`);
          finish();
        });
      };
      // Give /sessions and SSE a tick to complete before GB-scale SQLite work.
      setTimeout(() => refreshNext(0), 750);
    }
    // Qwen publishes new rates without warning the local ledger, so refresh
    // them automatically and keep every estimate on the dated official card.
    const stopQwenPriceRefresh = startQwenPriceAutoRefresh(store, {
      onUpdate: ({ asOf, modelCount }) => {
        console.log(`qwen prices refreshed: ${modelCount} models (${asOf})`);
        try {
          store.dump();
        } catch (err) {
          console.error(
            `store dump failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      onError: (reason) => console.error(`qwen price refresh failed: ${reason}`),
    });
    const stopCatalogRefresh = startCatalogAutoRefresh(store, {
      onUpdate: ({ modelCount }) => {
        console.log(`catalog prices refreshed: ${modelCount} models`);
        try {
          store.dump();
        } catch (err) {
          console.error(
            `store dump failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      onError: (reason) => console.error(`catalog price refresh failed: ${reason}`),
    });

    // Codex writes append-only JSONL files below dated directories. On macOS,
    // the recursive watcher can miss content changes in that tree, so use the
    // per-directory watcher plus its stat-based scan for reliable ingestion.
    watchSessions(store, () => {}, {
      recursive: process.platform !== "darwin",
      onError: onIngestError,
    });

    const dumpTimer = setInterval(() => {
      try {
        store.dump();
      } catch (err) {
        console.error(
          `store dump failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, STORE_DUMP_INTERVAL_MS);
    dumpTimer.unref?.();

    let shuttingDown = false;
    const dumpAndExit = (code: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      stopQwenPriceRefresh();
      stopCatalogRefresh();
      clearInterval(dumpTimer);
      void gracefulShutdown({
        close,
        dump: () => store.dump(),
        exit: (exitCode) => process.exit(exitCode),
        code,
      });
    };
    process.once("SIGINT", () => dumpAndExit(0));
    process.once("SIGTERM", () => dumpAndExit(0));
  }
}
const entry = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export type { SessionSnapshot };
