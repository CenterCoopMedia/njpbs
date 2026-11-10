import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { MAX_SAVED_MEDIA_VIEW_NAME_LENGTH } from "../../lib/saved-media-views";
import type { SavedMediaViewsController } from "../../lib/use-saved-media-views";
import { Checkbox } from "../ui/Checkbox";
import { Popover } from "../ui/Popover";
import { Button, Select, TextInput } from "../ui/Primitives";
import { SegmentedControl } from "../ui/SegmentedControl";
import "./MediaDisplayPopover.css";

interface DisplayOptionModel {
  value: string;
  label: string;
}

export interface MediaDisplaySegmentedRowModel {
  kind: "segmented";
  id: string;
  label: string;
  value: string;
  options: readonly (DisplayOptionModel & { icon?: "grid" | "columns" })[];
  onChange: (value: string) => void;
}

export interface MediaDisplaySelectRowModel {
  kind: "select";
  id: string;
  label: string;
  value: string;
  options: readonly (DisplayOptionModel & { appSetting?: boolean })[];
  onChange?: (value: string) => void;
  disabled?: boolean;
  note?: string;
  noteBelow?: boolean;
}

export interface MediaDisplayFieldOptionModel extends DisplayOptionModel {
  selected: boolean;
  disabled?: boolean;
  note?: string;
}

export interface MediaDisplayFieldsRowModel {
  kind: "fields";
  id: string;
  label: string;
  options: readonly MediaDisplayFieldOptionModel[];
  onChange: (value: string) => void;
  note?: string;
}

export type MediaDisplayRowModel = MediaDisplaySegmentedRowModel | MediaDisplaySelectRowModel | MediaDisplayFieldsRowModel;

export interface MediaDisplayConfiguration {
  rows: readonly MediaDisplayRowModel[];
  onReset?: () => void;
}

export interface MediaDisplayPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display, or the More trigger while Display is collapsed. */
  anchorRef: RefObject<HTMLElement | null>;
  configuration: MediaDisplayConfiguration;
  savedViews?: SavedMediaViewsController;
  savedViewDisplayAvailable?: boolean;
}

const APP_DENSITY_LABELS: Readonly<Record<string, string>> = {
  compact: "Compact",
  comfortable: "Comfortable",
  loose: "Loose",
};

/** The shell's density on the document element, followed as it changes. */
function useAppDensity(): string | undefined {
  const read = () => (typeof document === "undefined" ? undefined : document.documentElement.dataset.density);
  const [density, setDensity] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => setDensity(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    setDensity(read());
    return () => observer.disconnect();
  }, []);
  return density;
}

