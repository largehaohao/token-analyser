import { createContext, useContext, type ReactNode } from "react";
import type { CostUnit } from "./format";

const UnitContext = createContext<{
  unit: CostUnit;
  setUnit: (u: CostUnit) => void;
} | null>(null);

export function UnitProvider({
  unit,
  setUnit,
  children,
}: {
  unit: CostUnit;
  setUnit: (u: CostUnit) => void;
  children: ReactNode;
}) {
  return (
    <UnitContext.Provider value={{ unit, setUnit }}>
      {children}
    </UnitContext.Provider>
  );
}

export function useUnit(): { unit: CostUnit; setUnit: (u: CostUnit) => void } {
  const ctx = useContext(UnitContext);
  if (!ctx) throw new Error("useUnit must be used within UnitProvider");
  return ctx;
}
