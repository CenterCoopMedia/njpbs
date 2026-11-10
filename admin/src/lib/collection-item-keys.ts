export const COLLECTION_ITEM_ID_KEY = "itemId";

let fallbackSequence = 0;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectionItemId(value: unknown): string | null {
  if (!isPlainRecord(value)) return null;
  const itemId = value[COLLECTION_ITEM_ID_KEY];
  return typeof itemId === "string" && itemId.trim().length > 0
    ? itemId
    : null;
}

export function mintCollectionItemId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `collection-item-${globalThis.crypto.randomUUID()}`;
  }
  fallbackSequence += 1;
  return `collection-item-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}

function equalWithoutItemId(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => equalWithoutItemId(value, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left)
    .filter((key) => key !== COLLECTION_ITEM_ID_KEY)
    .sort();
  const rightKeys = Object.keys(right)
    .filter((key) => key !== COLLECTION_ITEM_ID_KEY)
    .sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every((key) => equalWithoutItemId(left[key], right[key]));
}

function uniqueId(mint: () => string, used: Set<string>): string {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const candidate = mint();
    if (candidate.trim().length > 0 && !used.has(candidate)) return candidate;
  }
  throw new Error("Unable to mint a unique collection item id.");
}

// One persisted identity contract now serves the reducer, undo mapping, and React keys.
// Existing ids win. Legacy rows first match an unmatched prior row by content (ignoring
// itemId), then by position for an in-place field edit, and only then receive a new id.
export function reconcileCollectionItemIds(
  previousItems: readonly unknown[],
  nextItems: readonly unknown[],
  mint: () => string = mintCollectionItemId,
): readonly unknown[] {
  const matchedPrevious = new Set<number>();
  const usedIds = new Set<string>();
  let changed = false;

  const reconciled = nextItems.map((item, nextIndex) => {
    if (!isPlainRecord(item)) return item;

    let id = collectionItemId(item);
    let previousIndex = -1;
    if (id && usedIds.has(id)) id = null;

    if (id) {
      previousIndex = previousItems.findIndex(
        (prior, index) =>
          !matchedPrevious.has(index) && collectionItemId(prior) === id,
      );
    } else {
      previousIndex = previousItems.findIndex(
        (prior, index) =>
          !matchedPrevious.has(index) &&
          collectionItemId(prior) !== null &&
          equalWithoutItemId(prior, item),
      );
      if (previousIndex >= 0) id = collectionItemId(previousItems[previousIndex]);
    }

    if (!id) {
      const positionalId = collectionItemId(previousItems[nextIndex]);
      if (
        positionalId &&
        !matchedPrevious.has(nextIndex) &&
        !usedIds.has(positionalId)
      ) {
        previousIndex = nextIndex;
        id = positionalId;
      }
    }

    if (!id) id = uniqueId(mint, usedIds);
    if (previousIndex >= 0) matchedPrevious.add(previousIndex);
    usedIds.add(id);

    if (collectionItemId(item) === id) return item;
    changed = true;
    return { ...item, [COLLECTION_ITEM_ID_KEY]: id };
  });

  return changed ? reconciled : nextItems;
}

export function collectionItemsById(
  value: unknown,
): Map<string, Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    if (!isPlainRecord(item)) return null;
    const id = collectionItemId(item);
    if (!id || byId.has(id)) return null;
    byId.set(id, item);
  }
  return byId;
}

export function sameCollectionItemIds(left: unknown, right: unknown): boolean {
  const leftById = collectionItemsById(left);
  const rightById = collectionItemsById(right);
  if (!leftById || !rightById || leftById.size !== rightById.size) return false;
  return [...leftById.keys()].every((id) => rightById.has(id));
}
