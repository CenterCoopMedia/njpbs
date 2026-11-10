import { useVideoRightsWarnings } from "../lib/video-rights";
import { useOptionalShell } from "../routes/ShellContext";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { BlockType } from "../../../packages/content-core/src/content-model";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";
import { homeStructuralMoveNeighbors } from "../../../packages/content-core/src/home-composition";
import { LIVE_BLOG_SIDEBAR } from "../../../packages/content-core/src/live-blog-layout";
import type { AdminBlock } from "../lib/block-factory";
import { contentSiblings, type ContentDestination } from "../lib/content-row-editing";
import { deriveContentOutline, editorSectionCount, outlineSummary, outlineTypeLabel, outlineTypeName } from "../lib/content-outline";
import { useReorder } from "../hooks/useReorder";
import { ReorderHandle } from "./ReorderHandle";
import { ActionControl } from "./ui/ActionControl";
import { Button, Panel } from "./ui/Primitives";
import { AddContent, BLOCK_TYPE_ICONS } from "./ContentPicker";
import { Icon } from "./ui/Icon";
import "./page-outline.css";

interface PageOutlineProps {
  supplementalSections?: readonly { label: string; onNavigate: () => void }[];
  onNavigateWriting?: () => void;
  docked?: boolean;
  navigationOnly?: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  blocks: AdminBlock[];
  blockErrors: Record<string, string[]>;
  activeBlockId: string | null;
  activeColumn: number | null;
  collapsed: boolean;
  contentId: string;
  pageId?: PublicPageId;
  allowInsertion?: boolean;
  palette: readonly BlockType[];
  readOnly: boolean;
  renderKey: (id: string) => string;
  canMoveBlock?: (block: AdminBlock) => boolean;
  fixedPositionReason?: (block: AdminBlock) => string | undefined;
  includeSectionBoundariesInMoves?: boolean;
  onNavigate: (id: string, column?: number) => void;
  onMove: (id: string, toIndex: number) => void;
  onPlace?: (id: string, destination: ContentDestination) => void;
  onInsert: (type: BlockType, destination: ContentDestination) => string | null;
}

