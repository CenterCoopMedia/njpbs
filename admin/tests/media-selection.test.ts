import { describe, expect, it } from "vitest";
import {
  COLLECTION_CHANGE_LIMIT,
  VIDEO_SELECTION_CAP,
  changeSelection,
  clearSelection,
  collectionCapError,
  emptySelection,
  offPageCount,
  pageSelectionState,
  refreshSelected,
  removeSelected,
  selectRange,
  selectionSummary,
  setPageSelection,
  toggleSelection,
  type MediaSelection,
} from "../src/lib/media-selection";

interface Item { id: string; sourceId: string; name: string }
const item = (id: string, sourceId = "s1"): Item => ({ id, sourceId, name: `Name ${id}` });
const page = (ids: string[]) => ids.map((id) => item(id));
const ids = (selection: MediaSelection<Item>) => selection.items.map((entry) => entry.id);
const withItems = (entries: Item[], anchor: string | null = null): MediaSelection<Item> => ({ items: entries, anchor, error: "" });

describe("media selection model", () => {
  it("toggles one item and keeps off-page items", () => {
    const offPage = item("z9");
    const start = withItems([offPage]);
    const on = toggleSelection(start, item("a1"));
    expect(ids(on)).toEqual(["z9", "a1"]);
    expect(on.anchor).toBe("a1");
    const off = toggleSelection(on, item("a1"));
    expect(ids(off)).toEqual(["z9"]);
    expect(off.anchor).toBe("a1");
    expect(start.items).toEqual([offPage]);
  });

  it("selects a shift range only within the visible page", () => {
    const visible = page(["a1", "a2", "a3", "a4", "a5"]);
    const anchored = toggleSelection(emptySelection<Item>(), visible[1]);
    const range = selectRange(anchored, visible, "a4", true);
    expect(ids(range)).toEqual(["a2", "a3", "a4"]);
    expect(range.anchor).toBe("a4");
    const backwards = selectRange(withItems([], "a4"), visible, "a1", true);
    expect(ids(backwards)).toEqual(["a1", "a2", "a3", "a4"]);
    // An anchor from another page (or none) selects only the clicked item.
    expect(ids(selectRange(withItems([], "gone"), visible, "a3", true))).toEqual(["a3"]);
    expect(ids(selectRange(emptySelection<Item>(), visible, "a3", true))).toEqual(["a3"]);
    // Unchecking a range removes it and leaves the rest.
    const all = withItems(visible, "a1");
    expect(ids(selectRange(all, visible, "a3", false))).toEqual(["a4", "a5"]);
  });

  it("select page adds only loaded page items and never unloaded results", () => {
    const visible = page(["a1", "a2", "a3"]);
    const selected = setPageSelection(withItems([item("z9")]), visible, true);
    expect(ids(selected)).toEqual(["z9", "a1", "a2", "a3"]);
    expect(pageSelectionState(selected.items, visible)).toBe("all");
    expect(offPageCount(selected.items, visible)).toBe(1);
    const cleared = setPageSelection(selected, visible, false);
    expect(ids(cleared)).toEqual(["z9"]);
    expect(pageSelectionState(cleared.items, visible)).toBe("none");
    expect(pageSelectionState([visible[0]], visible)).toBe("some");
    expect(pageSelectionState([], [])).toBe("none");
  });

  it("rejects a change that would pass the cap atomically and keeps the previous set", () => {
    const current = withItems(Array.from({ length: 98 }, (_, index) => item(`k${index}`)), "k0");
    const rejected = changeSelection(current, page(["a1", "a2", "a3"]), true, { cap: VIDEO_SELECTION_CAP });
    expect(rejected.items).toBe(current.items);
    expect(rejected.error).toBe("Select no more than 100 videos in one batch. No additional videos were selected.");
    const accepted = changeSelection(rejected, page(["a1", "a2"]), true, { cap: VIDEO_SELECTION_CAP });
    expect(accepted.items).toHaveLength(100);
    expect(accepted.error).toBe("");
    // Items from another source are ignored, as the video hook does today.
    const scoped = changeSelection(emptySelection<Item>(), [item("a1"), item("b1", "s2")], true, { accepts: (entry) => entry.sourceId === "s1" });
    expect(ids(scoped)).toEqual(["a1"]);
    expect(VIDEO_SELECTION_CAP.max).toBe(100);
  });

  it("reports the collection cap at 31", () => {
    expect(COLLECTION_CHANGE_LIMIT).toBe(30);
    expect(collectionCapError(30, "items")).toBeNull();
    expect(collectionCapError(31, "items")).toBe("Select no more than 30 items for one collection change.");
    expect(collectionCapError(31, "videos")).toBe("Select no more than 30 videos for one collection change.");
  });

  it("summarizes as 7 of 100 selected · 3 not on this page and 5 selected", () => {
    expect(selectionSummary({ count: 7, offPage: 3, cap: 100 })).toBe("7 of 100 selected · 3 not on this page");
    expect(selectionSummary({ count: 5, offPage: 0 })).toBe("5 selected");
    expect(selectionSummary({ count: 5, offPage: 2 })).toBe("5 selected · 2 not on this page");
  });

  it("clears to an empty set with no anchor or error", () => {
    expect(clearSelection<Item>()).toEqual({ items: [], anchor: null, error: "" });
  });

  it("refreshes loaded copies in place and removes a deleted item, keeping identity when nothing changed", () => {
    const a1 = item("a1");
    const start = withItems([a1, item("z9")], "a1");
    expect(refreshSelected(start, [item("q1")])).toBe(start);
    const renamed = { ...a1, name: "Renamed" };
    const refreshed = refreshSelected(start, [renamed]);
    expect(refreshed.items[0]).toBe(renamed);
    expect(refreshed.anchor).toBe("a1");
    // A same-id record from another source does not replace the selected copy.
    const otherSource = refreshSelected(start, [{ ...a1, sourceId: "s2", name: "Other" }], (left, right) => left.id === right.id && left.sourceId === right.sourceId);
    expect(otherSource).toBe(start);
    expect(ids(removeSelected(start, "a1"))).toEqual(["z9"]);
  });
});
