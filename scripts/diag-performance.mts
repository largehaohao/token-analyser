/**
 * Diagnosis harness for TTFT / output-token-speed across session sources.
 *
 * Reads the real session data on this machine (never writes it) and prints the
 * counts the UI needs: recorded durations, per-turn performance, and the
 * session-level performance summary. Symptom lines start with SYMPTOM.
 *
 * Run: npx tsx scripts/diag-performance.mts [pi|cursor|claude|all] [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestSessions } from "../packages/engine/src/ingest.ts";
import type { SessionSnapshot } from "../packages/engine/src/types.ts";

type Source = "pi" | "cursor" | "claude" | "all";
const args = process.argv.slice(2);
const json = args.includes("--json");
const wanted = (args.find((a) => !a.startsWith("--")) as Source) ?? "all";
const home = os.homedir();
const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "diag-perf-"));

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function latest(files: string[], count: number): string[] {
  return [...files].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, count);
}

function ingest(files: string[]): SessionSnapshot[] {
  const out: SessionSnapshot[] = [];
  for (const file of files) {
    try { out.push(...ingestSessions(file, { cacheHome })); } catch { /* skip unreadable */ }
  }
  return out;
}

/** Counts straight from the raw logs, independent of any parsing. */
function rawAssistantLines(files: string[]): { usage: number; duration: number; ttft: number } {
  let usage = 0;
  let duration = 0;
  let ttft = 0;
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message || message.role !== "assistant") continue;
      const flat = JSON.stringify(entry);
      if (message.usage) usage += 1;
      if (/"durationMs"|"duration_ms"|"request_duration_ms"/.test(flat)) duration += 1;
      if (/"ttftMs"|"ttft_ms"|"time_to_first_token_ms"/.test(flat)) ttft += 1;
    }
  }
  return { usage, duration, ttft };
}

type Report = {
  label: string;
  sessions: number;
  turns: number;
  raw: { usage: number; duration: number; ttft: number };
  turnDuration: number;
  turnTtft: number;
  turnSpeed: number;
  sessionsWithUsage: number;
  sessionsTtft: number;
  sessionsSpeed: number;
  basis: Record<string, number>;
  symptoms: string[];
};

function report(label: string, snapshots: SessionSnapshot[], raw: Report["raw"]): Report {
  const turns = snapshots.flatMap((s) => s.turns);
  const perf = turns.map((t) => t.requestPerformance);
  const sessionsWithUsage = snapshots.filter((s) => s.turns.some((t) => t.usageRecorded)).length;
  const basis: Record<string, number> = {};
  for (const s of snapshots) {
    const key = s.performance?.basis ?? "none";
    basis[key] = (basis[key] ?? 0) + 1;
  }
  const sessionsTtft = snapshots.filter((s) => s.performance?.avgTtftMs != null).length;
  const sessionsSpeed = snapshots.filter((s) => s.performance?.outputTokensPerSecond != null).length;
  const symptoms: string[] = [];
  if (raw.duration > 0 && perf.every((p) => p?.durationMs == null)) {
    symptoms.push("durations recorded in the logs never reach turn performance");
  }
  if (raw.duration > 0 && sessionsSpeed === 0) {
    symptoms.push("request durations are recorded, but no session reports output tokens per second");
  }
  if (snapshots.length > 0 && raw.usage > 0 && sessionsWithUsage === 0) {
    symptoms.push("token usage is recorded in the logs, but no session reports recorded usage");
  }
  return {
    label,
    sessions: snapshots.length,
    turns: turns.length,
    raw,
    turnDuration: perf.filter((p) => p?.durationMs != null).length,
    turnTtft: perf.filter((p) => p?.ttftMs != null).length,
    turnSpeed: perf.filter((p) => p?.outputTokensPerSecond != null).length,
    sessionsWithUsage,
    sessionsTtft,
    sessionsSpeed,
    basis,
    symptoms,
  };
}

const sources: Source[] = wanted === "all" ? ["pi", "cursor", "claude"] : [wanted];
const reports: Report[] = [];
for (const source of sources) {
  if (source === "cursor") {
    const store = path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    const snapshots = fs.existsSync(store)
      ? ingest([store]).filter((s) => s.source === "cursor")
      : [];
    const transcripts = latest(walk(path.join(home, ".cursor/projects")), 25);
    reports.push(report("cursor", snapshots, rawAssistantLines(transcripts)));
    continue;
  }
  const dir = source === "pi"
    ? path.join(home, ".pi/agent/sessions")
    : path.join(home, ".claude/projects");
  const files = latest(walk(dir), 25);
  reports.push(report(source, ingest(files), rawAssistantLines(files)));
}

fs.rmSync(cacheHome, { recursive: true, force: true });

if (json) {
  console.log(JSON.stringify(reports, null, 1));
} else {
  for (const r of reports) {
    console.log(`\n== ${r.label} ==`);
    console.log(`sessions=${r.sessions} turns=${r.turns}`);
    console.log(`raw logs: assistantUsage=${r.raw.usage} assistantWithDuration=${r.raw.duration} assistantWithTtft=${r.raw.ttft}`);
    console.log(`turn performance: duration=${r.turnDuration} ttft=${r.turnTtft} speed=${r.turnSpeed}`);
    console.log(`sessions with recorded usage=${r.sessionsWithUsage}`);
    console.log(`session summary: ttft=${r.sessionsTtft} speed=${r.sessionsSpeed} basis=${JSON.stringify(r.basis)}`);
    for (const symptom of r.symptoms) console.log(`SYMPTOM ${symptom}`);
  }
}

const failing = reports.some((r) => r.symptoms.length > 0);
if (failing) console.error("RESULT red");
