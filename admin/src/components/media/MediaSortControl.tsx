import { forwardRef, useId, useMemo, useRef, useState, type Ref, type RefObject } from "react";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { Button } from "../ui/Primitives";
import "./MediaSortControl.css";

type ImagesSortField = "updatedAt" | "createdAt" | "name" | "sizeBytes";
type SortDirection = "asc" | "desc";

export interface MediaSortChange {
  sort: ImagesSortField;
  direction: SortDirection;
  page: 1;
}

export interface MediaSortModelChange {
  value: string;
  direction: string;
}

export interface MediaSortDirectionModel {
  value: string;
  label: string;
}

export interface MediaSortOptionModel {
  value: string;
  label: string;
  directions: readonly [MediaSortDirectionModel, ...MediaSortDirectionModel[]];
}

export interface MediaSortControlModel {
  value: string;
  direction: string;
  options: readonly MediaSortOptionModel[];
  /** A locked sort stays visible and reachable, but cannot open or change. */
  locked?: { label: string; reason: string };
}

const IMAGE_SORT_OPTIONS: readonly MediaSortOptionModel[] = [
  { value: "updatedAt", label: "Last updated", directions: [{ value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }] },
  { value: "createdAt", label: "Created", directions: [{ value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }] },
  { value: "name", label: "Name", directions: [{ value: "asc", label: "A–Z" }, { value: "desc", label: "Z–A" }] },
  { value: "sizeBytes", label: "File size", directions: [{ value: "desc", label: "Largest first" }, { value: "asc", label: "Smallest first" }] },
];

interface MediaSortFieldsProps {
  model: MediaSortControlModel;
  onChange: (next: MediaSortModelChange) => void;
  /** Attached to the checked field radio, for a popover's initial focus. */
  checkedRef?: Ref<HTMLInputElement>;
}

// "Newest first" reads "newest first" mid-sentence; "A–Z" stays as it is.
const inSentence = (value: string) => (/^[A-Z][a-z]/.test(value) ? value.charAt(0).toLowerCase() + value.slice(1) : value);

/** The configured sort field and direction radio groups. */
export function MediaSortFields({ checkedRef, model, onChange }: MediaSortFieldsProps) {
  const name = useId();
  const selected = model.options.find((option) => option.value === model.value) ?? model.options[0];
  const directions = selected?.directions ?? [];
  return (
    <div className="media-sort-fields">
      <fieldset>
        <legend>Sort by</legend>
        {model.options.map((option) => (
          <label className="media-sort-option" key={option.value}>
            <input
              checked={option.value === model.value}
              name={`${name}-field`}
              onChange={() => onChange({
                value: option.value,
                direction: option.directions.some((direction) => direction.value === model.direction)
                  ? model.direction
                  : option.directions[0].value,
              })}
              ref={option.value === model.value ? checkedRef : undefined}
              type="radio"
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Direction</legend>
        {directions.map((direction) => (
          <label className="media-sort-option" key={direction.value}>
            <input
              checked={direction.value === model.direction}
              name={`${name}-direction`}
              onChange={() => onChange({ value: model.value, direction: direction.value })}
              type="radio"
            />
            <span>{direction.label}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

interface SharedSortControlProps {
  /** Controls the popover from outside, such as from a More menu item. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The popover's anchor and focus return while the trigger is not mounted. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** false leaves the trigger out, for when a More menu holds Sort. */
  showTrigger?: boolean;
}

interface ConfiguredSortControlProps extends SharedSortControlProps {
  model: MediaSortControlModel;
  onModelChange: (next: MediaSortModelChange) => void;
  sort?: never;
  direction?: never;
  onChange?: never;
}

interface ImagesSortControlProps extends SharedSortControlProps {
  model?: never;
  onModelChange?: never;
  sort: ImagesSortField;
  direction: SortDirection;
  /** Called with page 1 on every field or direction change; the popover stays open. */
  onChange: (next: MediaSortChange) => void;
}

export type MediaSortControlProps = ConfiguredSortControlProps | ImagesSortControlProps;

// The media sort control: a trigger that reads as a
// sentence and a Sort popover with two radio groups. The forwarded ref is the trigger.
export const MediaSortControl = forwardRef<HTMLButtonElement, MediaSortControlProps>(function MediaSortControl(props, ref) {
  const { anchorRef, onOpenChange, open: openProp, showTrigger = true } = props;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const checkedRef = useRef<HTMLInputElement>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const model: MediaSortControlModel = "model" in props && props.model
    ? props.model
    : { value: props.sort, direction: props.direction, options: IMAGE_SORT_OPTIONS };
  const setOpen = (next: boolean) => {
    if (model.locked) return;
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const change = (next: MediaSortModelChange) => {
    if ("model" in props && props.model) props.onModelChange(next);
    else props.onChange({ sort: next.value as ImagesSortField, direction: next.direction as SortDirection, page: 1 });
  };
  // The trigger when it is mounted, else the supplied anchor.
  const popoverAnchor = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      return triggerRef.current ?? anchorRef?.current ?? null;
    },
  }), [anchorRef]);

  const field = model.options.find((option) => option.value === model.value)?.label ?? model.value;
  const directions = model.options.find((option) => option.value === model.value)?.directions ?? [];
  const directionLabel = directions.find((option) => option.value === model.direction)?.label ?? model.direction;
  const triggerLabel = model.locked?.label ?? `${field}, ${inSentence(directionLabel)}`;

  return (
    <>
      {showTrigger ? (
        <Button
          aria-disabled={model.locked ? "true" : undefined}
          aria-expanded={model.locked ? undefined : open}
          aria-haspopup={model.locked ? undefined : "dialog"}
          aria-label={`Sort: ${triggerLabel}`}
          className="media-sort-control"
          onClick={() => setOpen(!open)}
          ref={(element) => {
            triggerRef.current = element;
            if (typeof ref === "function") ref(element);
            else if (ref) ref.current = element;
          }}
          title={model.locked?.reason}
          variant="secondary"
        >
          <Icon name="sort" />
          <span className="media-sort-control-prefix">Sort:</span>{" "}
          <strong className="media-sort-control-field">{model.locked?.label ?? field}</strong>
          {model.locked ? null : <Icon name={model.direction === "asc" ? "arrow-up" : "arrow-down"} />}
        </Button>
      ) : null}
      {model.locked ? null : (
        <Popover
          anchorRef={popoverAnchor}
          className="media-sort-popover"
          initialFocusRef={checkedRef}
          label="Sort"
          onOpenChange={setOpen}
          open={open}
        >
          <MediaSortFields checkedRef={checkedRef} model={model} onChange={change} />
        </Popover>
      )}
    </>
  );
});
