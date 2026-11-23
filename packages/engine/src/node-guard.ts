/** First 22.x release with both node:sqlite and node:zlib's Zstandard decoder. */
export const MIN_NODE_VERSION = "22.15.0";

export function isNodeVersionSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15);
}

export function unsupportedNodeMessage(current = process.version): string {
  return [
    `token-analyser requires Node.js ${MIN_NODE_VERSION}+ (22.x) or 23.8+ (current ${current}).`,
    "The engine uses node:sqlite and the built-in Zstandard decoder.",
    "Install a supported Node.js version (see .nvmrc) and start again.",
  ].join("\n");
}

export function assertSupportedNode(): void {
  if (isNodeVersionSupported(process.versions.node)) return;
  console.error(unsupportedNodeMessage());
  process.exit(1);
}

assertSupportedNode();
