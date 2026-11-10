import { InfoTooltip } from "./ui/InfoTooltip";
import { TokenInput } from "./ui/TokenInput";
import { editorialTermKey } from "../../../packages/content-core/src/published-vocabulary";
import { mediaImageSources } from "../lib/media-image";
import { fieldInfo } from "../lib/field-help";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { RichTextEditor } from "./RichTextEditor";
import { EMPTY_RICH_TEXT_DOC } from "../lib/rich-text";
import { defaultValueForField, emptyItem } from "../lib/field-defaults";
import {
  recommendedFieldWarning,
  unfinishedDatetimeDraftMessage,
  unreadableDatetimeMessage,
} from "../lib/field-validation";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";
import type { RichTextDoc } from "../../../packages/content-core/src/content-model";
import {
  instantToStationLocal,
  stationLocalToInstant,
} from "../../../packages/content-core/src/station-time";
import { Button, Select, Textarea, TextInput } from "./ui/Primitives";
import { ActionControl } from "./ui/ActionControl";
import { Icon } from "./ui/Icon";
import {
  MediaPickerDialog,
  type MediaPickerLoader,
} from "./MediaPickerDialog";
import type {
  MediaAssetSummary,
  MediaCategoryDefinition,
} from "../lib/functions";
import type { MediaUploader } from "./MediaUploadForm";
import { useResolvedMediaAsset } from "./useResolvedMediaAsset";
import { StoryCreditsField } from "./StoryCreditsField";
import type { BylineAuthorOption } from "../lib/functions";

// "Buttons" -> "button", so an add control reads "Add button", not "Add Buttons".
function singularLabel(pluralLabel: string): string {
  return pluralLabel
    .replace(/ies$/i, "y")
    .replace(/s$/i, "")
    .toLowerCase();
}

function addLabel(pluralLabel: string): string {
  return `Add ${singularLabel(pluralLabel)}`;
}

function recordTargetLabels(target: EditorField["target"]): {
  collection: string;
  record: string;
} {
  const collection = (target ?? "record")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return {
    collection,
    record: collection === "staff" ? "staff member" : collection,
  };
}

// A monotonic source of React keys for list rows. These ids are ephemeral UI identity
// only: never part of the item data, never saved. They give each row a key that is stable
// across reorders and removals, so a row's editor (its TipTap instance, undo history, and
// open link popover) travels with its item instead of being reassigned to whichever item
// lands at its old index. Uniqueness across the whole app is enough; React only needs keys
// unique among siblings.
let listRowSeq = 0;
function nextRowKey(): string {
  listRowSeq += 1;
  return `row-${listRowSeq}`;
}

interface FieldRendererProps {
  termSuggestions?: { values: string[]; note: string; ready: boolean; onFocus?: () => void };
  field: EditorField;
  textPresentation?: "headline" | "summary" | "identifier";
  selectPresentation?: "crop";
  togglePresentation?: "inline";
  assetSummary?: { label: string; description: string; autoChoose?: boolean; disabled?: boolean; relatedFields?: ReactNode; header?: ReactNode };
  value: unknown;
  placeholder?: string;
  onChange: (value: unknown) => void;
  fieldId: string;
  // An editor-facing validation message shown under the control (e.g. a required field
  // left blank). Plain words, never a machine field name.
  error?: string;
  // Some validations apply to a relationship between fields. The host can mark this
  // control invalid and associate it with one shared recovery message without asking
  // FieldRenderer to repeat that message under every field in the relationship.
  invalid?: boolean;
  additionalDescriptionId?: string;
  // A nudge about an allowed value, such as empty alt text. It is announced with the
  // field but never marks the control invalid, because the value can still be saved.
  warning?: string | null;
  // A field may keep the shared label, help, and error treatment while supplying a
  // purpose-built control. The headline level setting uses this path because its model
  // field is numeric while the shared descriptor catalog has no numeric field kind.
  control?: ReactNode;
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
  assetPicker?: { open: boolean; onOpenChange: (open: boolean) => void };
  onAssetSelect?: (asset: MediaAssetSummary | null) => void;
  suggestion?: string;
  onUseSuggestion?: () => void;
  // Optional visible source state for a value that may be inherited rather than stored.
  // It is associated with the control through aria-describedby; when an override exists,
  // the host can also provide the explicit action that returns it to inheritance (#1399).
  valueStatus?: string;
  resetLabel?: string;
  onReset?: () => void;
  // The people a byline may credit (#1040), for the story-credits control. Passed
  // down rather than fetched here so one host load feeds every field that needs it.
  bylineAuthors?: readonly BylineAuthorOption[];
  bylineAuthorsUnavailable?: boolean;
  // A control that holds text the form cannot hold says so here (#850). Today only the
  // date-time control has such a state: it keeps a half-typed value on screen rather than
  // snapping back, so without this channel the form validates the stored instant, saves it,
  // and reports Saved while the editor is looking at different text. The message is the
  // field's own wording; null means the control and the record agree again. Hosts record it
  // and surface it when a save is attempted, so nothing shouts mid-keystroke.
  onDraftError?: (message: string | null) => void;
}

