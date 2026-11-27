import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Turn } from "./api";
import { ChartTooltip, useChartTooltip } from "./ChartTooltip";
import { formatCompactTokens } from "./format";
import { downsampleValues } from "./sparkline";
import { sortTurnsAscending } from "./turn-page";

type Props = {
  turns: Turn[];
};

const BAR_COUNT = 12;
const BAR_W = 4;
const BAR_GAP = 2;
const WIDTH = BAR_COUNT * BAR_W + (BAR_COUNT - 1) * BAR_GAP; // 70px
const HEIGHT = 20;

export function TurnSparkline({ turns }: Props) {
  const ordered = sortTurnsAscending(turns);
  const values = downsampleValues(
    ordered.map((turn) => turn.cost.raw),
    BAR_COUNT,
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tip = useChartTooltip();
  const [scrub, setScrub] = useState<number | null>(null);
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);

  // Flagged bars highlight buckets that contain any flagged/reread turn or peak.
  const bucketHasFlag = values.map((_, idx) => {
    const start = Math.floor((idx * ordered.length) / values.length);
    const end = Math.max(start + 1, Math.floor(((idx + 1) * ordered.length) / values.length));
    return ordered
      .slice(start, end)
      .some((t) => t.bucket === "reread" || (t.labels?.length ?? 0) > 0);
  });

  function scrubTo(index: number | null) {
    if (index == null) {
      setScrub(null);
      tip.hide();
      return;
    }
    const clamped = Math.max(0, Math.min(values.length - 1, index));
    setScrub(clamped);
    if (wrapRef.current) tip.show(`turn-${clamped}`, wrapRef.current);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    scrubTo(Math.round(ratio * (values.length - 1)));
  }

  return (
    <div
      ref={wrapRef}
      className="turn-sparkline-wrap"
      tabIndex={0}
      role="group"
      aria-label="各轮 token 用量；左右方向键逐段读数，Esc 关闭"
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
        className="turn-sparkline"
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        aria-hidden="true"
      >
        {values.map((val, idx) => {
          const barH = Math.max(3, Math.round((val / max) * (HEIGHT - 2)));
          const x = idx * (BAR_W + BAR_GAP);
          const y = HEIGHT - barH;
          const flagged = bucketHasFlag[idx];
          const active = scrub === idx;
          return (
            <rect
              key={idx}
              x={x}
              y={y}
              width={BAR_W}
              height={barH}
              rx={2}
              className={
                flagged
                  ? "turn-spark-bar is-flagged"
                  : active
                    ? "turn-spark-bar is-active"
                    : "turn-spark-bar"
              }
            />
          );
        })}
      </svg>
      {scrub != null && (
        <ChartTooltip
          position={tip.position}
          onMouseEnter={tip.cancelHide}
          onMouseLeave={() => scrubTo(null)}
        >
          <b>第 {scrub + 1} / {values.length} 段</b>
          <span>{formatCompactTokens(values[scrub] ?? 0)} tokens</span>
          <span className="sep">峰值刻度 {formatCompactTokens(max)}</span>
        </ChartTooltip>
      )}
    </div>
  );
}
