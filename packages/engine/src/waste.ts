import {
  addKnownCost,
  emptyCost,
  emptyMaybeCost,
  type Cost,
  type AnalysisSession,
  type AnalysisTurn,
  type WasteToggleId,
} from "./types.ts";
import { isIdleChild } from "./tree.ts";

function isOwnTurnWaste(turn: AnalysisTurn, toggles: Record<WasteToggleId, boolean>): boolean {
  if (toggles.poll && turn.bucket === "waiting.poll") return true;
  if (toggles.reread && turn.bucket === "reread") return true;
  if (toggles.compaction_loop && turn.labels.includes("compaction_loop")) return true;
  if (toggles.coord && turn.bucket === "waiting.coord") return true;
  if (toggles.planning && turn.bucket === "planning") return true;
  if (toggles.code && turn.bucket === "code") return true;
  return false;
}

function collectChildTurns(child: AnalysisSession, idle: boolean): AnalysisTurn[] {
  const matchesIdle = isIdleChild(child);
  const turns = matchesIdle === idle ? [...child.turns] : [];
  for (const grandchild of child.children) {
    turns.push(...collectChildTurns(grandchild, idle));
  }
  return turns;
}

function walkTurns(
  session: AnalysisSession,
  visit: (turn: AnalysisTurn) => void,
): void {
  for (const turn of session.turns) visit(turn);
  for (const child of session.children) walkTurns(child, visit);
}

export function computeWaste(args: {
  turns: AnalysisTurn[];
  children: AnalysisSession[];
  toggles: Record<WasteToggleId, boolean>;
}): { waste: Cost; turnIds: Set<string> } {
  const turnIds = new Set<string>();
  const turnById = new Map<string, AnalysisTurn>();

  const consider = (turn: AnalysisTurn): void => {
    if (isOwnTurnWaste(turn, args.toggles)) {
      turnIds.add(turn.id);
      turnById.set(turn.id, turn);
    }
  };

  for (const turn of args.turns) consider(turn);
  for (const child of args.children) walkTurns(child, consider);

  if (args.toggles.idle_subagents) {
    for (const child of args.children) {
      for (const turn of collectChildTurns(child, true)) {
        turnIds.add(turn.id);
        turnById.set(turn.id, turn);
      }
    }
  }

  if (args.toggles.healthy_subagents) {
    for (const child of args.children) {
      for (const turn of collectChildTurns(child, false)) {
        turnIds.add(turn.id);
        turnById.set(turn.id, turn);
      }
    }
  }

  let waste = emptyMaybeCost();
  for (const id of turnIds) {
    waste = addKnownCost(waste, turnById.get(id)!.cost);
  }
  if (waste.raw === 0 && !waste.unmeasured && !waste.usd) waste = emptyCost();

  return { waste, turnIds };
}
