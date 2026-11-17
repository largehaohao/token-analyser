import type { OverviewDay } from "./api";
import type { ChartMetric } from "./chart-metric";
import { dayMetricValue } from "./chart-metric";

export type MetricPoint = { date: string; value: number | null };
export type TrendMode = "daily" | "cumulative" | "moving";
export type DonutSegment = { key: string; label: string; value: number; color: string };

export function metricSeries(
  days: OverviewDay[],
  metric: ChartMetric,
): MetricPoint[] {
  return days.map((day) => ({ date: day.date, value: dayMetricValue(day, metric) }));
}

export function cumulativeSeries(points: MetricPoint[]): number[] {
  let running = 0;
  return points.map((point) => {
    running += point.value ?? 0;
    return running;
  });
}

/**
 * Trailing window average. A missing reading stays missing and never
 * contributes to a neighbouring window, so the sparkline cannot invent data.
 */
export function movingAverage(values: Array<number | null>, window = 7): Array<number | null> {
  return values.map((_, index) => {
    const start = Math.max(0, index - window + 1);
    const slice = values.slice(start, index + 1);
    if (slice.some((value) => value == null)) return null;
    return slice.reduce<number>((sum, value) => sum + (value ?? 0), 0) / slice.length;
  });
}

export function trendOverlay(
  points: MetricPoint[],
  mode: Exclude<TrendMode, "daily">,
  window = 7,
): Array<number | null> {
  const values = points.map((point) => point.value);
  if (mode === "cumulative") {
    return cumulativeSeries(points).map((value, index) => (values[index] == null ? null : value));
  }
  return movingAverage(values, window);
}

export function donutSegments(
  parts: Array<{ key: string; label: string; value: number; color: string }>,
): DonutSegment[] {
  return parts.filter((part) => part.value > 0);
}

/** SVG arc length for a donut ring with `radius`, in a 0..100 percentage scale. */
export function donutArc(total: number, value: number, radius: number): {
  dash: number;
  gap: number;
} {
  const circumference = 2 * Math.PI * radius;
  const dash = total > 0 ? (Math.max(0, value) / total) * circumference : 0;
  return { dash, gap: circumference - dash };
}

/** Calendar cells keep their weekday slot; empty trailing cells stay null. */
export function heatCalendar(days: OverviewDay[], metric: ChartMetric): Array<{
  date: string | null;
  value: number | null;
  level: number;
}> {
  const dated = days.filter(
    (day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && dayMetricValue(day, metric) != null,
  );
  if (dated.length === 0) return [];
  const first = new Date(`${dated[0]!.date}T00:00:00`);
  const lead = (first.getDay() + 6) % 7;
  const values = dated.map((day) => dayMetricValue(day, metric) ?? 0);
  const max = Math.max(...values, 1);
  const cells: Array<{ date: string | null; value: number | null; level: number }> = [];
  for (let i = 0; i < lead; i += 1) {
    cells.push({ date: null, value: null, level: 0 });
  }
  for (const day of dated) {
    const value = dayMetricValue(day, metric) ?? 0;
    const ratio = max > 0 ? value / max : 0;
    const level = value <= 0 ? 0 : ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
    cells.push({ date: day.date, value, level });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ date: null, value: null, level: 0 });
  }
  return cells;
}
