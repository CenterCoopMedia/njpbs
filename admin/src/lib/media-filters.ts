import type { ListMediaResponse, MediaAssetSummary, MediaKind, MediaListQuery, MediaSortDirection, MediaSortField } from "./functions";
import type {
  CollectionsMediaLocationState,
  FavoritesMediaLocationState,
  MediaLocationState,
  VideoMediaLocationState,
  VideoRightsFilter,
} from "./media-query";

// Filter, sort, chip and status rules for the images tab. Pure functions over the location state, so the toolbar, chips and result bar
// only compose tested logic.

export const SORT_OPTIONS: readonly { label: string; value: MediaSortField }[] = [
  { label: "Last updated", value: "updatedAt" },
  { label: "Created", value: "createdAt" },
  { label: "Name", value: "name" },
  { label: "File size", value: "sizeBytes" },
];

const DIRECTION_LABELS: Record<MediaSortField, Record<MediaSortDirection, string>> = {
  updatedAt: { desc: "Newest first", asc: "Oldest first" },
  createdAt: { desc: "Newest first", asc: "Oldest first" },
  name: { asc: "A–Z", desc: "Z–A" },
  sizeBytes: { desc: "Largest first", asc: "Smallest first" },
};

const KIND_LABELS: Record<MediaKind, string> = { image: "Images", document: "Documents", audio: "Audio" };
const MAX_PAGE_TAGS = 12;

/** Direction choices for a sort field, the usual one first: A–Z for names, newest or largest otherwise. */
export function sortDirections(field: MediaSortField): MediaSortDirection[] {
  return field === "name" ? ["asc", "desc"] : ["desc", "asc"];
}

export function sortDirectionLabel(field: MediaSortField, direction: MediaSortDirection): string {
  return DIRECTION_LABELS[field][direction];
}

const HEADING_SORT_FIELDS: Readonly<Record<string, MediaSortField>> = { name: "name", size: "sizeBytes", updated: "updatedAt" };

/** The sort a list heading applies: Name, Size and Updated have one; other columns do not. */
export function headingSortField(column: string): MediaSortField | null {
  return HEADING_SORT_FIELDS[column] ?? null;
}

/**
 * A list heading click: the first click on a column
 * sorts by its field in that field's first direction, as the Sort control lists it; a second
 * click on the sorted column reverses it. Either way the list returns to page 1.
 */
export function headingSort(
  column: string,
  current: { sort: MediaSortField; direction: MediaSortDirection },
): { sort: MediaSortField; direction: MediaSortDirection; page: 1 } | null {
  const sort = headingSortField(column);
  if (!sort) return null;
  if (sort === current.sort) return { sort, direction: current.direction === "asc" ? "desc" : "asc", page: 1 };
  return { sort, direction: sortDirections(sort)[0], page: 1 };
}

export function toggleValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

/**
 * With a result, the counted categories plus any selected ones, sorted by id. Without one
 * (loading or an error), the selected categories in URL order, so a filter can still be
 * unchecked while the list fails.
 */
export function categoryOptions(
  result: Pick<ListMediaResponse, "categoryCounts"> | null | undefined,
  selected: readonly string[],
  registry: readonly string[] = [],
): string[] {
  const counted = result?.categoryCounts ? Object.keys(result.categoryCounts) : [];
  if (registry.length === 0 && counted.length === 0) return [...selected];
  return [...new Set([...registry, ...counted, ...selected])].sort();
}

export interface FilterChip {
  key: string;
  field: "kind" | "category";
  value: string;
  label: string;
}

export function filterChips(query: MediaListQuery, categoryLabel: (id: string) => string): FilterChip[] {
  return [
    ...query.kinds.map((kind) => ({ key: `kind:${kind}`, field: "kind" as const, value: kind, label: `Type: ${KIND_LABELS[kind]}` })),
    ...query.categories.map((id) => ({ key: `category:${id}`, field: "category" as const, value: id, label: `Category: ${categoryLabel(id)}` })),
  ];
}

export function appliedFilterCount(query: MediaListQuery): number {
  return query.kinds.length + query.categories.length;
}

function withQuery(state: MediaLocationState, query: Partial<MediaListQuery>): MediaLocationState {
  return { ...state, query: { ...state.query, ...query, page: 1 } };
}

export function removeFilterChip(state: MediaLocationState, chip: FilterChip): MediaLocationState {
  return chip.field === "kind"
    ? withQuery(state, { kinds: state.query.kinds.filter((kind) => kind !== chip.value) })
    : withQuery(state, { categories: state.query.categories.filter((id) => id !== chip.value) });
}

/** Clear all: removes every chip and the search text; sort, view and selection stay. */
export function clearFilterChips(state: MediaLocationState): MediaLocationState {
  return withQuery(state, { kinds: [], categories: [], q: "" });
}

export function applyFilterDraft(
  state: MediaLocationState,
  draft: { kinds: MediaKind[]; categories: string[] },
): MediaLocationState {
  return withQuery(state, { kinds: [...draft.kinds], categories: [...draft.categories] });
}

/** After removing chip `index` of `count`, focus the next remove button, else the previous, else Filter. */
export function focusAfterChipRemoval(index: number, count: number): { target: "chip"; index: number } | { target: "filter" } {
  const remaining = count - 1;
  if (remaining <= 0) return { target: "filter" };
  return { target: "chip", index: Math.min(index, remaining - 1) };
}

