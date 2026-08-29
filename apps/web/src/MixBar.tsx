import { allocatePercents, formatExactTokens } from "./format";

export type MixSegment = {
  key: string;
  label?: string;
  value: number;
  className: string;
  color?: string;
};

type Props = {
  segments: MixSegment[];
  label: string;
  className?: string;
  testId?: string;
};

export function MixBar({ segments, label, className, testId }: Props) {
  const values = segments.map((seg) => Math.max(0, seg.value));
  const total = values.reduce((sum, value) => sum + value, 0);
  const percents = allocatePercents(values);
  const classes = className ? `mix-bar ${className}` : "mix-bar";
  const detail = segments
    .map((seg, i) => {
      const name = seg.label ?? seg.key;
      return `${name} ${formatExactTokens(seg.value)} (${percents[i].toFixed(1)}%)`;
    })
    .join(" · ");

  return (
    <div
      className={classes}
      role="img"
      aria-label={`${label}. ${detail}`}
      title={total === 0 ? label : `${label} · ${detail}`}
      data-testid={testId}
    >
      {total === 0 ? (
        <span className="mix-seg empty" style={{ width: "100%" }} />
      ) : (
        segments.map((seg, i) => {
          const pct = percents[i];
          if (pct <= 0) return null;
          return (
            <span
              key={seg.key}
              className={`mix-seg ${seg.className}`}
              style={{
                width: `${pct}%`,
                ...(seg.color ? { background: seg.color } : {}),
              }}
            />
          );
        })
      )}
    </div>
  );
}
