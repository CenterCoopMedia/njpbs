import { useControlPresentation } from "../context/ControlPresentationContext";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { isRowData } from "../../../packages/content-core/src/content-layout";
import type { BlockType } from "../../../packages/content-core/src/content-model";
import { BLOCK_LABELS } from "../../../packages/content-core/src/editor-admin";
import type { AdminBlock } from "../lib/block-factory";
import { BLOCK_DESCRIPTIONS } from "../lib/block-descriptions";
import { contentPlacementReason, type ContentDestination } from "../lib/content-row-editing";
import { ICON_CONTROL_REGISTRY } from "../lib/icon-control-registry";
import { ActionControl } from "./ui/ActionControl";
import { Icon, type IconName } from "./ui/Icon";
import { Button, TextInput } from "./ui/Primitives";
import "./content-insert-control.css";
import "./content-picker.css";

const PickerTrigger = memo(ActionControl);

export const BLOCK_TYPE_ICONS: Readonly<Record<BlockType, IconName>> = {
  bio_card: "users",
  headline: "bold",
  prose: "file",
  image: "image",
  video: "video",
  image_gallery: "media",
  cta_row: "link",
  card_grid: "grid",
  link_card: "external-link",
  document_list: "download",
  faq_item: "info",
  coverage_list: "list-ordered",
  data_table: "table-column",
  data_hub_section: "chart",
  data_figure: "chart",
  town_lookup: "search",
  election_results: "chart",
  county_comparison: "chart",
  embed: "play",
  html: "code",
  content_shelf: "list",
  promotion_playlist: "queue",
  newsletter_signup: "check-square",
  home_newscast: "microphone",
  topic_shelf: "tag",
  video_playlist: "panel-right",
  record_card: "folder",
  sponsor_strip: "heart",
  row: "columns",
  divider: "remove",
};

interface Props {
  toolbar?: boolean;
  blocks: AdminBlock[];
  palette: readonly BlockType[];
  destination: ContentDestination;
  onInsert: (type: BlockType, destination: ContentDestination) => string | null;
  position?: number;
  label?: string;
  /** Destination text shared by the visible and accessible trigger labels. */
  triggerLabel?: string;
  allowRows?: boolean;
  readOnly?: boolean;
}

function sameColumn(left: AdminBlock["layout"], right: ContentDestination["layout"]): boolean {
  return left?.rowId === right?.rowId && left?.column === right?.column;
}

function changedDestination(blocks: AdminBlock[], destination: ContentDestination): boolean {
  const layout = destination.layout;
  if (layout) {
    const row = blocks.find(block => block.id === layout.rowId && block.type === "row");
    if (!row || !isRowData(row.data) || !Number.isInteger(layout.column) || layout.column < 0 || layout.column >= row.data.columns.length) return true;
  }
  if (!destination.beforeId) return false;
  const before = blocks.find(block => block.id === destination.beforeId);
  return !before || !sameColumn(before.layout, destination.layout);
}

function matches(type: BlockType, search: string): boolean {
  const query = search.trim().toLowerCase();
  return `${BLOCK_LABELS[type]} ${BLOCK_DESCRIPTIONS[type]}`.toLowerCase().includes(query);
}

function BlockTypeGraphic({ type }: { type: BlockType }) {
  if (type === "headline") return <span className="content-picker-type-glyph">{ICON_CONTROL_REGISTRY.heading.glyph}</span>;
  return <Icon name={BLOCK_TYPE_ICONS[type] ?? "content"} />;
}

