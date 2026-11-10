import { MAX_BULK_VIDEOS } from "./source-media-bulk";

// One selection model for the images and video libraries. A selection is per person and per surface. It survives paging, sorting and
// filtering and is lost on reload; the caller keeps it in React state and scopes it.
// These rules come from useSourceMediaBulkEditing.changeSelection and MediaRoute's
// setAssetsSelected, so both surfaces behave the same. Nothing here reads unloaded
// results: every change names the loaded items it adds or removes.

export interface SelectableMedia {
  id: string;
}

export interface MediaSelection<T extends SelectableMedia> {
  /** The selected items in the order they were added. */
  items: readonly T[];
  /** The last toggled item, used as the start of a Shift range. */
  anchor: string | null;
  /** The last rejected change's message, cleared by the next accepted change. */
  error: string;
}

export interface SelectionCap {
  max: number;
  message: string;
}

export interface SelectionRules<T> {
  /** Rejects the whole change, keeping the previous items, when the result would pass max. */
  cap?: SelectionCap;
  /** Skips candidates this surface does not own, such as a video from another source. */
  accepts?: (item: T) => boolean;
}

/** The video bulk-edit cap, with the message staff already see. */
export const VIDEO_SELECTION_CAP: SelectionCap = Object.freeze({
  max: MAX_BULK_VIDEOS,
  message: `Select no more than ${MAX_BULK_VIDEOS} videos in one batch. No additional videos were selected.`,
});

/** One collection change takes at most this many items, for images and video. */
export const COLLECTION_CHANGE_LIMIT = 30;

export type PageSelectionState = "none" | "some" | "all";

export function emptySelection<T extends SelectableMedia>(): MediaSelection<T> {
  return { items: [], anchor: null, error: "" };
}

export function clearSelection<T extends SelectableMedia>(): MediaSelection<T> {
  return emptySelection<T>();
}

/**
 * Adds or removes the candidates in one step. A change that would pass the cap is
 * rejected whole: the previous items stay, and the cap message is set.
 */
export function changeSelection<T extends SelectableMedia>(
  selection: MediaSelection<T>,
  candidates: readonly T[],
  checked: boolean,
  rules: SelectionRules<T> = {},
): MediaSelection<T> {
  const map = new Map(selection.items.map((item) => [item.id, item]));
  for (const item of candidates) {
    if (rules.accepts && !rules.accepts(item)) continue;
    if (checked) map.set(item.id, item);
    else map.delete(item.id);
  }
  if (rules.cap && map.size > rules.cap.max) return { ...selection, error: rules.cap.message };
  return { items: [...map.values()], anchor: selection.anchor, error: "" };
}

/** Flips one item and makes it the anchor. Off-page items stay selected. */
export function toggleSelection<T extends SelectableMedia>(
  selection: MediaSelection<T>,
  item: T,
  rules: SelectionRules<T> = {},
): MediaSelection<T> {
  const checked = !selection.items.some((entry) => entry.id === item.id);
  return { ...changeSelection(selection, [item], checked, rules), anchor: item.id };
}

/**
 * A Shift range from the anchor to the target, within the visible page only. With no
 * anchor on this page, only the target changes. The target becomes the new anchor.
 */
export function selectRange<T extends SelectableMedia>(
  selection: MediaSelection<T>,
  visible: readonly T[],
  targetId: string,
  checked: boolean,
  rules: SelectionRules<T> = {},
): MediaSelection<T> {
  const end = visible.findIndex((item) => item.id === targetId);
  if (end < 0) return selection;
  const start = selection.anchor === null ? -1 : visible.findIndex((item) => item.id === selection.anchor);
  const range = start >= 0 ? visible.slice(Math.min(start, end), Math.max(start, end) + 1) : [visible[end]];
  return { ...changeSelection(selection, range, checked, rules), anchor: targetId };
}

/** Selects or deselects every loaded item on the visible page (Cmd or Ctrl+A, "Select this page"). */
export function setPageSelection<T extends SelectableMedia>(
  selection: MediaSelection<T>,
  visible: readonly T[],
  checked: boolean,
  rules: SelectionRules<T> = {},
): MediaSelection<T> {
  return changeSelection(selection, visible, checked, rules);
}

/**
 * Replaces selected copies with fresher loaded records. Returns the same object when
 * nothing changed, so React state does not update for no reason.
 */
export function refreshSelected<T extends SelectableMedia>(
  selection: MediaSelection<T>,
  records: readonly T[],
  same: (selected: T, record: T) => boolean = (selected, record) => selected.id === record.id,
): MediaSelection<T> {
  if (!selection.items.length) return selection;
  const items = selection.items.map((item) => records.find((record) => same(item, record)) ?? item);
  return items.every((item, index) => item === selection.items[index]) ? selection : { ...selection, items };
}

/** Drops one item, such as a deleted video, and keeps the rest. */
export function removeSelected<T extends SelectableMedia>(selection: MediaSelection<T>, id: string): MediaSelection<T> {
  return { ...selection, items: selection.items.filter((item) => item.id !== id) };
}

/** How many selected items are not on the visible page. */
export function offPageCount(items: readonly SelectableMedia[], visible: readonly SelectableMedia[]): number {
  const onPage = new Set(visible.map((item) => item.id));
  return items.filter((item) => !onPage.has(item.id)).length;
}

/** The page checkbox's tri-state: none, some or all of the visible page. */
export function pageSelectionState(items: readonly SelectableMedia[], visible: readonly SelectableMedia[]): PageSelectionState {
  const selected = new Set(items.map((item) => item.id));
  const count = visible.filter((item) => selected.has(item.id)).length;
  if (count === 0) return "none";
  return count === visible.length ? "all" : "some";
}

/** The existing collection-limit message once a selection passes 30, else null. */
export function collectionCapError(count: number, noun: "items" | "videos"): string | null {
  return count > COLLECTION_CHANGE_LIMIT
    ? `Select no more than ${COLLECTION_CHANGE_LIMIT} ${noun} for one collection change.`
    : null;
}

/** The bar's count: "5 selected", "7 of 100 selected · 3 not on this page". */
export function selectionSummary({ count, offPage, cap }: { count: number; offPage: number; cap?: number }): string {
  const base = cap === undefined ? `${count} selected` : `${count} of ${cap} selected`;
  return offPage > 0 ? `${base} · ${offPage} not on this page` : base;
}
