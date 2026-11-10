// The finite query contract behind the two dynamic blocks (#1046): a topic shelf of
// related stories and an editorial video playlist. The resolver is pure and takes the
// committed snapshot as an argument, so the editor preview and the public build run the
// same query over the same data and cannot drift.
import { describe, it, expect } from "vitest";
import {
  RELATED_STORY_INDEX,
  APPROVED_VIDEO_LIBRARY,
} from "../../packages/content-core/src/shelf-catalog";
import {
  SHELF_ITEM_LIMITS,
  SHELF_PIN_MAX,
  SHELF_SORTS,
  SHELF_TOPICS,
  SHELF_STALE_AFTER_DAYS,
  TOPIC_SHELF_SOURCES,
  VIDEO_LIBRARIES,
  isShelfTopicId,
  shelfTopicLabel,
  type StoryShelfItem,
  type VideoShelfItem,
  type ShelfSnapshot,
} from "../../packages/content-core/src/dynamic-shelves";
import {
  resolveTopicShelf,
  resolveVideoPlaylist,
} from "../../packages/content-core/src/dynamic-shelf-resolve";

const NOW = "2026-08-20T12:00:00.000Z";

function story(
  id: string,
  overrides: Partial<StoryShelfItem> = {},
): StoryShelfItem {
  return {
    id,
    source: "njpbs_related_index",
    title: `Story ${id}`,
    href: `https://www.njspotlightnews.org/${id}/`,
    topics: ["immigration"],
    publishedAt: "2026-06-01T00:00:00.000Z",
    sourceLabel: "NJ Spotlight News",
    ...overrides,
  };
}

function video(
  id: string,
  overrides: Partial<VideoShelfItem> = {},
): VideoShelfItem {
  return {
    id,
    library: "njpbs_watch",
    title: `Video ${id}`,
    href: `https://watch.njpbs.org/video/${id}/`,
    topics: ["immigration"],
    publishedAt: "2026-06-01T00:00:00.000Z",
    durationSeconds: 600,
    captioned: true,
    access: "public",
    rightsExpireAt: null,
    thumbnail: { url: "https://image.pbs.org/x.jpg", alt: "" },
    ...overrides,
  };
}

function storySnapshot(
  items: StoryShelfItem[],
  checkedAt = NOW,
): ShelfSnapshot<StoryShelfItem> {
  return { checkedAt, provenance: "test fixture", items };
}

function videoSnapshot(
  items: VideoShelfItem[],
  checkedAt = NOW,
): ShelfSnapshot<VideoShelfItem> {
  return { checkedAt, provenance: "test fixture", items };
}