export function AddContent({ toolbar = false, blocks, palette, destination: requestedDestination, onInsert, position, label, triggerLabel, allowRows = false, readOnly = false }: Props) {
  const presentation = useControlPresentation();
  const [open, setOpen] = useState(false);
  const currentDestination = useRef(requestedDestination);
  currentDestination.current = requestedDestination;
  const [heldDestination, setHeldDestination] = useState(requestedDestination);
  const destination = open ? heldDestination : requestedDestination;
  const [search, setSearch] = useState("");
  const [selectedType, setSelectedType] = useState<BlockType | null>(null);
  const [insertError, setInsertError] = useState<string | null>(null);
  const committing = useRef(false);
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const row = blocks.find(block => block.id === destination.layout?.rowId);
  const rowNumber = row ? blocks.filter(block => block.type === "row").indexOf(row) + 1 : null;
  const target = rowNumber ? `Row ${rowNumber} › Column ${destination.layout!.column + 1}` : "Page level";
  const before = blocks.find(block => block.id === destination.beforeId);
  const location = `${target} · ${before ? `Before ${BLOCK_LABELS[before.type]}` : "At end"}`;
  const destinationChanged = changedDestination(blocks, destination);
  const types = palette.filter(type => type !== "row" && matches(type, search));
  const rowMatches = allowRows && !destination.layout && matches("row", search);
  const selectedReason = selectedType ? contentPlacementReason(blocks, selectedType, destination) : null;
  const selectedAllowed = selectedType === "row"
    ? rowMatches
    : selectedType !== null && types.includes(selectedType);
  const canInsert = selectedAllowed && !readOnly && !destinationChanged && !selectedReason;

  useEffect(() => {
    if (selectedType && selectedType !== "row" && !palette.includes(selectedType)) {
      setSelectedType(null);
    }
  }, [palette, selectedType]);

  const openPicker = useCallback(() => {
    committing.current = false;
    setHeldDestination(structuredClone(currentDestination.current));
    setSearch("");
    setSelectedType(null);
    setInsertError(null);
    setOpen(true);
    dialog.current?.showModal?.();
  }, []);

  function close(restoreFocus = true) {
    dialog.current?.close?.();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  function changeSearch(value: string) {
    setSearch(value);
    if (selectedType && !matches(selectedType, value)) setSelectedType(null);
  }

  function insert(type: BlockType) {
    const allowed = type === "row"
      ? allowRows && !destination.layout && matches("row", search)
      : palette.includes(type) && matches(type, search);
    if (committing.current || readOnly || !allowed || changedDestination(blocks, destination) || contentPlacementReason(blocks, type, destination)) return;
    committing.current = true;
    const insertedId = onInsert(type, destination);
    if (!insertedId) {
      setInsertError("This content could not be inserted. Close the picker and choose the position again.");
      return;
    }
    close(false);
  }

  const insertionLabel = triggerLabel ?? label ?? (destination.layout
    ? `Add plank to column ${destination.layout.column + 1}`
    : "Add content");
  const insertionGraphic = useMemo(() => <><Icon name="plus" /><span className="content-insert-label" aria-hidden="true">{insertionLabel}</span></>, [insertionLabel]);

  return <div className={toolbar ? "content-toolbar-add" : "content-row-add"} data-placement={destination.layout ? "column" : "page"}>
    {toolbar ? <Button ref={trigger} variant="ghost" disabled={readOnly} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      data-control-presentation={presentation} aria-label={insertionLabel} onClick={openPicker}><Icon name="plus" /><span className="editor-toolbar-add-label">{insertionLabel}</span></Button> : <PickerTrigger action="add-block" label={insertionLabel} contextLabel={position === undefined ? undefined : `position ${position}`} ref={trigger} disabled={readOnly} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      className="content-insert-control" graphic={insertionGraphic}
      onClick={openPicker} />}
    <dialog ref={dialog} open={open} id={id} className="content-picker-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }}>
      {open ? <>
        <div className="content-picker-head">
          <h2 id={`${id}-title`}>Add content</h2>
          <ActionControl action="close" label="Close content picker" onClick={() => close()} />
        </div>
        <div className="content-picker-body">
          <p className="content-picker-location">{location}</p>
          {destinationChanged ? <p className="error-text" role="alert">This destination has changed. Close the picker and choose an existing position.</p> : null}
          <label className="content-picker-search">Find content
            <span className="content-picker-search-control"><Icon name="search" /><TextInput autoFocus value={search} onChange={event => changeSearch(event.target.value)} placeholder="Search content types" /></span>
          </label>
          <div className="content-picker-results-head">
            <h3>Choose a block</h3>
            <span aria-live="polite" role="status">
              {types.length} {types.length === 1 ? "type matches" : "types match"}
              {rowMatches ? <span className="sr-only">; 1 row command matches.</span> : null}
            </span>
          </div>
          {rowMatches ? <Button className="content-picker-add-row" disabled={readOnly || destinationChanged || Boolean(insertError)} onClick={() => insert("row")}><Icon name="plus" /><span className="button-compact-label">Add row</span></Button> : null}
          <div role="radiogroup" aria-label={position === undefined ? "Content types" : `Content types at position ${position}`} className="content-row-palette">
            {types.map(type => {
              const reason = contentPlacementReason(blocks, type, destination);
              const unavailable = Boolean(reason) || destinationChanged || readOnly;
              return <label key={type} className="content-row-palette-option" data-unavailable={unavailable || undefined}>
                <input type="radio" name={`${id}-type`} value={type} checked={selectedType === type} disabled={unavailable} aria-label={BLOCK_LABELS[type]} aria-describedby={`${id}-${type}`} onChange={() => setSelectedType(type)} />
                <span className="content-picker-type-icon" aria-hidden="true"><BlockTypeGraphic type={type} /></span>
                <span className="content-picker-type-copy"><strong>{BLOCK_LABELS[type]}</strong><span id={`${id}-${type}`}>{reason ? <><strong>Not in multi-column rows</strong><br />{reason}</> : BLOCK_DESCRIPTIONS[type]}</span></span>
              </label>;
            })}
            {!types.length && !rowMatches ? <p>No content types match your search.</p> : null}
          </div>
          {insertError ? <p className="error-text" role="alert">{insertError}</p> : null}
        </div>
        <div className="content-picker-footer"><Button onClick={() => close()}>Cancel</Button><Button variant="primary" disabled={!canInsert || Boolean(insertError)} onClick={() => selectedType && insert(selectedType)}>Insert block</Button></div>
      </> : null}
    </dialog>
  </div>;
}
