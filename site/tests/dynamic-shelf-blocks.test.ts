// The two dynamic blocks end to end (#1046): what the parser accepts, and what the one
// shared renderer emits for the editor preview and the public page.
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import type { RenderBlockOptions } from "../../packages/content-core/src/content-render";
import type {
  ShelfSnapshot,
  StoryShelfItem,
  VideoShelfItem,
} from "../../packages/content-core/src/dynamic-shelves";
import { RELATED_STORY_INDEX } from "../../packages/content-core/src/shelf-catalog";

function block(
  type: string,
  data: Record<string, unknown>,
  options: RenderBlockOptions = {},
): string {
  const result = parseBlocks([{ id: "b1", type, order: 0, visible: true, data }]);
  if (!result.ok) throw new Error(`invalid fixture: ${result.error}`);
  return renderBlock(result.blocks[0], options);
}

const topicShelf = {
  title: "More on Delaney Hall",
  topic: "delaney-hall",
  source: "njpbs_related_index",
  itemLimit: 4,
  sort: "newest",
};

const playlist = {
  title: "Watch: immigration",
  topic: "immigration",
  library: "njpbs_watch",
  itemLimit: 4,
  sort: "newest",
};

const videoSnapshot: ShelfSnapshot<VideoShelfItem> = {
  checkedAt: "2026-08-20T00:00:00.000Z",
  provenance: "test fixture",
  items: [
    {
      id: "v1",
      library: "njpbs_watch",
      title: "Inside the hearing",
      href: "https://watch.njpbs.org/video/v1/",
      topics: ["immigration"],
      publishedAt: "2026-07-01T00:00:00.000Z",
      durationSeconds: 1560,
      captioned: true,
      access: "passport_members",
      rightsExpireAt: null,
      thumbnail: { url: "https://image.pbs.org/v1.jpg", alt: "" },
    },
  ],
};

const emptyStories: ShelfSnapshot<StoryShelfItem> = {
  checkedAt: "2026-08-20T00:00:00.000Z",
  provenance: "test fixture",
  items: [],
};

// Rendering behavior must not depend on yesterday's editorial headlines.
const storySnapshot: ShelfSnapshot<StoryShelfItem> = {
  ...emptyStories,
  items: [
    { id: "delaney", title: "Detention hearing", topics: ["delaney-hall"] },
    { id: "budget-pin", title: "Budget hearing", topics: ["budget"] },
    ...[1, 2, 3, 4].map((n) => ({ id: `business-${n}`, title: `Business story ${n}`, topics: ["business"] })),
  ].map((item) => ({ ...item, source: "njpbs_related_index", sourceLabel: "NJ Spotlight News",
    href: `https://www.njspotlightnews.org/2026/08/${item.id}/`, publishedAt: "2026-08-19T00:00:00.000Z" })),
};

describe("parseBlocks accepts only a bounded dynamic query", () => {
  it("accepts a well-formed topic shelf and video playlist", () => {
    expect(parseBlocks([
      { id: "a", type: "topic_shelf", order: 0, visible: true, data: topicShelf },
      { id: "b", type: "video_playlist", order: 1, visible: true, data: playlist },
    ]).ok).toBe(true);
  });

  it("accepts pins and an absent pin list alike", () => {
    expect(
      parseBlocks([{ id: "a", type: "topic_shelf", order: 0, visible: true, data: { ...topicShelf, pinned: [{ id: "x" }] } }]).ok,
    ).toBe(true);
  });

  it.each([
    ["an unapproved topic", { ...topicShelf, topic: "anything-i-type" }],
    ["an unapproved source", { ...topicShelf, source: "wordpress_query" }],
    ["a cap outside the finite list", { ...topicShelf, itemLimit: 500 }],
    ["an unknown sort", { ...topicShelf, sort: "most_active" }],
    ["a free-text extra key", { ...topicShelf, query: "tag:anything" }],
    ["a missing title", { topic: "delaney-hall", source: "njpbs_related_index", itemLimit: 4, sort: "newest" }],
    ["pins past the cap", { ...topicShelf, pinned: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `p${n}` })) }],
    ["a duplicate pin", { ...topicShelf, pinned: [{ id: "x" }, { id: "x" }] }],
    ["a pin that is not an object", { ...topicShelf, pinned: ["x"] }],
  ])("refuses a topic shelf with %s", (_name, data) => {
    expect(parseBlocks([{ id: "a", type: "topic_shelf", order: 0, visible: true, data }]).ok).toBe(false);
  });

  it.each([
    ["an unapproved library", { ...playlist, library: "youtube" }],
    ["a source key it does not own", { ...playlist, source: "njpbs_related_index" }],
    ["copied items baked into the block", { ...playlist, items: [{ title: "stale copy" }] }],
  ])("refuses a video playlist with %s", (_name, data) => {
    expect(parseBlocks([{ id: "a", type: "video_playlist", order: 0, visible: true, data }]).ok).toBe(false);
  });
});

