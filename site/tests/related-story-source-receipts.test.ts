import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import images from "./fixtures/public-contracts/story-images.json";
import receipts from "./fixtures/public-contracts/story-sources.json";
import { spotlightCopyImageUrl } from "../../packages/content-core/src/spotlight-image.mjs";
import { RELATED_STORY_INDEX } from "../../packages/content-core/src/shelf-catalog";
import { prepareRelatedStories } from "../scripts/prepare-related-stories";

describe("the September 8 related-story source receipts", () => {
  it("reproduces every committed story and topic from the retained publisher metadata", () => {
    const inputs = receipts.sources.map((source) => ({
      source: "nj-spotlight-news-rss",
      request: { url: source.url },
      checkedAt: source.checkedAt,
      cards: source.cards.map((card) => ({ ...card, source: "nj-spotlight-news-rss" })),
    }));
    // Reproduce from the prior catalog, not the candidate under test: otherwise
    // an accidentally changed candidate id would be accepted as an existing pin.
    const prepared = prepareRelatedStories(inputs, receipts.previousCatalog);
    const enriched = prepared.snapshot.items.map(story => {
      const image = images.images.find(image => image.id === story.id);
      if (!image) return story;
      expect(image.articleUrl).toBe(story.href);
      expect(image.thumbnail.url).toBe(image.mediaUrl);
      expect(spotlightCopyImageUrl(image.mediaUrl)).toBe(image.mediaUrl);
      expect(new URL(image.mediaUrl).pathname.split("/").at(-2))
        .toBe(createHash("sha256").update(image.sourceUrl).digest("hex"));
      expect(new URL(image.mediaUrl).pathname.split("/").at(-1)).toBe(`${image.sha256}.jpg`);
      return { ...story, thumbnail: image.thumbnail };
    });
    expect(new Set(images.images.map(image => image.id)).size).toBe(images.images.length);
    expect(images.images.every(image => prepared.snapshot.items.some(story => story.id === image.id))).toBe(true);
    expect({ ...prepared.snapshot, items: enriched,
      provenance: `${prepared.snapshot.provenance} ${images.provenance}` }).toEqual(RELATED_STORY_INDEX);
    expect(prepared.report).toEqual(receipts.report);
  });
});
