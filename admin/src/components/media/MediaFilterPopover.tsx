import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Checkbox } from "../ui/Checkbox";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { Button, TextInput } from "../ui/Primitives";
import type { SavedMediaViewsController } from "../../lib/use-saved-media-views";
import "./MediaFilterPopover.css";

export type MediaFilterProperty = string;

/** Where the popover opens: a picker, with one value focused when a chip opened it. */
export interface MediaFilterStart {
  property: MediaFilterProperty;
  value?: string;
}

export interface MediaFilterOptionModel {
  value: string;
  label: string;
  description?: string;
  selected?: boolean;
  count?: number;
  disabled?: boolean;
}

export interface MediaFilterPropertyModel {
  id: MediaFilterProperty;
  label: string;
  appliedCount?: number;
  /** Actions are tag-like choices that do not stay selected in this picker. */
  picker: "options" | "actions" | "text";
  options: readonly MediaFilterOptionModel[];
  hint?: string;
  emptyLabel?: string;
  text?: { value: string; onChange: (value: string) => void; placeholder: string; maxLength: number; error?: string };
}

export interface MediaFilterPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Filter, or the chip body that opened the popover. Escape returns focus here. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Without it the popover opens on the property list. */
  start?: MediaFilterStart | null;
  /** Visible guidance that applies to every property in this filter. */
  note?: string;
  properties: readonly MediaFilterPropertyModel[];
  onSelect: (property: MediaFilterProperty, value: string) => void;
  savedViews?: SavedMediaViewsController;
}

const FIRST_OPTION = ".media-filter-option input, .media-filter-tag, .media-filter-text-input";