export function PageOutline({ supplementalSections = [], docked = false, navigationOnly = false, onNavigateWriting, onClose, triggerRef, blocks, blockErrors, activeBlockId, activeColumn, collapsed, contentId, pageId, allowInsertion = true, palette, readOnly, renderKey, canMoveBlock = block => block.section === undefined || block.section === LIVE_BLOG_SIDEBAR, fixedPositionReason, includeSectionBoundariesInMoves = false, onNavigate, onMove, onPlace, onInsert }: PageOutlineProps) {
  const view = useEditorWorkspaceView();
  const tokenAvailable = Boolean(useOptionalShell()?.getIdToken);
  const videoIds = useMemo(() => blocks.flatMap(block => block.type === "video" && typeof block.data.assetId === "string" ? [block.data.assetId] : []), [blocks]);
  const videoWarnings = useVideoRightsWarnings(videoIds);
  const sharedPost = view?.kind === "post";
  const sharedHome = Boolean(view?.kind && pageId === "home" && includeSectionBoundariesInMoves);
  const shell = useRef<HTMLDialogElement | null>(null);
  const OutlineShell = docked ? "div" : "dialog";
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1100px)").matches);
  const modal = narrow && !docked;
  const wasModal = useRef(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 1100px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    if (wasModal.current && (collapsed || !modal)) { element.close?.(); triggerRef.current?.focus({ preventScroll: true }); }
    if (!collapsed && modal && !element.open) element.showModal?.();
    if (!collapsed && !modal) element.open = true;
    wasModal.current = !collapsed && modal;
    return () => { if (collapsed) element.close?.(); };
  }, [collapsed, modal, triggerRef]);
  function navigate(id: string, column?: number) {
    if (modal) onClose();
    onNavigate(id, column);
  }
  const outline = useMemo(() => {
    // Group canonical order before hiding the paired action, so row validation sees
    // no order gaps and movement/selection keep the original block references.
    const derived = deriveContentOutline(blocks);
    if (!sharedHome) return derived;
    const nodes = derived.nodes.filter(node => node.block.section !== "home-passport-action");
    return { ...derived, nodes, blockCount: derived.blockCount - (derived.nodes.length - nodes.length) };
  }, [blocks, sharedHome]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const active = blocks.find(block => block.id === activeBlockId);
  const parentId = active?.layout?.rowId ?? (active?.type === "row" ? active.id : undefined);
  const parentKey = parentId ? renderKey(parentId) : undefined;
  const column = active?.layout?.column ?? activeColumn;
  const activeKey = active ? renderKey(active.id) : undefined;
  const topLevelBlocks = useMemo(
    () => includeSectionBoundariesInMoves
      ? homeStructuralMoveNeighbors(blocks)
      : blocks.filter((block) => block.layout === undefined),
    [blocks, includeSectionBoundariesInMoves],
  );
  const reorderBlocks = blocks.filter(block => block.layout || topLevelBlocks.includes(block));
  const rowNumbers = new Map(outline.nodes.flatMap(node => node.kind === "row" ? [[node.block.id, node.rowNumber] as const] : []));
  function reorderLabel(block: AdminBlock): string {
    return block.type === "row" ? `Span ${rowNumbers.get(block.id)} in content outline`
      : `${outlineTypeName(block)} ${blocks.indexOf(block) + 1} in content outline`;
  }
  const reorder = useReorder({
    items: reorderBlocks.map(block => ({
      id: renderKey(block.id),
      label: reorderLabel(block),
      group: block.layout ? `${renderKey(block.layout.rowId)}:${block.layout.column}` : "page",
      disabled: !canMoveBlock(block) || (!includeSectionBoundariesInMoves && block.section !== undefined && block.section !== LIVE_BLOG_SIDEBAR),
    })),
    disabled: readOnly || !onPlace,
    onMove: (key, { targetId, after }) => {
      const block = reorderBlocks.find(candidate => renderKey(candidate.id) === key);
      const target = reorderBlocks.find(candidate => renderKey(candidate.id) === targetId);
      if (!block || !target || !canMoveBlock(block) || (!includeSectionBoundariesInMoves && block.section !== undefined && block.section !== LIVE_BLOG_SIDEBAR)) return;
      const siblings = (block.layout ? contentSiblings(blocks, block) : topLevelBlocks).filter(candidate => candidate.id !== block.id);
      const index = siblings.indexOf(target) + (after ? 1 : 0);
      onPlace?.(block.id, { layout: block.layout, beforeId: siblings[index]?.id });
    },
  });
  // Reveal only on navigation/selection changes, never on a keystroke or count change.
  useEffect(() => {
    if (collapsed || !parentKey) return;
    setClosed(previous => {
      const next = new Set(previous);
      next.delete(parentKey);
      if (column !== null && column !== undefined) next.delete(`${parentKey}:${column}`);
      return next;
    });
  }, [collapsed, parentKey, column, activeKey]);
  function toggle(key: string) {
    setClosed(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const allKeys = outline.nodes.flatMap(node => node.kind === "row" ? [renderKey(node.block.id), ...node.columns.map(column => `${renderKey(node.block.id)}:${column.column}`)] : []);
  function leaf(block: AdminBlock, inheritedHidden = false) {
    const siblings = block.layout
      ? contentSiblings(blocks, block)
      : includeSectionBoundariesInMoves
        ? topLevelBlocks
        : outline.rowCount ? contentSiblings(blocks, block) : blocks;
    const position = siblings.indexOf(block);
    const canMove = !readOnly && canMoveBlock(block);
    const active = !view?.specialSelection && (block.id === activeBlockId || sharedHome && block.section === "home-passport-copy" && blocks.find(candidate => candidate.id === activeBlockId)?.section === "home-passport-action");
    const invalid = blockErrors[block.id] !== undefined;
    const reason = fixedPositionReason?.(block);
    const reasonId = reason ? `${contentId}-${renderKey(block.id)}-fixed` : undefined;
    const handleProps = reorder.handleProps(renderKey(block.id));
    return <li key={renderKey(block.id)} {...reorder.itemProps(renderKey(block.id))}
      className={`block-outline-item${active ? " block-outline-item-active" : ""}${invalid ? " block-outline-item-invalid" : ""}`}>
      <ReorderHandle {...handleProps} aria-label={`Move: ${reorderLabel(block)}`}
        aria-describedby={`${reorder.helpId}${reasonId ? ` ${reasonId}` : ""}`} title={reason ?? handleProps.title} />
      <OutlineRow navigationTitle={navigationOnly ? sharedPost ? block.type === "video" ? "Uploaded video" : block.type === "prose" ? block.layout ? "Story text" : "Continued story" : block.type === "image" ? "Story image" : outlineTypeName(block) : outlineSummary(block, pageId) : undefined}
      navigationDetail={navigationOnly ? sharedPost && block.type === "video" && (!tokenAvailable || videoWarnings.some(warning => warning.assetId === block.data.assetId)) ? "Rights need review"
        : sharedHome && block.section === "home-passport-copy" ? "Copy + action · move together" : sharedHome && block.type === "embed" ? String(block.data.url).includes("youtu") ? "YouTube embed" : "Embedded media" : undefined : undefined}
      block={block} index={blocks.indexOf(block)} summary={outlineSummary(block, pageId)} fixedReason={reason} reasonId={reasonId}
      canMoveUp={canMove && position > 0}
      canMoveDown={canMove && position >= 0 && position < siblings.length - 1}
      active={active} invalid={blockErrors[block.id] !== undefined}
      inheritedHidden={inheritedHidden} onNavigate={onNavigate} onMove={onMove} />
      {reasonId ? <span id={reasonId} className="sr-only">{reason}</span> : null}
    </li>;
  }
  return <OutlineShell ref={(element: HTMLDivElement | HTMLDialogElement | null) => { shell.current = element instanceof HTMLDialogElement ? element : null; }} className="content-outline-shell" role={modal ? "dialog" : "presentation"} data-drawer={modal || undefined} data-docked={docked || undefined} data-navigation-only={navigationOnly || undefined} open={docked ? undefined : !collapsed && !modal} hidden={collapsed} aria-label={modal ? "Content outline" : undefined} onCancel={event => { event.preventDefault(); onClose(); }}>
    <Panel className="block-outline content-outline" id={contentId} hidden={collapsed}>
    <p className="sr-only" id={reorder.helpId}>{reorder.instructions}</p>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{reorder.announcement}</p>
    <div className="block-outline-header">
      <h2>Content outline</h2>
      {modal ? <Button className="content-outline-close" onClick={onClose} aria-label="Close content outline">Close</Button> : null}
      <span aria-hidden="true">{outline.rowCount ? `${outline.rowCount} ${outline.rowCount === 1 ? "row" : "rows"} · ` : ""}{outline.blockCount} {outline.blockCount === 1 ? "block" : "blocks"}</span>
      <span className="sr-only">{outline.rowCount ? `${outline.rowCount} ${outline.rowCount === 1 ? "row" : "rows"}, ` : ""}{outline.blockCount} {outline.blockCount === 1 ? "block" : "blocks"} in outline</span>
    </div>
    {navigationOnly ? <p className="editor-outline-caption">{sharedHome ? `${editorSectionCount(blocks, pageId)} sections · reading order` : "Reading order"}</p> : null}
    {allKeys.length ? <div className="content-outline-disclosures">
      <Button variant="ghost" onClick={() => setClosed(new Set())}>Expand all</Button>
      <Button variant="ghost" onClick={() => setClosed(new Set(allKeys))}>Collapse all</Button>
    </div> : null}
    {sharedHome ? <button type="button" className={`block-outline-jump editor-outline-hero${view?.specialSelection ? " block-outline-item-active" : ""}`} aria-current={view?.specialSelection ? "location" : undefined} onClick={() => { view?.setSpecialSelection("home-hero"); if (view?.phone) view.closePane("outline", false); requestAnimationFrame(() => document.getElementById("home-hero-frame")?.focus()); }}><Icon name="image" /><span className="block-outline-copy"><strong>Home hero</strong><span>Fixed position</span></span></button> : null}
    {navigationOnly && sharedPost ? <button type="button" className={`block-outline-jump editor-outline-writing${activeBlockId === null ? " block-outline-item-active" : ""}`} aria-current={activeBlockId === null ? "location" : undefined} onClick={() => {
      onNavigateWriting?.(); if (view?.phone) view.closePane("outline", false);
      requestAnimationFrame(() => {
        const field = document.getElementById("record-post-title"); field?.scrollIntoView({ block: "center" }); field?.focus();
      });
    }}><Icon name="content" /><span className="block-outline-copy"><strong>Headline &amp; summary</strong></span></button> : null}
    <nav aria-label="Content outline" className="block-outline-content" onClick={event => { if (modal && (event.target as Element).closest(".block-outline-jump")) onClose(); }}>
      <ol className="block-outline-list">
        {outline.nodes.map(node => {
          if (node.kind === "block") return leaf(node.block);
          const row = node.block;
          const siblings = includeSectionBoundariesInMoves
            ? topLevelBlocks
            : contentSiblings(blocks, row);
          const position = siblings.indexOf(row);
          const canMove = !readOnly && canMoveBlock(row);
          const key = renderKey(row.id);
          const childrenId = `${contentId}-${key}-columns`;
          const summary = `${node.columns.length} ${node.columns.length === 1 ? "column" : "columns"} · ${node.blockCount ? `${node.blockCount} ${node.blockCount === 1 ? "block" : "blocks"}` : "Empty"}`;
          const invalid = Boolean(blockErrors[row.id]) || node.columns.some(column => column.blocks.some(block => blockErrors[block.id]));
          return <li key={key} {...reorder.itemProps(key)} className="content-outline-container" data-context={parentId === row.id || undefined}>
            <div className="content-outline-node content-outline-movable" data-selected={activeBlockId === row.id && activeColumn === null || undefined}>
              <ReorderHandle {...reorder.handleProps(key)} />
              <Button variant="ghost" aria-label={`${closed.has(key) ? "Expand" : "Collapse"} Row ${node.rowNumber}`} aria-expanded={!closed.has(key)} aria-controls={childrenId} onClick={() => toggle(key)}>{closed.has(key) ? "▸" : "▾"}</Button>
              <button type="button" className="block-outline-jump" aria-current={activeBlockId === row.id && activeColumn === null ? "location" : undefined} onClick={() => navigate(row.id)} title={`Row ${node.rowNumber}: ${summary}`}>
                <span className="block-outline-copy"><strong>Row {node.rowNumber}</strong><span>{navigationOnly && sharedPost ? `${node.columns.length} columns` : summary}</span>
                  {!row.visible ? <span>Hidden</span> : null}{invalid ? <span className="block-outline-state-invalid">Needs attention</span> : null}
                </span>
              </button>
            <OutlineMoveControls block={row} index={blocks.indexOf(row)} label={`Row ${node.rowNumber}`}
              canMoveUp={canMove && position > 0}
              canMoveDown={canMove && position >= 0 && position < siblings.length - 1}
              onMove={onMove} />
            </div>
            <ol id={childrenId} hidden={closed.has(key)} className="content-outline-children">
              {node.columns.map(({ column, blocks: children }) => {
                const columnKey = `${key}:${column}`;
                const blocksId = `${contentId}-${key}-${column}-blocks`;
                const columnSummary = children.length ? `${children.length} ${children.length === 1 ? "block" : "blocks"}` : "Empty";
                return <li key={columnKey} className="content-outline-container" data-context={parentId === row.id && (active?.layout?.column ?? activeColumn) === column || undefined}>
                  <div className="content-outline-node" data-selected={activeBlockId === row.id && activeColumn === column || undefined}>
                    <Button variant="ghost" aria-label={`${closed.has(columnKey) ? "Expand" : "Collapse"} Row ${node.rowNumber}, column ${column + 1}`} aria-expanded={!closed.has(columnKey)} aria-controls={blocksId} onClick={() => toggle(columnKey)}>{closed.has(columnKey) ? "▸" : "▾"}</Button>
                    <button type="button" className="block-outline-jump" aria-label={`Go to Row ${node.rowNumber}, column ${column + 1}: ${columnSummary}${!row.visible ? ", hidden by row" : ""}`} aria-current={activeBlockId === row.id && activeColumn === column ? "location" : undefined} onClick={() => navigate(row.id, column)}>
                      <span className="block-outline-copy"><strong>Column {column + 1}</strong>{navigationOnly && sharedPost ? null : <span>{columnSummary}</span>}{!row.visible ? <span>Hidden by row</span> : null}</span>
                    </button>
                  </div>
                  <ol id={blocksId} hidden={closed.has(columnKey)} className="content-outline-children">
                    {children.map(block => leaf(block, !row.visible))}
                    {!children.length && !readOnly && allowInsertion ? <li><AddContent blocks={blocks} readOnly={readOnly} palette={palette} destination={{ layout: { rowId: row.id, column } }} onInsert={(type, destination) => {
                      const insertedId = onInsert(type, destination);
                      if (insertedId) navigate(row.id, column);
                      return insertedId;
                    }} /></li> : null}
                  </ol>
                </li>;
              })}
            </ol>
          </li>;
        })}
      </ol>
      {navigationOnly ? supplementalSections.map(section => <button key={section.label} type="button" className="block-outline-jump" onClick={() => { section.onNavigate(); if (view?.phone) view.closePane("outline", false); }}><Icon name="content" /><span className="block-outline-copy"><strong>{section.label}</strong></span></button>) : null}
    </nav>
  </Panel></OutlineShell>;
}

function OutlineMoveControls({ block, index, label, canMoveUp, canMoveDown, onMove, reasonId }: {
  block: AdminBlock;
  index: number;
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  reasonId?: string;
  onMove: (id: string, toIndex: number) => void;
}) {
  return <div className="block-outline-controls">
    <ActionControl action="move-up" variant="ghost" contextLabel={`${label} in content outline`}
      aria-describedby={reasonId}
      disabled={!canMoveUp} onClick={() => onMove(block.id, index - 1)} />
    <ActionControl action="move-down" variant="ghost" contextLabel={`${label} in content outline`}
      aria-describedby={reasonId}
      disabled={!canMoveDown} onClick={() => onMove(block.id, index + 1)} />
  </div>;
}
// One row of the outline, memoized on the block it names.
//
// The outline's summary is derived from the block's live content, so the row for the block being
// typed into has to re-render on every keystroke -- and only that one. Its props are the block
// itself (identity-preserved for untouched blocks by the reducer), its position, and the two
// stable handlers the editor passes down (#511).
const OutlineRow = memo(function OutlineRow({
  block,
  index,
  summary,
  navigationTitle, navigationDetail,
  fixedReason,
  reasonId,
  canMoveUp,
  canMoveDown,
  active,
  invalid = false,
  inheritedHidden = false,
  onNavigate,
  onMove,
}: {
  block: AdminBlock;
  index: number;
  summary: string;
  navigationTitle?: string; navigationDetail?: string;
  fixedReason?: string;
  reasonId?: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  active: boolean;
  /** The last save refused this block; the row marks it so the outline is a map of the fixes. */
  invalid?: boolean;
  inheritedHidden?: boolean;
  onNavigate: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
}) {
  const label = outlineTypeName(block);
  const position = index + 1;
  const states = [
    ...(invalid ? ["needs attention"] : []),
    ...(block.visible ? [] : ["hidden"]),
    ...(inheritedHidden ? ["hidden by row"] : []),
  ];
  // Compose the jump button's accessible name rather than leave it to name-from-content (which
  // runs the separate spans together with no spaces) or to a bare "Go to <type> <position>" (which
  // drops the content summary and the Hidden badge that tells two blocks of the same type apart on
  // a long page). The visible spans stay decorative; this name carries the same information the
  // eye gets.
  const jumpLabel = `Go to ${label} ${position}: ${summary}${
    states.length ? `, ${states.join(", ")}` : ""
  }`;
  return (
    <>
      <button
        type="button"
        className="block-outline-jump"
        aria-current={active ? "location" : undefined}
        aria-label={jumpLabel}
        title={fixedReason ? `${jumpLabel}. ${fixedReason}` : jumpLabel}
        aria-describedby={reasonId}
        onClick={() => onNavigate(block.id)}
      >
        <Icon name={BLOCK_TYPE_ICONS[block.type] ?? "content"} />
        <span className="block-outline-copy">
          <strong>{navigationTitle ?? summary}</strong>
          {navigationTitle || navigationDetail ? navigationDetail ? <span>{navigationDetail}</span> : null : <span><span className="block-outline-position">{position}</span> · {outlineTypeLabel(block)}{fixedReason ? " · Fixed" : ""}</span>}
        </span>
        {states.length === 0 ? null : (
          <span className="block-outline-states">
            {invalid ? (
              <span className="block-outline-state block-outline-state-invalid">
                Needs attention
              </span>
            ) : null}
            {inheritedHidden ? <span className="block-outline-state">Hidden by row</span> : null}
            {block.visible ? null : (
              <span className="block-outline-state">Hidden</span>
            )}
          </span>
        )}
      </button>
      <OutlineMoveControls block={block} index={index} label={`${label} ${position}`}
        canMoveUp={canMoveUp} canMoveDown={canMoveDown} onMove={onMove} reasonId={reasonId} />
    </>
  );
});
