// What a destructive editing action is about to take away, in words an editor recognizes (#1035).
//
// Removal needs both recovery and a clear description. A question or a notice that says
// "Remove block?" leaves
// the person to work out which block, and a notice that says "Removed." leaves them to work out
// what they just lost. Everything here answers that -- the block's type, its position, its own
// title, and a count of what it holds; an image's alt text or caption; a button's label.
//
// Pure functions over the block value, so the wording is unit-tested rather than read off a
// rendered dialog, and one phrasing serves the confirmation, the undo notice, and the accessible
// names of both.

import {
  BLOCK_LABELS,
  editorFieldsForBlock,
  type EditorField,
} from "../../../packages/content-core/src/editor-admin";
import {
  isRichTextDoc,
  richTextIsEmpty,
} from "../../../packages/content-core/src/content-model";
import type { AdminBlock } from "./block-factory";

// A title longer than this is cut, because the question ("Remove heading 2 “…”?") has to stay
// readable as a question. The cut point is generous enough that two similar headings still read
// as different ones.
const TITLE_LIMIT = 48;

// The data keys that can carry a block's own title, in the order they are preferred. A headline's
// text, an FAQ's question, and a shelf's heading each name the block on the page; a caption names
// an image or an embed when nothing better is there.
const TITLE_KEYS = ["text", "question", "title", "caption"] as const;

// Whether this block holds anything a person would be sorry to lose. Text is populated when it is
// more than whitespace, a rich-text body when its document is not empty, and a list when it holds
// at least one item -- an added-but-unfilled gallery slot is still a placement the editor made, so
// removing the block takes work away. Toggles, numbers, and finite selects are settings rather
// than content: a chosen heading level or a decorative mark alone does not make a removal
// destructive, and treating it as content would put a question in front of tidying up an empty
// block that was inserted by mistake.
export function blockIsPopulated(block: AdminBlock): boolean {
  if (block.type === "election_results") return Array.isArray(block.data.races) && block.data.races.length > 0;
  return editorFieldsForBlock(block.type).some((field) =>
    fieldIsPopulated(field, block.data[field.key]),
  );
}

function fieldIsPopulated(field: EditorField, value: unknown): boolean {
  switch (field.kind) {
    case "toggle":
    case "select":
      return false;
    case "richText":
      return isRichTextDoc(value) ? !richTextIsEmpty(value) : false;
    case "list":
    case "recordList":
    case "storyCredits":
      return Array.isArray(value) && value.length > 0;
    default:
      return typeof value === "string" ? value.trim().length > 0 : false;
  }
}

// The block's own title, trimmed and cut to length, or null when it has none. Used to tell two
// blocks of the same type apart in a question that would otherwise read "Remove heading 2?" for
// every heading on the page.
export function blockTitle(block: AdminBlock): string | null {
  for (const key of TITLE_KEYS) {
    const value = block.data[key];
    if (typeof value !== "string") continue;
    const text = value.trim().replace(/\s+/g, " ");
    if (text.length === 0) continue;
    return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT).trimEnd()}…` : text;
  }
  return null;
}

// How the editor names this block: its type and its position, plus its title when it has one.
// "heading 2 “Tonight on NJ PBS”". The type and position match the block card's own controls, so
// the words in the question are the words on screen.
export function blockDisplayName(block: AdminBlock, position: number): string {
  const base = `${BLOCK_LABELS[block.type]} ${position}`;
  const title = blockTitle(block);
  return title ? `${base} ${quoted(title)}` : base;
}

export interface RemovalPrompt {
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
}

// The confirmation for removing a populated block: what it is, what it holds, and that the removal
// is recoverable both immediately and after a save. Naming the recovery in the question is part of
// the contract -- a person who knows the change can be taken back answers the question they
// actually mean rather than the safest one.
export function blockRemovalPrompt(block: AdminBlock, position: number): RemovalPrompt {
  const label = BLOCK_LABELS[block.type];
  return {
    title: `Remove ${blockDisplayName(block, position)}?`,
    detail: `${blockContentSummary(block)} Undo takes the removal back, and a removal you have already saved can still be recovered from revision history.`.trim(),
    confirmLabel: `Confirm removal of ${label} ${position}`,
    cancelLabel: `Cancel removal of ${label} ${position}`,
  };
}

// A sentence naming what the block holds, counted where it can be counted, so nothing is removed
// unseen. A gallery says how many images; a card set how many cards; anything else names its own
// filled-in fields in the editor's words rather than quoting a whole body into a dialog.
export function blockContentSummary(block: AdminBlock): string {
  const counts: string[] = [];
  const fields: string[] = [];
  for (const field of editorFieldsForBlock(block.type)) {
    const value = block.data[field.key];
    if (!fieldIsPopulated(field, value)) continue;
    if (field.kind === "list" || field.kind === "recordList" || field.kind === "storyCredits") {
      const count = (value as unknown[]).length;
      counts.push(`${count} ${countNoun(field.label, count)}`);
      continue;
    }
    fields.push(field.label.toLowerCase());
  }
  // One possessive covers the whole list of named fields ("its image, alt text, and caption")
  // rather than repeating "its" per field, which is what makes this read as a sentence somebody
  // wrote instead of a serialized descriptor list.
  const parts = fields.length > 0 ? [...counts, `its ${joinParts(fields)}`] : counts;
  if (parts.length === 0) return "";
  return `Removing it takes away ${joinParts(parts)}.`;
}

// A list field's label as a counted noun: "Images" reads as "3 images" and "1 image". Derived from
// the descriptor's own label so a new list block gets the right word with no second list to keep
// in step.
function countNoun(label: string, count: number): string {
  const noun = label.toLowerCase();
  if (count === 1 && noun.endsWith("s")) return noun.slice(0, -1);
  return noun;
}

function joinParts(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// The notice shown after a block is removed. Same name as the question used, so the confirmation
// and the way back describe one action rather than two.
export function removedBlockNotice(block: AdminBlock, position: number): string {
  return `Removed ${blockDisplayName(block, position)}.`;
}

export function removedItemNotice(itemName: string): string {
  return `Removed ${itemName}.`;
}

// How a gallery image is named when it is removed: its alt text, or its caption when the image is
// marked decorative and carries none, falling back to the position alone for an image that has
// neither. Position leads either way, because that is what the item's own controls are labeled by.
export function galleryImageName(
  image: { alt?: string; caption?: string },
  position: number,
): string {
  const name = firstText(image.alt, image.caption);
  return name ? `image ${position} ${quoted(name)}` : `image ${position}`;
}

// How a button or a card is named when it is removed: the label or title the editor typed, or the
// position alone for an item still empty.
export function listItemName(
  noun: string,
  item: { label?: unknown; title?: unknown },
  position: number,
): string {
  const name = firstText(
    typeof item.label === "string" ? item.label : undefined,
    typeof item.title === "string" ? item.title : undefined,
  );
  return name ? `${noun} ${position} ${quoted(name)}` : `${noun} ${position}`;
}

// How a chosen media asset is named when it is cleared out of an image field. The resolved asset
// name is the thing the person sees in the picker; without it (media access unavailable, or the
// asset not yet resolved) the notice still says an image went.
export function removedAssetName(assetName: string | null | undefined): string {
  const name = firstText(assetName ?? undefined);
  return name ? `image ${quoted(name)}` : "the chosen image";
}

function firstText(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim().replace(/\s+/g, " ");
    if (text.length === 0) continue;
    return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT).trimEnd()}…` : text;
  }
  return null;
}

function quoted(text: string): string {
  return `“${text}”`;
}