describe("the topic shelf renderer", () => {
  it("bakes the resolved stories into the page, newest first", () => {
    const html = block("topic_shelf", topicShelf, { storyShelfSnapshot: storySnapshot });
    expect(html).toContain('class="topic-shelf dynamic-shelf"');
    expect(html).toContain('data-shelf-topic="delaney-hall"');
    expect(html).toContain("More on Delaney Hall");
    expect(html).toContain(
      "https://www.njspotlightnews.org/2026/08/delaney/",
    );
    expect(html).toContain("NJ Spotlight News");
    // Baked, not fetched: no script and no client query in the published markup.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("data-derived-items");
  });

  it("honours the cap and the pin order in the emitted markup", () => {
    const html = block("topic_shelf", {
      title: "Related",
      topic: "business",
      source: "njpbs_related_index",
      itemLimit: 3,
      sort: "newest",
      pinned: [{ id: "budget-pin" }],
    }, { storyShelfSnapshot: storySnapshot });
    const titles = [...html.matchAll(/class="shelf-card__title">([^<]+)</g)].map((m) => m[1]);
    expect(titles[0]).toBe("Budget hearing");
    expect(titles).toHaveLength(3);
  });

  it("renders a designed empty state when nothing matches", () => {
    const html = block("topic_shelf", { ...topicShelf, topic: "budget" }, {
      storyShelfSnapshot: emptyStories,
    });
    expect(html).toContain("shelf-empty");
    expect(html).toContain("no related stories to show");
    expect(html).not.toContain("<li");
  });

  it("escapes shelf copy", () => {
    const html = block("topic_shelf", { ...topicShelf, title: "<Delaney> & Hall" });
    expect(html).toContain("&lt;Delaney&gt; &amp; Hall");
  });

  it("reads the committed index by default, and an injected snapshot when given one", () => {
    expect(block("topic_shelf", topicShelf)).toEqual(
      block("topic_shelf", topicShelf, { storyShelfSnapshot: RELATED_STORY_INDEX }),
    );
    expect(
      block("topic_shelf", topicShelf, { storyShelfSnapshot: emptyStories }),
    ).toContain("shelf-empty");
  });
});

describe("the video playlist renderer", () => {
  it("shows the runtime, the caption state, and the member gate on every card", () => {
    const html = block("video_playlist", playlist, { videoLibrarySnapshot: videoSnapshot });
    expect(html).toContain('class="video-playlist dynamic-shelf"');
    expect(html).toContain("Inside the hearing");
    expect(html).toContain("26 min");
    expect(html).toContain("Captioned");
    expect(html).toContain("Passport members");
    expect(html).toContain("https://image.pbs.org/v1.jpg");
  });

  it("renders the empty state the shipped library currently produces", () => {
    const html = block("video_playlist", playlist);
    expect(html).toContain("shelf-empty");
    expect(html).toContain("no videos to show");
    expect(html).not.toContain("<li");
  });

  it("never emits an uncaptioned or expired video", () => {
    const html = block("video_playlist", playlist, {
      videoLibrarySnapshot: {
        checkedAt: "2026-08-20T00:00:00.000Z",
        provenance: "test fixture",
        items: [
          { ...videoSnapshot.items[0], id: "v2", title: "Uncaptioned", captioned: false },
          {
            ...videoSnapshot.items[0],
            id: "v3",
            title: "Expired",
            rightsExpireAt: "2020-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    expect(html).not.toContain("Uncaptioned");
    expect(html).not.toContain("Expired");
    expect(html).toContain("shelf-empty");
  });
});
