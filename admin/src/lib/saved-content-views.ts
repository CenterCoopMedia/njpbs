import {
  encodeContentQuery,
  parseContentQuery,
  resetPage,
  type ContentQuery,
} from "./content-query";

export const MAX_SAVED_CONTENT_VIEWS = 20;
export const MAX_SAVED_CONTENT_VIEW_NAME_LENGTH = 60;

export interface SavedContentView {
  id: string;
  name: string;
  // Canonical content-query string, including its own codec version and never a page.
  query: string;
}

export type SavedContentViewMutation =
  | { type: "add"; view: SavedContentView }
  | { type: "delete"; id: string };

// These messages are safe to show to the signed-in editor. Keeping a distinct error type lets
// the Firestore wrapper preserve validation refusals while still replacing backend/network
// failures with one non-diagnostic message.
export class SavedContentViewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedContentViewValidationError";
  }
}

function validId(value: string): boolean {
  return value.length >= 1 && value.length <= 100 && /^[A-Za-z0-9_-]+$/.test(value);
}

function canonicalQuery(value: string | ContentQuery): string {
  const query = typeof value === "string" ? parseContentQuery(value) : value;
  return encodeContentQuery(resetPage(query));
}

export function createSavedContentView(
  id: string,
  name: string,
  query: string | ContentQuery,
): SavedContentView {
  if (!validId(id)) throw new SavedContentViewValidationError("Saved view id is invalid");
  const normalizedName = name.trim();
  if (normalizedName === "") {
    throw new SavedContentViewValidationError("Enter a name for this view");
  }
  if (normalizedName.length > MAX_SAVED_CONTENT_VIEW_NAME_LENGTH) {
    throw new SavedContentViewValidationError(
      `View names must be ${MAX_SAVED_CONTENT_VIEW_NAME_LENGTH} characters or fewer`,
    );
  }
  return { id, name: normalizedName, query: canonicalQuery(query) };
}

// User-profile data is untrusted at the read boundary. Keep the first valid view for each id,
// drop malformed rows, and canonicalize every query so old paging state or query-key ordering
// cannot leak into the UI or the next profile write.
export function parseSavedContentViews(value: unknown): SavedContentView[] {
  if (!Array.isArray(value)) return [];
  const views: SavedContentView[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (views.length >= MAX_SAVED_CONTENT_VIEWS) break;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      continue;
    }
    const { id, name, query } = candidate as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof query !== "string" ||
      ids.has(id)
    ) {
      continue;
    }
    try {
      const view = createSavedContentView(id, name, query);
      views.push(view);
      ids.add(view.id);
    } catch {
      // Corrupt preferences cannot block the whole content library. Ignore only the bad row.
    }
  }
  return views;
}

// Apply exactly one intent to the newest profile snapshot. The Firestore store calls this from
// a transaction, so an add or delete from a stale tab preserves unrelated views created in a
// different tab instead of replacing the whole array it happened to load earlier.
export function applySavedContentViewMutation(
  current: unknown,
  mutation: SavedContentViewMutation,
): SavedContentView[] {
  const views = parseSavedContentViews(current);
  if (mutation.type === "delete") {
    if (!validId(mutation.id)) {
      throw new SavedContentViewValidationError("Saved view id is invalid");
    }
    return views.filter((view) => view.id !== mutation.id);
  }

  const view = createSavedContentView(
    mutation.view.id,
    mutation.view.name,
    mutation.view.query,
  );
  if (views.some((candidate) => candidate.id === view.id)) {
    throw new SavedContentViewValidationError("A saved view with this id already exists");
  }
  if (views.length >= MAX_SAVED_CONTENT_VIEWS) {
    throw new SavedContentViewValidationError(
      `You can save up to ${MAX_SAVED_CONTENT_VIEWS} views.`,
    );
  }
  const matchingName = views.find(
    (candidate) => candidate.name.toLocaleLowerCase() === view.name.toLocaleLowerCase(),
  );
  if (matchingName) {
    throw new SavedContentViewValidationError(
      `A saved view named “${matchingName.name}” already exists.`,
    );
  }
  const matchingQuery = views.find((candidate) => candidate.query === view.query);
  if (matchingQuery) {
    throw new SavedContentViewValidationError(
      `These filters are already saved as “${matchingQuery.name}”.`,
    );
  }
  return [...views, view];
}
