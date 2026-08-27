import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { sha256 } from "./hash.ts";
import { tokenAnalyserHome } from "./config.ts";
import type { SessionSnapshot } from "./types.ts";

export function cacheDir(home?: string): string {
  return path.join(home ?? tokenAnalyserHome(), "cache");
}

export function cacheKey(filePath: string): string {
  const st = statSync(filePath);
  return sha256(`${filePath}${st.ino}${st.size}${st.mtimeMs}`);
}

export function isLive(mtimeMs: number): boolean {
  return mtimeMs > Date.now() - 120_000;
}

export function readCache(
  key: string,
  home?: string,
): SessionSnapshot | undefined {
  const file = path.join(cacheDir(home), `${key}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionSnapshot;
  } catch {
    unlinkSync(file);
    return undefined;
  }
}

export function writeCache(
  key: string,
  snapshot: SessionSnapshot,
  home?: string,
): void {
  const dir = cacheDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(snapshot));
}
