import type { Ref } from "react";
import { Icon } from "./Icon";
import "./Chip.css";

export interface ChipProps {
  /** The filter property, such as "Category". Omit it when the value is clear alone. */
  property?: string;
  value: string;
  /** Overrides the body's accessible name, such as "Filter by tag interview". */
  label?: string;
  /** "filter" chips sit in the applied-filter row; "tag" chips sit on cards and rows. */
  variant?: "filter" | "tag";
  /** Opens the chip's picker, or applies the tag as a filter. Without it the chip is text. */
  onSelect?: () => void;
  onRemove?: () => void;
  /** Marks a toggle chip, such as a tag filter, as currently applied. */
  pressed?: boolean;
  /** The body button, for anchoring a picker to the chip and returning focus to it. */
  bodyRef?: Ref<HTMLButtonElement>;
  /** Marks a body that opens a picker, such as the applied-filter chips' "dialog". */
  popup?: "dialog";
  /** -1 takes the chip's buttons out of the tab order, as a roving grid does. */
  tabIndex?: number;
}

// One chip for applied filters and tags. The body and the remove control are separate
// buttons so removing never also reopens the picker, and each has its own name.
export function Chip({ bodyRef, label, onRemove, onSelect, popup, pressed, property, tabIndex, value, variant = "filter" }: ChipProps) {
  const name = property ? `${property}: ${value}` : value;
  const content = (
    <>
      {property ? <span className="ui-chip-property">{property}: </span> : null}
      <span className="ui-chip-value">{value}</span>
    </>
  );

  return (
    <span className={`ui-chip ui-chip-${variant}${pressed ? " ui-chip-pressed" : ""}`}>
      {onSelect ? (
        <button
          aria-haspopup={popup}
          aria-label={label ?? name}
          aria-pressed={pressed}
          className="ui-chip-body"
          onClick={onSelect}
          ref={bodyRef}
          tabIndex={tabIndex}
          type="button"
        >
          {content}
        </button>
      ) : (
        <span className="ui-chip-body">{content}</span>
      )}
      {onRemove ? (
        <button
          aria-label={`Remove filter ${name}`}
          className="ui-chip-remove"
          onClick={onRemove}
          tabIndex={tabIndex}
          type="button"
        >
          <Icon name="close" />
        </button>
      ) : null}
    </span>
  );
}
