import path from "node:path";

const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "bat",
  "less",
  "more",
  "rg",
  "grep",
  "ag",
  "ack",
  "wc",
]);

const SEARCH_COMMANDS = new Set(["rg", "grep", "ag", "ack"]);

function tokensOf(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function binaryName(command: string): string {
  const tokens = tokensOf(command);
  return path.basename(tokens[0] ?? "");
}

export function isReadCommand(command: string): boolean {
  if (/^sed\s+-n\b/.test(command.trim())) return true;
  return READ_COMMANDS.has(binaryName(command));
}

export function extractReadPaths(command: string): string[] {
  const trimmed = command.trim();
  if (/^sed\s+-n\b/.test(trimmed)) {
    const nonFlags = tokensOf(trimmed).slice(2).filter((t) => !t.startsWith("-"));
    return nonFlags.length > 0 ? [nonFlags[nonFlags.length - 1]] : [];
  }

  const binary = binaryName(trimmed);
  if (!READ_COMMANDS.has(binary)) return [];

  const nonFlags = tokensOf(trimmed).slice(1).filter((t) => !t.startsWith("-"));
  if (SEARCH_COMMANDS.has(binary)) {
    return nonFlags.length >= 2 ? [nonFlags[nonFlags.length - 1]] : [];
  }
  return nonFlags;
}

export function isWriteOrTest(command: string): boolean {
  if (/git apply/.test(command)) return true;
  if (/\bpatch\b/.test(command)) return true;
  if (/tee /.test(command)) return true;
  if (/>/.test(command)) return true;
  if (/sed -i/.test(command)) return true;
  if (/pytest/.test(command)) return true;
  if (/vitest/.test(command)) return true;
  if (/jest/.test(command)) return true;
  if (/cargo test/.test(command)) return true;
  if (/go test/.test(command)) return true;
  if (/pnpm test/.test(command)) return true;
  if (/npm test/.test(command)) return true;
  return false;
}
