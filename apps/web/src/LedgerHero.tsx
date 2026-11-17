import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Overview } from "./api";
import { ChartTooltip, useChartTooltip } from "./ChartTooltip";
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
import { BareButton, Icon } from "./ui";

const WIDTH = 240;
const HEIGHT = 64;
const PAD = 3;

function sparkPoints(values: number[], max: number): string[] {
  const innerW = WIDTH - PAD * 2;
  const innerH = HEIGHT - PAD * 2;
  return values.map((value, index) => {
    const x = PAD + (index / Math.max(1, values.length - 1)) * innerW;
    const y = HEIGHT - PAD - (value / max) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
}

function sparkShape(values: number[], max: number) {
  if (values.length < 2) return null;
  const points = sparkPoints(values, max);
  const last = points[points.length - 1]!.split(",");
  return {
    line: points.join(" "),
    area: `${PAD},${HEIGHT - PAD} ${points.join(" ")} ${WIDTH - PAD},${HEIGHT - PAD}`,
    lastX: Number(last[0]),
    lastY: Number(last[1]),
  };
}

export function LedgerHero({
  overview,
  previous,
  previousLabel,
  unit,
  onDrillDay,
}: {
  overview: Overview;
  previous: Overview | null;
  previousLabel: string | null;
  unit: CostUnit;
  onDrillDay?: (date: string) => void;
}) {
  const current = costValue(overview.cost, unit);
  const prev = previous ? costValue(previous.cost, unit) : null;
  const delta = prev != null && prev > 0 && current != null ? ((current - prev) / prev) * 100 : null;
  const animated = useAnimatedNumber(current);
  const flash = useFlashOnChange(overview.cost.raw);
  const today = localDateString(new Date());
  const values = metricSeries(overview.days, unit).map((point) => point.value ?? 0);
  const prevValues = previous
    ? metricSeries(previous.days, unit).map((point) => point.value ?? 0)
    : null;
  const max = Math.max(...values, ...(prevValues ?? []), 1);
  const hasData = values.some((value) => value > 0);
  const shape = hasData ? sparkShape(values, max) : null;
  const ghost =
    prevValues && prevValues.length >= 2 && prevValues.some((value) => value > 0)
      ? sparkPoints(prevValues, max).join(" ")
      : null;
  const dated = overview.days.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
  const lastIsToday = dated.length > 0 && dated[dated.length - 1]!.date === today;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tip = useChartTooltip();
  const [scrub, setScrub] = useState<number | null>(null);

  function scrubTo(index: number | null) {
    if (index == null || values.length === 0) {
      setScrub(null);
      tip.hide();
      return;
    }
    const clamped = Math.max(0, Math.min(values.length - 1, index));
    setScrub(clamped);
    if (wrapRef.current) tip.show(`scrub-${clamped}`, wrapRef.current);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    scrubTo(Math.round(ratio * (values.length - 1)));
  }

  const scrubDate = scrub != null ? overview.days[scrub]?.date : null;
  const scrubPoint = scrub != null ? sparkPoints(values, max)[scrub] : null;
  const scrubX = scrubPoint?.split(",")[0];
  const scrubY = scrubPoint?.split(",")[1];

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
      {shape ? (
        <div
          ref={wrapRef}
          className="ledger-hero-spark-wrap"
          tabIndex={0}
          role="group"
          aria-label="统计窗口内每日用量趋势；左右方向键逐日读数，Esc 关闭"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => scrubTo(null)}
          onFocus={() => scrubTo(values.length - 1)}
          onBlur={() => scrubTo(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") scrubTo(null);
            else if (event.key === "ArrowLeft") scrubTo((scrub ?? values.length - 1) - 1);
            else if (event.key === "ArrowRight") scrubTo((scrub ?? 0) + 1);
            else if (event.key === "Home") scrubTo(0);
            else if (event.key === "End") scrubTo(values.length - 1);
          }}
        >
          <svg
            className="ledger-hero-spark"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            aria-hidden="true"
          >
            <polygon className="hero-spark-area" points={shape.area} />
            {ghost && <polyline className="hero-spark-ghost" points={ghost} />}
            <polyline className="hero-spark-line" points={shape.line} pathLength={1} />
            {scrubX != null && scrubY != null && (
              <g className="hero-spark-scrub">
                <line x1={scrubX} y1={PAD} x2={scrubX} y2={HEIGHT - PAD} />
                <circle cx={scrubX} cy={scrubY} r={3} />
              </g>
            )}
            {lastIsToday && scrub == null && (
              <circle
                className="hero-spark-today"
                cx={shape.lastX}
                cy={shape.lastY}
                r={3}
                style={{ "--i": 0 } as CSSProperties}
              />
            )}
          </svg>
          {scrub != null && scrubDate && (
            <ChartTooltip
              position={tip.position}
              onMouseEnter={tip.cancelHide}
              onMouseLeave={() => scrubTo(null)}
            >
              <b>{scrubDate}</b>
              <span>{values[scrub]?.toLocaleString()} {unit}</span>
              {ghost && prevValues?.[scrub] != null && (
                <span className="sep">上一周期同序 {prevValues[scrub]?.toLocaleString()}</span>
              )}
              {onDrillDay && (
                /^\d{4}-\d{2}-\d{2}$/.test(scrubDate) && (
                <BareButton
                  type="button"
                  className="tooltip-action"
                  onClick={() => {
                    scrubTo(null);
                    onDrillDay(scrubDate);
                  }}
                >
                  查看当日会话 <Icon name="arrow" />
                </BareButton>
                )
              )}
            </ChartTooltip>
          )}
        </div>
      ) : (
        <span className="ledger-hero-empty">窗口内无已记录用量</span>
      )}
    </section>
  );
}
