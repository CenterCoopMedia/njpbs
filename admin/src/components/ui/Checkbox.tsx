import type { InputHTMLAttributes, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import type { ControlSize } from "../../context/ControlSizingContext";
import "./Checkbox.css";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children" | "size"> {
  /** Deliberate dense-row adoption; existing checkboxes keep their 44px target. */
  size?: ControlSize;
  label: string;
  /** Keeps the label as the accessible name but draws only the box, as on a tile. */
  hideLabel?: boolean;
  /** Partial selection, such as "some items on this page". */
  indeterminate?: boolean;
  /**
   * With hideLabel, visible words that differ from the name, such as a short "This page" for
   * "Select this page". They are hidden from assistive technology; the label stays the name.
   */
  visibleLabel?: ReactNode;
}

// A native checkbox with a drawn 24px box inside a 44px hit area. The input stays in the
// document so keyboard, forms and assistive technology behave as they do for any checkbox.
export function Checkbox({
  className,
  hideLabel = false,
  indeterminate = false,
  label,
  onClick,
  visibleLabel,
  size = "legacy",
  ...props
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // The browser clears the mixed state on every click, even when the parent keeps it, so
  // the prop is reapplied after each render and after each click.
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  });

  return (
    <label className={["ui-checkbox", className].filter(Boolean).join(" ")} data-control-size={size}>
      <input
        className="ui-checkbox-input"
        onClick={(event) => {
          onClick?.(event);
          event.currentTarget.indeterminate = indeterminate;
        }}
        ref={inputRef}
        type="checkbox"
        {...props}
      />
      <span aria-hidden="true" className="ui-checkbox-box">
        <Icon className="ui-checkbox-check" name="check" />
        <Icon className="ui-checkbox-mixed" name="remove" />
      </span>
      <span className={hideLabel ? "sr-only" : "ui-checkbox-label"}>{label}</span>
      {hideLabel && visibleLabel ? <span aria-hidden="true" className="ui-checkbox-label">{visibleLabel}</span> : null}
    </label>
  );
}
