import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Turn } from "./api";
import { ChartTooltip, useChartTooltip } from "./ChartTooltip";
import { formatCompactTokens } from "./format";
import { downsampleValues, sparklinePoints } from "./sparkline";

type Props = {
  turns: Turn[];
};

const WIDTH = 220;
const HEIGHT = 48;
const MAX_POINTS = 80;
const PAD = 3;

export function TurnSparkline({ turns }: Props) {
  const ordered = [...turns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const values = downsampleValues(
    ordered.map((turn) => turn.cost.raw),
    MAX_POINTS,
  );
  const points = sparklinePoints(values, WIDTH, HEIGHT, PAD);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tip = useChartTooltip();
  const [scrub, setScrub] = useState<number | null>(null);
  if (!points) return null;
  const max = Math.max(...values, 1);
  const baseline = HEIGHT - PAD;
  const area = `${PAD},${baseline} ${points} ${WIDTH - PAD},${baseline}`;

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

  const point = scrub == null ? null : points.split(" ")[scrub]?.split(",");

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
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        aria-hidden="true"
      >
        <polygon className="turn-spark-area" points={area} />
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          pathLength={1}
          points={points}
        />
        {point && (
          <g className="hero-spark-scrub">
            <line x1={point[0]} y1={PAD} x2={point[0]} y2={baseline} />
            <circle cx={point[0]} cy={point[1]} r={2.5} />
          </g>
        )}
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