const itemCount = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "item" : "items"}`;

// The Filter popover. The first level lists the
// configured properties; choosing one swaps the body to that property's bounded picker.
// Focus follows each swap.
export function MediaFilterPopover({
  anchorRef,
  note,
  onOpenChange,
  onSelect,
  open,
  properties,
  savedViews,
  start = null,
}: MediaFilterPopoverProps) {
  const id = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState<MediaFilterProperty | null>(start?.property ?? null);
  const [seen, setSeen] = useState({ open, start });
  // What takes focus after the next swap: the first option, or the row the person came from.
  const swapFocusRef = useRef<MediaFilterProperty | "first" | null>(null);

  // Each opening, and each chip that reopens it, starts at its own level.
  if (open !== seen.open || start !== seen.start) {
    setSeen({ open, start });
    if (open) setLevel(start?.property ?? null);
  }

  // On open: the chip's value, else the picker's first option, else the first property row.
  const initialFocusRef = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      const body = bodyRef.current;
      if (!body || !start) return null;
      const choices = Array.from(body.querySelectorAll<HTMLElement>("[data-value]"));
      return choices.find((choice) => choice.dataset.value === start.value)
        ?? body.querySelector<HTMLElement>(FIRST_OPTION);
    },
  }), [start]);

  useLayoutEffect(() => {
    const target = swapFocusRef.current;
    swapFocusRef.current = null;
    const body = bodyRef.current;
    if (!target || !body) return;
    const element = target === "first"
      ? body.querySelector<HTMLElement>(FIRST_OPTION) ?? body.querySelector<HTMLElement>(".media-filter-back")
      : Array.from(body.querySelectorAll<HTMLElement>("[data-property]"))
        .find((candidate) => candidate.dataset.property === target);
    element?.focus();
  }, [level]);

  const swap = (next: MediaFilterProperty | null) => {
    swapFocusRef.current = next ? "first" : level;
    setLevel(next);
  };

  function option(property: MediaFilterProperty, entry: MediaFilterOptionModel) {
    const countId = `${id}-${property}-${entry.value}-count`;
    const descriptionId = `${id}-${property}-${entry.value}-description`;
    return (
      <div className="media-filter-option" key={entry.value}>
        <Checkbox
          aria-describedby={[
            ...(entry.count === undefined ? [] : [countId]),
            ...(entry.description ? [descriptionId] : []),
          ].join(" ") || undefined}
          checked={entry.selected ?? false}
          data-value={entry.value}
          disabled={entry.disabled}
          label={entry.label}
          onChange={() => onSelect(property, entry.value)}
        />
        {entry.count === undefined ? null : <span className="media-filter-count" id={countId}>{itemCount(entry.count)}</span>}
        {entry.description ? <p className="media-filter-description" id={descriptionId}>{entry.description}</p> : null}
      </div>
    );
  }

  function picker(property: MediaFilterPropertyModel) {
    if (property.picker === "text" && property.text) {
      return <>
        {property.hint ? <p className="media-filter-hint">{property.hint}</p> : null}
        <form className="media-filter-text" onSubmit={event => { event.preventDefault(); onSelect(property.id, property.text!.value.trim()); }}>
          <TextInput aria-invalid={property.text.error ? true : undefined} aria-label={property.label}
            className="media-filter-text-input" maxLength={property.text.maxLength}
            onChange={event => property.text?.onChange(event.target.value)} placeholder={property.text.placeholder}
            value={property.text.value} />
          <Button type="submit">Apply {property.label.toLowerCase()}</Button>
        </form>
        {property.text.error ? <p className="media-filter-text-error" role="alert">{property.text.error}</p> : null}
        {property.options.length ? <div className="media-filter-tags">{property.options.map(entry =>
          <button className="media-filter-tag" data-value={entry.value} key={entry.value}
            onClick={() => onSelect(property.id, entry.value)} type="button">{entry.label}</button>)}</div> : null}
      </>;
    }
    if (property.options.length === 0) {
      return <p className="media-filter-empty">{property.emptyLabel ?? "No choices available"}</p>;
    }
    if (property.picker === "actions") {
      return (
        <>
          {property.hint ? <p className="media-filter-hint">{property.hint}</p> : null}
          <div className="media-filter-tags">
            {property.options.map((entry) => (
              <button
                className="media-filter-tag"
                data-value={entry.value}
                disabled={entry.disabled}
                key={entry.value}
                onClick={() => onSelect(property.id, entry.value)}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </>
      );
    }
    return (
      <>
        {property.hint ? <p className="media-filter-hint">{property.hint}</p> : null}
        {property.options.map((entry) => option(property.id, entry))}
      </>
    );
  }

  const current = properties.find((entry) => entry.id === level);

  const personalViews = savedViews ? (
    <section aria-labelledby={`${id}-saved-views`} className="media-saved-views">
      <div className="media-saved-views-heading">
        <h3 id={`${id}-saved-views`}>Personal views</h3>
        <span>Only you can see these.</span>
      </div>
      {savedViews.status === "loading" || savedViews.status === "idle" ? (
        <p className="media-saved-views-status" role="status">Loading saved views…</p>
      ) : savedViews.status === "error" ? (
        <div className="media-saved-views-error" role="alert">
          <span>{savedViews.error}</span>
          <Button disabled={savedViews.busy} onClick={() => void savedViews.load()} variant="ghost">Try again</Button>
        </div>
      ) : savedViews.views.length === 0 ? (
        <p className="media-saved-views-status">No personal views saved for this page.</p>
      ) : (
        <ul className="media-saved-views-list">
          {savedViews.views.map((view) => (
            <li className="media-saved-view" key={view.id}>
              <button
                aria-current={savedViews.currentViewId === view.id ? "true" : undefined}
                className="media-saved-view-apply"
                disabled={savedViews.busy}
                onClick={() => {
                  onOpenChange(false);
                  savedViews.apply(view);
                  anchorRef.current?.focus();
                }}
                type="button"
              >
                {view.name}
              </button>
              <Button
                aria-label={`Delete saved view ${view.name}`}
                className="media-saved-view-delete"
                disabled={savedViews.busy}
                onClick={(event) => {
                  const row = event.currentTarget.closest("li");
                  const next = row?.nextElementSibling?.querySelector<HTMLElement>(".media-saved-view-apply")
                    ?? row?.previousElementSibling?.querySelector<HTMLElement>(".media-saved-view-apply")
                    ?? bodyRef.current?.querySelector<HTMLElement>(".media-filter-property");
                  next?.focus();
                  void savedViews.remove(view.id);
                }}
                title={`Delete ${view.name}`}
                variant="ghost"
              >
                <Icon name="trash" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {savedViews.status !== "error" && savedViews.error ? (
        <p className="media-saved-views-error" role="alert">{savedViews.error}</p>
      ) : null}
    </section>
  ) : null;

  return (
    <Popover
      anchorRef={anchorRef}
      className="media-filter-popover"
      initialFocusRef={initialFocusRef}
      label="Filter"
      onOpenChange={onOpenChange}
      open={open}
    >
      <div className="media-filter-body" ref={bodyRef}>
        {note ? <p className="media-filter-note">{note}</p> : null}
        {current ? (
          <>
            <Button className="media-filter-back" onClick={() => swap(null)} variant="ghost">
              <Icon name="arrow-left" />
              <span className="button-compact-label">All filters</span>
            </Button>
            <fieldset className="media-filter-picker">
              <legend>{current.label}</legend>
              {picker(current)}
            </fieldset>
          </>
        ) : (
          <>
            {personalViews}
            <div className="media-filter-properties">
              {properties.map((property) => (
                <button
                  aria-describedby={property.appliedCount ? `${id}-${property.id}-applied` : undefined}
                  aria-label={property.label}
                  className="media-filter-property"
                  data-property={property.id}
                  key={property.id}
                  onClick={() => swap(property.id)}
                  type="button"
                >
                  <span className="media-filter-property-label">{property.label}</span>
                  {property.appliedCount ? (
                    <span className="media-filter-property-count" id={`${id}-${property.id}-applied`}>
                      {property.appliedCount} applied
                    </span>
                  ) : null}
                  <Icon className="media-filter-property-arrow" name="arrow-right" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Popover>
  );
}
