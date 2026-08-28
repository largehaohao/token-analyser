import { useUnit } from "./UnitContext";
import type { CostUnit } from "./format";

const UNITS: { id: CostUnit; label: string }[] = [
  { id: "tokens", label: "Tokens" },
  { id: "credits", label: "Credits" },
  { id: "usd", label: "费用" },
];

export function UnitSwitcher() {
  const { unit, setUnit } = useUnit();

  return (
    <div className="metric-switch">
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
