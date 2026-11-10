// How a dynamic shelf query resolves (#1046): the one pure, deterministic function behind
// both blocks, and the eligibility rules that decide what a shelf may publish.
//
// Split from dynamic-shelves.ts, which holds the vocabulary an editor picks from, so the
// block parser and the editor's field descriptors can import the choices without importing
// this. The three properties this function holds up -- a finite query, a deterministic
// build-time result, and one contract shared by the editor preview and the public page --
// are stated in that file's header.

import { safeHref } from "./safe-href";
import { SHELF_STALE_AFTER_DAYS } from "./dynamic-shelves";
import type {
  ShelfItemLimit,
  ShelfPin,
  ShelfSnapshot,
  ShelfSort,
  ShelfTopicId,
  StoryShelfItem,
  TopicShelfSource,
  VideoLibraryId,
  VideoShelfItem,
} from "./dynamic-shelves";

// ---------------------------------------------------------------------------
// The query and its result
// ---------------------------------------------------------------------------

interface ShelfQueryBase {
  title: string;
  topic: ShelfTopicId;
  itemLimit: ShelfItemLimit;
  sort: ShelfSort;
  /** Manual order, highest precedence. Absent means a purely dynamic shelf. */
  pinned?: readonly ShelfPin[];
}

export interface TopicShelfQuery extends ShelfQueryBase {
  source: TopicShelfSource;
}

export interface VideoPlaylistQuery extends ShelfQueryBase {
  library: VideoLibraryId;
}

export type ShelfEmptyReason = "source_empty" | "no_matches";

export type ResolvedShelfItem<T> = T & {
  /** True when this item is in the list because an editor pinned it. */
  pinned: boolean;
};

export interface ResolvedShelf<T> {
  items: ResolvedShelfItem<T>[];
  /** Eligible items carrying the topic, before the cap. */
  totalMatched: number;
  /** Entries refused because a duplicate id or link already claimed the slot. */
  duplicatesDropped: number;
  /** Entries refused because their metadata was incomplete or unusable. */
  ineligibleDropped: number;
  /** Pinned ids the snapshot does not hold, so the editor can see the pin is dead. */
  missingPins: string[];
  empty: boolean;
  emptyReason?: ShelfEmptyReason;
  /** The snapshot is older than SHELF_STALE_AFTER_DAYS. Reported, never acted on. */
  stale: boolean;
  checkedAt: string;
}

export interface ResolveShelfOptions {
  /** ISO-8601 instant used for the rights window and the staleness report. */
  now?: string;
}

function hasVisibleText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A story the shelf may publish: a real title, and a link the renderer would actually
 * emit. The href goes through the renderer's own `safeHref`, so a catalog entry can
 * never smuggle a `javascript:` link into a card the way a hand-authored one cannot.
 */
export function isEligibleStory(item: StoryShelfItem): boolean {
  return (
    hasVisibleText(item.id) &&
    hasVisibleText(item.title) &&
    safeHref(item.href) !== null &&
    instant(item.publishedAt) !== null
  );
}

/**
 * A video the playlist may publish. Every piece of metadata the issue requires must be
 * present and usable, and the rights window must still be open at `nowMs`. This is the
 * fail-closed half of "approved libraries only": being in the library is not enough.
 */
export function isEligibleVideo(item: VideoShelfItem, nowMs: number): boolean {
  if (!hasVisibleText(item.id) || !hasVisibleText(item.title)) return false;
  if (safeHref(item.href) === null) return false;
  if (instant(item.publishedAt) === null) return false;
  if (item.captioned !== true) return false;
  if (!Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0) return false;
  if (item.access !== "public" && item.access !== "passport_members") return false;
  if (
    typeof item.thumbnail !== "object" ||
    item.thumbnail === null ||
    !hasVisibleText(item.thumbnail.url) ||
    typeof item.thumbnail.alt !== "string"
  ) {
    return false;
  }
  if (item.rightsExpireAt !== null) {
    const expiry = instant(item.rightsExpireAt);
    if (expiry === null || expiry <= nowMs) return false;
  }
  return true;
}

interface ShelfKind<T> {
  /** True when the item belongs to the source or library the query names. */
  inScope: (item: T) => boolean;
  isEligible: (item: T, nowMs: number) => boolean;
  identity: (item: T) => { id: string; href: string; publishedAt: string; topics: readonly string[] };
}

