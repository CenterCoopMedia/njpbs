import type { ListMediaResponse, MediaAssetSummary, MediaKind, MediaListQuery, MediaSortDirection, MediaSortField } from "./functions";
import { MEDIA_ASPECTS, type MediaMetadataBounds } from "./media-browse-metadata";
import type {
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
  field: "kind" | "category" | MetadataFilterField;
  value: string;
  label: string;
}

type MetadataFilterField = "updated" | "duration" | "aspect" | "metadata";
type MetadataFilterChip = FilterChip & { field: MetadataFilterField };

export function metadataFilterChips(query: MediaMetadataBounds, requested: boolean): MetadataFilterChip[] {
  const { updatedFrom, updatedTo, minDuration, maxDuration, aspect } = query;
  const chips: MetadataFilterChip[] = [];
  if (updatedFrom || updatedTo) {
    const value = updatedFrom && updatedTo ? `${updatedFrom} to ${updatedTo}` : updatedFrom ? `from ${updatedFrom}` : `through ${updatedTo}`;
    chips.push({ key: `updated:${value}`, field: "updated", value, label: `Last updated ${value}` });
  }
  if (minDuration !== undefined || maxDuration !== undefined) {
    const value = minDuration !== undefined && maxDuration !== undefined ? `${minDuration}–${maxDuration} seconds`
      : minDuration !== undefined ? `at least ${minDuration} seconds` : `up to ${maxDuration} seconds`;
    chips.push({ key: `duration:${value}`, field: "duration", value, label: `Duration: ${value}` });
  }
  if (aspect) chips.push({ key: `aspect:${aspect}`, field: "aspect", value: aspect,
    label: `Aspect: ${MEDIA_ASPECTS.find(option => option.value === aspect)?.label}` });
  if (requested) chips.push({ key: "metadata:requested", field: "metadata", value: "requested", label: "Metadata update requested" });
  return chips;
}

export function filterChips(query: MediaListQuery, categoryLabel: (id: string) => string): FilterChip[] {
  return [
    ...query.kinds.map((kind) => ({ key: `kind:${kind}`, field: "kind" as const, value: kind, label: `Type: ${KIND_LABELS[kind]}` })),
    ...query.categories.map((id) => ({ key: `category:${id}`, field: "category" as const, value: id, label: `Category: ${categoryLabel(id)}` })),
    ...metadataFilterChips(query, query.metadataUpdateRequested === true),
  ];
}

export function appliedFilterCount(query: MediaListQuery): number {
  return query.kinds.length + query.categories.length + metadataFilterChips(query, query.metadataUpdateRequested === true).length;
}

function withQuery(state: MediaLocationState, query: Partial<MediaListQuery>): MediaLocationState {
  return { ...state, query: { ...state.query, ...query, page: 1 } };
}

export function removeFilterChip(state: MediaLocationState, chip: FilterChip): MediaLocationState {
  switch (chip.field) {
    case "kind": return withQuery(state, { kinds: state.query.kinds.filter((kind) => kind !== chip.value) });
    case "category": return withQuery(state, { categories: state.query.categories.filter((id) => id !== chip.value) });
    case "updated": return withQuery(state, { updatedFrom: undefined, updatedTo: undefined });
    case "duration": return withQuery(state, { minDuration: undefined, maxDuration: undefined });
    case "aspect": return withQuery(state, { aspect: undefined });
    case "metadata": return withQuery(state, { metadataUpdateRequested: undefined });
  }
}

/** Clear all: removes every chip and the search text; sort, view and selection stay. */
export function clearFilterChips(state: MediaLocationState): MediaLocationState {
  return withQuery(state, { kinds: [], categories: [], q: "", updatedFrom: undefined, updatedTo: undefined,
    minDuration: undefined, maxDuration: undefined, aspect: undefined, metadataUpdateRequested: undefined });
}

export function applyFilterDraft(
  state: MediaLocationState,
  draft: { kinds: MediaKind[]; categories: string[] },
): MediaLocationState {
  return withQuery(state, { kinds: [...draft.kinds], categories: [...draft.categories],
    ...(draft.kinds.length && !draft.kinds.includes("image") ? { aspect: undefined } : {}) });
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
  | { field: "rights"; value: VideoRightsFilter }
  | { field: "metadata"; value: "requested" }
  | { bounds: MediaMetadataBounds };

export interface SurfaceFilterChip {
  key: string;
  field: "tag" | "by" | "rights" | MetadataFilterField;
  value: string;
  label: string;
}

/** Video supports one indexed structured property. Choosing another replaces it. */
export function setVideoStructuredFilter(
  state: VideoMediaLocationState,
  filter: VideoStructuredFilter | null,
): VideoMediaLocationState {
  const { q, sort, limit } = state.query;
  const query = { q, sort, limit };
  return {
    ...state,
    query: filter ? { ...query, ...("bounds" in filter ? filter.bounds : { [filter.field]: filter.value }) } : query,
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
  return metadataFilterChips(state.query, state.query.metadata === "requested");
}

/** Video Clear all removes search and its one chip while retaining URL sort and page size. */
export function clearVideoFilterChips(state: VideoMediaLocationState): VideoMediaLocationState {
  const cleared = setVideoStructuredFilter(state, null);
  return { ...cleared, query: { ...cleared.query, q: "" } };
}