describe("the bounded vocabulary an editor picks from", () => {
  it("offers only approved topics, sources, libraries, caps, and sorts", () => {
    expect(SHELF_TOPICS.length).toBeGreaterThan(0);
    for (const topic of SHELF_TOPICS) {
      expect(topic.id).toMatch(/^[a-z0-9-]+$/);
      expect(topic.label.trim()).not.toBe("");
    }
    expect(TOPIC_SHELF_SOURCES).toContain("njpbs_related_index");
    expect(VIDEO_LIBRARIES).toContain("njpbs_watch");
    expect([...SHELF_ITEM_LIMITS].every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    expect(SHELF_SORTS).toEqual(["newest", "oldest", "curated"]);
  });

  it("refuses a topic id that is not in the approved list", () => {
    expect(isShelfTopicId("immigration")).toBe(true);
    expect(isShelfTopicId("delaney-hall")).toBe(true);
    expect(isShelfTopicId("anything-an-editor-types")).toBe(false);
    expect(isShelfTopicId(7)).toBe(false);
  });

  it("names every topic in plain language", () => {
    expect(shelfTopicLabel("immigration")).toBe("Immigration");
  });
});

describe("resolveTopicShelf", () => {
  it("keeps only items carrying the chosen topic, newest first", () => {
    const snapshot = storySnapshot([
      story("a", { publishedAt: "2026-05-01T00:00:00.000Z" }),
      story("b", { topics: ["business"] }),
      story("c", { publishedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const resolved = resolveTopicShelf(
      { title: "Related", topic: "immigration", source: "njpbs_related_index", itemLimit: 4, sort: "newest" },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((item) => item.id)).toEqual(["c", "a"]);
    expect(resolved.totalMatched).toBe(2);
    expect(resolved.empty).toBe(false);
  });

  it("sorts oldest first and keeps curated order untouched", () => {
    const snapshot = storySnapshot([
      story("a", { publishedAt: "2026-05-01T00:00:00.000Z" }),
      story("c", { publishedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const query = { title: "Related", topic: "immigration", source: "njpbs_related_index", itemLimit: 4 } as const;
    expect(
      resolveTopicShelf({ ...query, sort: "oldest" }, snapshot, { now: NOW }).items.map((i) => i.id),
    ).toEqual(["a", "c"]);
    expect(
      resolveTopicShelf({ ...query, sort: "curated" }, snapshot, { now: NOW }).items.map((i) => i.id),
    ).toEqual(["a", "c"]);
  });

  it("orders equal dates by id so two builds of one snapshot agree", () => {
    const snapshot = storySnapshot([story("b"), story("a")]);
    const resolved = resolveTopicShelf(
      { title: "T", topic: "immigration", source: "njpbs_related_index", itemLimit: 4, sort: "newest" },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("drops a duplicate id and a duplicate link rather than showing a story twice", () => {
    const snapshot = storySnapshot([
      story("a"),
      story("a", { title: "Same id again" }),
      story("b", { href: "https://www.njspotlightnews.org/a/" }),
    ]);
    const resolved = resolveTopicShelf(
      { title: "T", topic: "immigration", source: "njpbs_related_index", itemLimit: 8, sort: "curated" },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["a"]);
    expect(resolved.duplicatesDropped).toBe(2);
  });

  it("treats a repeated topic on one item as one match", () => {
    const snapshot = storySnapshot([
      story("a", { topics: ["immigration", "immigration"] }),
    ]);
    const resolved = resolveTopicShelf(
      { title: "T", topic: "immigration", source: "njpbs_related_index", itemLimit: 8, sort: "curated" },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items).toHaveLength(1);
  });

  it("never returns more than the chosen cap", () => {
    const snapshot = storySnapshot(["a", "b", "c", "d", "e", "f"].map((id) => story(id)));
    const resolved = resolveTopicShelf(
      { title: "T", topic: "immigration", source: "njpbs_related_index", itemLimit: 3, sort: "curated" },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items).toHaveLength(3);
    expect(resolved.totalMatched).toBe(6);
  });

  it("puts pinned stories first, in the pinned order, ahead of the query", () => {
    const snapshot = storySnapshot([
      story("a", { publishedAt: "2026-07-01T00:00:00.000Z" }),
      story("b", { publishedAt: "2026-06-01T00:00:00.000Z" }),
      story("c", { publishedAt: "2026-05-01T00:00:00.000Z" }),
    ]);
    const resolved = resolveTopicShelf(
      {
        title: "T",
        topic: "immigration",
        source: "njpbs_related_index",
        itemLimit: 4,
        sort: "newest",
        pinned: [{ id: "c" }, { id: "b" }],
      },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(resolved.items.filter((i) => i.pinned).map((i) => i.id)).toEqual(["c", "b"]);
  });

  it("pins an approved item from the same source even when it misses the topic", () => {
    const snapshot = storySnapshot([story("a"), story("z", { topics: ["business"] })]);
    const resolved = resolveTopicShelf(
      {
        title: "T",
        topic: "immigration",
        source: "njpbs_related_index",
        itemLimit: 4,
        sort: "newest",
        pinned: [{ id: "z" }],
      },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["z", "a"]);
  });

  it("ignores a pin naming an item the snapshot does not hold", () => {
    const snapshot = storySnapshot([story("a")]);
    const resolved = resolveTopicShelf(
      {
        title: "T",
        topic: "immigration",
        source: "njpbs_related_index",
        itemLimit: 4,
        sort: "newest",
        pinned: [{ id: "gone" }],
      },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["a"]);
    expect(resolved.missingPins).toEqual(["gone"]);
  });

  it("drops a story with no usable title or link", () => {
    const snapshot = storySnapshot([
      story("a", { title: "   " }),
      story("b", { href: "javascript:alert(1)" }),
      story("c"),
    ]);
    const resolved = resolveTopicShelf(
      { title: "T", topic: "immigration", source: "njpbs_related_index", itemLimit: 8, sort: "curated" },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["c"]);
    expect(resolved.ineligibleDropped).toBe(2);
  });

  it("reports an empty shelf and why it is empty", () => {
    const noMatch = resolveTopicShelf(
      { title: "T", topic: "budget", source: "njpbs_related_index", itemLimit: 4, sort: "newest" },
      storySnapshot([story("a")]),
      { now: NOW },
    );
    expect(noMatch.empty).toBe(true);
    expect(noMatch.emptyReason).toBe("no_matches");

    const noSource = resolveTopicShelf(
      { title: "T", topic: "budget", source: "njpbs_related_index", itemLimit: 4, sort: "newest" },
      storySnapshot([]),
      { now: NOW },
    );
    expect(noSource.emptyReason).toBe("source_empty");
  });

  it("flags a snapshot that has gone stale without changing what it returns", () => {
    const items = [story("a")];
    const fresh = resolveTopicShelf(
      { title: "T", topic: "immigration", source: "njpbs_related_index", itemLimit: 4, sort: "newest" },
      storySnapshot(items, "2026-08-19T00:00:00.000Z"),
      { now: NOW },
    );
    const stale = resolveTopicShelf(
      { title: "T", topic: "immigration", source: "njpbs_related_index", itemLimit: 4, sort: "newest" },
      storySnapshot(items, "2026-01-01T00:00:00.000Z"),
      { now: NOW },
    );
    expect(fresh.stale).toBe(false);
    expect(stale.stale).toBe(true);
    expect(stale.items.map((i) => i.id)).toEqual(fresh.items.map((i) => i.id));
    expect(SHELF_STALE_AFTER_DAYS).toBeGreaterThan(0);
  });

  it("treats an unreadable checkedAt as stale rather than fresh", () => {
    const resolved = resolveTopicShelf(
      { title: "T", topic: "immigration", source: "njpbs_related_index", itemLimit: 4, sort: "newest" },
      storySnapshot([story("a")], "not a date"),
      { now: NOW },
    );
    expect(resolved.stale).toBe(true);
  });
});

describe("resolveVideoPlaylist", () => {
  it("returns only approved-library videos that carry their rights and caption metadata", () => {
    const snapshot = videoSnapshot([
      video("ok"),
      video("nocaps", { captioned: false }),
      video("expired", { rightsExpireAt: "2026-01-01T00:00:00.000Z" }),
      video("otherlib", { library: "pbs_national" }),
    ]);
    const resolved = resolveVideoPlaylist(
      { title: "Watch", topic: "immigration", library: "njpbs_watch", itemLimit: 8, sort: "curated" },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["ok"]);
    expect(resolved.ineligibleDropped).toBe(2);
  });

  it("keeps a video whose rights window has not closed yet", () => {
    const resolved = resolveVideoPlaylist(
      { title: "Watch", topic: "immigration", library: "njpbs_watch", itemLimit: 8, sort: "curated" },
      videoSnapshot([video("ok", { rightsExpireAt: "2026-12-01T00:00:00.000Z" })]),
      { now: NOW },
    );
    expect(resolved.items).toHaveLength(1);
  });

  it("drops a video with no thumbnail or no runtime rather than rendering a hole", () => {
    const snapshot = videoSnapshot([
      video("nothumb", { thumbnail: undefined as unknown as VideoShelfItem["thumbnail"] }),
      video("noduration", { durationSeconds: 0 }),
      video("ok"),
    ]);
    const resolved = resolveVideoPlaylist(
      { title: "Watch", topic: "immigration", library: "njpbs_watch", itemLimit: 8, sort: "curated" },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["ok"]);
  });

  it("keeps a member-only video and says so", () => {
    const resolved = resolveVideoPlaylist(
      { title: "Watch", topic: "immigration", library: "njpbs_watch", itemLimit: 8, sort: "curated" },
      videoSnapshot([video("passport", { access: "passport_members" })]),
      { now: NOW },
    );
    expect(resolved.items[0].access).toBe("passport_members");
  });

  it("applies the same cap, pin precedence, and empty reporting as the story shelf", () => {
    const snapshot = videoSnapshot([video("a"), video("b"), video("c"), video("d")]);
    const resolved = resolveVideoPlaylist(
      {
        title: "Watch",
        topic: "immigration",
        library: "njpbs_watch",
        itemLimit: 3,
        sort: "curated",
        pinned: [{ id: "c" }],
      },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(SHELF_PIN_MAX).toBeGreaterThan(0);
  });

  it("drops pins past the cap rather than pushing the shelf over it", () => {
    const snapshot = videoSnapshot([video("a"), video("b"), video("c"), video("d")]);
    const resolved = resolveVideoPlaylist(
      {
        title: "Watch",
        topic: "immigration",
        library: "njpbs_watch",
        itemLimit: 3,
        sort: "curated",
        pinned: [{ id: "c" }, { id: "b" }, { id: "a" }, { id: "d" }],
      },
      snapshot,
      { now: NOW },
    );
    expect(resolved.items.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });
});

describe("the committed catalogs", () => {
  it("ships a related-story index the resolver can read", () => {
    expect(RELATED_STORY_INDEX.provenance.trim()).not.toBe("");
    expect(Number.isNaN(Date.parse(RELATED_STORY_INDEX.checkedAt))).toBe(false);
    expect(new Set(RELATED_STORY_INDEX.items.map((item) => item.id)).size).toBe(RELATED_STORY_INDEX.items.length);
    expect(new Set(RELATED_STORY_INDEX.items.map((item) => item.href)).size).toBe(RELATED_STORY_INDEX.items.length);
    for (const item of RELATED_STORY_INDEX.items) {
      expect(item.source).toBe("njpbs_related_index");
      expect(item.id.trim()).not.toBe("");
      expect(item.title.trim()).not.toBe("");
      expect(new URL(item.href).origin).toBe("https://www.njspotlightnews.org");
      expect(item.topics.length).toBeGreaterThan(0);
      expect(item.topics.every((topic) => isShelfTopicId(topic))).toBe(true);
      expect(Number.isNaN(Date.parse(item.publishedAt))).toBe(false);
    }
  });

  it("ships an approved video library whose every entry carries full metadata", () => {
    expect(APPROVED_VIDEO_LIBRARY.provenance.trim()).not.toBe("");
    for (const item of APPROVED_VIDEO_LIBRARY.items) {
      expect(VIDEO_LIBRARIES).toContain(item.library);
      expect(item.captioned).toBe(true);
      expect(item.durationSeconds).toBeGreaterThan(0);
      expect(item.thumbnail.url).not.toBe("");
      expect(["public", "passport_members"]).toContain(item.access);
      expect(item.topics.every((topic) => isShelfTopicId(topic))).toBe(true);
    }
  });
});
