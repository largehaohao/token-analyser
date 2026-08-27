import http from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUserConfig, tokenAnalyserHome } from "./config.ts";
import { SessionStore } from "./store.ts";
import { watchSessions } from "./watch.ts";
import type { SessionSnapshot, WasteToggleId } from "./types.ts";

const CORS_ORIGIN = "http://127.0.0.1:7788";
const HOST = "127.0.0.1";
const DEFAULT_PORT = 7789;
const HEARTBEAT_MS = 15_000;

type SseEvent = "session_added" | "session_updated" | "session_error";

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,PATCH,POST,OPTIONS",
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

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parsePathname(url: string | undefined): string {
  return new URL(url ?? "/", "http://localhost").pathname;
}

function isRolloutJsonl(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

function collectRolloutFiles(roots: string[]): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (isRolloutJsonl(entry.name)) {
        results.push(full);
      }
    }
  }

  for (const root of roots) {
    walk(root);
  }
  return results;
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

  const origIngest = store.ingestPath.bind(store);
  store.ingestPath = (filePath: string) => {
    try {
      const idsBefore = new Set(store.list().map((s) => s.id));
      const id = origIngest(filePath);
      if (id) {
        const snap = store.get(id);
        const isNew = snap?.parentId == null && !idsBefore.has(id);
        onChange(id, isNew);
        if (snap?.parentId) {
          onChange(snap.parentId, false);
        }
      }
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
    toggles: Record<WasteToggleId, boolean>,
  ) => {
    if (!store.get(id)) return;
    origSetToggles(id, toggles);
    onChange(id, false);
  };
}

async function handleImport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SessionStore,
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.startsWith("application/x-ndjson")) {
    const filename = req.headers["x-filename"];
    if (!filename || Array.isArray(filename)) {
      sendJson(res, 400, { error: "missing_filename" });
      return;
    }

    const importsDir = path.join(tokenAnalyserHome(), "imports");
    mkdirSync(importsDir, { recursive: true });
    const dest = path.join(importsDir, path.basename(filename));
    writeFileSync(dest, await readBody(req));

    const id = store.ingestPath(dest);
    if (!id) {
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
      body = JSON.parse((await readBody(req)).toString("utf8")) as {
        path?: string;
      };
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    const filePath = body.path;
    if (!filePath || !path.isAbsolute(filePath) || !filePath.endsWith(".jsonl")) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    const id = store.ingestPath(filePath);
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
    const raw = (await readBody(req)).toString("binary");
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

    const importsDir = path.join(tokenAnalyserHome(), "imports");
    mkdirSync(importsDir, { recursive: true });
    const dest = path.join(importsDir, filename);
    writeFileSync(dest, fileData, "binary");

    const id = store.ingestPath(dest);
    if (!id) {
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

  if (!resolved.startsWith(path.resolve(staticDir))) {
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
  createReadStream(filePath).pipe(res);
  return true;
}

export async function startServer(opts?: {
  port?: number;
  store?: SessionStore;
  staticDir?: string;
}): Promise<{
  url: string;
  close: () => Promise<void>;
  onIngestError: (id: string, reason: string) => void;
}> {
  const store = opts?.store ?? new SessionStore();
  const staticDir = opts?.staticDir;
  const port =
    opts?.port ??
    (process.env.PORT ? Number.parseInt(process.env.PORT, 10) : DEFAULT_PORT);

  const sseClients = new Set<http.ServerResponse>();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function broadcast(event: SseEvent, data: { id: string; reason?: string }): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
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
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const pathname = parsePathname(req.url);
    const parts = pathname.split("/").filter(Boolean);

    if (req.method === "GET" && parts[0] === "sessions" && parts.length === 1) {
      sendJson(res, 200, { sessions: store.list() });
      return;
    }

    if (req.method === "GET" && parts[0] === "sessions" && parts.length === 2) {
      const snap = store.get(parts[1]!);
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
      const snap = store.get(id);
      if (!snap) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }

      let partial: Partial<Record<WasteToggleId, boolean>>;
      try {
        partial = JSON.parse((await readBody(req)).toString("utf8")) as Partial<
          Record<WasteToggleId, boolean>
        >;
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      store.setToggles(id, { ...snap.toggles, ...partial });
      sendJson(res, 200, store.get(id));
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
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === "POST" && parts[0] === "import" && parts.length === 1) {
      await handleImport(req, res, store);
      return;
    }

    if (staticDir && req.method === "GET") {
      if (serveStatic(req, res, staticDir)) return;
    }

    sendJson(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve());
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  const url = `http://${HOST}:${actualPort}`;

  heartbeatTimer = setInterval(() => {
    for (const client of sseClients) {
      client.write(": heartbeat\n\n");
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

async function main(): Promise<void> {
  const config = loadUserConfig();
  const store = new SessionStore();
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );

  const fixtureDir = process.env.FIXTURE_DIR;
  if (fixtureDir) {
    const root = path.isAbsolute(fixtureDir)
      ? fixtureDir
      : path.resolve(repoRoot, fixtureDir);
    for (const file of collectFixtureFiles(root)) {
      store.ingestPath(file);
    }
  } else {
    store.refresh(collectRolloutFiles(config.watch_paths));
  }

  const webDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../apps/web/dist",
  );
  const serveUi = process.env.SERVE_UI === "1" && existsSync(webDist);
  const { url, onIngestError } = await startServer({
    store,
    ...(serveUi ? { staticDir: webDist, port: 7788 } : {}),
  });
  console.log(`token-analyser engine listening on ${url}`);

  if (!fixtureDir) {
    watchSessions(store, () => {}, { onError: onIngestError });
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
