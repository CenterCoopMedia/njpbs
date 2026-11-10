// The domain codec for the content library's filter/sort/paging state. One codec serves
// every representation of that state: the query string in the browser URL, a saved-view
// document (#593), an imported link, and tests. Keeping parse and encode here, pure and
// project-owned, is what keeps the URL contract independent of the router (a router swap does
// not touch this) and is why the URL stays the single source of truth for what the library is
// showing. No React, no router, no Firestore.
//
// The combined library consumes this boundary directly. Its URL shape, validation, and round-trip
// guarantee also give later durable, user-named saved views one honest definition to persist.
import {
  CONTENT_STATUSES,
  LIBRARY_RECORD_KINDS,
  isContentStatus,
  isLibraryRecordKind,
  type ContentStatus,
  type LibraryRecordKind,
} from "./content-vocab";

// The codec version, emitted as `v` and independent of any saved-view document schema. A
// future incompatible URL grammar bumps this; an unknown value is ignored on parse and the
// input falls back to the closest safe state rather than being trusted.
export const CONTENT_QUERY_VERSION = 1;

export type OwnerMode = "any" | "me" | "specific";
export type AssignmentMode = "any" | "me" | "specific";
export type SortField = "updatedAt" | "createdAt" | "title" | "status" | "publishAt";
export type SortDirection = "asc" | "desc";

const SORT_FIELDS: readonly SortField[] = [
  "updatedAt",
  "createdAt",
  "title",
  "status",
  "publishAt",
];
const SORT_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

// The trimmed search cap, matching the saved-view schema's limit (#593), so a value that
// would be rejected on save is also rejected here rather than silently persisted.
const MAX_SEARCH_LENGTH = 200;

// The library's filter, sort, and paging state as a normalized value. Arrays are always
// deduplicated and sorted, so two URLs describing the same filter compare equal. `page` is
// 1-based and lives only in the browsing URL; it is dropped when a view is saved or selected.
export interface ContentQuery {
  // A retired kind is a valid filter value even though nothing can create one: a
  // stored record still has to be findable by type.
  types: LibraryRecordKind[];
  statuses: ContentStatus[];
  ownerMode: OwnerMode;
  // The uid to filter by when ownerMode is "specific"; null otherwise. "me" resolves to the
  // signed-in uid at read time and is not stored here, so a copied link never pins another
  // person's identity into someone else's filter.
  ownerUid: string | null;
  assignmentMode: AssignmentMode;
  // The uid to filter by when assignmentMode is "specific"; null otherwise.
  // Assignment is deliberately separate from owner/updatedBy.
  assigneeUid: string | null;
  q: string;
  sortField: SortField;
  sortDirection: SortDirection;
  sortExplicit: boolean;
  page: number;
}

export const DEFAULT_CONTENT_QUERY: Readonly<ContentQuery> = Object.freeze({
  types: [],
  statuses: [],
  ownerMode: "any",
  ownerUid: null,
  assignmentMode: "any",
  assigneeUid: null,
  q: "",
  sortField: "updatedAt",
  sortDirection: "desc",
  sortExplicit: false,
  page: 1,
});

/**
 * How many of the disclosed filter axes (type, status, owner, assignment) hold a non-default
 * value. The Filters button carries this count so a saved view or a shared address that arrives
 * with the panel collapsed still shows that something is narrowing the list; the search box,
 * sort, and page sit in the open toolbar and are not counted.
 */
export function activeAdvancedFilterCount(query: ContentQuery): number {
  return (
    (query.types.length > 0 ? 1 : 0) +
    (query.statuses.length > 0 ? 1 : 0) +
    (query.ownerMode !== DEFAULT_CONTENT_QUERY.ownerMode ? 1 : 0) +
    (query.assignmentMode !== DEFAULT_CONTENT_QUERY.assignmentMode ? 1 : 0)
  );
}

function toSearchParams(input: string | URLSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  // Accept a full "?a=b" or a bare "a=b"; URLSearchParams tolerates a leading "?".
  return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
}

// Deduplicate while preserving membership, then sort into a fixed order so the encoded form
// is canonical regardless of the order the values arrived in.
function normalizeStringSet<T extends string>(
  values: string[],
  allowed: readonly T[],
  guard: (value: string) => value is T,
): T[] {
  const seen = new Set<T>();
  for (const value of values) {
    if (guard(value)) seen.add(value);
  }
  // Sort by the vocabulary's own order, so the canonical form is stable and human-legible
  // rather than lexicographic.
  return allowed.filter((value) => seen.has(value));
}

