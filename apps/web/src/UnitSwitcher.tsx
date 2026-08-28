import { useUnit } from "./UnitContext";
import type { CostUnit } from "./format";

const UNITS: { id: CostUnit; label: string }[] = [
  { id: "tokens", label: "Tokens" },
  { id: "credits", label: "Credits" },
  { id: "usd", label: "USD" },
];

export function UnitSwitcher() {
  const { unit, setUnit } = useUnit();

  return (
    <div className="metric-switch" role="group" aria-label="显示单位">
      {UNITS.map((u) => (
        <button
          key={u.id}
          type="button"
          className={unit === u.id ? "active" : ""}
          onClick={() => setUnit(u.id)}
        >
          {u.label}
        </button>
      ))}
    </div>
  );
}
