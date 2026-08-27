import { extractReadPaths, isReadCommand } from "./exec-command.ts";
import { sumTurns } from "./tree.ts";
import type { DetectorLabel, RolloutLine, Suggestion, Turn } from "./types.ts";

function addLabel(turn: Turn, label: DetectorLabel): void {
  if (!turn.labels.includes(label)) {
    turn.labels.push(label);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function pathsReadInTurn(turn: Turn): string[] {
  const paths: string[] = [];
  for (const tool of turn.tools) {
    if (tool.name === "exec" && isReadCommand(tool.input)) {
      paths.push(...extractReadPaths(tool.input));
    }
  }
  return paths;
}

function copyTurns(turns: Turn[]): Turn[] {
  return turns.map((turn) => ({
    ...turn,
    tools: [...turn.tools],
    labels: [...turn.labels],
  }));
}

function detectPollSpin(turns: Turn[]): Suggestion | null {
  const labeled: Turn[] = [];

  let i = 0;
  while (i < turns.length) {
    if (turns[i]!.bucket !== "waiting.poll") {
      i++;
      continue;
    }

    let j = i;
    while (j < turns.length && turns[j]!.bucket === "waiting.poll") {
      j++;
    }

    const run = turns.slice(i, j);
    if (run.length >= 3) {
      const intervals: number[] = [];
      for (let k = 1; k < run.length; k++) {
        intervals.push(
          Date.parse(run[k]!.endedAt) - Date.parse(run[k - 1]!.endedAt),
        );
      }
      const med = median(intervals);
      if (med >= 20_000 && med <= 70_000) {
        for (const turn of run) {
          addLabel(turn, "poll_spin");
          labeled.push(turn);
        }
      }
    }

    i = j;
  }

  if (labeled.length === 0) return null;

  const hasWaitAgent = labeled.some((turn) =>
    turn.tools.some((tool) => tool.name === "wait_agent"),
  );
  const allCost = sumTurns(turns);
  const spinCost = sumTurns(labeled);
  const rawPct = allCost.raw === 0 ? 0 : (100 * spinCost.raw) / allCost.raw;
  const creditsPct =
    allCost.credits == null ||
    spinCost.credits == null ||
    allCost.credits === 0
      ? null
      : (100 * spinCost.credits) / allCost.credits;

  const title = hasWaitAgent
    ? "Parent woke the model only to call wait_agent"
    : "Repeated poll idle turns";

  let body = `Poll is ${rawPct.toFixed(1)}% of session raw`;
  if (creditsPct != null) {
    body += `, ~${creditsPct.toFixed(1)}% of credits`;
  }
  body += ".";

  return {
    id: "poll-spin-1",
    kind: "poll_spin",
    title,
    body,
    turnIds: labeled.map((turn) => turn.id),
  };
}

function detectRereadRepeat(turns: Turn[]): Turn[] {
  const pathHashCounts = new Map<string, Map<string, number>>();
  const labeled: Turn[] = [];

  for (const turn of turns) {
    let labeledTurn = false;
    for (const tool of turn.tools) {
      if (tool.name !== "exec" || !isReadCommand(tool.input)) continue;
      for (const targetPath of extractReadPaths(tool.input)) {
        const counts = pathHashCounts.get(targetPath) ?? new Map<string, number>();
        const seen = counts.get(tool.outputSha256) ?? 0;
        if (seen >= 1) {
          labeledTurn = true;
        }
        counts.set(tool.outputSha256, seen + 1);
        pathHashCounts.set(targetPath, counts);
      }
    }
    if (labeledTurn) {
      addLabel(turn, "reread_repeat");
      labeled.push(turn);
    }
  }

  return labeled;
}

function detectCompactionLoop(
  turns: Turn[],
  events: RolloutLine[],
): { compactionTurns: Turn[]; heavy: boolean } {
  const compactTimes = events
    .filter((event) => event.type === "compacted")
    .map((event) => Date.parse(event.timestamp))
    .sort((a, b) => a - b);

  const compactionTurns: Turn[] = [];

  for (let ci = 0; ci < compactTimes.length; ci++) {
    const compactAt = compactTimes[ci]!;
    const nextCompactAt =
      ci + 1 < compactTimes.length ? compactTimes[ci + 1]! : Number.POSITIVE_INFINITY;

    const pathsBefore = new Set<string>();
    for (const turn of turns) {
      if (Date.parse(turn.endedAt) >= compactAt) break;
      for (const targetPath of pathsReadInTurn(turn)) {
        pathsBefore.add(targetPath);
      }
    }

    for (const turn of turns) {
      const endedAt = Date.parse(turn.endedAt);
      if (endedAt <= compactAt || endedAt >= nextCompactAt) continue;
      if (turn.bucket !== "reread") continue;
      if (pathsReadInTurn(turn).some((targetPath) => pathsBefore.has(targetPath))) {
        addLabel(turn, "compaction_loop");
        compactionTurns.push(turn);
      }
    }
  }

  let heavy = false;
  if (compactTimes.length >= 2) {
    const firstCompact = compactTimes[0]!;
    const lastCompact = compactTimes[compactTimes.length - 1]!;
    const windowTurns = turns.filter((turn) => {
      const endedAt = Date.parse(turn.endedAt);
      return endedAt > firstCompact && endedAt < lastCompact;
    });
    const windowCost = sumTurns(windowTurns);
    const codeRaw = windowTurns
      .filter((turn) => turn.bucket === "code")
      .reduce((sum, turn) => sum + turn.cost.raw, 0);
    const rereadRaw = windowTurns
      .filter((turn) => turn.bucket === "reread")
      .reduce((sum, turn) => sum + turn.cost.raw, 0);
    if (
      windowCost.raw > 0 &&
      codeRaw / windowCost.raw < 0.15 &&
      rereadRaw / windowCost.raw >= 0.3
    ) {
      heavy = true;
    }
  }

  return { compactionTurns, heavy };
}

function buildCompactionSuggestions(
  turns: Turn[],
  events: RolloutLine[],
  compactionTurns: Turn[],
  heavy: boolean,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const compactCount = events.filter((event) => event.type === "compacted").length;

  if (compactionTurns.length > 0 || heavy) {
    const allCost = sumTurns(turns);
    const loopCost = sumTurns(compactionTurns);
    const credits =
      loopCost.credits == null ? null : loopCost.credits.toFixed(1);

    suggestions.push({
      id: heavy ? "compaction-loop-heavy-1" : "compaction-loop-1",
      kind: heavy ? "compaction_loop_heavy" : "compaction_loop",
      title: heavy
        ? "Heavy compaction loop detected"
        : "Compaction loop detected",
      body: `Context compacted ${compactCount} time${compactCount === 1 ? "" : "s"}, then the same files were read back.${credits != null ? ` ~${credits} credits.` : ""} Finish the child task or shrink the working set before continuing.`,
      turnIds: compactionTurns.map((turn) => turn.id),
    });
  }

  return suggestions;
}

function buildRereadRepeatSuggestion(labeled: Turn[]): Suggestion | null {
  if (labeled.length === 0) return null;

  return {
    id: "reread-repeat-1",
    kind: "reread_repeat",
    title: "Identical file reads repeated",
    body: `${labeled.length} turn${labeled.length === 1 ? "" : "s"} re-read files with unchanged output.`,
    turnIds: labeled.map((turn) => turn.id),
  };
}

export function detect(
  turns: Turn[],
  events: RolloutLine[],
): { turns: Turn[]; suggestions: Suggestion[] } {
  const copied = copyTurns(turns);

  const pollSuggestion = detectPollSpin(copied);
  const rereadRepeatTurns = detectRereadRepeat(copied);
  const { compactionTurns, heavy } = detectCompactionLoop(copied, events);

  const suggestions: Suggestion[] = [];
  if (pollSuggestion) suggestions.push(pollSuggestion);

  const compactionSuggestions = buildCompactionSuggestions(
    copied,
    events,
    compactionTurns,
    heavy,
  );
  suggestions.push(...compactionSuggestions);

  if (compactionSuggestions.length === 0) {
    const rereadSuggestion = buildRereadRepeatSuggestion(rereadRepeatTurns);
    if (rereadSuggestion) suggestions.push(rereadSuggestion);
  }

  return { turns: copied, suggestions };
}
