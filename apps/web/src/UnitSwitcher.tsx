import { useUnit } from "./UnitContext";
import type { CostUnit } from "./format";

const UNITS: { id: CostUnit; label: string }[] = [
  { id: "tokens", label: "tokens" },
  { id: "credits", label: "credits" },
  { id: "usd", label: "usd" },
];

export function UnitSwitcher() {
  const { unit, setUnit } = useUnit();

  return (
    <div className="unit-switcher">
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
