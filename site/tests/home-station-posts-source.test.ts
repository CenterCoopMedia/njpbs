// @vitest-environment node
import { describe, expect, it } from "vitest";
import posts from "./fixtures/home-sources/station-posts.json";
import { adaptHomeStationPosts } from "../../packages/content-core/src/home-station-posts-source";

const cutoffAt = "2026-10-11T15:00:00Z";
const snapshot = { status: "ready" as const, checkedAt: "2026-10-11T14:56:00Z", posts };
describe("frozen station Post collection", () => {
  it("preserves real public dates and credits in the established editorial order", () => {
    const result = adaptHomeStationPosts(snapshot, { cutoffAt });
    expect(result.source).toBe("station_posts");
    expect(result.cards.map(card => card.title)).toEqual([
      "NJ PBS announces Rob Nelson as anchor of new daily newscast", "NJ PBS announces six staff appointments",
    ]);
    expect(result.cards[0]).toMatchObject({ id: "1208e81a5470be941e3fb392eac674ae", sourceVersion: 40,
      href: "/posts/nj-pbs-announces-rob-nelson-as-anchor-of-new-daily-newscast/",
      byline: "NJ PBS", displayDate: "2026-09-16", publishedAt: "2026-10-03T22:56:21.054Z",
      image: { alt: "A portrait of journalist Rob Nelson smiling and wearing a suit." } });
    expect(result.browseHref).toBe("/posts/");
  });

  it("prefers the lead image and uses a title background decoratively only when the lead is absent", () => {
    const heroBackgroundImage = { ...posts[0].heroImage, url: posts[1].heroImage.url };
    const cardFor = (post: unknown) => adaptHomeStationPosts({ ...snapshot, posts: [post] }, { cutoffAt }).cards[0];
    expect(cardFor({ ...posts[0], heroBackgroundImage }).image)
      .toEqual({ url: posts[0].heroImage.url, alt: posts[0].heroImageAlt });
    expect(cardFor({ ...posts[0], heroImage: undefined, heroBackgroundImage }).image)
      .toEqual({ url: heroBackgroundImage.url, alt: "" });
    expect(cardFor({ ...posts[0], heroImage: undefined, heroBackgroundImage: { url: "javascript:alert(1)" } }).image)
      .toBeUndefined();
  });

  it("keeps the existing approved decorative background fallback for a video lead without a poster", () => {
    const post = { ...posts[0], leadMedia: { kind: "embed", data: { url: "https://youtu.be/dQw4w9WgXcQ", title: "County meeting" } },
      heroImage: null, heroBackgroundImage: posts[1].heroImage };
    expect(adaptHomeStationPosts({ ...snapshot, posts: [post] }, { cutoffAt }).cards[0].image)
      .toEqual({ url: posts[1].heroImage.url, alt: "" });
  });

  it("uses a valid decorative background when the lead image fails validation", () => {
    const heroBackgroundImage = posts[1].heroImage;
    const post = { ...posts[0], heroImage: { url: "javascript:alert(1)" }, heroBackgroundImage };
    expect(adaptHomeStationPosts({ ...snapshot, posts: [post] }, { cutoffAt }).cards[0].image)
      .toEqual({ url: heroBackgroundImage.url, alt: "" });
  });

  it("uses a lead-media-only Post image and its own alt before decorative topic art", () => {
    const leadMedia = { kind: "image", data: { assetId: "photo", alt: "Young voters outside a polling place" } };
    const post = { ...posts[0], heroImage: "", heroImageAlt: "Stale legacy alt", leadMedia,
      assets: { photo: posts[0].heroImage }, heroBackgroundImage: posts[1].heroImage };
    const cardFor = (value: unknown) => adaptHomeStationPosts({ ...snapshot, posts: [value] }, { cutoffAt }).cards[0];
    expect(cardFor(post).image).toEqual({ url: posts[0].heroImage.url, alt: leadMedia.data.alt });
    expect(cardFor({ ...post, heroImage: posts[1].heroImage }).image)
      .toEqual({ url: posts[1].heroImage.url, alt: post.heroImageAlt });
    expect(cardFor({ ...post, leadMedia: { ...leadMedia, data: { ...leadMedia.data, alt: "", altDecorative: true } } }).image)
      .toEqual({ url: posts[0].heroImage.url, alt: "" });
    expect(cardFor({ ...post, assets: { photo: { url: "javascript:alert(1)" } } }).image)
      .toEqual({ url: posts[1].heroImage.url, alt: "" });
    expect(cardFor({ ...post, assets: {} }).image).toEqual({ url: posts[1].heroImage.url, alt: "" });
  });

  it("manual selections stay in the Post source and cannot introduce a working document", () => {
    const selectedIds = [posts[1].postId, posts[0].postId];
    expect(adaptHomeStationPosts(snapshot, { cutoffAt, selectedIds }).cards.map(card => card.id)).toEqual(selectedIds);
    const working = { id: posts[0].postId, type: "post", title: "Private working title", status: "draft", published: posts[0] };
    expect(adaptHomeStationPosts({ ...snapshot, posts: [working] }, { cutoffAt, selectedIds: [posts[0].postId] }))
      .toMatchObject({ cards: [], missingIds: [posts[0].postId], emptyReason: "selection_unavailable" });
    expect(adaptHomeStationPosts({ ...snapshot, posts: [] }, { cutoffAt }).emptyReason).toBe("source_empty");
    expect(adaptHomeStationPosts({ status: "error" }, { cutoffAt }).emptyReason).toBe("source_error");
  });

  it("omits future/unsafe posts, honors explicit source attribution and never invents authors", () => {
    const future = { ...posts[0], publishedAt: "2027-01-01T00:00:00Z" };
    const unsafe = { ...posts[1], path: "https://www.njspotlightnews.org/story/" };
    expect(adaptHomeStationPosts({ ...snapshot, posts: [future, unsafe] }, { cutoffAt }).cards).toEqual([]);
    const credited = adaptHomeStationPosts({ ...snapshot, posts: [{ ...posts[0], spotlightNews: true, credits: [] }] }, { cutoffAt });
    expect(credited.cards[0].sourceLabel).toBe("NJ Spotlight News");
    expect(credited.cards[0]).not.toHaveProperty("byline");
    expect(JSON.stringify(credited)).not.toContain("authorId");
  });

  it("excludes unlisted Posts and keeps legacy or unknown dates stable after a republish", () => {
    const hidden = { ...posts[0], noindex: true };
    expect(adaptHomeStationPosts({ ...snapshot, posts: [hidden] }, { cutoffAt, selectedIds: [posts[0].postId] }).cards).toEqual([]);
    const legacy = { ...posts[1], firstPublishedAt: null, sortInstant: Date.parse("2026-09-01T04:00:00.000Z"), publishedAt: "2026-10-11T14:59:59Z" };
    expect(adaptHomeStationPosts({ ...snapshot, posts: [legacy, posts[0]] }, { cutoffAt }).cards.map(card => card.id))
      .toEqual(["1208e81a5470be941e3fb392eac674ae", "57298ff3b0d0917f9e653f80bada063d"]);
    const unknown = { ...posts[0], sortInstant: null, displayDate: null };
    expect(adaptHomeStationPosts({ ...snapshot, posts: [unknown, legacy] }, { cutoffAt }).cards.map(card => card.id))
      .toEqual(["57298ff3b0d0917f9e653f80bada063d", "1208e81a5470be941e3fb392eac674ae"]);
  });

  it("retains the existing excerpt fallback for a Post without a summary", () => {
    const excerptOnly = { ...posts[0], summary: "", excerpt: posts[0].summary };
    expect(adaptHomeStationPosts({ ...snapshot, posts: [excerptOnly] }, { cutoffAt }).cards[0].summary)
      .toBe("Veteran journalist and New Jersey native will lead NJ PBS News with Rob Nelson, launching as part of the station's new era under Montclair State University");
  });
});
