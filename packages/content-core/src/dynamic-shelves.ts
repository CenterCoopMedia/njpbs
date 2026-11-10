// The finite query contract behind the two dynamic blocks from the 2026-08-18
// editorial test (#1046): a TOPIC SHELF of related stories and an editorial VIDEO
// PLAYLIST. Brent asked for reusable playlists and related-content groups driven by a
// topic; Joe bounded that to approved tags and categories with a chosen order.
//
// Three properties are load-bearing and are enforced here rather than left to the
// surfaces that call it:
//
//   1. The query is FINITE. An editor picks a topic, a source, a cap, and a sort from
//      closed vocabularies declared in this file. There is no free-text query, no
//      arbitrary filter expression, and no way to widen the source list from stored
//      content: an unapproved value fails the block parser (content-model.ts) before
//      it can reach a resolver.
//   2. The query is DETERMINISTIC and runs at BUILD TIME. `resolveShelf` is pure: the
//      same query over the same snapshot returns the same ordered items, ties broken
//      on the stable item id so two builds of one snapshot cannot disagree. Nothing
//      here fetches, and the resolved list is baked into the published HTML, so a
//      published page never runs a client query against a live feed.
//   3. The editor preview and the public renderer run THIS function over the SAME
//      committed snapshot (shelf-catalog.ts), so what an editor is shown is what the
//      build will publish. That is the parity the issue asks for, and it is a property
//      of the import graph rather than of a sync check.
//
// Staleness is reported, never acted on: `stale` says the committed snapshot has not
// been refreshed recently, and the admin surfaces it, but it does not change which
// items resolve. A time-varying item set would break property 2.
//
// This module holds the VOCABULARY and the item shapes only: what an editor may choose and
// what a catalog entry carries. Resolution lives beside it in dynamic-shelf-resolve.ts.
// The split is not cosmetic. The block parser and the editor's field descriptors need the
// vocabulary, and both are in the admin's entry chunk, while the resolver is needed only
// where a shelf is actually rendered -- so keeping the two together put the resolver, and
// through it the committed catalogs, in front of every signed-in editor before any route
// mounted.

// ---------------------------------------------------------------------------
// The bounded vocabularies
// ---------------------------------------------------------------------------

/**
 * One approved topic an editor may point a shelf or playlist at. Id and label only: the
 * reason a topic is on the list is review documentation, and it is written below rather
 * than carried as a data field, because this module ships to the browser in the admin's
 * entry chunk and prose nothing renders is weight every editor downloads.
 */
export interface ShelfTopic {
  id: string;
  label: string;
}

/**
 * The approved topic list. This is the whole vocabulary: an editor picks from it and
 * cannot type a tag, so a shelf can never query a topic nobody approved.
 *
 * PROVENANCE, and the part that needs a newsroom decision:
 * These ids originated with the six-story 2026-06-29 seed and Brent's Delaney Hall
 * example in #1046. The old homepage snapshot did not preserve raw RSS categories:
 * its topic matcher also reads headlines and links. Those labels alone therefore
 * do not establish publisher classification or newsroom sign-off.
 *
 * Reviewed refreshes now match the publisher's preserved source categories/tags
 * exactly to these labels. They never add vocabulary or infer running-story tags
 * from headlines. Watch/Full Episodes is a format and is not a shelf topic.
 * This remains the current permitted vocabulary, pending newsroom approval or
 * replacement under #1117.md.
 */
export const SHELF_TOPICS: readonly ShelfTopic[] = Object.freeze([
  Object.freeze({ id: "budget", label: "Budget" }),
  Object.freeze({ id: "business", label: "Business" }),
  Object.freeze({ id: "delaney-hall", label: "Delaney Hall" }),
  Object.freeze({ id: "energy-environment", label: "Energy and environment" }),
  Object.freeze({ id: "immigration", label: "Immigration" }),
  Object.freeze({ id: "social-issues", label: "Social issues" }),
]);

export type ShelfTopicId = string;

const SHELF_TOPIC_IDS: ReadonlySet<string> = new Set(SHELF_TOPICS.map((t) => t.id));

export function isShelfTopicId(value: unknown): value is ShelfTopicId {
  return typeof value === "string" && SHELF_TOPIC_IDS.has(value);
}

/** The plain-language name of a topic, or the id when it is not an approved one. */
export function shelfTopicLabel(id: string): string {
  return SHELF_TOPICS.find((topic) => topic.id === id)?.label ?? id;
}

/**
 * The approved sources of related STORIES. One entry today: the committed
 * related-story index in shelf-catalog.ts. It is an enum rather than a boolean so a
 * second approved source (station posts, once the public post set is large enough to
 * query) is one entry plus its snapshot, not a schema change.
 */
