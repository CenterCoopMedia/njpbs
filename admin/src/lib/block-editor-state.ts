import {
  applyEditorOp,
  BLOCK_LABELS,
  canPlaceBlock,
  editorFieldsForBlock,
  SECTION_LABELS,
  validateSection,
  type EditorField,
  type EditorOp,
  type SectionId,
} from "../../../packages/content-core/src/editor-admin";
import { LIVE_BLOG_SIDEBAR, canPlaceInLiveBlogSidebar } from "../../../packages/content-core/src/live-blog-layout";
import type { BlockType } from "../../../packages/content-core/src/content-model";
// From the heading leaf, not the renderer: the editor state only needs the rank rule, and
// importing it from content-render.ts pulls the whole render graph -- the shelf resolver
// and the committed shelf catalogs among it -- into the admin's entry chunk.
import { parseDataTableForEditing } from "../../../packages/content-core/src/data-table";
import { clampHeadingLevel } from "../../../packages/content-core/src/heading-outline";
import { isNoticeAddedAt } from "../../../packages/content-core/src/document-list";
import type { AdminBlock } from "./block-factory";
import { recordsEqual } from "./record-equality";
import { editContentRows, restoreContentStructure, type ContentRowEdit, type ContentStructureEntry } from "./content-row-editing";
import { isRichTextDoc, type CardGridBlock } from "../../../packages/content-core/src/content-model";
import { homeSectionMemberIds } from "../../../packages/content-core/src/home-composition";
import { homeDetailText, homePassportHeading } from "../../../packages/content-core/src/home-composition-contract";
import {
  collectionItemId,
  collectionItemsById,
  mintCollectionItemId,
  reconcileCollectionItemIds,
  sameCollectionItemIds,
} from "./collection-item-keys";

// One entry on the undo stack. A structural op (insert / remove / move) is stored as the bare
// inverse `applyEditorOp` hands back and replayed through that same reducer. A plain-field data
// edit and a visibility toggle are not structural -- they change no id, type, order, or count --
// but the editor still did them, so they enter the same stack as their own inverse: the value to
// restore. Their `kind` is disjoint from the structural ops' `insert | remove | move`, so the
// undo reducer discriminates on `kind` without wrapping the structural entries, and every existing
// undo entry keeps its exact shape (#582).
//
// Rich-text field edits are deliberately absent: a rich-text field carries its own TipTap/
// ProseMirror history, so the outer stack covers non-rich-text fields and structure only, and the
// two Undo affordances never fight over the same edit.
export type UndoEntry<B extends AdminBlock = AdminBlock> =
  | EditorOp<B>
  | { kind: "restoreStructure"; structure: ContentStructureEntry[] }
  | { kind: "restoreHomeText"; id: string; field: HomeTextField; value: string }
  // `fields` holds ONLY the plain field keys the edit changed, at their prior values -- not the
  // whole payload. Undo merges them back over the block's current data, so a rich-text field the
  // editor changed after this plain edit (excluded from the outer stack by design) keeps its newer
  // value instead of being reverted with it (#582).
  //
  // `overlaySafe` names the subset of `fields` that are nested-rich-text list fields whose edit
  // preserved positional identity (a single card's non-rich sub-field changed). Only for those may
  // undo overlay the current rich text position-by-position; a structural change (reorder, add,
  // remove, multi-item) is absent, so its snapshot is restored wholesale and each card's body travels
  // back with its own card. The license is positional identity, recorded at push time, not the
  // list's length at restore time -- a reorder is equal-length yet moves positions (#582).
  | { kind: "restoreData"; id: string; fields: Record<string, unknown>; overlaySafe: string[] }
  | { kind: "restoreLiveBlogSidebar"; id: string; sidebar: boolean }
  | { kind: "restoreVisible"; id: string; visible: boolean; ids?: string[] }
  | { kind: "restoreBlock"; block: AdminBlock };

// These plain controls are stored inside rich text, but do not have a TipTap
// editor/history. Their narrow inverse must not replace a later Passport body.
export type HomeTextField = "passport-heading" | 0 | 1 | 2 | 3;

function replaceHomeText(
  block: AdminBlock,
  field: HomeTextField,
  value: string,
): { block: AdminBlock; previous: string } | null {
  if (field === "passport-heading") {
    const doc = block.data.content;
    if (block.type !== "prose" || block.section !== "home-passport-copy" || !isRichTextDoc(doc)) return null;
    const previous = homePassportHeading(doc) ?? "";
    const heading = {
      type: "heading", attrs: { level: 2 },
      content: value ? [{ type: "text", text: value }] : [],
    };
    const content = { ...doc, content: [heading, ...doc.content.slice(1)] };
    return { previous, block: { ...block, data: { ...block.data, content } } };
  }
  if (block.type !== "card_grid" || block.section !== "home-start" || !Array.isArray(block.data.cards)) return null;
  const cards = block.data.cards as CardGridBlock["data"]["cards"];
  const card = cards[field];
  if (!card || (card.body !== undefined && !isRichTextDoc(card.body))) return null;
  const previous = homeDetailText(card.body) ?? "";
  const body = {
    type: "doc",
    content: [{ type: "paragraph", content: value ? [{ type: "text", text: value }] : [] }],
  };
  const nextCards = cards.map((item, index) => index === field ? { ...item, body } : item);
  return { previous, block: { ...block, data: { ...block.data, cards: nextCards } } };
}

