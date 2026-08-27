import { extractReadPaths, isReadCommand, isWriteOrTest } from "./exec-command.ts";
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
    if (isWriteOrTest(tool.input)) return false;
    if (!isReadCommand(tool.input)) return false;
  }
  return true;
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

  if (isReadOnlyTurn(turn) && isReread(turn, pathHashes)) {
    return "reread";
  }

  if (turn.collaborationMode === "plan") return "planning";

  if (turn.hasPatchApply) return "code";
  for (const tool of turn.tools) {
    if (tool.name === "exec" && isWriteOrTest(tool.input)) {
      return "code";
    }
  }

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
