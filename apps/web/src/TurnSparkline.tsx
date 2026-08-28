import type { Turn } from "./api";
import { downsampleValues, sparklinePoints } from "./sparkline";

type Props = {
  turns: Turn[];
};

const WIDTH = 220;
const HEIGHT = 36;
const MAX_POINTS = 80;

export function TurnSparkline({ turns }: Props) {
  const values = downsampleValues(
    [...turns]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((t) => t.cost.raw),
    MAX_POINTS,
  );
  const points = sparklinePoints(values, WIDTH, HEIGHT);
  if (!points) return null;

  return (
    <svg
      className="turn-sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="各轮 token 用量"
    >
      <polyline
        fill="none"
        stroke="#7dffb3"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  );
}
