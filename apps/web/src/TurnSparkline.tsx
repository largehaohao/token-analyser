import type { Turn } from "./api";

type Props = {
  turns: Turn[];
};

export function TurnSparkline({ turns }: Props) {
  const values = [...turns]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((t) => t.cost.raw);
  if (values.length < 2) return null;

  const max = Math.max(...values, 1);
  const width = 220;
  const height = 36;
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const points = values
    .map((value, i) => {
      const x = pad + (i / (values.length - 1)) * innerW;
      const y = height - pad - (value / max) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      className="turn-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Token use over turns"
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
