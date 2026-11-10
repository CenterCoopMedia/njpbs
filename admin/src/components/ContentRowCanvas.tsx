import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { Menu } from "./ui/Menu";
import { createPortal } from "react-dom";
import { LIVE_BLOG_SIDEBAR } from "../../../packages/content-core/src/live-blog-layout";
import { groupContentRows } from "../../../packages/content-core/src/content-layout";
import { BLOCK_LABELS } from "../../../packages/content-core/src/editor-admin";
import { isHomeLockedAuthoringSection, isHomeSectionAction } from "../../../packages/content-core/src/home-composition";
import type { BlockType } from "../../../packages/content-core/src/content-model";
import type { AdminBlock } from "../lib/block-factory";
import { contentColumnDomId, outlineTypeLabel } from "../lib/content-outline";
import { contentPlacementReason, contentSiblings, type ContentDestination } from "../lib/content-row-editing";
import { Button } from "./ui/Primitives";
import { useReorder } from "../hooks/useReorder";
import { ReorderHandle } from "./ReorderHandle";
import { Icon } from "./ui/Icon";
import { ActionControl } from "./ui/ActionControl";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { AddContent } from "./ContentPicker";
import { MoveContentDialog } from "./MoveContentDialog";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { ComponentPhonePreview } from "./ComponentPhonePreview";
import { BlockPreview } from "./BlockPreview";
import { CustomHtmlEditing } from "./InlineBlockSurface";
import type { MediaPickerLoader } from "./MediaPickerDialog";
export { AddContent } from "./ContentPicker";
import "./content-row-canvas.css";

const SPLITS = [
  { label: "One column", widths: [12] },
  { label: "Two equal columns", widths: [6, 6] },
  { label: "Wide left", widths: [8, 4] },
  { label: "Wide right", widths: [4, 8] },
  { label: "Three equal columns", widths: [4, 4, 4] },
  { label: "Four equal columns", widths: [3, 3, 3, 3] },
];

export interface ContentSectionFrame { label: string; content: ReactNode }

interface ContentRowCanvasProps {
  homeV2?: boolean;
  blocks: AdminBlock[];
  palette: readonly BlockType[];
  readOnly?: boolean;
  loadMedia?: MediaPickerLoader;
  showPageSeedAssets?: boolean;
  allowRows?: boolean;
  hideInsertionControls?: boolean;
  frame?: ReactNode;
  frameBlockIds?: ReadonlySet<string>;
  sectionFrames?: ReadonlyMap<string, ContentSectionFrame>;
  selectedBlockId?: string | null;
  selectedColumn?: number | null;
  editRequest?: { id: string; column?: number; sequence: number };
  onSelect?: (id: string, column?: number) => void;
  rowNotice?: { id: string; content: ReactNode };
  renderBlock: (block: AdminBlock, index: number, placementControls?: ReactNode) => ReactNode;
  /** Stable through a save receipt's temporary-to-canonical ID change. */
  renderKey: (id: string) => string;
  onInsert: (type: BlockType, destination: ContentDestination) => string | null;
  onMove: (id: string, destination: ContentDestination) => void;
  onSplit: (id: string, widths: number[]) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string, column?: number) => void;
  onToggleVisible: (id: string) => void;
}

type PlacementState = Pick<ContentRowCanvasProps, "blocks" | "onMove" | "renderKey"> & {
  pageLevelIds: string[];
  handleProps: ReturnType<typeof useReorder>["handleProps"];
};
const PlacementContext = createContext<PlacementState | null>(null);

// Live placement data updates this small consumer without invalidating the
// memoized card. The dialog always receives the current destination list.
function HeaderPlacementControls({ id }: { id: string }) {
  const state = useContext(PlacementContext)!;
  const block = state.blocks.find(candidate => candidate.id === id);
  if (!block) return null;
  return <>
    <ReorderHandle {...state.handleProps(state.renderKey(id))} />
    <MoveContentDialog block={block} blocks={state.blocks} pageLevelIds={state.pageLevelIds} onMove={state.onMove} />
  </>;
}

/** Keep each content editor in one stable portal while its column container moves.
 * Changing the portal target would remount TipTap and lose its private history.
 */
