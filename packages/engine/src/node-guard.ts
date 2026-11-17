/** Minimum runtime: Cursor and OpenCode stores use the built-in node:sqlite. */
export const MIN_NODE_VERSION = "22.13.0";

export function isNodeVersionSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== 22) return major > 22;
  if (minor !== 13) return minor > 13;
  return patch >= 0;
}

export function unsupportedNodeMessage(current = process.version): string {
  return [
    `token-analyser requires Node.js >= ${MIN_NODE_VERSION} (current ${current}).`,
    "Cursor and OpenCode stores are read with node:sqlite, which this runtime does not provide.",
    "Install Node.js 22.13 or newer (see .nvmrc) and start again.",
  ].join("\n");
}

export function assertSupportedNode(): void {
  if (isNodeVersionSupported(process.versions.node)) return;
  console.error(unsupportedNodeMessage());
  process.exit(1);
}

assertSupportedNode();
