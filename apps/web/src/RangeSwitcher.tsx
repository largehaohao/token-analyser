import {
  SESSION_RANGES,
  type SessionRangeId,
} from "./session-range";

type Props = {
  range: SessionRangeId;
  onChange: (range: SessionRangeId) => void;
};

export function RangeSwitcher({ range, onChange }: Props) {
  return (
    <div className="range-switch" role="group" aria-label="时间范围">
      {SESSION_RANGES.map((item) => (
        <button
          key={item.id}
          type="button"
          className={range === item.id ? "active" : ""}
          aria-pressed={range === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
