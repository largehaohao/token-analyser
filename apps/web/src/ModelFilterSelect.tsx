import { ALL_MODELS, modelOptions } from "./model-filter";
import type { OverviewModel } from "./api";

type Props = {
  models: OverviewModel[] | undefined;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  id: string;
};

/**
 * Per-panel model scope. Independent selects can show different models at once.
 */
export function ModelFilterSelect({
  models,
  value,
  onChange,
  disabled,
  id,
}: Props) {
  const options = modelOptions(models);
  return (
    <label className="model-filter" htmlFor={id}>
      <span className="model-filter-label">模型选择</span>
      <select
        id={id}
        data-testid={id}
        value={value}
        disabled={disabled || options.length === 0}
        aria-label="模型选择"
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={ALL_MODELS}>全部模型</option>
        {options.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </label>
  );
}
