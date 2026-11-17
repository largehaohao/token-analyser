export function isSupportedNode(version = process.versions.node) {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (major !== 22) return major > 22;
  if (minor !== 13) return minor > 13;
  return patch >= 0;
}

export function assertSupportedNode() {
  if (isSupportedNode()) return;
  console.error(
    `token-analyser requires Node.js >= 22.13.0 (current ${process.version}).\n` +
      "Cursor and OpenCode stores are read with node:sqlite, which this runtime does not provide.\n" +
      "Install Node.js 22.13 or newer (see .nvmrc) and start again.",
  );
  process.exit(1);
}
