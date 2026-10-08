import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { defaultSessionPaths, isSessionFile } from "../src/session-files.ts";
import { loadUserConfig } from "../src/config.ts";

afterEach(() => vi.unstubAllEnvs());
describe("default source discovery", () => {
  it("includes every provider in fresh configuration and supports custom source homes", () => {
    vi.stubEnv("TOKEN_ANALYSER_HOME", path.join(homedir(), "nonexistent-discovery-test-home"));
    vi.stubEnv("CODEX_HOME", "/custom/codex");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/custom/claude");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/custom/pi");
    const roots = defaultSessionPaths();
    expect(roots).toContain(path.join("/custom/codex", "sessions"));
    expect(roots).toContain(path.join("/custom/claude", "projects"));
    expect(roots).toContain(path.join("/custom/pi", "sessions"));
    expect(roots).toContain(path.join(homedir(), ".cursor/projects"));
    expect(roots).toContain(path.join(homedir(), ".cursor/chats"));
    expect(roots.some((root) => root.endsWith(path.join("Cursor/User/globalStorage", "state.vscdb")))).toBe(true);
    expect(roots.some((root) => root.endsWith(path.join("Cursor/User", "workspaceStorage")))).toBe(true);
    expect(loadUserConfig().watch_paths).toEqual(roots);
  });
  it("only selects supported session files", () => {
    for (const file of ["session.jsonl", "session.NDJSON", "state.vscdb"]) expect(isSessionFile(file)).toBe(true);
    for (const file of ["memory.md", "state.vscdb-wal", "state.vscdb-shm", "settings.json"]) expect(isSessionFile(file)).toBe(false);
  });
});
