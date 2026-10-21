import type { Turn } from "./api";

/**
 * Latency histograms. The buckets are fixed so two sessions, two ranges and two
 * sources can be compared on one scale; the engine publishes the same edges for
 * the overview aggregate, and the labels below are shared by both surfaces.
 */
export const TTFT_EDGES_S = [1, 2, 3, 5] as const;
export const TPS_EDGES = [10, 25, 40, 60] as const;

export type HistogramData = {
  labels: string[];
  counts: number[];
  /** Turns with a measurement, i.e. the histogram's own denominator. */
  known: number;
  /** Turns in scope, including turns with no timing at all. */
  total: number;
  unit: string;
};

function bucketLabels(edges: readonly number[], unit: string): string[] {
  return Array.from({ length: edges.length + 1 }, (_, index) => {
    if (index === 0) return `≤ ${edges[0]}${unit}`;
    if (index === edges.length) return `> ${edges[edges.length - 1]}${unit}`;
    return `${edges[index - 1]}–${edges[index]}${unit}`;
  });
}

/** Labels for the engine's fixed-count arrays (edges + 1 buckets). */
export const TTFT_LABELS = bucketLabels(TTFT_EDGES_S, "s");
export const TPS_LABELS = bucketLabels(TPS_EDGES, " tok/s");

function bucketize(
  values: number[],
  edges: readonly number[],
  labels: string[],
  unit: string,
  total: number,
): HistogramData {
  const counts = new Array(edges.length + 1).fill(0);
  for (const value of values) {
    const index = edges.findIndex((edge) => value <= edge);
    counts[index < 0 ? edges.length : index] += 1;
  }
  return { labels, counts, known: values.length, total, unit };
}

/**
 * Per-session latency histograms from the turn records. Turns without a
 * measurement are counted in `total` and left out of the buckets, so the panel
 * can say how much of the session has no timing at all.
 */
export function turnDistributions(turns: Turn[]): {
  ttft: HistogramData;
  speed: HistogramData;
} {
  // The engine records TTFT in milliseconds; the shared buckets are seconds.
  const seconds = turns
    .map((turn) => turn.requestPerformance?.ttftMs)
    .filter((value): value is number => value != null)
    .map((ms) => ms / 1000);
  const speeds = turns
    .map((turn) => turn.requestPerformance?.outputTokensPerSecond)
    .filter((value): value is number => value != null);
  return {
    ttft: bucketize(
      seconds,
      TTFT_EDGES_S,
      TTFT_LABELS,
      "s",
      turns.length,
    ),
    speed: bucketize(
      speeds,
      TPS_EDGES,
      TPS_LABELS,
      " tok/s",
      turns.length,
    ),
  };
}

/** The overview aggregate arrives as fixed-count arrays from the engine. */
export function arrayHistogram(
  labels: readonly string[],
  counts: readonly number[],
  unit: string,
  total: number,
): HistogramData {
  const known = counts.reduce((sum, count) => sum + count, 0);
  return {
    labels: [...labels],
    counts: [...counts],
    known,
    total,
    unit,
  };
}

export function distributionSummary(dist: HistogramData): string {
  if (dist.known === 0) return "该范围内没有来源记录的耗时";
  const mode = dist.labels[dist.counts.indexOf(Math.max(...dist.counts))];
  return `${dist.known}/${dist.total} 轮有记录 · 多数落在 ${mode}`;
}
