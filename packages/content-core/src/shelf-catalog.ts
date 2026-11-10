// The committed snapshots the dynamic blocks (#1046) query at build time.
//
// Both the admin preview and the public build import THIS file and run the same
// resolver over it, which is what makes "the editor sees what will publish" a property
// of the import graph rather than a promise. Nothing here is fetched: a snapshot is
// committed data with a date and a provenance sentence, the same way
// site/src/data/spotlight-news.json and site/src/data/launch-media-manager.json
// already are. Refreshing a snapshot is a reviewed commit, not a runtime event.

import type {
  ShelfSnapshot,
  StoryShelfItem,
  VideoShelfItem,
} from "./dynamic-shelves";

// Related-story data is a reviewed JSON snapshot. The preparation command and
// source receipts live outside the browser import graph; both consumers still
// receive this same frozen catalog.
import relatedStories from "./data/related-stories.json";

export const RELATED_STORY_INDEX: ShelfSnapshot<StoryShelfItem> = Object.freeze({
  ...relatedStories,
  items: Object.freeze(relatedStories.items.map((item) => Object.freeze({
    ...item,
    topics: Object.freeze(item.topics),
  }))),
}) as ShelfSnapshot<StoryShelfItem>;

/**
 * The approved video library.
 *
 * IT SHIPS EMPTY, DELIBERATELY. A playlist entry has to carry the runtime, the caption
 * status, the rights window, the thumbnail, and whether the video is Passport-gated
 * (#1046), and the resolver refuses an entry missing any of them. This repository does
 * not hold that metadata for a single video: the committed Media Manager snapshot
 * (site/src/data/launch-media-manager.json, checked 2026-06-29) is a SHOW list -- title,
 * description, portal link, key art -- with no asset-level runtime, captions, or
 * availability window, and the credentialed Media Manager asset fetch that would carry
 * them is still the deferred half of the catalog work. Writing plausible runtimes and
 * caption flags here would put numbers on a public page that nobody can source, which
 * is exactly what the repository's guardrails forbid.
 *
 * So the block is complete and the shelf is honest: an editor who adds a video playlist
 * today sees, in the editor and on the page, that no approved video has cleared its
 * rights and caption metadata yet. Two ways to fill it, either of which is a data
 * change and no code change:
 *   1. Brian Lee or the PBS Media Manager asset fetch supplies per-asset runtime,
 *      caption, availability, and thumbnail values for the videos NJ PBS wants
 *      playlist-eligible.
 *   2. Joe confirms a hand-curated starter set with those five facts per video.
 */
export const APPROVED_VIDEO_LIBRARY: ShelfSnapshot<VideoShelfItem> = Object.freeze({
  checkedAt: "2026-08-22T00:00:00.000Z",
  provenance:
    "Empty pending per-asset video metadata. The committed Media Manager snapshot is a show list with no runtime, caption, or availability data, and the credentialed asset fetch that would carry them has not landed; no entry is added until its rights, captions, runtime, thumbnail, and access are sourced.",
  items: Object.freeze([]),
}) as ShelfSnapshot<VideoShelfItem>;