// Render one descriptor as the widget an editor sees: a human label, its help text, a
// required marker, and the control for its kind. Never shows the machine field name.
export function FieldRenderer({
  termSuggestions,
  field,
  textPresentation,
  selectPresentation,
  assetSummary, togglePresentation,
  value,
  placeholder,
  onChange,
  fieldId,
  error,
  invalid: externallyInvalid,
  additionalDescriptionId,
  warning,
  control,
  loadMedia,
  mediaPickerUnavailable,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  onMediaPickerDirtyChange,
  assetPicker,
  onAssetSelect,
  suggestion,
  onUseSuggestion,
  valueStatus,
  resetLabel,
  onReset,
  bylineAuthors,
  bylineAuthorsUnavailable,
  onDraftError,
}: FieldRendererProps) {
  // A stored value the date-time control cannot show is a state of the field itself, not a
  // verdict a save produced, so it is stated the moment the record is opened rather than
  // waiting for the editor to press Save on something they cannot see (#850). It takes the
  // error slot because there is only one thing to say about the field, and it is the same
  // sentence the save-time check composes, so the two can never disagree.
  const unreadableValue = unreadableDatetimeMessage(field, value);
  const shownError = unreadableValue ?? error;
  const info = [...new Set([field.help, fieldInfo(field)].filter(Boolean))].join(" ");
  const helpId = info ? `${fieldId}-help` : undefined;
  const valueStatusId = valueStatus ? `${fieldId}-value-status` : undefined;
  const errorId = shownError ? `${fieldId}-error` : undefined;
  const shownWarning = shownError ? null : warning;
  const warningId = shownWarning ? `${fieldId}-warning` : undefined;
  const describedBy =
    [helpId, valueStatusId, errorId, warningId, additionalDescriptionId]
      .filter(Boolean)
      .join(" ") || undefined;
  // A list or rich-text field is a group of controls, so it is labelled by a heading
  // rather than wrapping a single input in a <label>.
  const isGroup =
    field.kind === "list" ||
    field.kind === "richText" ||
    field.kind === "storyCredits" ||
    selectPresentation === "crop";
  const labelId = `${fieldId}-label`;

  const labelRow = (<div className="editor-field-label-row">
      {isGroup ? (
        <span className="editor-field-label" id={labelId}>
          {field.label}
          {field.required ? (
            <>
              <span className="editor-field-req" aria-hidden="true"> *</span>
              {/* The red asterisk is sighted-only. A group is labelled by this heading via
                  aria-labelledby, and `aria-required` is not a valid state on role="group",
                  so the required state has to live in the group's accessible name. This spoken
                  "(required)" folds into that name; the rich-text group also carries
                  aria-required on its own textbox. */}
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
        </span>
      ) : (
        <label className="editor-field-label" htmlFor={fieldId}>
          {field.label}
          {field.required ? <span className="editor-field-req" aria-hidden="true"> *</span> : null}
        </label>
      )}
      {info ? <InfoTooltip label={field.label} content={info} descriptionId={helpId} /> : null}
      </div>);
  return (
    // The field kind is surfaced to CSS so a dense bento layout can flow short controls (text,
    // URL, date, datetime, toggle) two-up while wide controls (rich text, lists, asset and
    // record pickers) still span the full column. It is a layout hint only; the control itself
    // is unchanged.
    <div className="editor-field" data-field-kind={field.kind} data-text-presentation={textPresentation} data-toggle-presentation={togglePresentation} data-asset-summary={Boolean(assetSummary) || undefined}>
      {!assetSummary ? labelRow : null}
      {control ?? (
        <FieldControl
          termSuggestions={termSuggestions}
          assetSummary={assetSummary ? { ...assetSummary, header: labelRow } : undefined}
          selectPresentation={selectPresentation}
          textPresentation={textPresentation}
          field={field}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          fieldId={fieldId}
          describedBy={describedBy}
          loadMedia={loadMedia}
          mediaPickerUnavailable={mediaPickerUnavailable}
          uploadMedia={uploadMedia}
          mediaCategories={mediaCategories}
          defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory}
          onMediaPickerDirtyChange={onMediaPickerDirtyChange}
          assetPicker={assetPicker}
          invalid={Boolean(shownError) || Boolean(externallyInvalid)}
          labelId={labelId}
          onDraftError={onDraftError}
          onAssetSelect={onAssetSelect}
          bylineAuthors={bylineAuthors}
          bylineAuthorsUnavailable={bylineAuthorsUnavailable}
        />
      )}
      {suggestion && onUseSuggestion ? (
        <div className="asset-field-suggestion">
          <span>Suggestion: {suggestion}</span>
          <Button variant="ghost" onClick={onUseSuggestion}>
            Use suggestion
          </Button>
        </div>
      ) : null}
      {valueStatus ? (
        <div className="editor-field-value-status">
          <span id={valueStatusId} role="status">
            {valueStatus}
          </span>
          {resetLabel && onReset ? (
            <Button
              variant="ghost"
              aria-label={`${resetLabel} for ${field.label}`}
              onClick={onReset}
            >
              {resetLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {shownError ? (
        <p className="error-text" id={errorId} role="alert">
          {shownError}
        </p>
      ) : null}
      {shownWarning ? (
        <p className="warning-text" id={warningId}>
          {shownWarning}
        </p>
      ) : null}
      {unreadableValue ? (
        // The way out. The control renders blank for this value, so its own change event can
        // never fire a change *to* empty, and before this the only escape from an unreadable
        // optional end time was to invent an end time and then delete it (#850). This writes
        // the cleared value the ordinary way, so the next save persists it.
        <div className="editor-field-recovery">
          <Button
            aria-label={`Clear this value from ${field.label}`}
            onClick={() => onChange("")}
          >
            Clear this value
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface FieldControlProps extends FieldRendererProps {
  describedBy: string | undefined;
  invalid: boolean;
  labelId: string;
}

function AssetField({
  field,
  assetSummary,
  value,
  onChange,
  fieldId,
  describedBy,
  invalid,
  loadMedia,
  mediaPickerUnavailable,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  onMediaPickerDirtyChange,
  onAssetSelect,
  assetPicker,
}: Pick<
  FieldControlProps,
  | "field"
  | "assetSummary"
  | "value"
  | "onChange"
  | "fieldId"
  | "describedBy"
  | "invalid"
  | "loadMedia"
  | "mediaPickerUnavailable"
  | "uploadMedia"
  | "mediaCategories"
  | "defaultUploadCategory"
  | "canUploadCategory"
  | "onMediaPickerDirtyChange"
  | "onAssetSelect"
  | "assetPicker"
>) {
  const assetId = typeof value === "string" ? value : "";
  const [localPickerOpen, setLocalPickerOpen] = useState(false);
  const pickerOpen = assetPicker?.open ?? localPickerOpen;
  const setPickerOpen = assetPicker?.onOpenChange ?? setLocalPickerOpen;
  const [selectedAsset, setSelectedAsset] = useState<MediaAssetSummary | null>(
    null,
  );
  const resolvedAsset = useResolvedMediaAsset(assetId, loadMedia);
  const displayedAsset =
    selectedAsset?.id === assetId ? selectedAsset : resolvedAsset;

  useEffect(() => {
    if (selectedAsset && selectedAsset.id !== assetId) setSelectedAsset(null);
  }, [assetId, selectedAsset]);

  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (invalid && detailsRef.current) detailsRef.current.open = true; }, [invalid]);
  function summaryWrap(body: ReactNode) {
    if (!assetSummary) return body;
    return <details ref={detailsRef} className="editor-image-role" data-image-role={field.key}>
      <summary onClick={() => {
        if (!assetSummary?.disabled && assetSummary?.autoChoose && !assetId && !detailsRef.current?.open && loadMedia && !mediaPickerUnavailable) setPickerOpen(true);
      }}><span className="editor-image-role-preview" aria-hidden="true">{displayedAsset ? <img {...mediaImageSources(displayedAsset, 120)} alt="" loading="lazy" decoding="async" /> : <Icon name="image" />}</span>
        <span><strong>{assetSummary.label}</strong><small>{assetId ? assetSummary.description : "No image selected"}</small></span><Icon name="pencil" /></summary>
      <fieldset className="editor-readonly-boundary editor-image-role-fields" disabled={assetSummary.disabled}>
        {assetSummary.header}{body}{assetSummary.relatedFields}
      </fieldset>
    </details>;
  }
  if (!loadMedia) {
    if (mediaPickerUnavailable) {
      return summaryWrap(
        <div className="asset-field">
          <div className="asset-field-preview" aria-hidden="true">
            <Icon name="image" />
            <span>{assetId ? "Saved image" : "No image"}</span>
          </div>
          <div className="asset-field-body">
            <TextInput
              id={fieldId}
              value={assetId ? "Saved image selected" : "No image selected"}
              readOnly
              aria-required={field.required}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
            />
            <p className="asset-field-note">
              Media access is required to change this image.
            </p>
          </div>
        </div>
      );
    }
    return summaryWrap(
      <div className="asset-field">
        <div className="asset-field-preview" aria-hidden="true">
          <Icon name="image" />
          <span>No preview</span>
        </div>
        <div className="asset-field-body">
          <TextInput
            id={fieldId}
            value={assetId}
            placeholder="Asset id"
            aria-required={field.required}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
          <p className="asset-field-note">
            The media library is not wired in this view.
          </p>
        </div>
      </div>
    );
  }

  const fieldName = field.label.toLocaleLowerCase("en-US");
  return summaryWrap(
    <>
      <div className="asset-field">
        <div className="asset-field-preview" aria-hidden="true">
          {displayedAsset ? (
            <img {...mediaImageSources(displayedAsset, 480)} alt="" loading="lazy" decoding="async" />
          ) : (
            <>
              <Icon name="image" />
              <span>{assetId ? "Saved image" : "No image"}</span>
            </>
          )}
        </div>
        <div className="asset-field-body">
          <TextInput
            id={fieldId}
            value={
              displayedAsset?.name ??
              (assetId ? "Saved image selected" : "No image selected")
            }
            readOnly
            aria-required={field.required}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
          />
          <div className="asset-field-actions">
            <Button
              aria-label={`${assetId ? "Change" : "Choose"} ${fieldName}`}
              onClick={() => setPickerOpen(true)}
            >
              {assetId ? "Change image" : "Choose image"}
            </Button>
            {assetId ? (
              <Button
                variant="ghost"
                aria-label={`Remove ${fieldName}`}
                onClick={() => {
                  setSelectedAsset(null);
                  if (onAssetSelect) onAssetSelect(null);
                  else onChange("");
                }}
              >
                Remove image
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {pickerOpen ? (
        <MediaPickerDialog
          destination={field.label}
          currentAssetId={assetId}
          loadMedia={loadMedia}
          uploadMedia={uploadMedia}
          categories={mediaCategories}
          defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory}
          onDirtyChange={onMediaPickerDirtyChange}
          onClose={() => setPickerOpen(false)}
          onSelect={(asset) => {
            setSelectedAsset(asset);
            setPickerOpen(false);
            if (onAssetSelect) onAssetSelect(asset);
            else onChange(asset.id);
          }}
        />
      ) : null}
    </>
  );
}

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})[T ]/i;

function isRealCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

// The record keeps a stored instant until the editor explicitly changes this control. Project
// only its validated literal date into the browser widget; rendering must never report a change
// or replace a non-midnight schedule during an unrelated full-record save.
function dateControlValue(value: unknown): string {
  if (typeof value !== "string") return "";
  if (CALENDAR_DATE_PATTERN.test(value)) {
    return isRealCalendarDate(value) ? value : "";
  }
  const prefix = value.match(ISO_DATE_PREFIX)?.[1];
  if (
    prefix === undefined ||
    !isRealCalendarDate(prefix) ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    return "";
  }
  return prefix;
}

interface DateTimeFieldProps {
  field: EditorField;
  value: unknown;
  onChange: (value: unknown) => void;
  fieldId: string;
  invalid: boolean;
  describedBy: string | undefined;
  onDraftError?: (message: string | null) => void;
}

// A stored instant, shown and edited in station time. The control speaks a bare
// wall-clock string, so the conversion happens on both sides of it and the form only
// ever holds the UTC instant the publish gate can read.
//
// The typed text is held here rather than derived from the stored value on every
// render, because a half-typed value is not a value the form can hold. Typing a year
// fills the segment a digit at a time, so the control reports 0002 and 0020 on the way
// to 2026, and none of those convert to an instant. Deriving the displayed text from
// the store would restore the last good value after each of those keystrokes and leave
// the year unreachable from the keyboard.
//
// `seededFrom` tracks the projection of the stored value and nothing else, so the draft
// re-seeds exactly when the store moves: an undo, a reload, or the record catching up to
// an edit made here. It must not be set from what the draft means instead. That looks
// like it saves a redundant re-seed, and it does for every value that round-trips, but
// it also suppresses the one that does not, leaving the skipped spring hour showing the
// time an editor typed while the record holds the hour it was moved to.
function DateTimeField({
  field,
  value,
  onChange,
  fieldId,
  invalid,
  describedBy,
  onDraftError,
}: DateTimeFieldProps) {
  const projected = instantToStationLocal(value);
  const [draft, setDraft] = useState(projected);
  const [seededFrom, setSeededFrom] = useState(projected);
  if (projected !== seededFrom) {
    setSeededFrom(projected);
    setDraft(projected);
  }

  // What the form cannot see for itself: the control is showing text that is not the value
  // the record holds. Reported from an effect rather than from the change handler so a
  // re-seed (an undo, a reload) withdraws the report with the draft it belonged to, and an
  // unmount does not leave a field the form still believes is blocking a save.
  //
  // The callback is held in a ref because hosts pass an inline closure: depending on it
  // would re-run this on every render of the form, and the message is what matters.
  const draftError = unfinishedDatetimeDraftMessage(field, draft);
  const reportDraftError = useRef(onDraftError);
  useEffect(() => {
    reportDraftError.current = onDraftError;
  });
  useEffect(() => {
    reportDraftError.current?.(draftError);
    return () => reportDraftError.current?.(null);
  }, [draftError]);

  return (
    <TextInput
      id={fieldId}
      type="datetime-local"
      value={draft}
      aria-required={field.required}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => {
        const local = event.target.value;
        setDraft(local);
        if (local === "") {
          onChange("");
          return;
        }
        const instant = stationLocalToInstant(local);
        if (instant === null) return;
        // Store and let the re-seed above show what was stored. For one hour a year
        // those differ: a time in the gap the clocks skip each spring is carried
        // forward, so 02:30 is stored as 03:30 and the control has to say so rather
        // than keep showing a time the record does not hold. Everything else
        // round-trips, so the re-seed is the same string back.
        onChange(instant);
      }}
    />
  );
}

function FieldControl({
  termSuggestions,
  field,
  textPresentation,
  selectPresentation,
  assetSummary,
  value,
  placeholder,
  onChange,
  fieldId,
  describedBy,
  invalid,
  labelId,
  loadMedia,
  mediaPickerUnavailable,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  onMediaPickerDirtyChange,
  onAssetSelect,
  assetPicker,
  bylineAuthors,
  bylineAuthorsUnavailable,
  onDraftError,
}: FieldControlProps) {
  if (textPresentation) return <Textarea autoGrow singleLine rows={1} id={fieldId} aria-label={field.label}
    value={String(value ?? "")} maxLength={field.maxLength}
    placeholder={placeholder ?? (textPresentation === "summary" ? "Add a summary…" : undefined)}
    aria-required={field.required} aria-invalid={invalid || undefined} aria-describedby={describedBy}
    onKeyDown={event => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
    }}
    onChange={event => onChange(event.target.value)} />;
  switch (field.kind) {
    // The ordered byline (#1040). Its own control, not a generic list: a
    // registered credit is a person chosen from the CMS author identities and
    // stored as their stable id, while a custom credit is display text only.
    case "storyCredits":
      return (
        <StoryCreditsField
          field={field}
          value={value}
          onChange={onChange}
          fieldId={fieldId}
          labelId={labelId}
          invalid={invalid}
          describedBy={describedBy}
          authors={bylineAuthors}
          authorsUnavailable={bylineAuthorsUnavailable}
        />
      );

    case "datetime":
      return (
        <DateTimeField
          field={field}
          value={value}
          onChange={onChange}
          fieldId={fieldId}
          invalid={invalid}
          describedBy={describedBy}
          onDraftError={onDraftError}
        />
      );

    case "toggle":
      return (
        <input
          id={fieldId}
          className="editor-toggle"
          type="checkbox"
          checked={Boolean(value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.checked)}
        />
      );

    case "number":
      return (
        <TextInput
          id={fieldId}
          type="number"
          inputMode="numeric"
          min={field.min}
          max={field.max}
          step={1}
          value={typeof value === "number" ? value : ""}
          aria-required={field.required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(
            event.target.value === "" ? undefined : Number(event.target.value),
          )}
        />
      );

    case "richText":
      return (
        <RichTextEditor
          id={fieldId}
          value={(value as RichTextDoc) ?? EMPTY_RICH_TEXT_DOC}
          onChange={(doc) => onChange(doc)}
          ariaLabel={field.label}
          ariaRequired={field.required}
          ariaInvalid={invalid}
          ariaDescribedBy={describedBy}
        />
      );

    case "list":
      return (
        <ListField
          termSuggestions={termSuggestions}
          field={field}
          value={value}
          onChange={onChange}
          fieldId={fieldId}
          labelId={labelId}
          invalid={invalid}
          describedBy={describedBy}
          loadMedia={loadMedia}
          mediaPickerUnavailable={mediaPickerUnavailable}
        />
      );

    case "select":
      if (selectPresentation === "crop") return <div id={fieldId} role="group" tabIndex={-1} aria-labelledby={labelId} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="editor-crop-choices">
        {!(field.options ?? []).some(option => String(option.value) === String(value ?? "")) ? <p role="status">Stored crop: {String(value ?? "Not set")}. Choose a supported crop to change it.</p> : null}
        {(field.options ?? []).map(option => <Button key={String(option.value)} size="compact" variant="secondary" aria-pressed={option.value === value} onClick={() => onChange(option.value)}><span className="editor-crop-diagram" data-position={String(option.value)} aria-hidden="true" />{option.label}</Button>)}
      </div>;
      return (
        <Select
          id={fieldId}
          value={String(value ?? "")}
          aria-required={field.required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            const selected = field.options?.find(
              (option) => String(option.value) === event.target.value,
            );
            onChange(selected?.value ?? event.target.value);
          }}
        >
          {/*
            A select whose stored value is not one of its choices renders an explicit
            unchosen entry first. Without it the browser shows the first real option while
            the record holds nothing, so a required select looks answered and then refuses
            the save ("Section is required") next to a control that plainly reads "Watch"
            (#845). Every seeded select already holds one of its own options, so this entry
            appears only where a choice genuinely has not been made yet.
          */}
          {(field.options ?? []).some(
            (option) => String(option.value) === String(value ?? ""),
          ) ? null : (
            <option value="">Choose {field.label.toLowerCase()}</option>
          )}
          {(field.options ?? []).map((option) => (
            <option key={`${typeof option.value}:${option.value}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      );

    // Use the shared station-image picker when the host supplies its authenticated loader.
    // Isolated design views can still expose the raw id as an explicit integration fallback;
    // production roles without media access get the read-only state above instead.
    case "asset":
      return (
        <AssetField
          assetPicker={assetPicker}
          assetSummary={assetSummary}
          field={field}
          value={value}
          onChange={onChange}
          fieldId={fieldId}
          describedBy={describedBy}
          invalid={invalid}
          loadMedia={loadMedia}
          mediaPickerUnavailable={mediaPickerUnavailable}
          uploadMedia={uploadMedia}
          mediaCategories={mediaCategories}
          defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory}
          onMediaPickerDirtyChange={onMediaPickerDirtyChange}
          onAssetSelect={onAssetSelect}
        />
      );

    // The immutable record id is the current link control.
    case "recordList": {
      const labels = recordTargetLabels(field.target);
      const recordId = String(value ?? "");
      const hasRecord = recordId.trim().length > 0;
      return (
        <div className="record-picker-field">
          <div className="record-picker-summary" data-has-value={hasRecord}>
            <span className="record-picker-icon" aria-hidden="true">
              <Icon name={field.target === "staff" ? "users" : "file"} />
            </span>
            <span className="record-picker-copy">
              <strong>
                {hasRecord ? `Selected ${labels.record}` : `No ${labels.record} selected`}
              </strong>
              {hasRecord ? (
                <code>{recordId.trim()}</code>
              ) : (
                <span>Enter an immutable {labels.record} id to link this field.</span>
              )}
            </span>
          </div>
          <div className="record-picker-body">
            <TextInput
              id={fieldId}
              value={recordId}
              placeholder={`${labels.collection} id`}
              aria-required={field.required}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
        </div>
      );
    }

    // Text, URL, and date are all a single text-like input. URL deliberately uses a text
    // input with a URL keyboard hint: the renderer accepts relative links such as `/watch/`,
    // while browsers' native `type="url"` validity rejects them even when the form opts out of
    // native validation. Keep one validation policy and expose its result through aria-invalid.
    default: {
      if (field.kind === "text" && field.multiline) return (
        <Textarea
          id={fieldId}
          rows={4}
          value={String(value ?? "")}
          placeholder={placeholder}
          maxLength={field.maxLength}
          aria-required={field.required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      );
      const type = field.kind === "date" ? "date" : "text";
      return (
        <TextInput
          id={fieldId}
          type={type}
          inputMode={field.kind === "url" ? "url" : undefined}
          value={field.kind === "date" ? dateControlValue(value) : String(value ?? "")}
          placeholder={placeholder}
          maxLength={field.maxLength}
          aria-required={field.required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    }
  }
}

interface ListFieldProps {
  termSuggestions?: FieldRendererProps["termSuggestions"];
  field: EditorField;
  value: unknown;
  onChange: (value: unknown) => void;
  fieldId: string;
  labelId: string;
  invalid: boolean;
  describedBy: string | undefined;
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
}

function ListField(props: ListFieldProps) {
  return props.field.itemFields ? (
    <StructuredListField {...props} />
  ) : (
    <TagListField {...props} />
  );
}

// A scalar list is a short ordered token set, not a stack of record forms. Keep its stored
// string array unchanged while giving editors one compact entry control and movable pills.
function TagListField({
  termSuggestions,
  field,
  value,
  onChange,
  fieldId,
  labelId,
  invalid,
  describedBy,
}: ListFieldProps) {
  const items = (Array.isArray(value) ? value : []).map((item) => String(item ?? ""));
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndex = useRef<number | null>(null);
  const itemName = singularLabel(field.label);

  useEffect(() => {
    const index = pendingFocusIndex.current;
    if (index === null) return;
    pendingFocusIndex.current = null;
    if (index >= 0) {
      removeRefs.current[index]?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [items.length]);

  function addTag(focusInput = true) {
    const next = canonicalTerm(draft);
    if (next === "") {
      setNotice(`Enter a ${itemName} first.`);
      if (focusInput) inputRef.current?.focus();
      return;
    }
    if (items.some((item) => item.trim().toLowerCase() === next.toLowerCase())) {
      setNotice(`${next} is already added.`);
      if (focusInput) inputRef.current?.focus();
      return;
    }
    onChange([...items, next]);
    setDraft("");
    setNotice(`${next} added.`);
    if (focusInput) inputRef.current?.focus();
  }

  function canonicalTerm(raw: string) {
    return termSuggestions?.values.find(value => editorialTermKey(value) === editorialTermKey(raw)) ?? raw.trim();
  }

  function appendTerms(values: string[]) {
    const seen = new Set(items.map(editorialTermKey));
    const added: string[] = [];
    for (const raw of values) {
      const value = canonicalTerm(raw);
      const key = editorialTermKey(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      added.push(value);
    }
    if (added.length) {
      onChange([...items, ...added]);
      setNotice(added.length === 1 ? `${added[0]} added.` : `${added.length} ${field.label.toLowerCase()} added.`);
    } else setNotice(`No new ${field.label.toLowerCase()} added.`);
  }

  function removeAt(index: number) {
    const next = items.filter((_, itemIndex) => itemIndex !== index);
    pendingFocusIndex.current = next.length === 0 ? -1 : Math.min(index, next.length - 1);
    onChange(next);
    setNotice(`${items[index]} removed.`);
  }

  function moveAt(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = items.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    setNotice(`${items[index]} moved ${delta < 0 ? "up" : "down"}.`);
  }

  return (
    <div
      className="editor-list editor-tag-list"
      onFocus={termSuggestions?.onFocus}
      role="group"
      aria-labelledby={labelId}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      // Out of the tab sequence, but able to take the focus a validation summary link or
      // the save's first-invalid focus sends here; a plain div silently drops that focus.
      tabIndex={invalid ? -1 : undefined}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        if (draft.trim() !== "") addTag(false);
      }}
    >
      {items.length === 0 ? (
        <p className="editor-field-help muted">No {field.label.toLowerCase()} yet.</p>
      ) : (
        <div className="editor-tag-pills" role="list" aria-label={`Added ${field.label.toLowerCase()}`}>
          {items.map((item, index) => (
            <span className="editor-tag-pill" role="listitem" key={`${item}-${index}`}>
              <span className="editor-tag-label">{item}</span>
              <span className="editor-tag-controls">
                <ActionControl
                  action="move-up"
                  className="editor-tag-move"
                  contextLabel={`${itemName} ${item}`}
                  disabled={index === 0}
                  onClick={() => moveAt(index, -1)}
                />
                <ActionControl
                  action="move-down"
                  className="editor-tag-move"
                  contextLabel={`${itemName} ${item}`}
                  disabled={index === items.length - 1}
                  onClick={() => moveAt(index, 1)}
                />
                <ActionControl
                  action="remove-item"
                  label="Remove"
                  variant="ghost"
                  ref={(node) => {
                    removeRefs.current[index] = node;
                  }}
                  className="editor-tag-remove"
                  accessibleName={`Remove ${itemName} ${item}`}
                  onClick={() => removeAt(index)}
                />
              </span>
            </span>
          ))}
        </div>
      )}
      <div className="editor-tag-entry">
        {termSuggestions ? <TokenInput
          label={`New ${itemName}`}
          announceSuggestions={termSuggestions.ready}
          onSubmitEntry={() => addTag()}
          onPasteEntries={appendTerms}
          inputId={`${fieldId}-new-${itemName}`}
          inputRef={inputRef}
          ariaDescribedBy={describedBy}
          ariaInvalid={invalid}
          draft={draft}
          onDraftChange={value => {
            setDraft(value);
            if (value) setNotice("");
          }}
          tokens={[]}
          maxLength={Number.MAX_SAFE_INTEGER}
          onChange={tokens => appendTerms(tokens.map(token => token.value))}
          suggestions={termSuggestions.values.filter(value => !items.some(item => editorialTermKey(item) === editorialTermKey(value)))}
          suggestionsNote={termSuggestions.note}
          placeholder={`Add ${itemName}…`}
        /> : (
        <input
          ref={inputRef}
          id={`${fieldId}-new-${itemName}`}
          className="field-control editor-tag-input"
          value={draft}
          aria-label={`New ${itemName}`}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            if (notice) setNotice("");
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            const start = event.currentTarget.selectionStart ?? draft.length;
            const end = event.currentTarget.selectionEnd ?? draft.length;
            const composed = `${draft.slice(0, start)}${pasted}${draft.slice(end)}`;
            if (!/[,\n]/.test(composed)) return;

            event.preventDefault();
            const existing = new Set(
              items.map((item) => item.trim().toLocaleLowerCase("en-US")),
            );
            const added: string[] = [];
            for (const candidate of composed.split(/[,\n]+/)) {
              const next = candidate.trim();
              const key = next.toLocaleLowerCase("en-US");
              if (next === "" || existing.has(key)) continue;
              existing.add(key);
              added.push(next);
            }

            setDraft("");
            if (added.length === 0) {
              setNotice(`No new ${field.label.toLowerCase()} added.`);
              return;
            }
            onChange([...items, ...added]);
            setNotice(
              added.length === 1
                ? `${added[0]} added.`
                : `${added.length} ${field.label.toLowerCase()} added.`,
            );
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            addTag();
          }}
        />
        )}
        <ActionControl action="add-item" label={addLabel(field.label)} onClick={() => addTag()} />
      </div>
      {termSuggestions ? <p className="editor-field-help muted" role={termSuggestions.ready ? undefined : "status"}>{termSuggestions.note}</p> : null}
      {notice ? (
        <p className="editor-field-help editor-tag-notice" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

// A structured list gives each object its own sub-form plus stable reorder controls. Its
// generous surface remains separate from the compact scalar-tag treatment above.
function StructuredListField({
  field,
  value,
  onChange,
  fieldId,
  labelId,
  invalid,
  describedBy,
  loadMedia,
  mediaPickerUnavailable,
}: ListFieldProps) {
  const items: unknown[] = Array.isArray(value) ? value : [];
  const itemFields = field.itemFields ?? [];
  const removeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const addRef = useRef<HTMLButtonElement>(null);
  const pendingFocusIndex = useRef<number | null>(null);
  useEffect(() => {
    if (pendingFocusIndex.current === null) return;
    const index = pendingFocusIndex.current;
    pendingFocusIndex.current = null;
    (index < 0 ? addRef.current : removeRefs.current[index])?.focus();
  }, [items.length]);
  const atLimit =
    typeof field.maxItems === "number" && items.length >= field.maxItems;

  // Stable per-row keys, held in lockstep with `items`. Every structural change below
  // updates both arrays together; a content edit (replaceAt) keeps the row's key, so its
  // editor is not remounted mid-typing.
  const [rowKeys, setRowKeys] = useState<string[]>(() => items.map(nextRowKey));
  if (rowKeys.length !== items.length) {
    // The items array changed length without going through the handlers below (a parent
    // reset). Pad or truncate the keys to match so every row still has one, keeping the
    // surviving rows' keys. This is React's "adjust state during render" pattern: the
    // functional update re-checks and returns the same array once it matches, so it
    // converges in one extra render before commit.
    setRowKeys((keys) => {
      if (keys.length === items.length) return keys;
      const next = keys.slice(0, items.length);
      while (next.length < items.length) next.push(nextRowKey());
      return next;
    });
  }

  function replaceAt(index: number, next: unknown) {
    onChange(items.map((item, i) => (i === index ? next : item)));
  }

  function add() {
    onChange([...items, emptyItem(itemFields)]);
    setRowKeys((keys) => [...keys, nextRowKey()]);
  }

  function removeAt(index: number) {
    pendingFocusIndex.current = items.length === 1 ? -1 : Math.min(index, items.length - 2);
    onChange(items.filter((_, i) => i !== index));
    setRowKeys((keys) => keys.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = items.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    setRowKeys((keys) => {
      const nextKeys = keys.slice();
      [nextKeys[index], nextKeys[target]] = [nextKeys[target], nextKeys[index]];
      return nextKeys;
    });
  }

  return (
    <div
      className="editor-list"
      role="group"
      aria-labelledby={labelId}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      // Out of the tab sequence, but able to take the focus a validation summary link or
      // the save's first-invalid focus sends here; a plain div silently drops that focus.
      tabIndex={invalid ? -1 : undefined}
    >
      {items.length === 0 ? (
        <p className="editor-field-help muted">Nothing added yet.</p>
      ) : null}
      {items.map((item, index) => (
        <div className="editor-list-item" key={rowKeys[index]}>
          <div className="editor-list-item-body">
            {itemFields.map((sub) => (
              <FieldRenderer
                key={sub.key}
                field={sub}
                value={(item as Record<string, unknown>)?.[sub.key]}
                onChange={(subValue) =>
                  replaceAt(index, { ...(item as Record<string, unknown>), [sub.key]: subValue })
                }
                fieldId={`${fieldId}-${index}-${sub.key}`}
                warning={recommendedFieldWarning(
                  sub,
                  (item as Record<string, unknown>)?.[sub.key],
                  { siblings: (item ?? {}) as Record<string, unknown> },
                )}
                loadMedia={loadMedia}
                mediaPickerUnavailable={mediaPickerUnavailable}
              />
            ))}
          </div>
          <div className="editor-list-item-controls">
            <ActionControl
              action="move-up"
              contextLabel={`${field.label} ${index + 1}`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            />
            <ActionControl
              action="move-down"
              contextLabel={`${field.label} ${index + 1}`}
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            />
            <ActionControl
              action="remove-item"
              label="Remove"
              variant="ghost"
              accessibleName={`Remove ${field.label} ${index + 1}`}
              ref={(node) => { removeRefs.current[index] = node; }}
              onClick={() => removeAt(index)}
            />
          </div>
        </div>
      ))}
      {atLimit ? (
        // The control says what the limit is where the Add button was, so reaching it
        // reads as a rule rather than as a control that stopped working.
        <p className="editor-field-help muted">
          {`${field.label} holds at most ${field.maxItems}. Remove one to add another.`}
        </p>
      ) : (
        <ActionControl action="add-item" label={addLabel(field.label)} ref={addRef} onClick={add} />
      )}
    </div>
  );
}
