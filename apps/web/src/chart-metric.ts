import type { OverviewDay } from "./api";
import {
  formatChartNumber,
  formatExactTokens,
  type CostUnit,
} from "./format";

export type ChartMetric = "usd" | "tokens" | "credits";

export function unitToChartMetric(unit: CostUnit): ChartMetric {
  return unit;
}

export function dayMetricValue(
  day: OverviewDay,
  metric: ChartMetric,
): number | null {
  if (metric === "tokens") return day.cost.raw;
  const money = metric === "credits" ? day.cost.credits : day.cost.usd;
  if (money == null && day.cost.raw === 0) return 0;
  return money;
}

export function flaggedValue(
  day: OverviewDay,
  metric: ChartMetric,
): number | null {
  if (metric === "tokens") return day.flaggedCost.raw;
  const money =
    metric === "credits" ? day.flaggedCost.credits : day.flaggedCost.usd;
  if (money == null && day.flaggedCost.raw === 0) return 0;
  return money;
}

export function dayUnpricedRaw(day: OverviewDay): number {
  return day.unpricedRaw ?? 0;
}

export function dayHasMixedUnpriced(
  day: OverviewDay,
  metric: ChartMetric,
): boolean {
  return (
    dayUnpricedRaw(day) > 0 &&
    dayMetricValue(day, metric) != null &&
    day.cost.raw > 0
  );
}

export function chartMax(values: Array<number | null>): number {
  const known = values.filter((value): value is number => value != null && value > 0);
  return Math.max(...known, 1);
}

export function barHeightPct(
  value: number | null,
  raw: number,
  max: number,
): { height: number; unpriced: boolean } {
  if (value == null) {
    return { height: raw > 0 ? 2 : 0, unpriced: raw > 0 };
  }
  if (value <= 0 || max <= 0) return { height: 0, unpriced: false };
  return { height: (100 * value) / max, unpriced: false };
}

export function isOverflowDate(date: string): boolean {
  return date === "earlier" || date === "later";
}

export function formatChartDay(date: string): string {
  if (date === "earlier") return "更早";
  if (date === "later") return "之后";
  const parts = date.split("-");
  return `${parts[1]}/${parts[2]}`;
}

export function chartDayTooltip(date: string): string {
  if (date === "earlier") return "窗口之前";
  if (date === "later") return "窗口之后";
  return `${date} 本地时间`;
}

export function trendColumnAriaLabel(
  day: OverviewDay,
  metric: ChartMetric,
): string {
  const total = dayMetricValue(day, metric);
  const value =
    total == null ? "未定价" : formatChartNumber(total, metric);
  const unpriced = dayUnpricedRaw(day);
  const extra =
    unpriced > 0 && total != null
      ? `，另有 ${formatExactTokens(unpriced)} tokens 未定价`
      : "";
  return `${chartDayTooltip(day.date)} ${value}${extra}`;
}

export function shouldLabelChartDay(
  date: string,
  dates: string[],
  maxLabels = 10,
): boolean {
  if (isOverflowDate(date)) return true;
  const dated = dates.filter((item) => !isOverflowDate(item));
  const index = dated.indexOf(date);
  if (index < 0) return false;
  const every = dated.length > 14 ? Math.ceil(dated.length / maxLabels) : 1;
  return index % every === 0;
}
