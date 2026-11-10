import { useId } from "react";
import { Icon, type IconName } from "./Icon";
import { useControlSize } from "../../context/ControlSizingContext";
import "./SegmentedControl.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
}

// A radio group drawn as one bar. Native radios sharing a name give arrow-key movement,
// one tab stop and form semantics without custom key handling.
export function SegmentedControl<T extends string>({
  disabled = false,
  label,
  onChange,
  options,
  value,
}: SegmentedControlProps<T>) {
  const name = useId();
  const size = useControlSize() ?? "legacy";

  return (
    <div aria-label={label} className="ui-segmented" role="radiogroup" data-control-size={size}>
      {options.map((option) => (
        <label className="ui-segmented-option" key={option.value}>
          <input
            checked={option.value === value}
            className="ui-segmented-input"
            disabled={disabled}
            name={name}
            onChange={() => onChange(option.value)}
            type="radio"
            value={option.value}
          />
          <span className="ui-segmented-face">
            {option.icon ? <Icon name={option.icon} /> : null}
            <span>{option.label}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
