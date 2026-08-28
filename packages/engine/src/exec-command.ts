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
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
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
    const tokens = tokensOf(trimmed).slice(2);
    return tokens.filter((token, index) => {
      if (token === "--") return false;
      if (token.startsWith("-")) return false;
      const previous = tokens[index - 1];
      return previous !== "-n" && previous !== "--line-range";
    }).slice(-1);
  }

  const binary = binaryName(trimmed);
  if (!READ_COMMANDS.has(binary)) return [];

  const tokens = tokensOf(trimmed).slice(1);
  const nonFlags: string[] = [];
  const valueFlags = new Set(["-n", "--lines", "-c", "--bytes", "-A", "-B", "-C"]);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") {
      nonFlags.push(...tokens.slice(i + 1));
      break;
    }
    if (valueFlags.has(token) && (binary === "head" || binary === "tail")) {
      i += 1;
      continue;
    }
    if (token.startsWith("-") || /^-(?:n|c|A|B|C)\d+$/.test(token)) continue;
    nonFlags.push(token);
  }
  if (SEARCH_COMMANDS.has(binary)) {
    return nonFlags.length >= 2 ? [nonFlags[nonFlags.length - 1]] : [];
  }
  return nonFlags;
}

export function isWriteOrTest(command: string): boolean {
  if (/\bgit\s+apply\b/.test(command)) return true;
  if (/(^|[;&|]\s*)patch\b/.test(command)) return true;
  if (/(^|[;&|]\s*)tee\b/.test(command)) return true;
  if (hasUnquotedRedirection(command)) return true;
  if (/(^|[;&|]\s*)sed\s+-i\b/.test(command)) return true;
  if (/(^|[;&|]\s*)(?:python3?|pytest|vitest|jest)\b/.test(command)) return true;
  if (/(^|[;&|]\s*)(?:cargo|go)\s+test\b/.test(command)) return true;
  if (/(^|[;&|]\s*)(?:pnpm|npm)\s+(?:[^;&|]+\s+)?test\b/.test(command)) return true;
  return false;
}

function hasUnquotedRedirection(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ">" || char === "<") {
      return true;
    }
  }
  return false;
}
