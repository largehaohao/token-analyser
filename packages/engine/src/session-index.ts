import { zstdCompressSync } from "node:zlib";
import { sha256 } from "./hash.ts";
import { sumTurns } from "./tree.ts";
import type { AnalysisSession, AnalysisTurn, SessionListItem, SessionSnapshot } from "./types.ts";

/** Source-level data needed for list and overview reads. Full evidence lives in sources.snapshot_json. */
export type SessionIndex = Omit<SessionListItem, "parse_error" | "parse_error_offset" | "parse_error_message"> &
  Omit<AnalysisSession, "children"> & Pick<SessionSnapshot, "path" | "finalized"> & {
    revision: string;
    children: SessionIndex[];
  };

export type PreparedSource = { index: SessionIndex; json: string; packedIndex?: Uint8Array };

export function encodeIndex(index: SessionIndex): Buffer {
  return zstdCompressSync(Buffer.from(JSON.stringify(index)));
}

export function prepareSource(snapshot: SessionSnapshot, json = JSON.stringify({ ...snapshot, children: [] })): PreparedSource {
  let unpricedRaw = 0;
  const turns: AnalysisTurn[] = snapshot.turns.map((turn) => {
    if (turn.cost.credits == null && turn.cost.usd == null) unpricedRaw += turn.cost.raw;
    return {
      id: turn.id,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      model: turn.model,
      bucket: turn.bucket,
      labels: turn.labels,
      usageRecorded: turn.usageRecorded,
      usage: { output_tokens: turn.usage.output_tokens },
      cost: turn.cost,
      requestPerformance: turn.requestPerformance,
    };
  });
  return {
    json,
    index: {
      revision: sha256(json),
      id: snapshot.id,
      source: snapshot.source,
      sourceId: snapshot.sourceId,
      parentId: snapshot.parentId,
      nickname: snapshot.nickname,
      messageCount: snapshot.messageCount,
      cwd: snapshot.cwd,
      path: snapshot.path,
      finalized: snapshot.finalized,
      startedAt: snapshot.startedAt,
      lastEventAt: snapshot.lastEventAt,
      model: snapshot.model,
      effort: snapshot.effort,
      live: snapshot.live,
      ledger_warning: snapshot.ledger_warning,
      parse_errors: snapshot.parse_errors,
      rateLimitSnapshots: snapshot.rateLimitSnapshots,
      taskTimings: snapshot.taskTimings,
      toolsChars: snapshot.context?.tools.chars ?? 0,
      toolsCount: snapshot.context?.tools.items.length ?? 0,
      skillsChars: snapshot.context?.skills.chars ?? 0,
      skillsCount: snapshot.context?.skills.items.length ?? 0,
      toggles: snapshot.toggles,
      cost: sumTurns(turns),
      waste: snapshot.waste,
      unpricedRaw,
      turns,
      children: [],
    },
  };
}
