import { LIVE_BLOG_SIDEBAR } from "../../../packages/content-core/src/live-blog-layout";
import { contentLayoutError, isRowData, type BlockLayout } from "../../../packages/content-core/src/content-layout";
import { applyEditorOp, validateSection, type SectionId } from "../../../packages/content-core/src/editor-admin";
import type { BlockType } from "../../../packages/content-core/src/content-model";
import {
  homePlacementFromFollowingSection,
  homePromotionPlacement,
  homeStructuralBlocks,
  homeSectionMemberIds,
  isHomeLockedAuthoringSection,
  isHomeSectionAction,
} from "../../../packages/content-core/src/home-composition";
import type { AdminBlock } from "./block-factory";

export interface ContentDestination {
  layout?: BlockLayout;
  /** Omit to append at the destination. Must name a sibling, not a row's child. */
  beforeId?: string;
}

export const DIVIDER_PLACEMENT_REASON = "Dividers are only available outside rows or inside a one-column row.";

/** Authoring eligibility only. Stored documents and historical restores keep their content. */
export function contentPlacementReason(blocks: AdminBlock[], type: BlockType, destination: ContentDestination): string | null {
  if (type !== "divider" || !destination.layout) return null;
  const row = blocks.find(block => block.id === destination.layout!.rowId && block.type === "row");
  return row && Array.isArray(row.data.columns) && row.data.columns.length > 1 ? DIVIDER_PLACEMENT_REASON : null;
}

function dividerAuthoringError(before: AdminBlock[], after: AdminBlock[]): string | null {
  for (const block of after) {
    if (!contentPlacementReason(after, block.type, { layout: block.layout })) continue;
    const previous = before.find(candidate => candidate.id === block.id);
    const priorRow = before.find(candidate => candidate.id === previous?.layout?.rowId);
    const nextRow = after.find(candidate => candidate.id === block.layout?.rowId);
    // An unchanged legacy placement can survive editing, hiding and group movement.
    if (previous && sameColumn(previous.layout, block.layout) &&
      Array.isArray(priorRow?.data.columns) && priorRow.data.columns.length > 1 &&
      priorRow.data.columns.length === (nextRow?.data.columns as number[]).length) continue;
    return `${DIVIDER_PLACEMENT_REASON} Move the divider outside the row or remove it before changing this layout.`;
  }
  return null;
}

export type ContentRowEdit =
  | { kind: "insert"; block: AdminBlock; destination: ContentDestination }
  | { kind: "replaceMany"; id: string; blocks: AdminBlock[] }
  | { kind: "move"; id: string; destination: ContentDestination }
  | { kind: "homeMove"; id: string; destination: ContentDestination }
  | { kind: "homeV2Move"; id: string; destination: ContentDestination }
  | { kind: "remove"; id: string }
  | { kind: "duplicate"; id: string; column?: number; newIds: Record<string, string> }
  | { kind: "split"; id: string; columns: number[] };

export interface ContentStructureEntry {
  id: string;
  layout?: BlockLayout;
  columns?: number[];
  /** Payload only for content this operation removed, never for surviving IDs. */
  removed?: AdminBlock;
}

export interface ContentStructureResult {
  blocks: AdminBlock[];
  inverse: ContentStructureEntry[];
}

function sameColumn(left?: BlockLayout, right?: BlockLayout): boolean {
  return left?.rowId === right?.rowId && left?.column === right?.column;
}

/** Local reorder controls stay in one column and skip fixed page regions. */
export function contentSiblings(blocks: AdminBlock[], block: AdminBlock): AdminBlock[] {
  return blocks.filter(candidate => candidate.section === block.section && sameColumn(candidate.layout, block.layout));
}

function placedBlock(block: AdminBlock, layout?: BlockLayout): AdminBlock {
  if (sameColumn(block.layout, layout)) return block;
  const { layout: _prior, ...rest } = block;
  return layout ? { ...rest, layout: { ...layout } } : rest;
}