// The block editor's whole state: the live block list, a stack of inverse entries for undo,
// and the last editor-facing error (an op the reducer rejected). Kept as a pure value with
// a pure reducer so the palette / list / undo behavior is unit-tested without React, the
// same discipline the decision core follows.
export interface BlockEditorState {
  blocks: AdminBlock[];
  // Inverse entries, oldest first. Every structural op the reducer accepts pushes the inverse
  // `applyEditorOp` handed back (issue #392, gap 6); a plain-field edit and a visibility toggle
  // push their own restore entry (#582). Undo replays the top entry so it reverses the last thing
  // the editor did rather than reaching past it to the last structural op.
  undo: UndoEntry<AdminBlock>[];
  // Inverse entries for the steps undo has taken back, oldest first, so redo puts them forward
  // again in the order they were undone (#1035). An entry moves from one stack to the other and
  // back: undoing produces the inverse of the inverse, which is exactly the entry redo replays,
  // and redoing produces the original inverse again, which returns to `undo`. So a person can walk
  // the same history in both directions instead of retyping work they stepped one action past.
  //
  // The stack is dropped the moment a new edit pushes onto `undo`, because the branch it belonged
  // to no longer exists. It deliberately survives a rich-text edit: rich text keeps its own history
  // and never pushes here, so typing in a body after an undo must not silently make the page-level
  // Redo unavailable.
  redo: UndoEntry<AdminBlock>[];
  // A key identifying the current typing session, or null between sessions. A plain field is
  // `id:key`; a list field is `id:key#position:subKey`, so a session is the same continuous edit to
  // one field -- or, within a list, one item and one sub-field. Consecutive matching edits coalesce
  // into one undo entry rather than one per keystroke, so Undo steps back a whole session, not a
  // character, while an edit to a different field, list item, or sub-field starts a new entry. Any
  // other action clears it, ending the session (#582).
  coalesce: string | null;
  // Editor-facing message for the last rejected op, or null. The reducer clears it on the
  // next accepted op so a stale rejection never lingers.
  error: string | null;
}

// The plain (non-rich-text) field keys whose value differs between two data payloads for a block
// of the given type. Rich-text fields are excluded because they own their own history; a key not
// in the block's descriptor list (an envelope-level field like a heading level) counts as plain.
// The decision the reducer needs is only "did a plain field change" -- when one did, the whole
// prior payload is what an undo restores, so the exact key set is used just for coalescing.
//
// A `list` field whose items carry a nested rich-text sub-field (a card grid's `cards`, each card's
// `body`) is a second place rich text hides. Editing only that nested body replaces the whole list
// value, so a bare top-level compare reads it as a structural list edit and pushes it onto the
// outer stack -- letting the page-level Undo swallow rich text the card's own TipTap history owns.
// Such a list is excluded exactly like a top-level rich-text field, but only when the sole
// difference is nested rich text: adding, removing, reordering, or editing a non-rich sub-field of a
// card is structural and still counts.
function changedPlainFields(
  type: AdminBlock["type"],
  prior: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const richKeys = new Set(
    editorFieldsForBlock(type).filter((f) => f.kind === "richText").map((f) => f.key),
  );
  const nestedRichLists = nestedRichTextLists(type);
  const keys = new Set([...Object.keys(prior), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (prior[key] === next[key]) continue;
    if (richKeys.has(key)) continue;
    const itemFields = nestedRichLists.get(key);
    if (itemFields && !listChangedStructurally(itemFields, prior[key], next[key])) continue;
    changed.push(key);
  }
  return changed;
}

// The item sub-fields of each `list` field that actually holds nested rich text, keyed by the list
// field. A list with no rich-text sub-field (an image gallery, a button row, a tag list) is absent,
// so any change to its value stays structural. Shared by the setData exclusion above and the undo
// restore below, so both reason about the same set of fields.
function nestedRichTextLists(type: AdminBlock["type"]): Map<string, readonly EditorField[]> {
  return new Map(
    editorFieldsForBlock(type)
      .filter((f) => f.kind === "list" && f.itemFields?.some((sub) => sub.kind === "richText"))
      .map((f) => [f.key, f.itemFields!]),
  );
}

// How one `list` field's value changed, localized: `none` (only nested rich text, or identical), a
// single continuous item edit (one position and its changed non-rich sub-fields), or a `structural`
// change (an add, remove, reorder, or an edit spanning items). This one description drives two
// decisions: whether the outer undo stack owns the change at all (anything but `none`), and, for
// coalescing, whether consecutive edits are the same continuous action (the same `item` position and
// sub-field). Rich-text sub-fields are ignored throughout -- they own their own history, so they
// never make a change structural and never define a coalesce session. Sub-field values are compared
// by identity, per field, matching the top-level compare in changedPlainFields: exact for the
// primitive sub-fields these items hold, and unaffected by an unchanged item the editor re-cloned,
// because it is the sub-values that are compared, not the item references.
//
// One exception keeps that rule from swallowing a real reorder (#617). Cards carry no stable
// identity, so two cards alike in every plain sub-field (title, image, link) and different only in
// their bodies compare equal at every position once rich text is stripped -- and a swap of them read
// as "nothing changed", pushing no undo entry, so the editor could not take it back. The tell is how
// MANY positions differ in rich text alone. One is an ordinary body edit, still the card's own
// history to undo. Two or more cannot come from one body edit: each TipTap editor dispatches its own
// setData, so no single edit rewrites two bodies at once, and the only thing that moves several
// bodies in one step is a reorder. That is structural, and being structural it is not overlay-safe,
// so undo restores the snapshot wholesale and every body travels back inside its own card.
type ListChange =
  | { kind: "none" }
  | { kind: "item"; position: number; subKeys: string[] }
  | { kind: "structural" };

function describeListChange(
  itemFields: readonly EditorField[],
  prior: unknown,
  next: unknown,
): ListChange {
  // A list value should be an array; if either side is not one, treat the (already-unequal) change
  // as structural rather than guess. A length difference is an add or a remove.
  if (!Array.isArray(prior) || !Array.isArray(next)) return { kind: "structural" };
  if (prior.length !== next.length) return { kind: "structural" };
  const richKeys = new Set(itemFields.filter((f) => f.kind === "richText").map((f) => f.key));
  let single: { position: number; subKeys: string[] } | null = null;
  // Positions whose ONLY difference is rich text. Counted rather than ignored so a swap of items
  // that plain sub-fields cannot tell apart is still visible as a reorder (#617).
  let richOnlyPositions = 0;
  for (let i = 0; i < prior.length; i++) {
    const diff = describeItemDiff(prior[i], next[i], richKeys);
    // A position whose change can't be localized to sub-fields (a non-record item) is structural.
    if (diff === null) return { kind: "structural" };
    if (diff.subKeys.length === 0) {
      if (diff.richChanged) richOnlyPositions++;
      continue;
    }
    // A second changed position means the edit spans items (a reorder, a multi-card change): the
    // outer stack owns it, but it is not one continuous item edit, so it must never coalesce.
    if (single) return { kind: "structural" };
    single = { position: i, subKeys: diff.subKeys };
  }
  // Rich text differing at several positions at once is a reorder, not a body edit: no single
  // TipTap edit rewrites two bodies in one setData (#617).
  if (richOnlyPositions > 1) return { kind: "structural" };
  return single ? { kind: "item", position: single.position, subKeys: single.subKeys } : { kind: "none" };
}

// How two list items differ: the non-rich sub-field keys that changed, and whether any rich-text
// sub-field changed. Null when either side is not a plain record, so the change can't be localized
// to sub-fields. Plain sub-field values are compared by identity, per field, which is exact for the
// primitives these items hold; a rich-text sub-field falls back to a content compare, for the reason
// given at that line.
//
// The rich-text flag is reported rather than discarded because the count of rich-only positions is
// what separates a body edit from a reorder of items nothing else distinguishes (#617). It never
// enters `subKeys`: rich text still owns its own history, so it neither makes a single position's
// change structural nor defines a coalesce session.
function describeItemDiff(
  prior: unknown,
  next: unknown,
  richKeys: Set<string>,
): { subKeys: string[]; richChanged: boolean } | null {
  if (prior === next) return { subKeys: [], richChanged: false };
  if (!isPlainRecord(prior) || !isPlainRecord(next)) return null;
  const changed: string[] = [];
  let richChanged = false;
  for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    if (prior[key] === next[key]) continue;
    if (richKeys.has(key)) {
      // A stored rich-text document is a tree, and the editor hands back a fresh one on every pass,
      // so identity would call an untouched sibling card's body "changed" and two re-cloned cards
      // would look like a reorder. Compare the content. The walk is bounded to the rich sub-fields
      // whose reference actually moved -- one card's body on a keystroke -- not the whole list.
      if (!richValuesEqual(prior[key], next[key])) richChanged = true;
      continue;
    }
    changed.push(key);
  }
  return { subKeys: changed.sort(), richChanged };
}

