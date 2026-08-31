import { SESSION_RANGES, type SessionRangeId } from "./session-range";
import { SegmentedControl } from "./ui";

type Props = {
  range: SessionRangeId;
  onChange: (range: SessionRangeId) => void;
};

export function RangeSwitcher({ range, onChange }: Props) {
  return (
    <SegmentedControl
      className="range-switch"
      label="时间范围"
      value={range}
      options={SESSION_RANGES}
      onChange={onChange}
    />
  );
}