function resolveShelf<T>(
  query: ShelfQueryBase,
  snapshot: ShelfSnapshot<T>,
  kind: ShelfKind<T>,
  options: ResolveShelfOptions,
): ResolvedShelf<T> {
  const nowMs = instant(options.now) ?? Date.now();
  const checkedAtMs = instant(snapshot.checkedAt);
  // An unreadable date is treated as stale rather than fresh: a snapshot that cannot
  // say when it was taken is exactly the one nobody should trust silently.
  const stale =
    checkedAtMs === null ||
    nowMs - checkedAtMs > SHELF_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  let duplicatesDropped = 0;
  let ineligibleDropped = 0;
  const seenIds = new Set<string>();
  const seenHrefs = new Set<string>();
  const eligible: T[] = [];
  let inScopeCount = 0;

  for (const item of snapshot.items) {
    if (!kind.inScope(item)) continue;
    inScopeCount += 1;
    if (!kind.isEligible(item, nowMs)) {
      ineligibleDropped += 1;
      continue;
    }
    const { id, href } = kind.identity(item);
    if (seenIds.has(id) || seenHrefs.has(href)) {
      duplicatesDropped += 1;
      continue;
    }
    seenIds.add(id);
    seenHrefs.add(href);
    eligible.push(item);
  }

  const byId = new Map(eligible.map((item) => [kind.identity(item).id, item]));

  // Manual order wins. A pin names an eligible item from the same source, whatever
  // topic it carries -- pinning is the editor overriding the query, so requiring the
  // pinned item to also satisfy the query would make the override useless in the one
  // case it is for. A pin the snapshot cannot honour is reported, not guessed at.
  const missingPins: string[] = [];
  const pinnedItems: T[] = [];
  const pinnedIds = new Set<string>();
  for (const pin of query.pinned ?? []) {
    const id = typeof pin?.id === "string" ? pin.id : "";
    if (id === "" || pinnedIds.has(id)) continue;
    const item = byId.get(id);
    if (!item) {
      missingPins.push(id);
      continue;
    }
    pinnedIds.add(id);
    pinnedItems.push(item);
  }

  const matched = eligible.filter((item) =>
    kind.identity(item).topics.includes(query.topic),
  );
  const dynamic = matched.filter((item) => !pinnedIds.has(kind.identity(item).id));

  if (query.sort !== "curated") {
    const direction = query.sort === "oldest" ? 1 : -1;
    dynamic.sort((left, right) => {
      const leftAt = instant(kind.identity(left).publishedAt) ?? 0;
      const rightAt = instant(kind.identity(right).publishedAt) ?? 0;
      if (leftAt !== rightAt) return (leftAt - rightAt) * direction;
      // Ties break on the stable id so one snapshot always resolves to one order.
      return kind.identity(left).id.localeCompare(kind.identity(right).id);
    });
  }

  const ordered: ResolvedShelfItem<T>[] = [
    ...pinnedItems.map((item) => ({ ...item, pinned: true })),
    ...dynamic.map((item) => ({ ...item, pinned: false })),
  ];
  // Pins count against the cap. An editor who pins more than the cap gets the first
  // ones in pin order rather than a shelf that quietly grows past what they chose.
  const items = ordered.slice(0, query.itemLimit);

  const empty = items.length === 0;
  return {
    items,
    totalMatched: matched.length,
    duplicatesDropped,
    ineligibleDropped,
    missingPins,
    empty,
    ...(empty
      ? { emptyReason: (inScopeCount === 0 ? "source_empty" : "no_matches") as ShelfEmptyReason }
      : {}),
    stale,
    checkedAt: snapshot.checkedAt,
  };
}

export function resolveTopicShelf(
  query: TopicShelfQuery,
  snapshot: ShelfSnapshot<StoryShelfItem>,
  options: ResolveShelfOptions = {},
): ResolvedShelf<StoryShelfItem> {
  return resolveShelf(
    query,
    snapshot,
    {
      inScope: (item) => item.source === query.source,
      isEligible: (item) => isEligibleStory(item),
      identity: (item) => item,
    },
    options,
  );
}

export function resolveVideoPlaylist(
  query: VideoPlaylistQuery,
  snapshot: ShelfSnapshot<VideoShelfItem>,
  options: ResolveShelfOptions = {},
): ResolvedShelf<VideoShelfItem> {
  return resolveShelf(
    query,
    snapshot,
    {
      inScope: (item) => item.library === query.library,
      isEligible: (item, nowMs) => isEligibleVideo(item, nowMs),
      identity: (item) => item,
    },
    options,
  );
}

/** A runtime as a card reads it: "12 min", or "1 hr 5 min" past the hour. */
export function formatShelfDuration(durationSeconds: number): string {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return "";
  const totalMinutes = Math.max(1, Math.round(durationSeconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}