function structureBefore(before: AdminBlock[], after: AdminBlock[]): ContentStructureEntry[] {
  const surviving = new Set(after.map(block => block.id));
  return before.map(block => ({
    id: block.id,
    ...(block.layout ? { layout: { ...block.layout } } : {}),
    ...(block.type === "row" ? { columns: [...block.data.columns as number[]] } : {}),
    ...(!surviving.has(block.id) ? { removed: block } : {}),
  }));
}

function checkedResult(section: SectionId, before: AdminBlock[], next: AdminBlock[], checkCatalog = true, authoring = true): ContentStructureResult {
  const placementError = authoring ? dividerAuthoringError(before, next) : null;
  if (placementError) throw new Error(placementError);
  const blocks = next.map((block, order) => block.order === order ? block : { ...block, order });
  const error = checkCatalog ? validateSection(section, blocks) : null;
  if (error) throw new Error(error.reason);
  const layoutError = contentLayoutError(blocks);
  if (layoutError) throw new Error(layoutError);
  return { blocks, inverse: structureBefore(before, blocks) };
}

function destinationIndex(blocks: AdminBlock[], destination: ContentDestination): number {
  const { layout, beforeId } = destination;
  if (layout) {
    const row = blocks.find(block => block.id === layout.rowId && block.type === "row");
    if (!row || !isRowData(row.data) || !Number.isInteger(layout.column) || layout.column < 0 || layout.column >= row.data.columns.length) {
      throw new Error("Choose an existing row and column.");
    }
  }
  if (beforeId !== undefined) {
    const index = blocks.findIndex(block => block.id === beforeId);
    if (index < 0 || !sameColumn(blocks[index].layout, layout)) throw new Error("Choose content in the destination column.");
    return index;
  }
  if (!layout) return blocks.length;
  let index = blocks.findIndex(block => block.id === layout.rowId) + 1;
  while (index < blocks.length && blocks[index].layout?.rowId === layout.rowId && blocks[index].layout!.column <= layout.column) index++;
  return index;
}

function duplicateContent(blocks: AdminBlock[], target: AdminBlock, edit: Extract<ContentRowEdit, { kind: "duplicate" }>): AdminBlock[] {
  if (target.section !== undefined) throw new Error("Fixed page sections cannot be duplicated.");
  const column = edit.column;
  if (column !== undefined && (target.type !== "row" || !isRowData(target.data) || !Number.isInteger(column) || column < 0 || column >= target.data.columns.length)) {
    throw new Error("Choose an existing column to duplicate.");
  }
  const source = blocks.filter(block => column === undefined
    ? block.id === target.id || (target.type === "row" && block.layout?.rowId === target.id)
    : block.layout?.rowId === target.id && block.layout.column === column);
  const used = new Set(blocks.map(block => block.id));
  const copies = source.map(block => {
    const id = edit.newIds[block.id];
    if (!id || used.has(id)) throw new Error("Could not duplicate this content. Try again.");
    used.add(id);
    const copy = { ...structuredClone(block), id };
    if (copy.layout) copy.layout = column === undefined
      ? { ...copy.layout, rowId: edit.newIds[copy.layout.rowId] ?? copy.layout.rowId }
      : { rowId: target.id, column: column + 1 };
    return copy;
  });
  if (column === undefined) {
    const next = [...blocks];
    const last = source[source.length - 1];
    next.splice(blocks.indexOf(last) + 1, 0, ...copies);
    return next;
  }
  const widths = [...target.data.columns as number[]];
  if (widths.length >= 4) throw new Error("A row can have up to four columns. Remove a column before duplicating one.");
  widths.splice(column + 1, 0, widths[column]);
  // Keep relative widths, with at least one of the twelve grid units per column.
  const total = widths.reduce((sum, width) => sum + width, 0);
  const scaled = widths.map(width => width * 12 / total);
  const columns = scaled.map(width => Math.max(1, Math.floor(width)));
  while (columns.reduce((sum, width) => sum + width, 0) < 12) {
    const index = scaled.reduce((best, width, index) => width - columns[index] > scaled[best] - columns[best] ? index : best, 0);
    columns[index]++;
  }
  const next = blocks.map(block => {
    if (block.id === target.id) return { ...block, data: { ...block.data, columns } };
    if (block.layout?.rowId === target.id && block.layout.column > column) return placedBlock(block, { rowId: target.id, column: block.layout.column + 1 });
    return block;
  });
  next.splice(destinationIndex(next, { layout: { rowId: target.id, column: column + 1 } }), 0, ...copies);
  return next;
}

