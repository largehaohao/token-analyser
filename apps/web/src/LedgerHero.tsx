import type { CSSProperties } from "react";
import type { Overview } from "./api";
import { localDateString } from "./chart-metric";
import {
  costValue,
  formatCostTitle,
  formatUnitSuffix,
  type CostUnit,
} from "./format";
import { formatAnimatedCost } from "./LedgerStrip";
import { useAnimatedNumber, useFlashOnChange } from "./motion";
import { metricSeries } from "./visual-metrics";

const WIDTH = 240;
const HEIGHT = 64;
const PAD = 3;

function sparkPath(values: number[]): { line: string; area: string; lastX: number; lastY: number } | null {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const innerW = WIDTH - PAD * 2;
  const innerH = HEIGHT - PAD * 2;
  const points = values.map((value, index) => {
    const x = PAD + (index / (values.length - 1)) * innerW;
    const y = HEIGHT - PAD - (value / max) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1]!.split(",");
  return {
    line: points.join(" "),
    area: `${PAD},${HEIGHT - PAD} ${points.join(" ")} ${WIDTH - PAD},${HEIGHT - PAD}`,
    lastX: Number(last[0]),
    lastY: Number(last[1]),
  };
}

/**
 * One primary reading plus the shape of the window. The exact value is still
 * in the title; the strip below keeps every comparison and secondary figure.
 */
export function LedgerHero({
  overview,
  previous,
  previousLabel,
  unit,
}: {
  overview: Overview;
  previous: Overview | null;
  previousLabel: string | null;
  unit: CostUnit;
}) {
  const current = costValue(overview.cost, unit);
  const prev = previous ? costValue(previous.cost, unit) : null;
  const delta = prev != null && prev > 0 && current != null ? ((current - prev) / prev) * 100 : null;
  const animated = useAnimatedNumber(current);
  const flash = useFlashOnChange(overview.cost.raw);
  const today = localDateString(new Date());
  const values = metricSeries(overview.days, unit).map((point) => point.value ?? 0);
  const shape = sparkPath(values);
  const dated = overview.days.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
  const lastIsToday = dated.length > 0 && dated[dated.length - 1]!.date === today;

  return (
    <section className="ledger-hero" data-testid="ledger-hero" aria-label="当前范围总用量">
      <div className="ledger-hero-copy">
        <span className="ledger-hero-label">总用量 · {unit}</span>
        <span
          className={`ledger-hero-value${flash ? " value-flash" : ""}`}
          title={formatCostTitle(overview.cost, unit)}
        >
          {formatAnimatedCost(overview.cost, unit, animated)}
          <span className="ledger-unit"> {formatUnitSuffix(unit)}</span>
        </span>
        <span className="ledger-hero-meta">
          <span className={`ledger-delta ${delta == null ? "" : delta > 0 ? "up" : "down"}`}>
            {delta == null
              ? `较${previousLabel ?? "上一周期"} —`
              : `较${previousLabel ?? "上一周期"} ${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(0)}%`}
          </span>
          <span>{overview.sessionCount.toLocaleString("en-US")} 个会话 · {overview.turnCount.toLocaleString("en-US")} 轮</span>
          <span>{overview.days.length} 天趋势</span>
        </span>
      </div>
      {shape && (
        <svg
          className="ledger-hero-spark"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="统计窗口内每日用量趋势"
        >
          <polygon className="hero-spark-area" points={shape.area} />
          <polyline className="hero-spark-line" points={shape.line} pathLength={1} />
          {lastIsToday && (
            <circle
              className="hero-spark-today"
              cx={shape.lastX}
              cy={shape.lastY}
              r={3}
              style={{ "--i": 0 } as CSSProperties}
            />
          )}
        </svg>
      )}
    </section>
  );
}
