import {
  SESSION_ENVIRONMENTS,
  type SessionEnvironmentId,
} from "./session-environment";
import { Icon } from "./ui";

type Props = {
  environment: SessionEnvironmentId;
  onChange: (environment: SessionEnvironmentId) => void;
  id?: string;
  compact?: boolean;
};

export function EnvironmentSwitcher({
  environment,
  onChange,
  id = "desktop-env-select",
  compact = false,
}: Props) {
  return (
    <div className={compact ? undefined : "dock-field"}>
      <label className={compact ? "sr-only" : "dock-label"} htmlFor={id}>
        {compact ? "切换监控节点" : "监控节点"}
      </label>
      <div className={compact ? "env-select-wrap is-compact" : "env-select-wrap"}>
        {!compact && (
          <span className="env-select-leading" aria-hidden="true">
            <Icon name="server" />
          </span>
        )}
        <select
          id={id}
          className="env-select"
          aria-label="分析环境"
          style={compact ? { width: "auto", paddingBlock: "5px" } : undefined}
          value={environment}
          onChange={(event) =>
            onChange(event.target.value as SessionEnvironmentId)
          }
        >
          {SESSION_ENVIRONMENTS.map((item) => (
            <option key={item.id} value={item.id}>
              {compact ? item.label : item.id === "local" ? `本机 · ${item.label}` : `远程 · ${item.label}`}
            </option>
          ))}
        </select>
        <span className="env-select-caret" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </div>
    </div>
  );
}