// Whether two stored rich-text values hold the same content. Wraps the record form's canonical walk
// rather than introducing a second notion of equality, so a card body compares here exactly as it
// does when the workspace decides whether a draft still holds unsaved work.
function richValuesEqual(prior: unknown, next: unknown): boolean {
  return recordsEqual({ value: prior }, { value: next });
}

// Whether two values for one `list` field differ in a way the outer undo stack should own, rather
// than only in nested rich-text content the item's own editor owns. Any change but `none` -- a
// count, order, or non-rich sub-field change -- is owned by the outer stack.
function listChangedStructurally(
  itemFields: readonly EditorField[],
  prior: unknown,
  next: unknown,
): boolean {
  return describeListChange(itemFields, prior, next).kind !== "none";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every `list` field with an item schema, keyed by field. Block list fields (an image gallery, a
// button row, a card grid) all declare item fields; a bare string list has none and coalesces per
// field key like a plain field. A superset of nestedRichTextLists, which keeps only those whose
// items carry rich text.
function listItemFields(type: AdminBlock["type"]): Map<string, readonly EditorField[]> {
  return new Map(
    editorFieldsForBlock(type)
      .filter((f) => f.kind === "list" && f.itemFields)
      .map((f) => [f.key, f.itemFields!]),
  );
}

// Table structure changes are discrete actions; typing coalesces only in one cell.
function csvEditKey(id: string, prior: unknown, next: unknown): string | null {
  if (typeof prior !== "string" || typeof next !== "string") return null;
  try {
    const before = parseDataTableForEditing(prior);
    const after = parseDataTableForEditing(next);
    if (before.headers.length !== after.headers.length || before.rows.length !== after.rows.length) return null;
    const previousRows = [before.headers, ...before.rows];
    const nextRows = [after.headers, ...after.rows];
    let key: string | null = null;
    for (let row = 0; row < nextRows.length; row += 1) {
      for (let column = 0; column < nextRows[row].length; column += 1) {
        if (previousRows[row][column] === nextRows[row][column]) continue;
        if (key !== null) return null;
        key = `${id}:csv:${row}:${column}`;
      }
    }
    return key;
  } catch { return null; }
}

// The coalesce key for the edit `changed` represents, so consecutive keystrokes fold into one undo
// entry while distinct actions each get their own. Two setData with the same non-null key are the
// same session and coalesce; a different key -- or a null key -- starts a new entry. Null means the
// edit is not a single continuous action: more than one top-level field at once, or a discrete list
// change (an add, remove, reorder, or an edit spanning items). A null key never coalesces and, left
// on state, never lets the next edit fold onto it.
//
// A plain top-level field coalesces per field key, as before. A list field coalesces per item
// position AND changed sub-field, so editing one card then another, or one card's title then its
// link, breaks the session -- an undo of the later edit can no longer discard the earlier one (#582).
function coalesceKey(
  type: AdminBlock["type"],
  id: string,
  prior: Record<string, unknown>,
  next: Record<string, unknown>,
  changed: string[],
): string | null {
  // Only a single field edited at once can be a continuous keystroke session.
  if (changed.length !== 1) return null;
  const key = changed[0];
  if (type === "data_table" && key === "csv") return csvEditKey(id, prior.csv, next.csv);
  const itemFields = listItemFields(type).get(key);
  if (!itemFields) return `${id}:${key}`;
  const change = describeListChange(itemFields, prior[key], next[key]);
  if (change.kind !== "item") return null;
  const nextItems = next[key];
  const itemIdentity = Array.isArray(nextItems)
    ? collectionItemId(nextItems[change.position])
    : null;
  return `${id}:${key}#${itemIdentity ?? change.position}:${change.subKeys.join(",")}`;
}

// The nested-rich-text list fields among `changed` whose edit preserved positional identity -- a
// single card's non-rich sub-field changed, so each position still names the same card. Recorded on
// the undo entry so restore may overlay the current rich text per position for these, and only these.
// A structural change (a reorder, add, remove, or an edit spanning items) is absent, so its snapshot
// is restored wholesale and every card's body travels back with its card (#582).
function overlaySafeFields(
  type: AdminBlock["type"],
  prior: Record<string, unknown>,
  next: Record<string, unknown>,
  changed: string[],
): string[] {
  const nestedRichLists = nestedRichTextLists(type);
  return changed.filter(
    (key) =>
      nestedRichLists.has(key) &&
      sameCollectionItemIds(prior[key], next[key]),
  );
}

function mergeRestoredFields(
  type: AdminBlock["type"],
  current: Record<string, unknown>,
  fields: Record<string, unknown>,
  overlaySafe: string[],
): Record<string, unknown> {
  const nestedRichLists = nestedRichTextLists(type);
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(fields)) {
    const restored = fields[key];
    if (restored === undefined) {
      delete merged[key];
      continue;
    }
    const itemFields = nestedRichLists.get(key);
    const currentById = collectionItemsById(current[key]);
    if (
      overlaySafe.includes(key) &&
      itemFields &&
      Array.isArray(restored) &&
      currentById &&
      sameCollectionItemIds(restored, current[key])
    ) {
      const richKeys = itemFields
        .filter((field) => field.kind === "richText")
        .map((field) => field.key);
      merged[key] = restored.map((item) => {
        const itemId = collectionItemId(item);
        const liveItem = itemId ? currentById.get(itemId) : undefined;
        return overlayCurrentRichText(item, liveItem, richKeys);
      });
    } else {
      merged[key] = restored;
    }
  }
  return merged;
}

// One restored list item with its rich-text sub-fields taken from the current item rather than the
// snapshot, so undoing a sibling change (a card's title) does not revert a nested rich-text edit.
function overlayCurrentRichText(restored: unknown, current: unknown, richKeys: string[]): unknown {
  if (!isPlainRecord(restored) || !isPlainRecord(current)) return restored;
  const merged: Record<string, unknown> = { ...restored };
  for (const key of richKeys) {
    if (key in current) merged[key] = current[key];
  }
  return merged;
}

// Whether replaying this redo entry would destroy rich text now standing in block `id`. Two
// entries can: one that removes the block outright, and one that restores a nested-rich-text list
// wholesale (a card grid's cards, where each card's body travels back inside the snapshot). An
// entry that only moves a block, restores its visibility, or names a different block cannot.
function redoEntryDestroysRichText(
  entry: UndoEntry<AdminBlock>,
  id: string,
  type: AdminBlock["type"],
): boolean {
  if (entry.kind === "restoreStructure") return !entry.structure.some(block => block.id === id);
  if (entry.kind === "remove") return entry.id === id;
  if (entry.kind === "restoreBlock") return entry.block.id === id;
  if (entry.kind !== "restoreData" || entry.id !== id) return false;
  const nestedRichLists = nestedRichTextLists(type);
  return Object.keys(entry.fields).some(
    (key) => nestedRichLists.has(key) && !entry.overlaySafe.includes(key),
  );
}

// The redo stack after rich text was written into block `id`.
//
// A rich-text edit pushes nothing onto the undo stack -- rich text keeps its own history -- so it
// deliberately leaves the redo branch alone: a redo that cannot reach this block is still exactly
// the step the person set aside. But a redo that would DELETE this block, or restore a snapshot of
// its cards taken before the body existed, would take the new writing with it. Remove a block,
// undo, write into the restored block, press Redo, and the block leaves with the paragraph that
// was never in the snapshot. So those entries are dropped rather than replayed.
//
// The stack is replayed from its end, so entries nearer the start redo later, each composed
// against the ones before it. Dropping an unsafe entry out of the middle would leave the ones
// queued behind it standing on a step that never ran. The branch is cut at the unsafe entry
// instead: everything that redoes before it survives, and it and everything behind it go.
function pruneRedoAfterRichTextEdit(
  redo: UndoEntry<AdminBlock>[],
  id: string,
  type: AdminBlock["type"],
): UndoEntry<AdminBlock>[] {
  for (let index = redo.length - 1; index >= 0; index--) {
    if (redoEntryDestroysRichText(redo[index]!, id, type)) return redo.slice(index + 1);
  }
  return redo;
}

export type BlockEditorAction =
  | { kind: "editRows"; edit: ContentRowEdit }
  // Insert / remove / move: the structural ops the reducer runs through `applyEditorOp`.
  // The action carries a fully-formed op (the insert's block, id and all, is minted by the
  // caller) so the reducer stays pure.
  | { kind: "apply"; op: EditorOp<AdminBlock> }
  // Insert a block, defaulting to the end of the list. The index is resolved here rather
  // than by the caller so it reads the reducer's fresh state: a caller that computed an
  // append index from a render-time closure would place every same-tick insert at the same
  // stale position. The block (id and all) is still minted by the caller to stay pure.
  | { kind: "insertBlock"; block: AdminBlock; index?: number }
  // Replay the top inverse to undo the last accepted structural op.
  | { kind: "undo" }
  // Replay the top entry of the redo stack, putting back the step undo took away (#1035).
  | { kind: "redo" }
  // Edit one block's data payload. This changes no structure (id, type, order, or count),
  // so it cannot affect section validity and does not run through `applyEditorOp` or enter
  // the undo stack.
  | { kind: "setData"; id: string; data: Record<string, unknown>; discrete?: boolean }
  | { kind: "setHomeText"; id: string; field: HomeTextField; value: string }
  // Toggle one block's visibility (ADR 0013 envelope field). Like setData this changes no
  // structure, so it cannot affect section validity, does not run through `applyEditorOp`,
  // and does not enter the undo stack. The renderer never consults `visible`; the page
  // assembler filters on it, and the editor shows every block with its visibility control.
  | { kind: "setLiveBlogSidebar"; id: string; sidebar: boolean }
  | { kind: "setVisible"; id: string; visible: boolean; homeSection?: boolean }
  | { kind: "replaceBlock"; id: string; type: BlockType; data: Record<string, unknown> }
  // Reconcile the server's canonical ids onto the live list after a save (#515). The server
  // owns each block's id and returns them for the blocks the save sent; `idMap` maps each
  // sent block's id to its canonical one. Every live block whose id is in the map takes the
  // canonical id, keeping its data. Because it maps rather than replaces, blocks the user
  // added while the save was in flight (not in the map) keep their temporary ids and are
  // minted on the next save, so an in-flight edit is never discarded. The undo stack is
  // preserved and remapped onto the canonical ids, not reset: a block added while the save
  // was in flight keeps its undo entry (its temp id is not in the map, so its inverse is
  // left untouched), and remapping the ids the server did mint keeps every inverse
  // replayable, so undo never targets a temporary id the reconcile just replaced.
  | { kind: "reconcileIds"; idMap: Record<string, string>; savedBlocks?: readonly AdminBlock[] }
  | { kind: "clearError" };

const COLLECTION_FIELD_BY_TYPE: Partial<Record<AdminBlock["type"], string>> = {
  image_gallery: "images",
  card_grid: "cards",
  promotion_playlist: "cards",
};

function normalizeLoadedCollectionItems(block: AdminBlock): AdminBlock {
  const field = COLLECTION_FIELD_BY_TYPE[block.type];
  if (!field || !Array.isArray(block.data[field])) return block;
  let sequence = 0;
  const items = reconcileCollectionItemIds([], block.data[field] as unknown[], () => {
    sequence += 1;
    return `collection-item:${block.id}:${field}:${sequence}`;
  });
  return items === block.data[field]
    ? block
    : { ...block, data: { ...block.data, [field]: items } };
}

function reconcileEditedCollectionItems(
  block: AdminBlock,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const field = COLLECTION_FIELD_BY_TYPE[block.type];
  if (!field || !Array.isArray(data[field])) return data;
  const previous = Array.isArray(block.data[field]) ? block.data[field] : [];
  const items = reconcileCollectionItemIds(
    previous as unknown[],
    data[field] as unknown[],
    mintCollectionItemId,
  );
  return items === data[field] ? data : { ...data, [field]: items };
}

function normalizeLoadedHeadlineLevel(block: AdminBlock): AdminBlock {
  if (block.type !== "headline") return block;
  const level = block.data.level;
  // The model accepts any finite numeric level, while the renderer deliberately maps
  // out-of-range values into 1..6 and fractional values to heading 2. Normalize exactly
  // that accepted numeric drift when it enters the editor so the value Save sends matches
  // the value the control and preview show. Leave absent and type-invalid values alone:
  // absence is the valid heading-2 default, and parseBlocks must still refuse strings,
  // NaN, or infinities instead of this boundary concealing corrupt data.
  if (typeof level !== "number" || !Number.isFinite(level)) return block;
  const normalized = clampHeadingLevel(level);
  return normalized === level
    ? block
    : { ...block, data: { ...block.data, level: normalized } };
}

export function normalizeLoadedEditorBlocks(blocks: AdminBlock[]): AdminBlock[] {
  let changed = false;
  const normalized = blocks.map((block, index) => {
    const collectionNormalized = normalizeLoadedCollectionItems(block);
    const headlineNormalized = normalizeLoadedHeadlineLevel(collectionNormalized);
    // The array is the editor's visible order. Repair a stale, duplicate, or reversed stored
    // order before any data-only edit can round-trip it back to Firestore (#506).
    const next =
      headlineNormalized.order === index
        ? headlineNormalized
        : { ...headlineNormalized, order: index };
    if (next !== block) changed = true;
    return next;
  });
  // Preserve the seed array when every block and position are already canonical. The editor
  // uses this identity as its initial clean baseline, so opening a valid page must not look
  // like an edit.
  return changed ? normalized : blocks;
}

export function initialBlockEditorState(blocks: AdminBlock[] = []): BlockEditorState {
  return {
    blocks: normalizeLoadedEditorBlocks(blocks),
    undo: [],
    redo: [],
    coalesce: null,
    error: null,
  };
}

// Apply one history entry to a block list and hand back the entry that reverses it. Undo and redo
// are the same operation pointed at different stacks, so they share this: whatever undo replays,
// the returned inverse is what redo replays to put it back, and vice versa. Keeping one
// implementation is what makes the two directions provably symmetric rather than two hand-written
// reducers that drift.
function applyHistoryEntry(
  section: SectionId,
  blocks: AdminBlock[],
  entry: UndoEntry<AdminBlock>,
): { blocks: AdminBlock[]; inverse: UndoEntry<AdminBlock> } | { error: string } {
  if (entry.kind === "restoreStructure") {
    try {
      const result = restoreContentStructure(section, blocks, entry.structure);
      return { blocks: result.blocks, inverse: { kind: "restoreStructure", structure: result.inverse } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The layout could not be restored." };
    }
  }
  if (entry.kind === "restoreHomeText") {
    const target = blocks.find(block => block.id === entry.id);
    const result = target ? replaceHomeText(target, entry.field, entry.value) : null;
    if (!result) return { error: "The Home text field is no longer available." };
    return {
      blocks: blocks.map(block => block.id === entry.id ? result.block : block),
      inverse: { ...entry, value: result.previous },
    };
  }
  if (entry.kind === "restoreData") {
    // Capture the values this restore is about to replace, so the opposite direction can put them
    // back. Only the keys the entry names are captured, which is the same narrow scope the entry
    // itself carries: a rich-text field edited since is neither restored nor recorded.
    const target = blocks.find((block) => block.id === entry.id);
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(entry.fields)) fields[key] = target?.data[key];
    const next = blocks.map((block) =>
      block.id === entry.id
        ? {
            ...block,
            data: mergeRestoredFields(block.type, block.data, entry.fields, entry.overlaySafe),
          }
        : block,
    );
    return {
      blocks: next,
      inverse: { kind: "restoreData", id: entry.id, fields, overlaySafe: entry.overlaySafe },
    };
  }
  if (entry.kind === "restoreLiveBlogSidebar") {
    const target = blocks.find(block => block.id === entry.id);
    if (!target || !canPlaceInLiveBlogSidebar(target)) return { error: "That sidebar destination is no longer available." };
    const { section: _section, ...rest } = target;
    const restored = entry.sidebar ? { ...rest, section: LIVE_BLOG_SIDEBAR } : rest;
    return {
      blocks: blocks.map(block => block.id === entry.id ? restored : block),
      inverse: { ...entry, sidebar: target.section === LIVE_BLOG_SIDEBAR },
    };
  }
  if (entry.kind === "restoreVisible") {
    const target = blocks.find((block) => block.id === entry.id);
    const next = blocks.map((block) =>
      (entry.ids ?? [entry.id]).includes(block.id) ? { ...block, visible: entry.visible } : block,
    );
    return {
      blocks: next,
      inverse: {
        kind: "restoreVisible",
        id: entry.id,
        visible: target ? target.visible : !entry.visible,
        ...(entry.ids ? { ids: entry.ids } : {}),
      },
    };
  }
  if (entry.kind === "restoreBlock") {
    const target = blocks.find((block) => block.id === entry.block.id);
    if (!target) return { error: "That content is no longer on the page." };
    const next = blocks.map((block) => (block.id === entry.block.id ? entry.block : block));
    const invalid = validateSection(section, next);
    if (invalid) return { error: invalid.reason };
    return {
      blocks: next,
      inverse: { kind: "restoreBlock", block: target },
    };
  }
  const result = applyEditorOp(section, blocks, entry);
  // An inverse is an op the reducer once accepted in reverse, so it should always apply; if a
  // corrupt list makes it fail, surface the reason and keep the stack rather than dropping the
  // inverse on the floor.
  if ("error" in result) return { error: result.error.reason };
  return { blocks: result.blocks, inverse: result.inverse };
}

// Run one structural op through the decision core and fold the result into state. A
// rejected op leaves the list exactly as it was and surfaces its reason; the bad state
// never lands. An accepted op replaces the list and pushes the inverse for undo.
function applyOp(
  section: SectionId,
  state: BlockEditorState,
  op: EditorOp<AdminBlock>,
): BlockEditorState {
  if (state.blocks.some(block => block.type === "row" || block.layout) || (op.kind === "insert" && op.block.type === "row")) {
    if (op.kind === "remove") return applyRowEdit(section, state, op);
    const target = op.kind === "move" ? state.blocks.find(block => block.id === op.id) : null;
    const remaining = op.kind === "move" ? state.blocks.filter(block => block.id !== op.id && !(target?.type === "row" && block.layout?.rowId === op.id)) : state.blocks;
    const index = op.kind === "insert" ? op.index : op.toIndex;
    const before = remaining[Math.max(0, Math.min(Math.trunc(index), remaining.length))];
    const destination = target?.type === "row"
      ? { beforeId: before?.layout?.rowId ?? before?.id }
      : { beforeId: before?.id, layout: op.kind === "insert" ? op.block.layout ?? before?.layout : before?.layout };
    return applyRowEdit(section, state, op.kind === "insert"
      ? { kind: "insert", block: op.block, destination }
      : { kind: "move", id: op.id, destination });
  }
  const result = applyEditorOp(section, state.blocks, op);
  if ("error" in result) return { ...state, error: result.error.reason };
  // A structural op ends any plain-field typing session: the next field edit starts its own entry.
  // It also ends the redo branch: the history now continues from here, so the steps undo had set
  // aside can no longer be replayed onto this list (#1035).
  return {
    blocks: result.blocks,
    undo: [...state.undo, result.inverse],
    redo: [],
    coalesce: null,
    error: null,
  };
}

function applyRowEdit(section: SectionId, state: BlockEditorState, edit: ContentRowEdit): BlockEditorState {
  try {
    const result = editContentRows(section, state.blocks, edit);
    if (result.blocks === state.blocks) return { ...state, error: null };
    return { ...state, blocks: result.blocks, undo: [...state.undo, { kind: "restoreStructure", structure: result.inverse }], redo: [], coalesce: null, error: null };
  } catch (error) {
    return { ...state, error: error instanceof Error ? error.message : "The layout could not be changed." };
  }
}

function pushHistory(
  state: BlockEditorState,
  blocks: AdminBlock[],
  entry: UndoEntry<AdminBlock>,
  coalesce: string | null,
): BlockEditorState {
  return {
    ...state,
    blocks,
    undo: [...state.undo, entry],
    redo: [],
    coalesce,
  };
}

// Remap the ids an inverse op references onto the server's canonical ids, so the undo stack
// stays replayable after a save reconciles them (#515). An inverse that names a block the
// server just re-minted must point at the canonical id, or replaying it would target a block
// that no longer carries that id. An op naming an id the server did not mint (a block added
// after the save was submitted, minted on the next save) is left untouched.
function reconcileNoticeData(data: Record<string, unknown>, savedData?: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(data.documents) || !Array.isArray(savedData?.documents)) return data;
  const dates = new Map(savedData.documents.filter(item => item && typeof item === "object" && isNoticeAddedAt(item.addedAt))
    .map(item => [item.itemId, item.addedAt]));
  let changed = false;
  const documents = data.documents.map(item => {
    const addedAt = item && typeof item === "object" ? dates.get(item.itemId) : undefined;
    if (!addedAt || item.addedAt === addedAt) return item;
    changed = true;
    return { ...item, addedAt };
  });
  return changed ? { ...data, documents } : data;
}

