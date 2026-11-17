import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSessionFile } from "./session-files.ts";

const ALLOWED_EXTENSIONS = new Set([
  ".jsonl",
  ".ndjson",
  ".zstd",
  ".vscdb",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

export function hasImportExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jsonl.zstd") || lower.endsWith(".ndjson.zstd")) return true;
  return ALLOWED_EXTENSIONS.has(path.extname(lower));
}

export type ResolvedImport =
  | { ok: true; path: string }
  | { ok: false; error: "invalid_path" };

/**
 * Resolve symlinks and reject special files before any parser, including
 * node:sqlite, sees the path. Extension checks run on the requested path and
 * again on the real path so a `.jsonl` symlink cannot point at an unexpected
 * file. A missing regular path is left for ingest to report.
 */
export function resolveImportTarget(filePath: string): ResolvedImport {
  if (!filePath || filePath.includes("\0") || !path.isAbsolute(filePath)) {
    return { ok: false, error: "invalid_path" };
  }
  if (!hasImportExtension(filePath) || !isSessionFile(filePath)) {
    return { ok: false, error: "invalid_path" };
  }

  let linkStat;
  try {
    linkStat = lstatSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, path: filePath };
    return { ok: false, error: "invalid_path" };
  }

  if (!linkStat.isFile() && !linkStat.isSymbolicLink()) {
    return { ok: false, error: "invalid_path" };
  }

  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    return { ok: false, error: "invalid_path" };
  }

  let resolvedStat;
  try {
    resolvedStat = statSync(resolved);
  } catch {
    return { ok: false, error: "invalid_path" };
  }
  if (!resolvedStat.isFile()) return { ok: false, error: "invalid_path" };
  if (!hasImportExtension(resolved) || !isSessionFile(resolved)) {
    return { ok: false, error: "invalid_path" };
  }
  return { ok: true, path: resolved };
}
