import path from "node:path";

const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "bat",
  "less",
  "more",
  "nl",
  "rg",
  "grep",
  "ag",
  "ack",
  "wc",
]);

const SEARCH_COMMANDS = new Set(["rg", "grep", "ag", "ack"]);

const ENVIRONMENT_COMMANDS = new Set([
  "pwd",
  "ls",
  "exa",
  "tree",
  "find",
  "ps",
  "lsof",
  "which",
  "where",
  "type",
  "command",
  "env",
  "printenv",
  "uname",
  "date",
  "whoami",
  "id",
  "stat",
  "file",
  "du",
  "sleep",
  "true",
  "false",
  "printf",
  "echo",
  "sort",
  "uniq",
  "cut",
  "tr",
]);

const GIT_INSPECTION_COMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "show",
  "status",
  "tag",
]);

const PACKAGE_MANAGER_COMMANDS = new Set(["pnpm", "npm", "yarn", "bun"]);
const PACKAGE_MANAGER_TOOLING_SUBCOMMANDS = new Set([
  "config",
  "exec",
  "list",
  "ls",
  "why",
  "store",
  "version",
  "--version",
  "-v",
  "start",
  "dev",
  "preview",
]);
const VALIDATION_BINARIES = new Set([
  "eslint",
  "biome",
  "jest",
  "playwright",
  "pytest",
  "tsc",
  "vitest",
]);
const MUTATING_BINARIES = new Set([
  "chmod",
  "chown",
  "cp",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "touch",
]);
const VALIDATION_TASKS = new Set([
  "build",
  "check",
  "compile",
  "coverage",
  "e2e",
  "lint",
  "test",
  "typecheck",
  "type-check",
  "validate",
  "verify",
]);

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
  const tokens = commandTokens(command);
  return path.basename(tokens[0] ?? "");
}

function commandTokens(command: string): string[] {
  const tokens = tokensOf(command);
  let first = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[first] ?? "")) first += 1;
  return tokens.slice(first);
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
  const tokens = commandTokens(command);
  if (path.basename(tokens[0] ?? "") === "sed" && tokens[1] === "-n") {
    return true;
  }
  return READ_COMMANDS.has(binaryName(command));
}

function isSimpleMutation(command: string): boolean {
  if (MUTATING_BINARIES.has(binaryName(command))) return true;
  if (/\bgit\s+apply\b/.test(command)) return true;
  if (/(^|[;&|]\s*)patch\b/.test(command)) return true;
  if (/(^|[;&|]\s*)tee\b/.test(command)) return true;
  if (hasUnquotedOutputRedirect(command)) return true;
  if (/(^|[;&|]\s*)sed\s+-i\b/.test(command)) return true;
  if (/(^|[;&|]\s*)python3?\b/.test(command)) return true;
  return false;
}

function isSimpleValidation(command: string): boolean {
  const trimmed = command.trim();
  if (/\bgit\s+diff\s+--check\b/.test(trimmed)) return true;

  const tokens = commandTokens(trimmed);
  const binary = path.basename(tokens[0] ?? "");
  if (VALIDATION_BINARIES.has(binary)) return true;
  if (
    (binary === "curl" || binary === "wget") &&
    tokens.some((token) =>
      ["-i", "--fail", "--fail-with-body", "-X", "--request"].includes(token),
    )
  ) {
    return true;
  }

  if (binary === "cargo" || binary === "go") {
    return tokens.slice(1).some((token) => token === "test");
  }
  if (binary === "mvn" || binary === "gradle") {
    return tokens.slice(1).some(
      (token) => VALIDATION_TASKS.has(token) || token.startsWith("test"),
    );
  }
  if (PACKAGE_MANAGER_COMMANDS.has(binary)) {
    return tokens.slice(1).some(
      (token) =>
        VALIDATION_TASKS.has(token) ||
        token.startsWith("test:") ||
        token === "playwright" ||
        token === "vitest" ||
        token === "jest" ||
        token === "tsc",
    );
  }
  return false;
}

function isSimpleEnvironment(command: string): boolean {
  const trimmed = command.trim();
  const tokens = commandTokens(trimmed);
  const binary = path.basename(tokens[0] ?? "");
  if (ENVIRONMENT_COMMANDS.has(binary)) {
    if (binary === "find") {
      return !tokens.some((token) =>
        ["-delete", "-exec", "-execdir"].includes(token),
      );
    }
    return true;
  }
  if (binary === "git") {
    return GIT_INSPECTION_COMMANDS.has(tokens[1] ?? "");
  }
  if (binary === "curl" || binary === "wget") {
    return !tokens.some((token) =>
      ["-d", "--data", "--data-raw", "--data-binary", "-XPOST", "-o"].includes(
        token,
      ),
    );
  }
  return false;
}

function isSimpleTooling(command: string): boolean {
  if (isSimpleEnvironment(command)) return true;
  const tokens = commandTokens(command);
  const binary = path.basename(tokens[0] ?? "");
  if (!PACKAGE_MANAGER_COMMANDS.has(binary)) return false;
  return tokens
    .slice(1)
    .some((token) => PACKAGE_MANAGER_TOOLING_SUBCOMMANDS.has(token));
}

export function isReadCommand(command: string): boolean {
  const segments = segmentsOf(command);
  return segments.length > 0 && segments.every(isSimpleRead);
}

/** True for source and file inspection commands that do not mutate state. */
export function isInspectionCommand(command: string): boolean {
  const segments = segmentsOf(command);
  return (
    segments.length > 0 &&
    segments.every(
      (segment) => isSimpleRead(segment) || isSimpleEnvironment(segment),
    )
  );
}

/** True when a command contains source reads plus environment probes. */
export function hasSourceReadCommand(command: string): boolean {
  return segmentsOf(command).some(isSimpleRead);
}

/** True when every shell segment is a test, build, lint, or type-check command. */
export function isValidationCommand(command: string): boolean {
  const segments = segmentsOf(command);
  return segments.length > 0 && segments.every(isSimpleValidation);
}

/** True for validation commands safely chained with read-only inspection. */
export function isVerificationCommand(command: string): boolean {
  const segments = segmentsOf(command);
  return (
    segments.length > 0 &&
    segments.some(isSimpleValidation) &&
    segments.every(
      (segment) =>
        isSimpleValidation(segment) ||
        isSimpleRead(segment) ||
        isSimpleEnvironment(segment),
    )
  );
}

/** True for safe environment probes and package-manager/tooling inspection. */
export function isToolingCommand(command: string): boolean {
  const segments = segmentsOf(command);
  return segments.length > 0 && segments.every(isSimpleTooling);
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
  const commandParts = commandTokens(trimmed);
  if (
    path.basename(commandParts[0] ?? "") === "sed" &&
    commandParts[1] === "-n"
  ) {
    const tokens = commandParts.slice(2);
    return tokens.filter((token, index) => {
      if (token === "--") return false;
      if (token.startsWith("-")) return false;
      const previous = tokens[index - 1];
      return previous !== "-n" && previous !== "--line-range";
    }).slice(-1);
  }

  const binary = binaryName(trimmed);
  if (!READ_COMMANDS.has(binary)) return [];

  const tokens = commandTokens(trimmed).slice(1);
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
  return segmentsOf(command).some(
    (segment) => isSimpleMutation(segment) || isSimpleValidation(segment),
  );
}

export function isWriteCommand(command: string): boolean {
  return segmentsOf(command).some(isSimpleMutation);
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
