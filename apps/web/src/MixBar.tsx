export type MixSegment = {
  key: string;
  value: number;
  className: string;
};

type Props = {
  segments: MixSegment[];
  label: string;
  className?: string;
  testId?: string;
};

export function MixBar({ segments, label, className, testId }: Props) {
  const total = segments.reduce((sum, seg) => sum + Math.max(0, seg.value), 0);
  const classes = className ? `mix-bar ${className}` : "mix-bar";

  return (
    <div
      className={classes}
      role="img"
      aria-label={label}
      data-testid={testId}
    >
      {total === 0 ? (
        <span className="mix-seg empty" style={{ width: "100%" }} />
      ) : (
        segments.map((seg) => {
          const pct = (100 * Math.max(0, seg.value)) / total;
          if (pct <= 0) return null;
          return (
            <span
              key={seg.key}
              className={`mix-seg ${seg.className}`}
              style={{ width: `${pct}%` }}
            />
          );
        })
      )}
    </div>
  );
}