/** A chosen tag replaces the search text; tags never become chips. */
export function chooseTag(state: MediaLocationState, tag: string): MediaLocationState {
  return withQuery(state, { q: tag });
}

/** Tags on the loaded page, once each ignoring case, most frequent first. No tag directory exists. */
export function pageTags(records: readonly Pick<MediaAssetSummary, "tags">[]): string[] {
  const counts = new Map<string, { tag: string; count: number; order: number }>();
  for (const record of records) {
    for (const tag of record.tags) {
      const key = tag.toLocaleLowerCase("en-US");
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { tag, count: 1, order: counts.size });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, MAX_PAGE_TAGS)
    .map((entry) => entry.tag);
}

export function resultStatus({
  total,
  keyword,
  page,
  pageCount,
  refreshing = false,
  filterLabels = [],
}: {
  total: number;
  keyword: boolean;
  page: number;
  pageCount: number;
  refreshing?: boolean;
  filterLabels?: readonly string[];
}): { text: string; hidden: string } {
  const count = `${total.toLocaleString("en-US")} ${keyword ? "keyword " : ""}${total === 1 ? "result" : "results"}`;
  const text = refreshing
    ? `${count}, updating`
    : pageCount > 1
      ? `${count} · Page ${page} of ${pageCount}`
      : count;
  return { text, hidden: filterLabels.length ? `Filtered by ${filterLabels.join(", ")}. ` : "" };
}

/** Nothing before the first selection, "N selected" after, "No items selected" once cleared. */
export function selectionAnnouncement(count: number, previousCount: number): string {
  if (count > 0) return `${count} selected`;
  return previousCount > 0 ? "No items selected" : "";
}

export type VideoStructuredFilter =
  | { field: "tag"; value: string }
  | { field: "by"; value: string }
  | { field: "rights"; value: VideoRightsFilter };

export interface SurfaceFilterChip {
  key: string;
  field: "tag" | "by" | "rights" | "kind" | "show" | "scope";
  value: string;
  label: string;
  /** Client-only filters use this visible qualifier beside the chip row. */
  scopeLabel?: "On this page";
}

/** Video supports one indexed structured property. Choosing another replaces it. */
export function setVideoStructuredFilter(
  state: VideoMediaLocationState,
  filter: VideoStructuredFilter | null,
): VideoMediaLocationState {
  const { tag: _tag, by: _by, rights: _rights, cursor: _cursor, ...query } = state.query;
  return {
    ...state,
    query: filter ? { ...query, [filter.field]: filter.value } : query,
  };
}

export function videoFilterChips(
  state: VideoMediaLocationState,
  uploaderLabel: (id: string) => string = () => "Staff uploader",
): SurfaceFilterChip[] {
  if (state.query.tag) {
    return [{ key: `tag:${state.query.tag}`, field: "tag", value: state.query.tag, label: `Tag: ${state.query.tag}` }];
  }
  if (state.query.by) {
    return [{ key: `by:${state.query.by}`, field: "by", value: state.query.by, label: `Uploader: ${uploaderLabel(state.query.by)}` }];
  }
  if (state.query.rights) {
    const label = state.query.rights === "pending" ? "Needs review" : "Recorded";
    return [{ key: `rights:${state.query.rights}`, field: "rights", value: state.query.rights, label: `Rights: ${label}` }];
  }
  return [];
}

/** Video Clear all removes search and its one chip while retaining URL sort and page size. */
export function clearVideoFilterChips(state: VideoMediaLocationState): VideoMediaLocationState {
  const cleared = setVideoStructuredFilter(state, null);
  return { ...cleared, query: { ...cleared.query, q: "" } };
}

const FAVORITE_KIND_LABELS = {
  audio: "Audio",
  image: "Images",
  document: "Documents",
  video: "Videos",
} as const;

export function favoritesFilterChips(state: FavoritesMediaLocationState): SurfaceFilterChip[] {
  return state.kind ? [{
    key: `kind:${state.kind}`,
    field: "kind",
    value: state.kind,
    label: `Type: ${FAVORITE_KIND_LABELS[state.kind]}`,
    scopeLabel: "On this page",
  }] : [];
}

export function clearFavoritesFilterChips(state: FavoritesMediaLocationState): FavoritesMediaLocationState {
  return { ...state, kind: null };
}

const COLLECTION_SCOPE_LABELS = { private: "Private", all_staff: "All staff" } as const;

export function collectionsFilterChips(state: CollectionsMediaLocationState): SurfaceFilterChip[] {
  return [
    ...(state.show === "archived" ? [{
      key: "show:archived",
      field: "show" as const,
      value: "archived",
      label: "Status: Archived",
    }] : []),
    ...(state.scope ? [{
      key: `scope:${state.scope}`,
      field: "scope" as const,
      value: state.scope,
      label: `Scope: ${COLLECTION_SCOPE_LABELS[state.scope]}`,
      scopeLabel: "On this page" as const,
    }] : []),
  ];
}

export function clearCollectionsFilterChips(state: CollectionsMediaLocationState): CollectionsMediaLocationState {
  return { ...state, show: "active", scope: null };
}
