import { HardwarePowerPage } from "./HardwarePowerPage";
import { SystemTemperaturePage } from "./SystemTemperaturePage";
import { Icon, SegmentedControl } from "./ui";
import { LegacyBadge as Badge } from "@/components/ui/legacy-badge";

type Tab = "temps" | "power";

export function HardwarePage(props: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  now: number;
}) {
  return (
    <div className="hardware-page" data-testid="hardware-page">
      <div className="hardware-toolbar">
        <div className="hardware-context">
          <p className="hardware-breadcrumb">
            <span className="hardware-crumb-mark" aria-hidden="true">
              <Icon name="gauge" />
            </span>
            <span className="hardware-crumb-brand">硬件监控</span>
            <span className="hardware-crumb-sep" aria-hidden="true">
              /
            </span>
            <Badge variant="outline" className="hardware-crumb-section">
              {props.tab === "temps" ? "温度" : "用电"}
            </Badge>
          </p>
          <p className="hardware-context-copy">
            {props.tab === "temps"
              ? "实时传感器读数与历史趋势 · 缺失读数保持为 —"
              : "功率曲线、区间用电与电费估算"}
          </p>
        </div>
        <nav className="hardware-tabs" aria-label="硬件子页">
          <SegmentedControl
            label="硬件子页"
            value={props.tab}
            onChange={(id) => props.onTabChange(id as Tab)}
            options={[
              { id: "temps", label: "温度" },
              { id: "power", label: "用电" },
            ]}
          />
        </nav>
      </div>
      {props.tab === "temps" ? (
        <SystemTemperaturePage now={props.now} />
      ) : (
        <HardwarePowerPage now={props.now} />
      )}
    </div>
  );
}
