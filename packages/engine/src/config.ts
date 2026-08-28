import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type UserConfig = {
  watch_paths: string[];
  usd_per_credit?: number;
};

function defaultWatchPaths(): string[] {
  return [path.join(homedir(), ".codex/sessions")];
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
    return {
      watch_paths: watchPaths.length > 0 ? watchPaths : defaultWatchPaths(),
      usd_per_credit: usdPerCredit,
    };
  } catch {
    return { watch_paths: defaultWatchPaths() };
  }
}