export const TOPIC_SHELF_SOURCES = ["njpbs_related_index"] as const;
export type TopicShelfSource = (typeof TOPIC_SHELF_SOURCES)[number];

/**
 * The approved VIDEO libraries. Only NJ PBS and PBS libraries appear here, per the
 * issue: a playlist cannot point at YouTube, a social platform, or a station-hosted
 * file. `njpbs_watch` is the station's own on-demand portal (watch.njpbs.org, backed
 * by PBS Media Manager); `pbs_national` is national PBS content the station is cleared
 * to present.
 */
export const VIDEO_LIBRARIES = ["njpbs_watch", "pbs_national"] as const;
export type VideoLibraryId = (typeof VIDEO_LIBRARIES)[number];

export const VIDEO_LIBRARY_LABELS: Readonly<Record<VideoLibraryId, string>> =
  Object.freeze({
    njpbs_watch: "NJ PBS video library",
    pbs_national: "PBS national library",
  });

/** The caps an editor may choose. Bounded so no shelf can ask for an unbounded feed. */
export const SHELF_ITEM_LIMITS = [3, 4, 6, 8, 12] as const;
export type ShelfItemLimit = (typeof SHELF_ITEM_LIMITS)[number];

/**
 * The orders an editor may choose.
 *
 * NEEDS A DECISION: Joe asked for "newest or most active". `most_active` is not here
 * because nothing in this repository measures activity -- there is no analytics feed,
 * comment count, or play count the build can read -- and inventing a ranking would be
 * a number the page states and nobody can source. `curated` is the honest third mode:
 * the order the approved index itself carries. Adding `most_active` is one entry plus
 * a sourced signal on the snapshot.
 */
export const SHELF_SORTS = ["newest", "oldest", "curated"] as const;
export type ShelfSort = (typeof SHELF_SORTS)[number];

export const SHELF_SORT_LABELS: Readonly<Record<ShelfSort, string>> = Object.freeze({
  newest: "Newest first",
  oldest: "Oldest first",
  curated: "The order the approved list carries",
});

/**
 * The most items an editor may pin by hand. Pins take precedence over the query, so
 * an unbounded pin list would be a hand-built shelf wearing a dynamic block's name.
 */
export const SHELF_PIN_MAX = 6;

/** How old a committed snapshot may be before the admin calls it stale. */
export const SHELF_STALE_AFTER_DAYS = 30;

// ---------------------------------------------------------------------------
// The items a snapshot holds
// ---------------------------------------------------------------------------

export interface ShelfThumbnail {
  url: string;
  /**
   * Contextual text. Empty when the thumbnail repeats the title beside it, which is
   * the usual case for a card: the title carries the meaning and a second reading of
   * it is noise.
   */
  alt: string;
}

/** One approved related story. */
export interface StoryShelfItem {
  id: string;
  source: TopicShelfSource;
  title: string;
  href: string;
  topics: readonly ShelfTopicId[];
  /** ISO-8601 instant used by the newest/oldest sorts. */
  publishedAt: string;
  /** Who published it, shown on the card so an outbound link is never a surprise. */
  sourceLabel: string;
  summary?: string;
  thumbnail?: ShelfThumbnail;
}

/**
 * One approved video. Every field the issue names is required rather than optional,
 * and `isEligibleVideo` refuses an entry missing any of them: a playlist may not
 * publish a video whose rights, captioning, runtime, thumbnail, or member gating the
 * station cannot state.
 */
export interface VideoShelfItem {
  id: string;
  library: VideoLibraryId;
  title: string;
  href: string;
  topics: readonly ShelfTopicId[];
  publishedAt: string;
  /** Runtime in seconds. Shown on the card; a zero or missing runtime is refused. */
  durationSeconds: number;
  /** Closed captions confirmed present. An uncaptioned video is never published here. */
  captioned: boolean;
  /** Who may watch: everyone, or Passport members. Shown on the card. */
  access: "public" | "passport_members";
  /** ISO-8601 instant the presentation rights end, or null for an open window. */
  rightsExpireAt: string | null;
  thumbnail: ShelfThumbnail;
  description?: string;
}

/** A committed, dated snapshot of approved items. */
export interface ShelfSnapshot<T> {
  /** ISO-8601 instant the snapshot was taken. */
  checkedAt: string;
  /** Where the entries came from, in a sentence a reviewer can check. */
  provenance: string;
  items: readonly T[];
}

/** One manual pin. An object rather than a bare id so the editor list UI can hold it. */
export interface ShelfPin {
  id: string;
}
