import {
  addCost,
  emptyCost,
  type Cost,
  type SessionSnapshot,
  type Turn,
  type WasteToggleId,
} from "./types.ts";
import { isIdleChild } from "./tree.ts";

function isOwnTurnWaste(turn: Turn, toggles: Record<WasteToggleId, boolean>): boolean {
  if (toggles.poll && turn.bucket === "waiting.poll") return true;
  if (toggles.reread && turn.bucket === "reread") return true;
  if (toggles.compaction_loop && turn.labels.includes("compaction_loop")) return true;
  if (toggles.coord && turn.bucket === "waiting.coord") return true;
  if (toggles.planning && turn.bucket === "planning") return true;
  if (toggles.code && turn.bucket === "code") return true;
  return false;
}

function collectChildTurns(child: SessionSnapshot, idle: boolean): Turn[] {
  const matchesIdle = isIdleChild(child);
  const turns = matchesIdle === idle ? [...child.turns] : [];
  for (const grandchild of child.children) {
    turns.push(...collectChildTurns(grandchild, idle));
  }
  return turns;
}

export function computeWaste(args: {
  turns: Turn[];
  children: SessionSnapshot[];
  toggles: Record<WasteToggleId, boolean>;
}): { waste: Cost; turnIds: Set<string> } {
  const turnIds = new Set<string>();
  const turnById = new Map<string, Turn>();

  for (const turn of args.turns) {
    if (isOwnTurnWaste(turn, args.toggles)) {
      turnIds.add(turn.id);
      turnById.set(turn.id, turn);
    }
  }

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

  let waste = emptyCost();
  for (const id of turnIds) {
    waste = addCost(waste, turnById.get(id)!.cost);
  }

  return { waste, turnIds };
}
