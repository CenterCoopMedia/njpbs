import {
  encodeCollectionsMediaLocation,
  encodeFavoritesMediaLocation,
  encodeMediaLocation,
  encodeVideoMediaLocation,
  parseCollectionsMediaLocation,
  parseFavoritesMediaLocation,
  parseMediaLocation,
  parseVideoMediaLocation,
} from "./media-query";
import {
  readMediaDisplay,
  type MediaDisplayPreferences,
  type MediaDisplaySurface,
  type VideoMediaDisplayPreferences,
} from "./media-display";

export const MAX_SAVED_MEDIA_VIEWS = 20;
export const MAX_SAVED_MEDIA_VIEW_NAME_LENGTH = 60;

export type SavedMediaViewSurface =
  | "images"
  | "audio"
  | "favorites"
  | "collections"
  | `video:${string}`;

export interface SavedMediaView {
  id: string;
  name: string;
  surface: SavedMediaViewSurface;
  query: string;
  display?: MediaDisplayPreferences | VideoMediaDisplayPreferences;
}

export type SavedMediaViewMutation =
  | { type: "add"; view: SavedMediaView }
  | { type: "delete"; id: string };

export class SavedMediaViewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedMediaViewValidationError";
  }
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function validId(value: string, maxLength: number): boolean {
  return value.length >= 1 && value.length <= maxLength && SAFE_ID_PATTERN.test(value);
}

function parseSurface(value: string): SavedMediaViewSurface {
  if (value === "images" || value === "audio" || value === "favorites" || value === "collections") {
    return value;
  }
  if (value.startsWith("video:") && validId(value.slice("video:".length), 128)) {
    return value as SavedMediaViewSurface;
  }
  throw new SavedMediaViewValidationError("Saved view surface is invalid");
}

function canonicalQuery(surface: SavedMediaViewSurface, value: string): string {
  if (surface === "images" || surface === "audio") {
    const { query } = parseMediaLocation(value);
    return encodeMediaLocation({ ...query, page: 1 }, null).toString();
  }
  if (surface === "favorites") {
    const { kind } = parseFavoritesMediaLocation(value);
    return encodeFavoritesMediaLocation(kind, null).toString();
  }
  if (surface === "collections") {
    const { show, scope } = parseCollectionsMediaLocation(value);
    return encodeCollectionsMediaLocation(show, scope, null).toString();
  }
  const { query } = parseVideoMediaLocation(value);
  return encodeVideoMediaLocation({ ...query, cursor: undefined }, null).toString();
}

function canonicalDisplay(
  surface: SavedMediaViewSurface,
  value: unknown,
): MediaDisplayPreferences | VideoMediaDisplayPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SavedMediaViewValidationError("Saved view display settings are invalid");
  }
  const displaySurface: MediaDisplaySurface = surface === "audio" ? "images" : surface === "images"
    || surface === "favorites"
    || surface === "collections"
    ? surface
    : "video";
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SavedMediaViewValidationError("Saved view display settings are invalid");
  }
  return readMediaDisplay(displaySurface, {
    getItem: () => serialized,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
}

export function createSavedMediaView(
  id: string,
  name: string,
  surfaceValue: string,
  query: string,
  display?: unknown,
): SavedMediaView {
  if (typeof id !== "string" || !validId(id, 100)) {
    throw new SavedMediaViewValidationError("Saved view id is invalid");
  }
  if (typeof name !== "string") {
    throw new SavedMediaViewValidationError("Enter a name for this view");
  }
  const normalizedName = name.trim();
  if (normalizedName === "") {
    throw new SavedMediaViewValidationError("Enter a name for this view");
  }
  if (normalizedName.length > MAX_SAVED_MEDIA_VIEW_NAME_LENGTH) {
    throw new SavedMediaViewValidationError(
      `View names must be ${MAX_SAVED_MEDIA_VIEW_NAME_LENGTH} characters or fewer`,
    );
  }
  if (typeof surfaceValue !== "string") {
    throw new SavedMediaViewValidationError("Saved view surface is invalid");
  }
  if (typeof query !== "string") {
    throw new SavedMediaViewValidationError("Saved view query is invalid");
  }
  const surface = parseSurface(surfaceValue);
  return {
    id,
    name: normalizedName,
    surface,
    query: canonicalQuery(surface, query),
    ...(display === undefined ? {} : { display: canonicalDisplay(surface, display) }),
  };
}

export function parseSavedMediaViews(value: unknown): SavedMediaView[] {
  if (!Array.isArray(value)) return [];
  const views: SavedMediaView[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (views.length >= MAX_SAVED_MEDIA_VIEWS) break;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      continue;
    }
    const { id, name, surface, query, display } = candidate as Record<string, unknown>;
    if (typeof id !== "string" || ids.has(id)) continue;
    try {
      const view = createSavedMediaView(
        id,
        name as string,
        surface as string,
        query as string,
        display,
      );
      views.push(view);
      ids.add(view.id);
    } catch {
      // One corrupt preference cannot block the remaining personal views.
    }
  }
  return views;
}

export function applySavedMediaViewMutation(
  current: unknown,
  mutation: SavedMediaViewMutation,
): SavedMediaView[] {
  const views = parseSavedMediaViews(current);
  if (mutation.type === "delete") {
    if (!validId(mutation.id, 100)) {
      throw new SavedMediaViewValidationError("Saved view id is invalid");
    }
    return views.filter((view) => view.id !== mutation.id);
  }

  const view = createSavedMediaView(
    mutation.view.id,
    mutation.view.name,
    mutation.view.surface,
    mutation.view.query,
    mutation.view.display,
  );
  if (views.some((candidate) => candidate.id === view.id)) {
    throw new SavedMediaViewValidationError("A saved view with this id already exists");
  }
  if (views.length >= MAX_SAVED_MEDIA_VIEWS) {
    throw new SavedMediaViewValidationError(
      `You can save up to ${MAX_SAVED_MEDIA_VIEWS} views.`,
    );
  }
  const matchingName = views.find(
    (candidate) =>
      candidate.surface === view.surface &&
      candidate.name.toLocaleLowerCase() === view.name.toLocaleLowerCase(),
  );
  if (matchingName) {
    throw new SavedMediaViewValidationError(
      `A saved view named “${matchingName.name}” already exists.`,
    );
  }
  const matchingQuery = views.find(
    (candidate) => candidate.surface === view.surface && candidate.query === view.query,
  );
  if (matchingQuery) {
    throw new SavedMediaViewValidationError(
      `These filters are already saved as “${matchingQuery.name}”.`,
    );
  }
  return [...views, view];
}
