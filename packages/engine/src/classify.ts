import {
  extractReadPaths,
  hasSourceReadCommand,
  isInspectionCommand,
  isReadCommand,
  isToolingCommand,
  isVerificationCommand,
  isWriteCommand,
} from "./exec-command.ts";
import type { Bucket, ToolCall, Turn } from "./types.ts";

const POLL_TOOLS = new Set([
  "wait_agent",
  "list_agents",
  "write_stdin",
  "wait",
]);

const COORD_TOOLS = new Set([
  "spawn_agent",
  "send_message",
  "wait_agent",
  "list_agents",
  "write_stdin",
  "wait",
]);

const COORD_INTERSECT = new Set(["spawn_agent", "send_message"]);

const COMMUNICATION_TOOLS = new Set([
  "send_user_message",
  "send_user_message_async",
  "notify",
]);

const TOOLING_TOOL_NAMES = new Set([
  "apply_patch",
  "get_handoff_status",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "load_workspace_dependencies",
  "navigate_to_codex_page",
  "open_in_codex",
  "read_mcp_resource",
  "read_thread",
  "read_thread_terminal",
  "request_user_input",
  "set_thread_title",
  "view_image",
]);

const TOOLING_WRAPPER_RE =
  /\btools\.(?!exec_command\b)[A-Za-z_][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*\s*\(/;
const PATCH_WRAPPER_RE =
  /(?:\btools\.apply_patch\s*\(|(?:^|\n)\s*\*\*\*\s+Begin\s+Patch|\bapply_patch\s+(?:<<|<))/;
const TOOLING_COMMAND_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:pnpm|npm|yarn|bun)\b.*\b(?:exec|dlx|start|dev|preview)\b/s;

function toolNames(tools: ToolCall[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

function isSubset(subset: Set<string>, superset: Set<string>): boolean {
  for (const name of subset) {
    if (!superset.has(name)) return false;
  }
  return true;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const name of a) {
    if (b.has(name)) return true;
  }
  return false;
}

function isReadOnlyTurn(turn: Turn): boolean {
  if (turn.hasPatchApply || turn.tools.length === 0) return false;
  for (const tool of turn.tools) {
    if (tool.name !== "exec") return false;
    if (isWriteCommand(tool.input)) return false;
    if (!isReadCommand(tool.input)) return false;
  }
  return true;
}

function isReadingTurn(turn: Turn): boolean {
  if (turn.hasPatchApply || turn.tools.length === 0) return false;
  const execTools = turn.tools.filter((tool) => tool.name === "exec");
  return (
    execTools.length === turn.tools.length &&
    execTools.some((tool) => hasSourceReadCommand(tool.input)) &&
    execTools.every((tool) => isInspectionCommand(tool.input))
  );
}

function isVerificationTurn(turn: Turn): boolean {
  if (turn.hasPatchApply || turn.tools.length === 0) return false;
  const execTools = turn.tools.filter((tool) => tool.name === "exec");
  if (execTools.length !== turn.tools.length) return false;
  if (!execTools.some((tool) => isVerificationCommand(tool.input))) {
    return false;
  }
  return execTools.every(
    (tool) =>
      !isWriteCommand(tool.input) &&
      isVerificationCommand(tool.input),
  );
}

function isCommunicationTool(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    COMMUNICATION_TOOLS.has(lower) ||
    /(?:^|__)send_user_message(?:_async)?$/.test(lower)
  );
}

function isToolingTool(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    TOOLING_TOOL_NAMES.has(lower) ||
    lower.startsWith("mcp__") ||
    lower.startsWith("tools.") ||
    lower.startsWith("functions.")
  );
}

function isCodeTurn(turn: Turn): boolean {
  if (turn.hasPatchApply) return true;
  return turn.tools.some(
    (tool) =>
      (tool.name === "exec" && isWriteCommand(tool.input)) ||
      PATCH_WRAPPER_RE.test(tool.input) ||
      tool.name.toLowerCase() === "apply_patch",
  );
}

function isToolingTurn(turn: Turn): boolean {
  if (turn.hasPatchApply || turn.tools.length === 0) return false;
  let hasToolingSignal = false;
  for (const tool of turn.tools) {
    if (tool.name !== "exec") {
      if (!isToolingTool(tool.name)) return false;
      hasToolingSignal = true;
      continue;
    }
    if (isCodeTurn({ ...turn, tools: [tool] })) return false;
    if (isVerificationCommand(tool.input)) return false;
    if (
      isToolingCommand(tool.input) ||
      TOOLING_COMMAND_RE.test(tool.input) ||
      TOOLING_WRAPPER_RE.test(tool.input)
    ) {
      hasToolingSignal = true;
      continue;
    }
    if (
      isInspectionCommand(tool.input) &&
      extractReadPaths(tool.input).length === 0
    ) {
      continue;
    }
    if (!isInspectionCommand(tool.input)) return false;
  }
  return hasToolingSignal;
}

function pathsForTurn(turn: Turn): string[] {
  const paths: string[] = [];
  for (const tool of turn.tools) {
    if (tool.name === "exec") {
      paths.push(...extractReadPaths(tool.input));
    }
  }
  return paths;
}

function hashForPath(turn: Turn, targetPath: string): string | null {
  for (const tool of turn.tools) {
    if (tool.name !== "exec") continue;
    if (extractReadPaths(tool.input).includes(targetPath)) {
      return tool.outputSha256;
    }
  }
  return null;
}

function isReread(turn: Turn, pathHashes: Map<string, string>): boolean {
  const paths = pathsForTurn(turn);
  if (paths.length === 0) return false;

  for (const targetPath of paths) {
    const stored = pathHashes.get(targetPath);
    if (stored === undefined) return false;
    if (hashForPath(turn, targetPath) !== stored) return false;
  }
  return true;
}

function updatePathHashes(turn: Turn, pathHashes: Map<string, string>): void {
  for (const tool of turn.tools) {
    if (tool.name !== "exec") continue;
    for (const targetPath of extractReadPaths(tool.input)) {
      pathHashes.set(targetPath, tool.outputSha256);
    }
  }
}

function classifyTurn(turn: Turn, pathHashes: Map<string, string>): Bucket {
  const names = toolNames(turn.tools);

  if (turn.tools.length > 0 && isSubset(names, POLL_TOOLS)) {
    return "waiting.poll";
  }

  if (
    turn.tools.length > 0 &&
    isSubset(names, COORD_TOOLS) &&
    intersects(names, COORD_INTERSECT)
  ) {
    return "waiting.coord";
  }

  if (
    turn.tools.length > 0 &&
    turn.tools.every((tool) => isCommunicationTool(tool.name))
  ) {
    return "communication";
  }

  if (isReadOnlyTurn(turn) && isReread(turn, pathHashes)) {
    return "reread";
  }

  if (turn.collaborationMode === "plan") return "planning";

  if (isCodeTurn(turn)) return "code";

  if (isVerificationTurn(turn)) return "verification";

  if (isReadingTurn(turn)) return "reading";

  if (isToolingTurn(turn)) return "tooling";

  if (turn.tools.length === 0) return "planning";

  return "other";
}

export function classifyTurns(turns: Turn[]): Turn[] {
  const pathHashes = new Map<string, string>();
  return turns.map((turn) => {
    const copy: Turn = {
      ...turn,
      tools: [...turn.tools],
      labels: [...turn.labels],
    };
    copy.bucket = classifyTurn(copy, pathHashes);
    updatePathHashes(copy, pathHashes);
    return copy;
  });
}