export function ContentRowCanvas({ homeV2 = false, blocks, palette, readOnly = false, loadMedia, showPageSeedAssets = false, allowRows = true, hideInsertionControls = false, frame, frameBlockIds, sectionFrames, selectedBlockId, selectedColumn, editRequest, onSelect, rowNotice, renderBlock, renderKey, onInsert, onMove, onSplit, onRemove, onDuplicate, onToggleVisible }: ContentRowCanvasProps) {
  const view = useEditorWorkspaceView();
  const canEditCustomHtml = useContext(CustomHtmlEditing);
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const [editingColumn, setEditingColumn] = useState<number | null>(null);
  const handledEditRequest = useRef<number>();
  useEffect(() => {
    if (readOnly) {
      setSelectedRow(null);
      return;
    }
    if (!editRequest || handledEditRequest.current === editRequest.sequence) return;
    handledEditRequest.current = editRequest.sequence;
    const row = blocks.find(block => block.id === editRequest.id && block.type === "row");
    if (row) {
      setSelectedRow(renderKey(row.id));
      setEditingColumn(editRequest.column ?? null);
    }
  }, [editRequest, blocks, readOnly, renderKey]);
  useEffect(() => {
    if (selectedRow && !blocks.some(block => block.type === "row" && renderKey(block.id) === selectedRow)) {
      setSelectedRow(null);
    }
  }, [blocks, renderKey, selectedRow]);
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const slots = useRef(new Map<string, HTMLDivElement>());
  const placementNodes = useRef(new Map<string, { id: string; node: ReactNode }>());
  const groups = groupContentRows(blocks);
  if (homeV2) {
    for (let index = 0; index < groups.length - 1; index++) {
      const group = groups[index];
      const next = groups[index + 1];
      if (!group.row && !next.row && group.columns[0][0].section === "home-passport-copy" && next.columns[0][0].section === "home-passport-action") {
        group.columns[0].push(...next.columns[0]);
        groups.splice(index + 1, 1);
      }
    }
  }
  const fixedGroups = groups.filter(group => !group.row && frameBlockIds?.has(group.columns[0][0].id));
  const editableGroups = groups.filter(group => !fixedGroups.includes(group) || (!group.row && sectionFrames?.has(group.columns[0][0].id)));
  const rowGroups = groups.filter(group => group.row);
  const movableGroups = editableGroups.filter(group => {
    const section = group.row ? undefined : group.columns[0][0].section;
    return !isHomeSectionAction(section);
  });
  const topIds = movableGroups.map(group => group.row?.id ?? group.columns[0][0].id);
  const reorderBlocks = blocks.filter(block => block.layout || topIds.includes(block.id));
  const reorder = useReorder({
    items: reorderBlocks.map(block => ({
      id: renderKey(block.id),
      label: block.type === "row" ? `Span ${rowGroups.findIndex(group => group.row?.id === block.id) + 1}` : `${BLOCK_LABELS[block.type]} plank ${blocks.indexOf(block) + 1}`,
      group: block.layout ? `${renderKey(block.layout.rowId)}:${block.layout.column}` : "page",
      disabled: block.section !== undefined && block.section !== LIVE_BLOG_SIDEBAR && (!homeV2 || isHomeLockedAuthoringSection(block.section) || isHomeSectionAction(block.section)),
    })),
    disabled: readOnly,
    onMove: (key, { targetId, after }) => {
      const block = reorderBlocks.find(candidate => renderKey(candidate.id) === key);
      const target = reorderBlocks.find(candidate => renderKey(candidate.id) === targetId);
      if (!block || !target || (block.section !== undefined && block.section !== LIVE_BLOG_SIDEBAR && !homeV2)) return;
      const siblings = (block.layout ? contentSiblings(blocks, block) : topIds.map(id => blocks.find(candidate => candidate.id === id)!)).filter(candidate => candidate.id !== block.id);
      const index = siblings.indexOf(target) + (after ? 1 : 0);
      onMove(block.id, { layout: block.layout, beforeId: siblings[index]?.id });
    },
  });
  const placements = new Map<string, string[]>();
  for (const group of groups) {
    group.columns.forEach((column, index) => {
      const slot = group.row ? `${renderKey(group.row.id)}:${index}` : renderKey(column[0].id);
      placements.set(slot, column.map(block => renderKey(block.id)));
    });
  }
  const leaves = blocks.filter(block => block.type !== "row");
  for (const block of leaves) {
    const key = renderKey(block.id);
    if (!hosts.current.has(key)) hosts.current.set(key, document.createElement("div"));
  }
  useLayoutEffect(() => {
    const active = document.activeElement;
    for (const [slotId, keys] of placements) {
      const slot = slots.current.get(slotId);
      if (!slot) continue;
      let before: Node | null = null;
      for (const key of [...keys].reverse()) {
        const host = hosts.current.get(key)!;
        if (host.parentNode !== slot || host.nextSibling !== before) {
          const atomic = slot as HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void };
          if (host.isConnected && slot.isConnected && atomic.moveBefore) atomic.moveBefore(host, before);
          else slot.insertBefore(host, before);
        }
        before = host;
      }
    }
    const currentKeys = new Set(leaves.map(block => renderKey(block.id)));
    for (const [key, host] of hosts.current) {
      if (currentKeys.has(key)) continue;
      host.remove();
      hosts.current.delete(key);
      placementNodes.current.delete(key);
    }
    if (active instanceof HTMLElement && active.isConnected && active !== document.activeElement) active.focus({ preventScroll: true });
  });
  const slotRef = (key: string) => (node: HTMLDivElement | null) => {
    if (node) slots.current.set(key, node);
    else slots.current.delete(key);
  };
  const selected = blocks.find(block => block.id === selectedBlockId);
  const parentId = selected?.layout?.rowId ?? (selected?.type === "row" ? selected.id : undefined);
  const parentNumber = rowGroups.findIndex(group => group.row?.id === parentId) + 1;
  const columnNumber = selected?.layout?.column ?? selectedColumn;
  const breadcrumb = ["Content", ...(parentNumber ? [`Row ${parentNumber}`] : []), ...(columnNumber != null ? [`Column ${columnNumber + 1}`] : []), ...(selected && selected.type !== "row" ? [outlineTypeLabel(selected)] : [])];
  return <PlacementContext.Provider value={{ blocks, onMove, renderKey, pageLevelIds: topIds, handleProps: reorder.handleProps }}><div className="content-row-canvas">
    <p className="sr-only" id={reorder.helpId}>{reorder.instructions}</p>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{reorder.announcement}</p>
    {!view?.kind && (homeV2 || breadcrumb.length > 1) ? <p className="content-row-breadcrumb">{breadcrumb.join(" › ")}</p> : null}
    {fixedGroups.map(group => {
      const block = group.columns[0][0];
      return <div className="content-row-fixed-editor" key={renderKey(block.id)} hidden={selectedBlockId !== block.id} ref={slotRef(renderKey(block.id))} />;
    })}
    {frame}
    {editableGroups.map(group => {
      if (!group.row) {
        const block = group.columns[0][0];
        const section = sectionFrames?.get(block.id);
        if (section) return <div key={`section:${renderKey(block.id)}`} {...reorder.itemProps(renderKey(block.id))}>
          {!hideInsertionControls ? <div className="content-row-footer" role="group" aria-label={`Before ${section.label}`}>
            <AddContent blocks={blocks} readOnly={readOnly} palette={palette} allowRows={allowRows} destination={{ beforeId: block.id }} position={blocks.indexOf(block) + 1} onInsert={onInsert} />
          </div> : null}
          {section.content}
        </div>;
        return <div key={renderKey(block.id)} data-home-section={homeV2 ? block.section : undefined}
          {...((homeV2 && block.section !== undefined || block.section === LIVE_BLOG_SIDEBAR) ? reorder.itemProps(renderKey(block.id)) : {})}>
          {!hideInsertionControls && block.section === undefined ? <AddContent blocks={blocks} readOnly={readOnly} palette={palette} allowRows={allowRows} destination={{ beforeId: block.id }} position={blocks.indexOf(block) + 1} onInsert={onInsert} /> : null}
          <div ref={slotRef(renderKey(block.id))} />
        </div>;
      }
      const row = group.row;
      const key = renderKey(row.id);
      const moveIndex = movableGroups.indexOf(group);
      const rowNumber = rowGroups.indexOf(group) + 1;
      const widths = row.data.columns as number[];
      const split = widths.join(",");
      const blockCount = group.columns.flat().length;
      const hasCustomHtml = group.columns.some(column => column.some(block => block.type === "html"));
      return <div key={key} className="content-row-group">
        {!hideInsertionControls ? <AddContent blocks={blocks} readOnly={readOnly} palette={palette} allowRows={allowRows} destination={{ beforeId: row.id }} position={blocks.indexOf(row) + 1} onInsert={onInsert} /> : null}
        <section {...reorder.itemProps(key)} id={`block-card-${row.id}`} tabIndex={-1} className="content-row-editor" data-editor-frame={view?.kind ?? undefined} data-context={parentId === row.id || undefined} data-selected={selectedBlockId === row.id && selectedColumn == null || undefined} onFocus={event => { if (event.target === event.currentTarget) onSelect?.(row.id); }} data-hidden={!row.visible || undefined} aria-label={`Row ${rowNumber}`}>
        <EditorFrameHeader
          scope="row"
          className="content-row-toolbar"
          leading={view?.kind ? <Icon name="columns" /> : <ReorderHandle {...reorder.handleProps(key)} />}
          title={<>{view?.kind ? "Row" : "Span"} {rowNumber}{!row.visible ? <span className="content-row-hidden-label">Hidden</span> : null}</>}
          meta={<>{widths.length} {widths.length === 1 ? "column" : "columns"} · {view?.kind ? widths.map(width => `${Math.round(width / 12 * 100)}%`).join(" / ") : `${blockCount} ${blockCount === 1 ? "plank" : "planks"}`}</>}
          actions={<ControlSizingProvider size={view?.kind ? "compact" : "legacy"}>
            {!view?.kind ? <><ActionControl action="move-up" label={`Move row ${rowNumber} up`} disabled={readOnly || moveIndex <= 0} onClick={() => onMove(row.id, { beforeId: topIds[moveIndex - 1] })} />
            <ActionControl action="move-down" label={`Move row ${rowNumber} down`} disabled={readOnly || moveIndex < 0 || moveIndex === movableGroups.length - 1} onClick={() => onMove(row.id, { beforeId: topIds[moveIndex + 2] })} />
            </> : null}
            <ActionControl action="settings" graphic={<Icon name="pencil" />} label={`Edit row ${rowNumber}`} aria-haspopup="dialog" aria-expanded={selectedRow === key} disabled={readOnly} onClick={() => { onSelect?.(row.id); setEditingColumn(null); setSelectedRow(key); }} />
            {!view?.kind ? <Button aria-label={`Duplicate span ${rowNumber}`} title={`Duplicate span ${rowNumber}`} disabled={readOnly || !canEditCustomHtml && hasCustomHtml} onClick={() => onDuplicate(row.id)}><Icon name="content" /></Button> : <Menu variant="ghost" label={`Row ${rowNumber} actions`} disabled={readOnly} items={[
              { key: "duplicate", label: "Duplicate row", icon: "content", hidden: !canEditCustomHtml && hasCustomHtml, onSelect: () => { if (!readOnly) onDuplicate(row.id); } },
              { key: "remove", label: "Remove row", icon: "trash", danger: true, onSelect: () => { if (!readOnly) { onSelect?.(row.id); setSelectedRow(key); onRemove(row.id); } } },
            ]} />}
          </ControlSizingProvider>}
        />
        <ComponentEditorDialog variant="content" open={!readOnly && selectedRow === key} onClose={() => setSelectedRow(null)} title={`Row ${rowNumber}`} preview={<ComponentPhonePreview block={row} blocks={[row, ...group.columns.flat()]} headingContext={blocks} loadMedia={loadMedia} showPageSeedAssets={showPageSeedAssets} />} description={`Content › Row ${rowNumber}${editingColumn != null ? ` › Column ${editingColumn + 1}` : ""}`} settings={<fieldset disabled={readOnly} className="content-row-modal-actions">
          <legend>Row settings</legend>
          <div className="content-row-settings-group">
            <h3>Visibility</h3>
            <ActionControl action={row.visible ? "hide" : "show"}
              graphic={<Icon name={row.visible ? "eye" : "eye-off"} />}
              disabled={!canEditCustomHtml && !row.visible && group.columns.some(column => column.some(block => block.type === "html" && block.visible))}
              label={row.visible ? "Hide row" : "Show row"} onClick={() => onToggleVisible(row.id)} />
            <p className="muted">{row.visible ? "Visible on page" : "Hidden from page"}</p>
          </div>
          <div className="content-row-settings-group">
            <h3>Move row</h3>
            <div className="button-row">
              <ActionControl action="move-up" label="Move row up" disabled={moveIndex <= 0} onClick={() => onMove(row.id, { beforeId: topIds[moveIndex - 1] })} />
              <ActionControl action="move-down" label="Move row down" disabled={moveIndex < 0 || moveIndex === movableGroups.length - 1} onClick={() => onMove(row.id, { beforeId: topIds[moveIndex + 2] })} />
            </div>
            <MoveContentDialog block={row} blocks={blocks} pageLevelIds={topIds} onMove={onMove} />
          </div>
          <div className="content-row-settings-group">
            <Button disabled={!canEditCustomHtml && hasCustomHtml} onClick={() => onDuplicate(row.id)}><Icon name="content" /><span className="button-compact-label">Duplicate row</span></Button>
          </div>
          <div className="content-row-settings-group">
            <Button variant="danger-quiet" onClick={() => onRemove(row.id)}><Icon name="trash" /><span className="button-compact-label">Remove row</span></Button>
            {selectedRow === key && rowNotice?.id === row.id ? rowNotice.content : null}
          </div>
        </fieldset>}>
          <fieldset disabled={readOnly} className="content-row-modal-fields">
            <legend>Choose a layout</legend>
            <div className="content-row-layout-options">
              {SPLITS.map(option => <label key={option.label} className="content-row-layout-option">
                <input className="sr-only" type="radio" name={`row-layout-${key}`} value={option.widths.join(",")}
                  checked={split === option.widths.join(",")}
                  onChange={() => { if (!readOnly) onSplit(row.id, [...option.widths]); }} />
                <span className="content-row-layout-diagram" aria-hidden="true"
                  style={{ gridTemplateColumns: option.widths.map(width => `${width}fr`).join(" ") }}>
                  {option.widths.map((_width, column) => <span key={column} />)}
                </span>
                <span>{option.label}</span>
                <span className="content-row-layout-check" aria-hidden="true"><Icon name="check" /></span>
              </label>)}
            </div>
            {!SPLITS.some(option => option.widths.join(",") === split)
              ? <p className="muted">Current custom layout: {widths.join(" / ")}. Choose a layout to change it.</p> : null}
            <div className="content-row-preview-heading">
              <h3>Row content preview</h3>
              <p className="muted">Edit each block from the page canvas.</p>
            </div>
            {widths.length >= 4 ? <p id={`row-${row.id}-column-limit`}>A row can have up to four columns.</p> : null}
            <div className="content-row-modal-columns" style={{ "--row-preview-columns": widths.map(width => `minmax(0, ${width}fr)`).join(" ") } as CSSProperties}>
              {group.columns.map((column, columnIndex) => <section key={columnIndex} data-selected={editingColumn === columnIndex || undefined} aria-label={`Column ${columnIndex + 1} settings`}>
                <EditorFrameHeader
                  scope="column"
                  className="content-row-preview-column-header"
                  title={<h3>Column {columnIndex + 1}</h3>}
                  meta={<span className="content-row-column-width">{Math.round(widths[columnIndex] / 12 * 100)}%</span>}
                  selected={editingColumn === columnIndex}
                />
                <div className="content-row-preview-blocks">
                  {column.length ? selectedRow === key && column.map(block => <BlockPreview key={renderKey(block.id)} block={block} loadMedia={loadMedia} showPageSeedAssets={showPageSeedAssets} />)
                    : <p className="muted">This column is empty.</p>}
                </div>
                <div className="content-row-preview-column-actions">
                  <p className="muted">{column.length} {column.length === 1 ? "block" : "blocks"} · {widths[columnIndex]} of 12 parts</p>
                  {hideInsertionControls && !homeV2 ? <AddContent blocks={blocks} readOnly={readOnly} palette={palette} destination={{ layout: { rowId: row.id, column: columnIndex } }} triggerLabel={`Add plank to column ${columnIndex + 1}`} onInsert={onInsert} /> : null}
                  <Button disabled={widths.length >= 4 || (!canEditCustomHtml && column.some(block => block.type === "html"))} aria-describedby={widths.length >= 4 ? `row-${row.id}-column-limit` : undefined} aria-label={`Duplicate row ${rowNumber}, column ${columnIndex + 1}`} onClick={() => onDuplicate(row.id, columnIndex)}>Duplicate column</Button>
                </div>
              </section>)}
            </div>
          </fieldset>
        </ComponentEditorDialog>
        {selectedRow !== key && rowNotice?.id === row.id ? rowNotice.content : null}
        <div className="cms-row" style={{ "--cms-columns": widths.map(width => `minmax(0, ${width}fr)`).join(" ") } as CSSProperties}>
          {group.columns.map((_column, column) => <div key={column} id={contentColumnDomId(row.id, column)} tabIndex={-1} onFocus={event => { if (event.target === event.currentTarget) onSelect?.(row.id, column); }} data-selected={selectedBlockId === row.id && selectedColumn === column || undefined} className="cms-row__column content-row-column" role="group" aria-label={`Row ${rowNumber}, column ${column + 1}`}>
            <EditorFrameHeader
              scope="column"
              className="content-row-column-header"
              title={<span className="content-row-column-label">Column {column + 1}</span>}
              meta={<span className="content-row-column-width">{Math.round(widths[column] / 12 * 100)}%</span>}
              selected={selectedBlockId === row.id && selectedColumn === column}
              actions={!view?.kind && !readOnly ? <ActionControl action="settings" label={`Edit row ${rowNumber}, column ${column + 1}`} aria-haspopup="dialog" onClick={() => { onSelect?.(row.id, column); setEditingColumn(column); setSelectedRow(key); }} /> : null}
            />
            <div className="content-row-column-content" ref={slotRef(`${key}:${column}`)} />
            {!hideInsertionControls ? <AddContent blocks={blocks} readOnly={readOnly} palette={palette} destination={{ layout: { rowId: row.id, column } }} triggerLabel={`Add plank to column ${column + 1}`} onInsert={onInsert} /> : null}
          </div>)}
        </div>
        </section>
      </div>;
    })}
    {leaves.map(block => {
      const representative = homeV2 && block.section === "home-passport-action"
        ? blocks.find(candidate => candidate.section === "home-passport-copy")! : block;
      const sectionArrange = homeV2 && !isHomeLockedAuthoringSection(block.section) && block.section !== "home-passport-action";
      // Portal events follow the React tree, so they bypass the section's DOM
      // wrapper. Forward only its drop handlers; the wrapper remains the one
      // registered target and supplies the complete group's bounds.
      const sectionDrop = reorder.itemProps(renderKey(representative.id));
      const placementProps = homeV2 && block.section !== undefined
        ? { onDragOver: sectionDrop.onDragOver, onDrop: sectionDrop.onDrop }
        : frameBlockIds?.has(block.id) ? {} : reorder.itemProps(renderKey(block.id));
      let placementNode: ReactNode;
      if (!readOnly && (block.section === undefined || block.section === LIVE_BLOG_SIDEBAR || sectionArrange) && !frameBlockIds?.has(block.id)) {
        const key = renderKey(block.id);
        let entry = placementNodes.current.get(key);
        if (!entry || entry.id !== representative.id) {
          entry = { id: representative.id, node: <HeaderPlacementControls id={representative.id} /> };
          placementNodes.current.set(key, entry);
        }
        placementNode = entry.node;
      }
      return createPortal(<div {...placementProps} className="content-plank-placement">
      {!hideInsertionControls && block.layout && block.section === undefined ? <AddContent blocks={blocks} readOnly={readOnly} palette={palette} destination={{ layout: block.layout, beforeId: block.id }} position={blocks.indexOf(block) + 1} triggerLabel="Add plank here" onInsert={onInsert} /> : null}
      {renderBlock(block, blocks.indexOf(block), placementNode)}
      {contentPlacementReason(blocks, block.type, { layout: block.layout }) ? <p className="content-row-placement-notice">{contentPlacementReason(blocks, block.type, { layout: block.layout })} Move this divider outside the row, remove it, or change the row to one column.</p> : null}
    </div>, hosts.current.get(renderKey(block.id))!, renderKey(block.id));
    })}
    {!hideInsertionControls ? <fieldset disabled={readOnly} className="content-row-footer">
      <AddContent blocks={blocks} readOnly={readOnly} palette={palette} allowRows={allowRows} destination={{}} position={blocks.length + 1} onInsert={onInsert} />
    </fieldset> : null}
  </div></PlacementContext.Provider>;
}
