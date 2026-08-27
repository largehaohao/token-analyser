import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Cost, TreeNode } from "./types.ts";
import { parseJsonlChunk } from "./parse-jsonl.ts";
import { analyseSession } from "./snapshot.ts";

function resolveWorkspaceRoot(start: string): string {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

function resolveInputPath(filePath: string): string {
  const direct = path.resolve(filePath);
  if (existsSync(direct)) return direct;
  return path.resolve(resolveWorkspaceRoot(process.cwd()), filePath);
}

function formatCredits(credits: number | null): string {
  if (credits == null) return "—";
  return credits.toFixed(4);
}

function formatCost(cost: Cost): string {
  return `raw=${cost.raw} credits=${formatCredits(cost.credits)}`;
}

function printTreeNode(node: TreeNode, prefix: string, isLast: boolean): void {
  const connector =
    prefix === "" ? "" : isLast ? " └─ " : " ├─ ";
  const pct = node.percentOfParent.toFixed(1);
  console.log(
    `${prefix}${connector}${node.label} ${pct}% ${formatCost(node.cost)}`,
  );

  const extension = prefix === "" ? " " : isLast ? "    " : " │  ";
  const childPrefix = prefix + extension;
  node.children.forEach((child, index) => {
    printTreeNode(child, childPrefix, index === node.children.length - 1);
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const filePath = args.find((arg) => arg !== "--json");

  if (!filePath) {
    console.error("Usage: analyse-cli.ts <file.jsonl> [--json]");
    process.exit(1);
  }

  const absolutePath = resolveInputPath(filePath);
  const text = readFileSync(absolutePath, "utf8");
  const { events, errors } = parseJsonlChunk(
    text.endsWith("\n") ? text : text + "\n",
    0,
  );

  const snapshot = analyseSession({
    events,
    path: absolutePath,
    parse_errors: errors,
  });

  if (jsonMode) {
    console.log(JSON.stringify(snapshot));
    return;
  }

  printTreeNode(snapshot.tree, "", true);
  console.log(`waste: ${formatCost(snapshot.waste)}`);
}

main();