export function reconcileBlockId(block: AdminBlock, idMap: Record<string, string>, savedBlocks?: readonly AdminBlock[]): AdminBlock {
  const id = ownCanonicalId(idMap, block.id) ?? block.id;
  const rowId = block.layout ? ownCanonicalId(idMap, block.layout.rowId) : undefined;
  // Only server-owned first-added dates are adopted. Titles, files, new entries,
  // and edits made while the request was in flight stay in the live draft.
  const data = block.type === "document_list" ? reconcileNoticeData(block.data,
    savedBlocks?.find(saved => saved.id === id && saved.type === "document_list")?.data) : block.data;
  if (id === block.id && rowId === undefined && data === block.data) return block;
  return { ...block, id, data, ...(rowId ? { layout: { ...block.layout!, rowId } } : {}) };
}

function reconcileOpId(
  op: EditorOp<AdminBlock>,
  idMap: Record<string, string>,
  savedBlocks?: readonly AdminBlock[],
): EditorOp<AdminBlock> {
  if (op.kind === "insert") {
    const block = reconcileBlockId(op.block, idMap, savedBlocks);
    return block === op.block ? op : { ...op, block };
  }
  const canonicalId = ownCanonicalId(idMap, op.id);
  return canonicalId ? { ...op, id: canonicalId } : op;
}

