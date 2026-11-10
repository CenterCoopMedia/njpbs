import { describe, expect, it } from "vitest";
import type { MediaAssetSummary } from "../src/lib/functions";
import {
  SORT_OPTIONS,
  appliedFilterCount,
  applyFilterDraft,
  categoryOptions,
  chooseTag,
  clearCollectionsFilterChips,
  clearFavoritesFilterChips,
  clearFilterChips,
  clearVideoFilterChips,
  collectionsFilterChips,
  favoritesFilterChips,
  filterChips,
  focusAfterChipRemoval,
  headingSort,
  headingSortField,
  pageTags,
  removeFilterChip,
  resultStatus,
  selectionAnnouncement,
  setVideoStructuredFilter,
  sortDirectionLabel,
  sortDirections,
  toggleValue,
  videoFilterChips,
} from "../src/lib/media-filters";
import {
  DEFAULT_MEDIA_QUERY,
  DEFAULT_VIDEO_MEDIA_QUERY,
  type CollectionsMediaLocationState,
  type FavoritesMediaLocationState,
  type MediaLocationState,
  type VideoMediaLocationState,
} from "../src/lib/media-query";

const label = (id: string) => ({ news: "News", programs: "Programs" })[id] ?? id;

function state(overrides: Partial<MediaLocationState["query"]> = {}, extra: Partial<MediaLocationState> = {}): MediaLocationState {
  return {
    query: { ...DEFAULT_MEDIA_QUERY, q: "studio", sort: "name", direction: "asc", page: 3, kinds: ["document", "image"], categories: ["programs", "news"], ...overrides },
    selectedId: "a1",
    view: "recent",
    ...extra,
  };
}

function tagged(tags: string[]): MediaAssetSummary {
  return { tags } as MediaAssetSummary;
}

describe("media filter rules", () => {
  it("keeps today's sort options and toggle helper", () => {
    expect(SORT_OPTIONS.map((option) => option.label)).toEqual(["Last updated", "Created", "Name", "File size"]);
    expect(toggleValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleValue(["a", "b"], "a")).toEqual(["b"]);
  });

  it("builds one chip per applied kind, then per category, in URL order with registry labels", () => {
    expect(filterChips(state().query, label).map((chip) => chip.label)).toEqual([
      "Type: Documents", "Type: Images", "Category: Programs", "Category: News",
    ]);
  });

  it("removes one chip value and returns to page 1", () => {
    const [first, , third] = filterChips(state().query, label);
    const afterKind = removeFilterChip(state(), first);
    expect(afterKind.query).toMatchObject({ kinds: ["image"], categories: ["programs", "news"], page: 1 });
    expect(removeFilterChip(state(), third).query.categories).toEqual(["news"]);
  });

  it("clears all chips and the search but keeps sort, direction, view and selection", () => {
    const cleared = clearFilterChips(state());
    expect(cleared).toEqual({
      query: { ...DEFAULT_MEDIA_QUERY, sort: "name", direction: "asc" },
      selectedId: "a1",
      view: "recent",
    });
  });

  it("counts applied filters for the Filter badge", () => {
    expect(appliedFilterCount(state().query)).toBe(4);
    expect(appliedFilterCount(DEFAULT_MEDIA_QUERY)).toBe(0);
  });

  it("with a result, offers counted categories plus selected ones, sorted by id", () => {
    expect(categoryOptions({ categoryCounts: { programs: 2, arts: 1 } }, ["zoo", "news"])).toEqual(["arts", "news", "programs", "zoo"]);
  });

  it("with no result, offers the selected categories in URL order", () => {
    expect(categoryOptions(null, ["zoo", "news"])).toEqual(["zoo", "news"]);
  });

  it("applies a filter draft as kinds and categories with page 1, keeping q, sort, direction, view and selection", () => {
    const next = applyFilterDraft(state(), { kinds: ["image"], categories: ["news"] });
    expect(next).toEqual({
      query: { ...state().query, kinds: ["image"], categories: ["news"], page: 1 },
      selectedId: "a1",
      view: "recent",
    });
  });

  it("picks the next remove button, then the previous one, then the Filter button after a removal", () => {
    expect(focusAfterChipRemoval(1, 4)).toEqual({ target: "chip", index: 1 });
    expect(focusAfterChipRemoval(3, 4)).toEqual({ target: "chip", index: 2 });
    expect(focusAfterChipRemoval(0, 1)).toEqual({ target: "filter" });
  });

  it("replaces search text with a chosen tag and resets the page", () => {
    const next = chooseTag(state(), "b-roll");
    expect(next.query).toMatchObject({ q: "b-roll", page: 1, kinds: ["document", "image"], categories: ["programs", "news"] });
  });

  it("collects page tags once each ignoring case, most frequent first, at most 12", () => {
    const records = [tagged(["News", "studio"]), tagged(["news", "night"]), tagged(["Studio", "news"])];
    expect(pageTags(records)).toEqual(["News", "studio", "night"]);
    const many = [tagged(Array.from({ length: 20 }, (_, index) => `tag-${index}`))];
    expect(pageTags(many)).toHaveLength(12);
  });

  it("describes results and hides a filter summary for screen readers", () => {
    expect(resultStatus({ total: 1, keyword: false, page: 1, pageCount: 1 })).toEqual({ text: "1 result", hidden: "" });
    expect(resultStatus({ total: 412, keyword: true, page: 2, pageCount: 14 }).text).toBe("412 keyword results · Page 2 of 14");
    expect(resultStatus({ total: 412, keyword: false, page: 1, pageCount: 14, refreshing: true }).text).toBe("412 results, updating");
    expect(resultStatus({ total: 3, keyword: false, page: 1, pageCount: 1, filterLabels: ["Category: News", "Type: Images"] }).hidden)
      .toBe("Filtered by Category: News, Type: Images. ");
  });

  it("labels directions per field", () => {
    expect([sortDirectionLabel("updatedAt", "desc"), sortDirectionLabel("createdAt", "asc")]).toEqual(["Newest first", "Oldest first"]);
    expect([sortDirectionLabel("name", "asc"), sortDirectionLabel("name", "desc")]).toEqual(["A–Z", "Z–A"]);
    expect([sortDirectionLabel("sizeBytes", "desc"), sortDirectionLabel("sizeBytes", "asc")]).toEqual(["Largest first", "Smallest first"]);
  });

  it("lists the usual direction first: A–Z for names, newest or largest otherwise", () => {
    expect(sortDirections("name")).toEqual(["asc", "desc"]);
    expect(sortDirections("updatedAt")).toEqual(["desc", "asc"]);
    expect(sortDirections("sizeBytes")).toEqual(["desc", "asc"]);
  });

  it("announces N selected, then No items selected after clearing, and nothing before the first selection", () => {
    expect(selectionAnnouncement(0, 0)).toBe("");
    expect(selectionAnnouncement(3, 0)).toBe("3 selected");
    expect(selectionAnnouncement(0, 3)).toBe("No items selected");
  });
});

