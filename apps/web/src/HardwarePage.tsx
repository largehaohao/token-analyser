import { HardwarePowerPage } from "./HardwarePowerPage";
import { SystemTemperaturePage } from "./SystemTemperaturePage";
import { SegmentedControl } from "./ui";

type Tab = "temps" | "power";

export function HardwarePage(props: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  now: number;
}) {
  return (
    <div className="hardware-page" data-testid="hardware-page">
      <div className="hardware-tabs">
        <SegmentedControl
          label="硬件子页"
          value={props.tab}
          onChange={(id) => props.onTabChange(id as Tab)}
          options={[
            { id: "temps", label: "温度" },
            { id: "power", label: "用电" },
          ]}
        />
      </div>
      {props.tab === "temps" ? (
        <SystemTemperaturePage now={props.now} />
      ) : (
        <HardwarePowerPage now={props.now} />
      )}
    </div>
  );
}