function ownCanonicalId(
  idMap: Record<string, string>,
  clientId: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(idMap, clientId)) return undefined;
  const canonicalId: unknown = idMap[clientId];
  return typeof canonicalId === "string" && canonicalId.length > 0
    ? canonicalId
    : undefined;
}

// Remap the id an undo entry references onto the server's canonical id (#515). A field-restore or
// visibility-restore entry names its block by id, exactly like a structural op, so it must follow
// the reconcile or a later undo would target a block that no longer carries the temporary id.
function reconcileEntryId(
  entry: UndoEntry<AdminBlock>,
  idMap: Record<string, string>,
  savedBlocks?: readonly AdminBlock[],
): UndoEntry<AdminBlock> {
  if (entry.kind === "restoreStructure") {
    return { ...entry, structure: entry.structure.map(item => ({
      ...item,
      id: ownCanonicalId(idMap, item.id) ?? item.id,
      ...(item.layout ? { layout: { ...item.layout, rowId: ownCanonicalId(idMap, item.layout.rowId) ?? item.layout.rowId } } : {}),
      ...(item.removed ? { removed: reconcileBlockId(item.removed, idMap, savedBlocks) } : {}),
    })) };
  }
  if (entry.kind === "restoreData" || entry.kind === "restoreVisible" || entry.kind === "restoreHomeText" || entry.kind === "restoreLiveBlogSidebar") {
    const canonicalId = ownCanonicalId(idMap, entry.id);
    if (entry.kind === "restoreData") {
      const id = canonicalId ?? entry.id;
      return { ...entry, id, fields: reconcileNoticeData(entry.fields,
        savedBlocks?.find(saved => saved.id === id && saved.type === "document_list")?.data) };
    }
    return { ...entry, id: ownCanonicalId(idMap, entry.id) ?? entry.id,
      ...(entry.kind === "restoreVisible" && entry.ids ? { ids: entry.ids.map(id => ownCanonicalId(idMap, id) ?? id) } : {}),
    };
  }
  if (entry.kind === "restoreBlock") {
    return { ...entry, block: reconcileBlockId(entry.block, idMap, savedBlocks) };
  }
  return reconcileOpId(entry, idMap, savedBlocks);
}