describe("list heading sort", () => {
  it("sorts only the columns a sort exists for: Name, Size and Updated", () => {
    expect(headingSortField("name")).toBe("name");
    expect(headingSortField("size")).toBe("sizeBytes");
    expect(headingSortField("updated")).toBe("updatedAt");
    for (const column of ["type", "category", "dimensions", "tags"] as const) expect(headingSortField(column)).toBeNull();
  });

  it("a first click uses the field's first direction and a second click on the sorted column reverses it, always on page 1", () => {
    const current = { sort: "updatedAt" as const, direction: "desc" as const };
    expect(headingSort("name", current)).toEqual({ sort: "name", direction: "asc", page: 1 });
    expect(headingSort("size", current)).toEqual({ sort: "sizeBytes", direction: "desc", page: 1 });
    expect(headingSort("updated", current)).toEqual({ sort: "updatedAt", direction: "asc", page: 1 });
    expect(headingSort("updated", { sort: "updatedAt", direction: "asc" })).toEqual({ sort: "updatedAt", direction: "desc", page: 1 });
    expect(headingSort("name", { sort: "name", direction: "asc" })).toEqual({ sort: "name", direction: "desc", page: 1 });
    expect(headingSort("tags", current)).toBeNull();
  });
});

describe("phase 5 surface filter rules", () => {
  const videoState: VideoMediaLocationState = {
    query: { ...DEFAULT_VIDEO_MEDIA_QUERY, q: "news", tag: "Interview", sort: "updated_asc", limit: 48 },
    selectedId: "video-one",
  };

  it("replaces the current video structured property when another is added", () => {
    expect(setVideoStructuredFilter(videoState, { field: "by", value: "staff-one" })).toEqual({
      query: { ...DEFAULT_VIDEO_MEDIA_QUERY, q: "news", by: "staff-one", sort: "updated_asc", limit: 48 },
      selectedId: "video-one",
    });
    expect(setVideoStructuredFilter(videoState, { field: "rights", value: "pending" }).query).toMatchObject({ rights: "pending" });
  });

  it("builds video chips and Clear all removes search and the chip while keeping sort and limit", () => {
    expect(videoFilterChips(videoState)).toEqual([
      { key: "tag:Interview", field: "tag", value: "Interview", label: "Tag: Interview" },
    ]);
    expect(clearVideoFilterChips(videoState)).toEqual({
      query: { ...DEFAULT_VIDEO_MEDIA_QUERY, sort: "updated_asc", limit: 48 },
      selectedId: "video-one",
    });
  });

  it("does not expose an uploader ID when no presented label is available", () => {
    const state = setVideoStructuredFilter(videoState, { field: "by", value: "private-user-id" });
    expect(videoFilterChips(state)[0].label).toBe("Uploader: Staff uploader");
    expect(videoFilterChips(state, () => "Me")[0].label).toBe("Uploader: Me");
  });

  it("marks Favorites kind and Collections scope chips as applying on this page", () => {
    const favorite: FavoritesMediaLocationState = {
      kind: "video",
      selectedRef: { backend: "s3", sourceId: "source-one", id: "same-id" },
    };
    expect(favoritesFilterChips(favorite)).toEqual([
      { key: "kind:video", field: "kind", value: "video", label: "Type: Videos", scopeLabel: "On this page" },
    ]);
    expect(clearFavoritesFilterChips(favorite)).toEqual({ ...favorite, kind: null });

    const collections: CollectionsMediaLocationState = {
      show: "archived",
      scope: "private",
      selectedRef: { backend: "r2", id: "same-id" },
    };
    expect(collectionsFilterChips(collections)).toEqual([
      { key: "show:archived", field: "show", value: "archived", label: "Status: Archived" },
      { key: "scope:private", field: "scope", value: "private", label: "Scope: Private", scopeLabel: "On this page" },
    ]);
    expect(clearCollectionsFilterChips(collections)).toEqual({ ...collections, show: "active", scope: null });
  });
});
