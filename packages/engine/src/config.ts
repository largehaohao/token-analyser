import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultSessionPaths } from "./session-files.ts";

export type UserConfig = {
  watch_paths: string[];
  usd_per_credit?: number;
  /** Overrides the CNY→USD rate used when refreshing Qwen prices. */
  usd_per_cny?: number;
};

function defaultWatchPaths(): string[] {
  return defaultSessionPaths();
}

export function tokenAnalyserHome(): string {
  return process.env.TOKEN_ANALYSER_HOME ?? path.join(homedir(), ".token-analyser");
}

export function loadUserConfig(): UserConfig {
  const configPath = path.join(tokenAnalyserHome(), "config.json");
  if (!existsSync(configPath)) {
    return { watch_paths: defaultWatchPaths() };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<UserConfig>;
    const watchPaths = Array.isArray(parsed.watch_paths)
      ? parsed.watch_paths.filter((item): item is string => typeof item === "string")
      : [];
    const usdPerCredit =
      typeof parsed.usd_per_credit === "number" &&
      Number.isFinite(parsed.usd_per_credit) &&
      parsed.usd_per_credit >= 0
        ? parsed.usd_per_credit
        : undefined;
    const usdPerCny =
      typeof parsed.usd_per_cny === "number" &&
      Number.isFinite(parsed.usd_per_cny) &&
      parsed.usd_per_cny > 0
        ? parsed.usd_per_cny
        : undefined;
    return {
      watch_paths: watchPaths.length > 0 ? watchPaths : defaultWatchPaths(),
      usd_per_credit: usdPerCredit,
      usd_per_cny: usdPerCny,
    };
  } catch {
    return { watch_paths: defaultWatchPaths() };
  }
}