// Reduce one action against the state for a fixed section. Section is curried in (not part
// of the action) because it is fixed for an editor instance and every op is gated on it.
export function blockEditorReducer(
  section: SectionId,
  state: BlockEditorState,
  action: BlockEditorAction,
): BlockEditorState {
  switch (action.kind) {
    case "editRows":
      return applyRowEdit(section, state, action.edit);
    case "apply":
      return applyOp(section, state, action.op);
    case "insertBlock": {
      // Resolve the append index against fresh state, then reuse the same op path.
      const index = action.index ?? state.blocks.length;
      return applyOp(section, state, { kind: "insert", block: action.block, index });
    }
    // Undo and redo are one operation over two stacks: each pops its own top entry, applies it,
    // and pushes the entry that reverses it onto the other stack. A field-restore or
    // visibility-restore entry carries the value the edit replaced, so applying it just writes
    // that back; a block since removed simply matches nothing. Either direction ends a typing
    // session. A rich-text field edited since an entry was recorded keeps its newer value in both
    // directions, because mergeRestoredFields reads the live values rather than a snapshot (#582).
    case "undo": {
      const entry = state.undo[state.undo.length - 1];
      if (!entry) return state;
      const result = applyHistoryEntry(section, state.blocks, entry);
      if ("error" in result) return { ...state, error: result.error };
      return {
        blocks: result.blocks,
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, result.inverse],
        coalesce: null,
        error: null,
      };
    }
    case "redo": {
      const entry = state.redo[state.redo.length - 1];
      if (!entry) return state;
      const result = applyHistoryEntry(section, state.blocks, entry);
      if ("error" in result) return { ...state, error: result.error };
      return {
        blocks: result.blocks,
        undo: [...state.undo, result.inverse],
        redo: state.redo.slice(0, -1),
        coalesce: null,
        error: null,
      };
    }
    case "setHomeText": {
      const result = applyHistoryEntry(section, state.blocks, { ...action, kind: "restoreHomeText" });
      if ("error" in result) return { ...state, error: result.error };
      if (result.inverse.kind === "restoreHomeText" && result.inverse.value === action.value) return state;
      const key = `${action.id}:home-text:${action.field}`;
      if (key === state.coalesce && state.undo.length > 0) return { ...state, blocks: result.blocks, redo: [], error: null };
      return pushHistory(state, result.blocks, result.inverse, key);
    }
    case "setData": {
    const target = state.blocks.find((block) => block.id === action.id);
    if (!target || recordsEqual(target.data, action.data)) return state;
    const nextData = reconcileEditedCollectionItems(target, action.data);
    const blocks = state.blocks.map((block) =>
      block.id === action.id ? { ...block, data: nextData } : block,
    );
    const changed = changedPlainFields(target.type, target.data, nextData);
    if (changed.length === 0) {
      const redo = pruneRedoAfterRichTextEdit(state.redo, action.id, target.type);
      return {
        ...state,
        blocks,
        redo,
        coalesce: null,
      };
    }
    const key = action.discrete ? null : coalesceKey(target.type, action.id, target.data, nextData, changed);
    if (key && key === state.coalesce && state.undo.length > 0) {
      return { ...state, blocks, redo: [], coalesce: key };
    }
    const fields = Object.fromEntries(
      changed.map((field) => [field, target.data[field]]),
    );
    const overlaySafe = overlaySafeFields(
      target.type,
      target.data,
      nextData,
      changed,
    );
    return pushHistory(
      state,
      blocks,
      {
        kind: "restoreData",
        id: action.id,
        fields,
        overlaySafe,
      },
      key,
    );
  }
    case "replaceBlock": {
      const target = state.blocks.find((block) => block.id === action.id);
      if (!target) return state;
      if (target.type === action.type && recordsEqual(target.data, action.data)) return state;
      if (!canPlaceBlock(section, action.type)) {
        return {
          ...state,
          error: `the ${BLOCK_LABELS[action.type]} block cannot be added to ${SECTION_LABELS[section]}`,
        };
      }
      const nextBlock: AdminBlock = { ...target, type: action.type, data: action.data };
      const blocks = state.blocks.map((block) => (block.id === action.id ? nextBlock : block));
      const invalid = validateSection(section, blocks);
      if (invalid) return { ...state, error: invalid.reason };
      return pushHistory(state, blocks, { kind: "restoreBlock", block: target }, null);
    }
    case "setLiveBlogSidebar": {
      const target = state.blocks.find(block => block.id === action.id);
      if (section !== "post" || !target || !canPlaceInLiveBlogSidebar(target)) return state;
      if ((target.section === LIVE_BLOG_SIDEBAR) === action.sidebar) return state;
      const { section: _section, ...rest } = target;
      const next = action.sidebar ? { ...rest, section: LIVE_BLOG_SIDEBAR } : rest;
      return pushHistory(state, state.blocks.map(block => block.id === target.id ? next : block),
        { kind: "restoreLiveBlogSidebar", id: target.id, sidebar: target.section === LIVE_BLOG_SIDEBAR }, null);
    }
    case "setVisible": {
      const target = state.blocks.find((block) => block.id === action.id);
      // No such block, or no actual change: leave the list and (ending any session) the coalesce
      // key untouched. Returning the same state when nothing changes keeps a keyed render steady.
      if (!target) return state;
      if (target.visible === action.visible) {
        return state.coalesce === null ? state : { ...state, coalesce: null };
      }
      const ids = action.homeSection ? homeSectionMemberIds(state.blocks, action.id) : [action.id];
      const blocks = state.blocks.map((block) =>
        ids.includes(block.id) ? { ...block, visible: action.visible } : block,
      );
      return {
        ...state,
        blocks,
        undo: [...state.undo, { kind: "restoreVisible", id: action.id, visible: target.visible, ...(action.homeSection ? { ids } : {}) }],
        redo: [],
        coalesce: null,
      };
    }
    case "reconcileIds": {
      const idMap = action.idMap;
      const blocks = state.blocks.map(block => reconcileBlockId(block, idMap, action.savedBlocks));
      // Preserve the undo stack, remapped onto the canonical ids, rather than clearing it:
      // an edit made while the save was in flight keeps its undo entry, and every inverse
      // stays replayable because the ids the server minted are remapped in lockstep. A save is a
      // commit point, so it also ends any open typing session.
      const undo = state.undo.map((entry) => reconcileEntryId(entry, idMap, action.savedBlocks));
      // The redo stack names the same blocks and must follow the same remap, or a redo after a
      // save would target a temporary id the reconcile just replaced (#1035, #515).
      const redo = state.redo.map((entry) => reconcileEntryId(entry, idMap, action.savedBlocks));
      return { blocks, undo, redo, coalesce: null, error: null };
    }
    case "clearError":
      return state.error === null ? state : { ...state, error: null };
  }
}


