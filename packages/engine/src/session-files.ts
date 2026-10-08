import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function defaultSessionPaths(): string[] {
  const home = homedir();
  const cursorUser = process.platform === "darwin"
    ? path.join(home, "Library/Application Support/Cursor/User")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), "Cursor/User")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Cursor/User");
  return [
    path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "sessions"),
    path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects"),
    path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi/agent"), "sessions"),
    path.join(home, ".cursor/projects"), path.join(home, ".cursor/chats"),
    path.join(cursorUser, "globalStorage/state.vscdb"),
    path.join(cursorUser, "workspaceStorage"),
  ];
}

export function isSessionFile(name: string): boolean {
  return /\.(jsonl|ndjson)$/i.test(name) || path.basename(name) === "state.vscdb";
}

export function collectSessionFiles(roots: string[]): string[] {
  const files = new Set<string>();
  const walk = (entry: string): void => {
    try {
      if (!existsSync(entry)) return;
      if (statSync(entry).isFile()) {
        if (isSessionFile(entry)) files.add(path.resolve(entry));
        return;
      }
      for (const child of readdirSync(entry, { withFileTypes: true })) {
        if (child.isDirectory() || (child.isFile() && isSessionFile(child.name))) walk(path.join(entry, child.name));
      }
    } catch { /* An unreadable source must not hide other sessions. */ }
  };
  for (const root of roots) walk(root);
  return [...files];
}
