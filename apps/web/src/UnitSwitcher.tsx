import { useUnit } from "./UnitContext";
import type { CostUnit } from "./format";
import { SegmentedControl } from "./ui";

const UNITS: { id: CostUnit; label: string }[] = [
  { id: "tokens", label: "Tokens" },
  { id: "credits", label: "Credits" },
  { id: "usd", label: "USD" },
];

export function UnitSwitcher() {
  const { unit, setUnit } = useUnit();

  return (
    <SegmentedControl
      className="metric-switch"
      label="显示单位"
      value={unit}
      options={UNITS}
      onChange={setUnit}
    />
  );
}
