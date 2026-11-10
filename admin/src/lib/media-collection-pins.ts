export const MEDIA_COLLECTION_PINS_VERSION = 1;
export const MAX_MEDIA_COLLECTION_PINS = 20;

export interface MediaCollectionPins {
  version: typeof MEDIA_COLLECTION_PINS_VERSION;
  ids: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseMediaCollectionPins(value: unknown): MediaCollectionPins {
  const candidate = record(value);
  if (candidate?.version !== MEDIA_COLLECTION_PINS_VERSION || !Array.isArray(candidate.ids)) {
    return { version: MEDIA_COLLECTION_PINS_VERSION, ids: [] };
  }
  const ids = candidate.ids.filter((id): id is string =>
    typeof id === "string" && /^[a-f0-9]{64}$/.test(id));
  return {
    version: MEDIA_COLLECTION_PINS_VERSION,
    ids: [...new Set(ids)].slice(0, MAX_MEDIA_COLLECTION_PINS),
  };
}

export function readMediaCollectionPins(profile: unknown): MediaCollectionPins {
  return parseMediaCollectionPins(record(record(profile)?.preferences)?.mediaCollectionPins);
}

export function setMediaCollectionPinned(
  current: MediaCollectionPins,
  collectionId: string,
  pinned: boolean,
): MediaCollectionPins {
  const ids = current.ids.filter(id => id !== collectionId);
  if (pinned) ids.unshift(collectionId);
  return {
    version: MEDIA_COLLECTION_PINS_VERSION,
    ids: ids.slice(0, MAX_MEDIA_COLLECTION_PINS),
  };
}
