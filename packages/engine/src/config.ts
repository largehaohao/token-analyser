import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type UserConfig = {
  watch_paths: string[];
  usd_per_credit?: number;
};

export function tokenAnalyserHome(): string {
  return process.env.TOKEN_ANALYSER_HOME ?? path.join(homedir(), ".token-analyser");
}

export function loadUserConfig(): UserConfig {
  const configPath = path.join(tokenAnalyserHome(), "config.json");
  if (!existsSync(configPath)) {
    return { watch_paths: [path.join(homedir(), ".codex/sessions")] };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<UserConfig>;
    return {
      watch_paths: parsed.watch_paths ?? [
        path.join(homedir(), ".codex/sessions"),
      ],
      usd_per_credit: parsed.usd_per_credit,
    };
  } catch {
    return { watch_paths: [path.join(homedir(), ".codex/sessions")] };
  }
}
