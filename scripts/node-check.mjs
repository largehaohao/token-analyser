export function isSupportedNode(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15);
}

export function assertSupportedNode() {
  if (isSupportedNode()) return;
  console.error(
    `token-analyser requires Node.js 22.15+ (22.x) or 23.8+ (current ${process.version}).\n` +
      "The engine uses node:sqlite and the built-in Zstandard decoder.\n" +
      "Install a supported Node.js version (see .nvmrc) and start again.",
  );
  process.exit(1);
}