// Parse an untrusted query string (or URLSearchParams) into a normalized ContentQuery.
// Unknown keys are ignored; every known value is validated and an invalid one falls back to
// its default rather than reaching a database query.
export function parseContentQuery(input: string | URLSearchParams): ContentQuery {
  const params = toSearchParams(input);

  const types = normalizeStringSet(
    params.getAll("type"),
    LIBRARY_RECORD_KINDS,
    isLibraryRecordKind,
  );
  const statuses = normalizeStringSet(
    params.getAll("status"),
    CONTENT_STATUSES,
    isContentStatus,
  );

  // Owner: "me" is the signed-in user; a non-empty, non-reserved value is a specific uid;
  // anything else (absent, "any", empty) is no owner filter.
  const ownerRaw = params.get("owner")?.trim() ?? "";
  let ownerMode: OwnerMode = "any";
  let ownerUid: string | null = null;
  if (ownerRaw === "me") {
    ownerMode = "me";
  } else if (ownerRaw !== "" && ownerRaw !== "any") {
    ownerMode = "specific";
    ownerUid = ownerRaw;
  }

  const assignedRaw = params.get("assigned")?.trim() ?? "";
  let assignmentMode: AssignmentMode = "any";
  let assigneeUid: string | null = null;
  if (assignedRaw === "me") {
    assignmentMode = "me";
  } else if (assignedRaw !== "" && assignedRaw !== "any") {
    assignmentMode = "specific";
    assigneeUid = assignedRaw;
  }

  const qRaw = params.get("q") ?? "";
  const q = qRaw.trim().slice(0, MAX_SEARCH_LENGTH);

  const sortRaw = params.get("sort") ?? "";
  const sortField: SortField = SORT_FIELDS.includes(sortRaw as SortField)
    ? (sortRaw as SortField)
    : DEFAULT_CONTENT_QUERY.sortField;

  const dirRaw = params.get("dir") ?? "";
  const sortDirection: SortDirection = SORT_DIRECTIONS.includes(dirRaw as SortDirection)
    ? (dirRaw as SortDirection)
    : DEFAULT_CONTENT_QUERY.sortDirection;

  const pageRaw = Number(params.get("page"));
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  return {
    types,
    statuses,
    ownerMode,
    ownerUid,
    assignmentMode,
    assigneeUid,
    q,
    sortField,
    sortDirection,
    sortExplicit: SORT_FIELDS.includes(sortRaw as SortField) || SORT_DIRECTIONS.includes(dirRaw as SortDirection),
    page,
  };
}

// Serialize a ContentQuery into a canonical query string. Keys are emitted in a fixed order,
// multi-select filters use repeated keys, and any value equal to its default is omitted, so
// the empty filter encodes to just the codec version. The output never carries a leading "?".
export function encodeContentQuery(query: ContentQuery): string {
  const params = new URLSearchParams();

  // Arrays are already vocabulary-ordered by construction when the value came from
  // parseContentQuery; re-normalize defensively so a hand-built query still encodes
  // canonically.
  for (const type of normalizeStringSet(
    query.types,
    LIBRARY_RECORD_KINDS,
    isLibraryRecordKind,
  )) {
    params.append("type", type);
  }
  for (const status of normalizeStringSet(
    query.statuses,
    CONTENT_STATUSES,
    isContentStatus,
  )) {
    params.append("status", status);
  }

  if (query.ownerMode === "me") {
    params.set("owner", "me");
  } else if (query.ownerMode === "specific" && query.ownerUid) {
    params.set("owner", query.ownerUid);
  }

  if (query.assignmentMode === "me") {
    params.set("assigned", "me");
  } else if (query.assignmentMode === "specific" && query.assigneeUid) {
    params.set("assigned", query.assigneeUid);
  }

  const q = query.q.trim().slice(0, MAX_SEARCH_LENGTH);
  if (q !== "") params.set("q", q);

  if (query.sortExplicit || query.sortField !== DEFAULT_CONTENT_QUERY.sortField) {
    params.set("sort", query.sortField);
  }
  if (query.sortDirection !== DEFAULT_CONTENT_QUERY.sortDirection) {
    params.set("dir", query.sortDirection);
  }
  if (Number.isInteger(query.page) && query.page > 1) {
    params.set("page", String(query.page));
  }

  params.set("v", String(CONTENT_QUERY_VERSION));
  return params.toString();
}

// A copy of the query with paging reset, for saving or selecting a view: a saved view names a
// filter, not a scroll position, so page 1 is the honest starting point and the encoded form
// omits `page` entirely.
export function resetPage(query: ContentQuery): ContentQuery {
  return { ...query, page: 1 };
}

// Whether two queries describe the same library state, comparing the normalized (paging-
// independent) form. This is how a saved view is marked active without depending on any stored
// view id, so renaming or deleting a view can never break the comparison.
export function contentQueriesEqual(a: ContentQuery, b: ContentQuery): boolean {
  return encodeContentQuery(resetPage(a)) === encodeContentQuery(resetPage(b));
}
