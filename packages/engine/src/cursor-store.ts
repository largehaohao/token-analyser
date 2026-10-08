import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iso, record, text } from "./session-adapters.ts";
import type { RolloutLine } from "./types.ts";

function json(value: unknown): Record<string, unknown> {
  try { return record(JSON.parse(typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("utf8"))); }
  catch { return {}; }
}

function workspacePaths(databasePath: string): Map<string, string> {
  const roots = new Map<string, string>();
  const userDir = path.basename(path.dirname(databasePath)) === "globalStorage"
    ? path.dirname(path.dirname(databasePath)) : path.dirname(path.dirname(path.dirname(databasePath)));
  const storage = path.join(userDir, "workspaceStorage");
  if (!existsSync(storage)) return roots;
  for (const entry of readdirSync(storage, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const workspace = json(readFileSync(path.join(storage, entry.name, "workspace.json"), "utf8"));
      const uri = text(workspace.folder ?? workspace.workspace);
      if (uri.startsWith("file:")) roots.set(entry.name, fileURLToPath(uri));
    } catch { /* Stale workspace metadata is optional. */ }
  }
  return roots;
}

/** Read Cursor's own database without copying it or touching its WAL. */
export function readCursorSessions(databasePath: string): RolloutLine[][] {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const headers = new Map<string, Record<string, unknown>>();
    const data = new Map<string, Record<string, unknown>>();
    if (tables.has("composerHeaders")) {
      for (const row of db.prepare("SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value FROM composerHeaders").all()) {
        headers.set(text(row.composerId), { ...row, ...json(row.value) });
      }
    }
    if (tables.has("cursorDiskKV")) {
      for (const row of db.prepare("SELECT key,value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
        data.set(text(row.key).slice("composerData:".length), json(row.value));
      }
    }
    if (tables.has("ItemTable")) {
      for (const row of db.prepare("SELECT value FROM ItemTable WHERE key IN ('composer.composerData','workbench.panel.aichat.view.aichat.chatdata')").all()) {
        const value = json(row.value);
        const composers = value.allComposers ?? value.tabs;
        if (Array.isArray(composers)) for (const item of composers) {
          const composer = record(item);
          const id = text(composer.composerId ?? composer.id);
          if (id && !data.has(id)) data.set(id, composer);
        }
      }
    }
    const cwdByWorkspace = workspacePaths(databasePath);
    const readBubbles = tables.has("cursorDiskKV")
      ? db.prepare("SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key") : null;
    const sessions: RolloutLine[][] = [];
    for (const [id, header] of new Map([...data, ...headers])) {
      const composer = { ...header, ...data.get(id) };
      const prefix = `bubbleId:${id}:`;
      let bubbles = readBubbles?.all(prefix, `${prefix}\uffff`).map((row) => json(row.value)) ?? [];
      if (!bubbles.length) {
        const conversation = composer.fullConversation ?? composer.bubbles;
        if (Array.isArray(conversation)) bubbles = conversation.map(record);
      }
      if (!bubbles.length) continue; // Workspace-only references are resolved by the global store.
      const order = new Map<string, number>();
      if (Array.isArray(composer.fullConversationHeadersOnly)) {
        composer.fullConversationHeadersOnly.forEach((item, index) => order.set(text(record(item).bubbleId), index));
      }
      bubbles.sort((a, b) => (order.get(text(a.bubbleId)) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(text(b.bubbleId)) ?? Number.MAX_SAFE_INTEGER) || Date.parse(iso(a.createdAt)) - Date.parse(iso(b.createdAt)));
      const parent = record(composer.subagentInfo);
      const selected = record(composer.modelConfig);
      const selectedModels = Array.isArray(selected.selectedModels) ? selected.selectedModels.map(record) : [];
      const chosenModel = text(selected.modelName) || (selectedModels.length === 1 ? text(selectedModels[0]?.modelId) : "");
      let currentModel = "";
      const events: RolloutLine[] = [{ type: "cursor_session", source: "cursor", sessionId: id,
        timestamp: iso(composer.createdAt), name: text(composer.name),
        cwd: cwdByWorkspace.get(text(composer.workspaceId)) ?? text(composer.cwd),
        parentSessionId: text(parent.parentComposerId), selectedModel: chosenModel,
        forkedFrom: text(composer.forkedFromComposerId) }];
      const seen = new Set<string>();
      for (const [index, bubble] of bubbles.entries()) {
        const bubbleId = text(bubble.bubbleId) || String(index);
        if (seen.has(bubbleId)) continue;
        seen.add(bubbleId);
        const role = typeof bubble.role === "string" ? bubble.role : bubble.type === 1 ? "user" : "assistant";
        currentModel = text(record(bubble.modelInfo).modelName) || currentModel;
        const tool = record(bubble.toolFormerData);
        const content: Record<string, unknown>[] = [{ type: "text", text: text(bubble.text) }];
        if (Object.keys(tool).length) {
          let input: unknown = tool.params ?? tool.rawArgs;
          if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* Preserve raw tool input. */ } }
          content.push({ type: "tool_use", id: text(tool.toolCallId) || bubbleId, name: text(tool.name) || String(tool.tool ?? "tool"), input });
        }
        const count = record(bubble.tokenCount);
        // Cursor populates zero placeholders even on unmetered transcripts.
        const usage = typeof count.inputTokens === "number" && typeof count.outputTokens === "number" &&
          count.inputTokens + count.outputTokens > 0 ? count : undefined;
        const timestamp = iso(bubble.createdAt) || iso(composer.lastUpdatedAt);
        events.push({ type: "message", source: "cursor", sessionId: id, timestamp, role,
          message: { role, id: bubbleId, model: currentModel || null, content, usage } });
        if (Object.keys(tool).length) {
          events.push({ type: "message", timestamp, message: { role: "toolResult",
            toolCallId: text(tool.toolCallId) || bubbleId, content: text(tool.result) || JSON.stringify(tool.result ?? "") } });
        }
      }
      sessions.push(events);
    }
    return sessions;
  } finally { db.close(); }
}
