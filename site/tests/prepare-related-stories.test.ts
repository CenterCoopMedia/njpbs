import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareRelatedStories, main } from "../scripts/prepare-related-stories";
import { RELATED_STORY_INDEX } from "../../packages/content-core/src/shelf-catalog";

const CHECKED = "2026-09-08T12:00:00.000Z";
const card = (slug: string, categories: string[] = ["Business"], overrides = {}) => ({
  source: "nj-spotlight-news-rss",
  title: `Story ${slug}`,
  href: `https://www.njspotlightnews.org/2026/09/${slug}/`,
  publishedAt: "Tue, 08 Sep 2026 04:00:00 +0000",
  sourceCategories: categories,
  ...overrides,
});
const source = (cards: unknown[], checkedAt = CHECKED) => ({
  source: "nj-spotlight-news-rss", checkedAt,
  request: { url: "https://www.njspotlightnews.org/feed/" }, cards,
});
const previous = { checkedAt: "2026-06-29T00:00:00.000Z", provenance: "fixture", items: [] };

describe("reviewed related-story preparation", () => {
  it("uses all exact source categories, omitting format-only items and headline guesses", () => {
    const input = source([
      card("tagged", ["Immigration", "Delaney Hall", "Politics", "IMMIGRATION"]),
      card("budget-headline", ["Politics"], { title: "Budget business immigration" }),
      card("nightly-show", ["Full Episodes", "Business"], { href: "https://www.njspotlightnews.org/video/nightly-show/" }),
      card("environment", ["Energy & Environment"]),
    ]);
    const before = JSON.stringify(input);
    const result = prepareRelatedStories([input], previous);
    expect(result.snapshot.items.map((item) => item.href)).toEqual([card("tagged").href, card("environment").href]);
    expect(result.snapshot.items[0].topics).toEqual(["immigration", "delaney-hall"]);
    expect(result.snapshot.items[1].topics).toEqual(["energy-environment"]);
    expect(result.report.skipped).toMatchObject({ noApprovedTopic: 1, invalidStory: 1 });
    expect(result.report.unmappedCategories).toContain("Politics");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("deduplicates across feeds and unions their sourced topics without losing a pin id", () => {
    const existing = { ...previous, items: [{ ...card("one"), id: "existing-pin", source: "njpbs_related_index", sourceLabel: "NJ Spotlight News", topics: ["business"] }] };
    const result = prepareRelatedStories([
      source([card("one", ["Business"])]),
      source([card("one", ["Budget"])]),
    ], existing);
    expect(result.snapshot.items).toHaveLength(1);
    expect(result.snapshot.items[0]).toMatchObject({ id: "existing-pin", topics: ["business", "budget"] });
    expect(result.report.duplicatesMerged).toBe(1);
    expect(result.report.removedIds).toEqual([]);
  });

  it("keeps the RSS image as review evidence and preserves a reviewed immutable media thumbnail", () => {
    const sourceImage = {
      url: "https://www.njspotlightnews.org/wp-content/uploads/sites/123/2026/04/story-300x169.jpg",
      width: 300,
      height: 169,
    };
    const thumbnail = { url: `https://media.njpbs.org/cms-media/spotlight/${"a".repeat(64)}/${"b".repeat(64)}.jpg`, alt: "" };
    const existing = { ...previous, items: [{
      ...card("one"),
      id: "existing-pin",
      source: "njpbs_related_index",
      sourceLabel: "NJ Spotlight News",
      topics: ["business"],
      thumbnail,
    }] };
    const result = prepareRelatedStories([
      source([card("one", ["Business"], {
        href: `${card("one").href}?from=feed#story`,
        image: "/brand/spotlight/business.jpg",
        sourceImage,
      })]),
    ], existing);

    expect(result.snapshot.items[0].thumbnail).toEqual(thumbnail);
    expect(result.sources[0].cards[0]).toMatchObject({ sourceImage });
  });

  it("retains the five reviewed media images from the default catalog", () => {
    const reviewed = RELATED_STORY_INDEX.items.filter((item) => item.thumbnail);
    const input = source(reviewed.map((item) => card("unused", ["Budget"], {
      title: item.title,
      href: item.href,
      publishedAt: item.publishedAt,
    })));
    const result = prepareRelatedStories([input]);

    expect(reviewed).toHaveLength(5);
    expect(result.snapshot.items.map(({ href, thumbnail }) => ({ href, thumbnail }))).toEqual(
      reviewed.map(({ href, thumbnail }) => ({ href, thumbnail })),
    );
  });

  it("does not promote RSS images, homepage fallback art, or unreviewed previous thumbnails", () => {
    const existing = { ...previous, items: [
      { id: "remote-pin", href: card("remote").href,
        thumbnail: { url: "https://www.njspotlightnews.org/wp-content/uploads/story.jpg", alt: "" } },
      { id: "topic-pin", href: card("topic").href,
        thumbnail: { url: "/brand/spotlight/business.jpg", alt: "" } },
      { id: "near-match-pin", href: card("near-match").href,
        thumbnail: { url: "https://media.njpbs.org/cms-media/spotlight/not-a-digest/image.webp", alt: "" } },
    ] };
    const result = prepareRelatedStories([source([
      card("remote", ["Business"], {
        sourceImage: {
          url: "https://www.njspotlightnews.org/wp-content/uploads/sites/123/2026/04/story-300x169.jpg",
          width: 300,
          height: 169,
        },
      }),
      card("topic", ["Business"], { image: "/brand/spotlight/business.jpg" }),
      card("near-match"),
    ])], existing);

    expect(result.snapshot.items).toHaveLength(3);
    expect(result.snapshot.items.every((item) => item.thumbnail === undefined)).toBe(true);
  });

  it("reports missing old ids and thin topics without inventing matches or re-dating source checks", () => {
    const existing = { ...previous, items: [{ ...card("old"), id: "pinned-old", source: "njpbs_related_index", sourceLabel: "NJ Spotlight News", topics: ["business"] }] };
    const inputs = [source([card("one")]), source([card("two")], "2026-09-08T10:00:00.000Z")];
    const result = prepareRelatedStories(inputs, existing);
    expect(result.snapshot.checkedAt).toBe("2026-09-08T10:00:00.000Z");
    expect(result.report.removedIds).toEqual(["pinned-old"]);
    expect(result.report.topicCounts).toMatchObject({ business: 2, "delaney-hall": 0 });
    expect(prepareRelatedStories(inputs, existing)).toEqual(result);
  });

  it.each(["reserved-id", "different-original-slug"])(
    "does not give a removed story's id to a different URL (old slug: %s)",
    (oldSlug) => {
      const existing = { items: [{
        id: "reserved-id",
        href: `https://www.njspotlightnews.org/2026/08/${oldSlug}/`,
      }] };
      const result = prepareRelatedStories([
        source([card("reserved-id")]),
      ], existing);
      expect(result.snapshot.items[0].id).not.toBe("reserved-id");
      expect(result.report.removedIds).toEqual(["reserved-id"]);
    },
  );

  it("does not reuse a legacy pin after an intervening refresh removes its story", () => {
    const original = { items: [{ id: "same-slug", href: "https://www.njspotlightnews.org/2026/08/same-slug/" }] };
    const withoutOriginal = prepareRelatedStories([source([card("other")])], original);
    expect(withoutOriginal.report.removedIds).toEqual(["same-slug"]);
    const later = prepareRelatedStories([source([card("same-slug")])], withoutOriginal.snapshot);
    expect(later.snapshot.items[0].id).not.toBe("same-slug");
  });

  it("keeps URL-derived IDs stable across absence and separates reused slugs", () => {
    const original = prepareRelatedStories([source([card("same-slug")])], previous);
    const absent = prepareRelatedStories([source([card("other")])], original.snapshot);
    const returned = prepareRelatedStories([source([
      card("same-slug", ["Business"], { href: `${card("same-slug").href}?from=feed#story` }),
      card("same-slug", ["Budget"], { href: "https://www.njspotlightnews.org/2026/08/same-slug/" }),
    ])], absent.snapshot);
    expect(returned.snapshot.items[0].id).toBe(original.snapshot.items[0].id);
    expect(returned.snapshot.items[0].id).toMatch(/^njspotlight-[a-f0-9]{64}$/);
    expect(returned.snapshot.items[1].id).not.toBe(original.snapshot.items[0].id);
  });

  it("refuses an existing custom ID that conflicts with another URL's generated ID", () => {
    const generated = prepareRelatedStories([source([card("one")])], previous).snapshot.items[0];
    expect(() => prepareRelatedStories([source([card("one")])], {
      items: [{ id: generated.id, href: card("other").href }],
    })).toThrow(/id collision/i);
  });

  it.each([
    source([{ ...card("legacy"), sourceCategories: undefined }]),
    { ...source([card("one")]), source: "other" },
    { ...source([card("one")]), checkedAt: "not-a-date" },
    { ...source([card("one")]), request: { url: "https://example.com/feed/" } },
    source(Array.from({ length: 101 }, (_, i) => card(String(i)))),
  ])("refuses an unverifiable or oversized input", (input) => {
    expect(() => prepareRelatedStories([input], previous)).toThrow();
  });

  it("rejects unsafe destinations, missing dates, and dates beyond the source check", () => {
    const result = prepareRelatedStories([source([
      card("valid"),
      card("bad-host", ["Budget"], { href: "https://www.njspotlightnews.org.evil.test/2026/09/bad/" }),
      card("bad-date", ["Budget"], { publishedAt: "unknown" }),
      card("future", ["Budget"], { publishedAt: "2027-01-01T00:00:00.000Z" }),
    ])], previous);
    expect(result.snapshot.items).toHaveLength(1);
    expect(result.report.skipped.invalidStory).toBe(3);
  });

  it("refuses empty and oversized candidate indexes", () => {
    expect(() => prepareRelatedStories([source([card("none", ["Watch"])])], previous)).toThrow(/no eligible/i);
    expect(() => prepareRelatedStories([], previous)).toThrow();
    expect(() => prepareRelatedStories(Array.from({ length: 11 }, () => source([])), previous)).toThrow();
    expect(() => prepareRelatedStories(Array.from({ length: 3 }, (_, batch) => source(
      Array.from({ length: 100 }, (_, i) => card(`${batch}-${i}`)),
    )), previous)).toThrow(/250/);
  });

  it("writes only an explicit candidate destination and leaves it intact when preparation fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "related-stories-"));
    const input = path.join(directory, "input.json");
    const output = path.join(directory, "candidate.json");
    try {
      await writeFile(input, JSON.stringify(source([card("one")])));
      await expect(main(["--input", input])).rejects.toThrow(/output/i);
      await main(["--input", input, "--output", output]);
      const saved = await readFile(output, "utf8");
      expect(JSON.parse(saved).items[0].href).toBe(card("one").href);
      await writeFile(input, JSON.stringify(source([])));
      await expect(main(["--input", input, "--output", output])).rejects.toThrow();
      expect(await readFile(output, "utf8")).toBe(saved);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