// The Display popover. Its bounded row models keep
// the surface order explicit. It stays open while each configured owner saves a change.
export function MediaDisplayPopover({
  anchorRef,
  configuration,
  onOpenChange,
  open,
  savedViewDisplayAvailable = false,
  savedViews,
}: MediaDisplayPopoverProps) {
  const id = useId();
  const rowsRef = useRef<HTMLDivElement>(null);
  const appDensity = useAppDensity();
  const appDensityLabel = appDensity ? APP_DENSITY_LABELS[appDensity] : undefined;
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState("");
  const [includeDisplay, setIncludeDisplay] = useState(false);
  const saveViewRef = useRef<HTMLButtonElement>(null);
  const restoreSaveFocusRef = useRef(false);
  useLayoutEffect(() => {
    if (!open || savingView || !restoreSaveFocusRef.current || !saveViewRef.current) return;
    restoreSaveFocusRef.current = false;
    saveViewRef.current.focus();
  }, [open, savingView]);
  // Focus starts on the checked option in the first segmented row.
  const initialFocusRef = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      return rowsRef.current?.querySelector<HTMLElement>("[role=radiogroup] input:checked") ?? null;
    },
  }), []);

  const renderRow = (row: MediaDisplayRowModel) => {
    const rowId = `${id}-${row.id}`;
    if (row.kind === "segmented") {
      return (
        <Fragment key={row.id}>
          <span aria-hidden="true" className="media-display-label">{row.label}</span>
          <div>
            <SegmentedControl
              label={row.label}
              onChange={row.onChange}
              options={row.options}
              value={row.value}
            />
          </div>
        </Fragment>
      );
    }
    if (row.kind === "select") {
      const select = (
        <Select
          aria-describedby={row.note ? `${rowId}-note` : undefined}
          disabled={row.disabled}
          id={rowId}
          onChange={row.onChange ? (event) => row.onChange?.(event.target.value) : undefined}
          value={row.value}
        >
          {row.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.appSetting && appDensityLabel ? `${option.label} (${appDensityLabel})` : option.label}
            </option>
          ))}
        </Select>
      );
      return (
        <Fragment key={row.id}>
          <label className="media-display-label" htmlFor={rowId}>{row.label}</label>
          {row.note ? (
            <div className={row.noteBelow ? "media-display-note-below" : "media-display-per-page"}>
              {select}
              <span className="media-display-note" id={`${rowId}-note`}>{row.note}</span>
            </div>
          ) : select}
        </Fragment>
      );
    }
    return (
      <Fragment key={row.id}>
        <span className="media-display-label media-display-fields-label" id={`${rowId}-label`}>{row.label}</span>
        <div
          aria-describedby={row.note ? `${rowId}-note` : undefined}
          aria-labelledby={`${rowId}-label`}
          className="media-display-field-grid"
          role="group"
        >
          {row.options.map((option) => (
            <span className={option.disabled ? "media-display-name" : undefined} key={option.value}>
              <Checkbox
                aria-describedby={option.note ? `${rowId}-${option.value}-note` : undefined}
                checked={option.selected}
                disabled={option.disabled}
                label={option.label}
                onChange={option.disabled ? undefined : () => row.onChange(option.value)}
                readOnly={option.disabled}
              />
              {option.note ? <span className="media-display-note" id={`${rowId}-${option.value}-note`}>{option.note}</span> : null}
            </span>
          ))}
        </div>
        {row.note ? <p className="media-display-note media-display-list-note" id={`${rowId}-note`}>{row.note}</p> : null}
      </Fragment>
    );
  };

  return (
    <Popover
      anchorRef={anchorRef}
      className="media-display-popover"
      initialFocusRef={initialFocusRef}
      label="Display"
      onOpenChange={onOpenChange}
      open={open}
      placement="bottom-end"
    >
      <div className="media-display-rows" ref={rowsRef}>
        {configuration.rows.map(renderRow)}
      </div>
      {savedViews ? (
        <section aria-labelledby={`${id}-saved-views`} className="media-display-saved">
          <div className="media-display-saved-heading">
            <div>
              <h3 id={`${id}-saved-views`}>Personal views</h3>
              <p>Save these filters for your account.</p>
            </div>
            {savingView ? null : (
              <Button
                disabled={savedViews.status !== "ready" || savedViews.busy}
                onClick={() => setSavingView(true)}
                ref={saveViewRef}
                variant="secondary"
              >
                Save as view
              </Button>
            )}
          </div>
          {savedViews.status === "loading" || savedViews.status === "idle" ? (
            <p className="media-display-saved-status" role="status">Loading saved views…</p>
          ) : null}
          {savingView ? (
            <form
              className="media-display-saved-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!await savedViews.save(viewName, includeDisplay)) return;
                restoreSaveFocusRef.current = true;
                setViewName("");
                setIncludeDisplay(false);
                setSavingView(false);
              }}
            >
              <label htmlFor={`${id}-saved-view-name`}>Name</label>
              <TextInput
                autoFocus
                id={`${id}-saved-view-name`}
                maxLength={MAX_SAVED_MEDIA_VIEW_NAME_LENGTH}
                onChange={(event) => setViewName(event.target.value)}
                required
                value={viewName}
              />
              {savedViewDisplayAvailable ? (
                <Checkbox
                  checked={includeDisplay}
                  label="Include display settings"
                  onChange={(event) => setIncludeDisplay(event.target.checked)}
                />
              ) : null}
              <div className="media-display-saved-actions">
                <Button
                  onClick={() => {
                    restoreSaveFocusRef.current = true;
                    setSavingView(false);
                    setViewName("");
                    setIncludeDisplay(false);
                  }}
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button disabled={savedViews.busy} type="submit" variant="primary">Save view</Button>
              </div>
            </form>
          ) : null}
          {savedViews.error ? (
            <div className="media-display-saved-error" role="alert">
              <span>{savedViews.error}</span>
              {savedViews.status === "error" ? (
                <Button onClick={() => void savedViews.load()} variant="ghost">Try again</Button>
              ) : null}
            </div>
          ) : null}
          <Button
            className="media-display-reset-filters"
            disabled={savedViews.busy}
            onClick={savedViews.resetFilters}
            variant="ghost"
          >
            Reset filters to default
          </Button>
        </section>
      ) : null}
      {configuration.onReset ? (
        <div className="media-display-footer">
          <Button onClick={configuration.onReset} variant="secondary">Reset to default</Button>
        </div>
      ) : null}
    </Popover>
  );
}
