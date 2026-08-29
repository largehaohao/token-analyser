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

const SAFE_ARGV = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function formatArgv(argv: unknown[]): string {
  return argv
    .map((item) => {
      const part = String(item);
      if (SAFE_ARGV.test(part)) return part;
      return `'${part.replace(/'/g, `'\\''`)}'`;
    })
    .join(" ");
}

function unwrapCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const record =
        parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const cmd = record?.cmd ?? record?.command;
      if (typeof cmd === "string") return unwrapCommand(cmd);
      if (Array.isArray(cmd)) return unwrapCommand(formatArgv(cmd));
    } catch {
      // Not a JSON command envelope.
    }
  }

  const tokens = tokensOf(trimmed);
  const bin = path.basename(tokens[0] ?? "");
  if (["bash", "sh", "zsh", "dash"].includes(bin)) {
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === "-lc" || tokens[i] === "-c") {
        const script = tokens[i + 1];
        if (script) return unwrapCommand(script);
      }
    }
  }
  return trimmed;
}

function splitConnectors(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (
      (char === "|" && command[i + 1] === "|") ||
      (char === "&" && command[i + 1] === "&")
    ) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (char === "|" || char === ";") {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function segmentsOf(command: string): string[] {
  return splitConnectors(unwrapCommand(command));
}

function isSimpleRead(command: string): boolean {
  if (/^sed\s+-n\b/.test(command.trim())) return true;
  return READ_COMMANDS.has(binaryName(command));
}

function isSimpleWrite(command: string): boolean {
  if (/\bgit\s+apply\b/.test(command)) return true;
  if (/(^|[;&|]\s*)patch\b/.test(command)) return true;
  if (/(^|[;&|]\s*)tee\b/.test(command)) return true;
  if (hasUnquotedOutputRedirect(command)) return true;
  if (/(^|[;&|]\s*)sed\s+-i\b/.test(command)) return true;
  if (/(^|[;&|]\s*)(?:python3?|pytest|vitest|jest)\b/.test(command)) return true;
  if (/(^|[;&|]\s*)(?:cargo|go)\s+test\b/.test(command)) return true;
  if (/(^|[;&|]\s*)(?:pnpm|npm)\s+(?:[^;&|]+\s+)?test\b/.test(command)) {
    return true;
  }
  return false;
}

export function isReadCommand(command: string): boolean {
  const segments = segmentsOf(command);
  return segments.length > 0 && segments.every(isSimpleRead);
}

export function extractReadPaths(command: string): string[] {
  const paths: string[] = [];
  for (const segment of segmentsOf(command)) {
    paths.push(...extractReadPathsFromSegment(segment));
  }
  return paths;
}

function extractReadPathsFromSegment(command: string): string[] {
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
    return nonFlags.length >= 2 ? [nonFlags[nonFlags.length - 1]!] : [];
  }
  return nonFlags;
}

export function isWriteOrTest(command: string): boolean {
  return segmentsOf(command).some(isSimpleWrite);
}

function hasUnquotedOutputRedirect(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
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
    } else if (char === ">") {
      return true;
    }
  }
  return false;
}