function sameHomeStructure(left: readonly AdminBlock[], right: readonly AdminBlock[]): boolean {
  return left.length === right.length && left.every((block, index) => {
    const other = right[index];
    return other !== undefined && block.id === other.id
      && homePromotionPlacement(block) === homePromotionPlacement(other);
  });
}

function applyHomeStructuralMove(
  blocks: AdminBlock[],
  target: AdminBlock,
  destination: ContentDestination,
): AdminBlock[] {
  if (destination.layout) throw new Error("Rows cannot go inside other rows.");
  const display = homeStructuralBlocks(blocks);
  const moving = display.filter(block => block.id === target.id || (target.type === "row" && block.layout?.rowId === target.id));
  const ids = new Set(moving.map(block => block.id));
  if (destination.beforeId && ids.has(destination.beforeId)) throw new Error("Choose a different position.");
  const remaining = display.filter(block => !ids.has(block.id));
  const index = destination.beforeId === undefined
    ? remaining.length
    : remaining.findIndex(block => block.id === destination.beforeId);
  if (destination.beforeId !== undefined && index < 0) throw new Error("Choose content in the destination column.");
  let next = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
  if (target.type === "promotion_playlist") {
    const placement = homePlacementFromFollowingSection(next, target.id);
    if (!placement) return blocks;
    next = next.map(block => block.id === target.id && homePromotionPlacement(block) !== placement
      ? { ...block, data: { ...block.data, placement } }
      : block);
    next = homeStructuralBlocks(next);
  }
  return sameHomeStructure(blocks, next) ? blocks : next;
}

function applyHomeV2Move(section: SectionId, blocks: AdminBlock[], target: AdminBlock,
  edit: Extract<ContentRowEdit, { kind: "homeV2Move" }>): AdminBlock[] {
  if (section !== "home") throw new Error("Home arrangement is only available on Home.");
  if (isHomeLockedAuthoringSection(target.section) || isHomeSectionAction(target.section)) throw new Error("Move the complete Home section.");
  if (edit.destination.layout) throw new Error("Home sections stay outside rows.");
  const memberIds = new Set(homeSectionMemberIds(blocks, target.id));
  const moving = blocks.filter(block => memberIds.has(block.id) || (target.type === "row" && block.layout?.rowId === target.id));
  const ids = new Set(moving.map(block => block.id));
  if (edit.destination.beforeId && ids.has(edit.destination.beforeId)) throw new Error("Choose a different position.");
  const next = blocks.filter(block => !ids.has(block.id));
  const destination = next.find(block => block.id === edit.destination.beforeId);
  if (destination && (destination.layout || isHomeSectionAction(destination.section))) throw new Error("Choose a position between Home sections.");
  next.splice(destinationIndex(next, edit.destination), 0, ...moving);
  return next;
}

function checkHomeDestination(section: SectionId, blocks: AdminBlock[], destination: ContentDestination): void {
  if (section !== "home" || destination.layout) return;
  const before = blocks.find(block => block.id === destination.beforeId);
  if (before && isHomeSectionAction(before.section)) {
    throw new Error("Choose a position between Home sections.");
  }
}

