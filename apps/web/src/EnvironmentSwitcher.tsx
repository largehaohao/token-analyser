import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  SESSION_ENVIRONMENTS,
  type SessionEnvironmentId,
} from "./session-environment";

type Props = {
  environment: SessionEnvironmentId;
  onChange: (environment: SessionEnvironmentId) => void;
};

export function EnvironmentSwitcher({ environment, onChange }: Props) {
  return (
    <section className="source-toolbar" aria-label="分析环境">
      <label className="filter-field source-filter-field">
        <span className="filter-label">环境</span>
        <NativeSelect
          className="source-select"
          aria-label="分析环境"
          value={environment}
          onChange={(event) =>
            onChange(event.target.value as SessionEnvironmentId)
          }
        >
          {SESSION_ENVIRONMENTS.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>
              {item.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="source-count-caption">从这台机器读取会话</span>
      </label>
    </section>
  );
}
