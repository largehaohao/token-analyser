import { lazy, Suspense } from "react";
import { StatePanel } from "./ui";

const HardwarePowerPage = lazy(() => import("./HardwarePowerPage").then((module) => ({ default: module.HardwarePowerPage })));
const SystemTemperaturePage = lazy(() => import("./SystemTemperaturePage").then((module) => ({ default: module.SystemTemperaturePage })));

export type HardwareTab = "temps" | "power";

export type HardwareTopMeta = {
  devicePill?: string;
  windowPill?: string;
  hostPill?: string;
  statusText?: string;
};

export function HardwarePage(props: {
  tab: HardwareTab;
  onTabChange: (tab: HardwareTab) => void;
  now: number;
  refreshKey: number;
  onTopMeta?: (meta: HardwareTopMeta) => void;
}) {
  return (
    <div className="hardware-page" data-testid="hardware-page">
      <Suspense fallback={<StatePanel kind="loading" title="正在加载硬件监控" />}>
        {props.tab === "temps" ? (
          <SystemTemperaturePage
            now={props.now}
            refreshKey={props.refreshKey}
            onTopMeta={props.onTopMeta}
          />
        ) : (
          <HardwarePowerPage
            now={props.now}
            refreshKey={props.refreshKey}
            onTopMeta={props.onTopMeta}
          />
        )}
      </Suspense>
    </div>
  );
}