/** Structure only: ordinary content can be incomplete while it is being edited. */
export function editContentRows(section: SectionId, blocks: AdminBlock[], edit: ContentRowEdit): ContentStructureResult {
  const currentError = contentLayoutError(blocks);
  if (currentError) throw new Error(currentError);
  if (edit.kind === "insert") {
    checkHomeDestination(section, blocks, edit.destination);
    const admission = applyEditorOp(section, blocks, { kind: "insert", block: edit.block, index: blocks.length });
    if ("error" in admission) throw new Error(admission.error.reason);
    const block = placedBlock(edit.block, edit.destination.layout);
    const next = [...blocks];
    next.splice(destinationIndex(next, edit.destination), 0, block);
    return checkedResult(section, blocks, next);
  }
  const target = blocks.find(block => block.id === edit.id);
  if (!target) throw new Error("This content is no longer on the page.");
  if (edit.kind === "replaceMany") {
    if (target.section !== undefined) throw new Error("This content belongs to a fixed page section.");
    const existingIds = new Set(blocks.filter(block => block.id !== target.id).map(block => block.id));
    const replacementIds = new Set<string>();
    for (const block of edit.blocks) {
      if (existingIds.has(block.id) || replacementIds.has(block.id)) {
        throw new Error("Each new content block needs a unique id.");
      }
      replacementIds.add(block.id);
    }
    const index = blocks.indexOf(target);
    const replacements = edit.blocks.map(block => placedBlock({
      ...block,
      visible: target.visible,
    }, target.layout));
    const next = [...blocks];
    next.splice(index, 1, ...replacements);
    return checkedResult(section, blocks, next);
  }
  if (edit.kind === "homeV2Move") {
    if (section !== "home") throw new Error("Home arrangement is only available on Home.");
    checkHomeDestination(section, blocks, edit.destination);
    if (target.section === undefined && (target.layout || edit.destination.layout)) return editContentRows(section, blocks, { ...edit, kind: "move" });
    return checkedResult(section, blocks, applyHomeV2Move(section, blocks, target, edit), false);
  }
  if (edit.kind === "duplicate") return checkedResult(section, blocks, duplicateContent(blocks, target, edit));
  if (target.section === LIVE_BLOG_SIDEBAR && edit.kind === "move" && edit.destination.layout) {
    throw new Error("Move this plank to Post body before placing it in a row.");
  }
  if (target.section !== undefined && target.section !== LIVE_BLOG_SIDEBAR && (edit.kind === "move" || edit.kind === "homeMove")) {
    throw new Error("This content belongs to a fixed page section.");
  }
  if (edit.kind === "homeMove") {
    const next = applyHomeStructuralMove(blocks, target, edit.destination);
    if (next === blocks) return { blocks, inverse: structureBefore(blocks, blocks) };
    return checkedResult(section, blocks, next, false);
  }
  if (edit.kind === "split") {
    if (target.type !== "row" || !isRowData({ columns: edit.columns })) throw new Error("Choose a valid column layout.");
    const lastColumn = edit.columns.length - 1;
    const next = blocks.map(block => {
      if (block.id === target.id) return { ...block, data: { ...block.data, columns: [...edit.columns] } };
      if (block.layout?.rowId === target.id && block.layout.column > lastColumn) {
        return placedBlock(block, { rowId: target.id, column: lastColumn });
      }
      return block;
    });
    return checkedResult(section, blocks, next);
  }
  const moving = blocks.filter(block => block.id === target.id || (target.type === "row" && block.layout?.rowId === target.id));
  const ids = new Set(moving.map(block => block.id));
  const next = blocks.filter(block => !ids.has(block.id));
  if (edit.kind === "move") {
    if (edit.destination.beforeId && ids.has(edit.destination.beforeId)) throw new Error("Choose a different position.");
    if (target.type === "row" && edit.destination.layout) throw new Error("Rows cannot go inside other rows.");
    const index = destinationIndex(next, edit.destination);
    next.splice(index, 0, ...moving.map(block => block.id === target.id ? placedBlock(block, edit.destination.layout) : block));
  }
  // Removing or moving cannot increase catalog counts. Let an imported document
  // with several violations be repaired one step at a time; save still validates it.
  return checkedResult(section, blocks, next, false);
}

/** Restore placement and widths; current text, settings and visibility always win. */
export function restoreContentStructure(section: SectionId, blocks: AdminBlock[], structure: ContentStructureEntry[]): ContentStructureResult {
  const live = new Map(blocks.map(block => [block.id, block]));
  const next = structure.map(entry => {
    const block = live.get(entry.id) ?? entry.removed;
    if (!block) throw new Error("This layout cannot be restored because content is missing.");
    const placed = placedBlock(block, entry.layout);
    return entry.columns ? { ...placed, data: { ...placed.data, columns: [...entry.columns] } } : placed;
  });
  return checkedResult(section, blocks, next, true, false);
}
