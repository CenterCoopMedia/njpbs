// @vitest-environment node
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/home-sources/newscast-documented-schema.json";
import posts from "./fixtures/home-sources/station-posts.json";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL, HOME_NEWSCAST_PROGRAM_HREF } from "../../packages/content-core/src/home-newscast-source";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import type { HomeCardSnapshot, HomeSourceCard } from "../../packages/content-core/src/home-source-curation";
import { contentLink } from "../../packages/content-core/src/content-link.ts";
import { selectNotFoundCards } from "../src/lib/not-found-content";
import { createHomeNewscastPacket } from "../../packages/content-core/src/home-newscast-published";

const cutoffAt = "2026-10-11T15:00:00Z";
const receipt = { status: "ready" as const, source: "pbs_media_manager" as const,
  requestUrl: HOME_NEWSCAST_ASSETS_URL, checkedAt: "2026-10-11T14:30:00Z", complete: true, response: fixture };
const newscast = adaptLatestHomeNewscast(receipt, cutoffAt);
const story = { ...posts[0], title: "Synthetic station news story", categories: ["NJ PBS News"], tags: [] };
const spotlightStory: HomeSourceCard = { id: "synthetic-spotlight-story", source: "spotlight_news",
  href: "https://www.njspotlightnews.org/2026/10/synthetic-story/", title: "Synthetic Spotlight story",
  sourceLabel: "NJ Spotlight News", publishedAt: "2026-10-11T13:00:00Z", displayDate: "2026-10-11" };
// This tests selection, not snapshot admission. Production passes only the
// validated public collection; test fixtures never enter the page frontmatter.
const sources = (snapshot: HomeCardSnapshot) => ({
  schemaVersion: 1,
  pbs: { source: "media-manager", checkedAt: cutoffAt, featured: [], more: [] },
  spotlight: { source: "spotlight-rss", checkedAt: cutoffAt, cards: [] },
  editorial: { catalog: { sources: { "home-spotlight": snapshot } } },
} as unknown as HomeSourceSnapshot);
const feed = (cards: HomeSourceCard[] = [spotlightStory]) => sources({ status: "ready", checkedAt: cutoffAt, cards });

describe("404 public recovery selection", () => {
  it("keeps the full broadcast, distinct station story and external Spotlight article in that order", () => {
    const result = selectNotFoundCards({ posts: [story], sources: feed(), newscast, cutoffAt });
    expect(result.map(card => card.slot)).toEqual(["newscast", "station-story", "spotlight-story"]);
    expect(result.map(card => card.sourceLabel)).toEqual(["NJ PBS News", "NJ PBS News", "NJ Spotlight News"]);
    expect(result.every(card => !card.fallback)).toBe(true);
    expect(result[0]).toMatchObject({ kind: "Full newscast", date: "2026-10-09" });
    expect(result[1].href).toBe(story.path);
    expect(result[2].href).toBe(spotlightStory.href);
  });

  it("keeps an undated newscast playable without a fabricated recovery-card date", () => {
    const source = structuredClone(newscast);
    source.episode!.title = "NJ PBS News with Rob Nelson";
    source.episode!.episodeDate = null;
    const card = selectNotFoundCards({ posts: [], cutoffAt, newscast: source })[0];
    expect(card).toMatchObject({ fallback: false, title: "NJ PBS News with Rob Nelson", href: source.episode!.href });
    expect(card).not.toHaveProperty("date");
  });

  it("keeps a categorized undated full broadcast out of the station-story slot", () => {
    const source = structuredClone(newscast);
    source.episode!.title = "NJ PBS News with Rob Nelson";
    source.episode!.episodeDate = null;
    const broadcastPost = { ...story, id: "undated-broadcast", title: source.episode!.title };
    const cards = selectNotFoundCards({ posts: [broadcastPost], cutoffAt, newscast: source });
    expect(cards[0]).toMatchObject({ fallback: false, title: "NJ PBS News with Rob Nelson" });
    expect(cards[1]).toMatchObject({ slot: "station-story", fallback: true });
  });

  it("does not call an incomplete or unavailable broadcast receipt the latest episode", () => {
    for (const newscast of [undefined, adaptLatestHomeNewscast({ ...receipt, complete: false }, cutoffAt), adaptLatestHomeNewscast({ status: "error" }, cutoffAt)]) {
      const card = selectNotFoundCards({ posts: [], cutoffAt, newscast })[0];
      expect(card).toMatchObject({ fallback: true, href: HOME_NEWSCAST_PROGRAM_HREF, action: "Browse broadcasts" });
      expect(card.date).toBeUndefined();
    }
  });

  it("uses the same published episode as Home and withdraws it at its rights boundary", () => {
    const expected = fixture.data[0].attributes;
    expect(selectNotFoundCards({ posts: [], cutoffAt, newscast })[0]).toMatchObject({
      title: expected.title, image: newscast.episode!.poster.url, href: newscast.episode!.href, fallback: false,
    });
    expect(selectNotFoundCards({ posts: [], cutoffAt: newscast.episode!.publicWindow.endsAt!, newscast })[0])
      .toMatchObject({ fallback: true, href: HOME_NEWSCAST_PROGRAM_HREF });
  });

  it("uses the retained PBS packet when an editorial catalog has no newscast service, respecting expiry", () => {
    const mixed = feed();
    mixed.pbs.newscast = createHomeNewscastPacket(newscast);
    const expected = fixture.data[0].attributes;
    for (const services of [undefined, { newsletters: { status: "error" as const } }]) {
      mixed.editorial!.catalog.services = services;
      expect(selectNotFoundCards({ posts: [], sources: mixed, cutoffAt })[0]).toMatchObject({
        title: expected.title, image: expected.images[0].image,
        href: `https://watch.njpbs.org/video/${expected.slug}/`, fallback: false,
      });
      expect(selectNotFoundCards({ posts: [], sources: mixed, cutoffAt: expected.availabilities.public.end })[0])
        .toMatchObject({ fallback: true, href: HOME_NEWSCAST_PROGRAM_HREF });
    }
    mixed.editorial!.catalog.services = { newsletters: { status: "error" },
      newscast: adaptLatestHomeNewscast({ status: "error" }, cutoffAt) };
    expect(selectNotFoundCards({ posts: [], sources: mixed, cutoffAt })[0])
      .toMatchObject({ fallback: true, href: HOME_NEWSCAST_PROGRAM_HREF });
  });

  it("carries a station title background into the recovery card", () => {
    const post = { ...story, heroImage: undefined, heroBackgroundImage: posts[0].heroImage };
    expect(selectNotFoundCards({ posts: [post], cutoffAt })[1])
      .toMatchObject({ fallback: false, image: posts[0].heroImage.url });
  });

  it("does not substitute a general post, imported Spotlight article or full broadcast for a station story", () => {
    const unrelated = { ...story, categories: ["News"], tags: [] };
    const imported = { ...story, spotlightNews: true };
    const full = { ...story, title: "NJ PBS News with Rob Nelson | October 9, 2026" };
    const card = selectNotFoundCards({ posts: [unrelated, imported, full], cutoffAt, newsIndexAvailable: true })[1];
    expect(card).toMatchObject({ fallback: true, href: "/posts/" });
  });

  it.each([
    ["private working document", { status: "draft", published: story }],
    ["unlisted story", { ...story, noindex: true }],
    ["future display date", { ...story, displayDate: "2027-01-01" }],
    ["invalid sort instant", { ...story, sortInstant: NaN }],
    ["future first publication despite a past display date", { ...story, firstPublishedAt: "2027-01-01T00:00:00Z" }],
    ["malformed first publication", { ...story, firstPublishedAt: "not-an-instant" }],
    ["empty first publication", { ...story, firstPublishedAt: "" }],
    ["future published snapshot", { ...story, publishedAt: "2027-01-01T00:00:00Z" }],
  ])("rejects a %s", (_reason, post) => {
    expect(selectNotFoundCards({ posts: [post], cutoffAt })[1].fallback).toBe(true);
  });

  it("retains eligible legacy projections and allows publication at the cutoff", () => {
    for (const firstPublishedAt of [undefined, null, cutoffAt]) {
      const post = { ...story, firstPublishedAt };
      expect(selectNotFoundCards({ posts: [post], cutoffAt })[1].fallback).toBe(false);
    }
  });

  it("selects the later Spotlight article on the same day and rejects future or unsafe links", () => {
    const newer = { ...spotlightStory, id: "newer", href: "https://www.njspotlightnews.org/2026/10/newer/",
      publishedAt: "2026-10-11T14:00:00Z" };
    const future = { ...newer, id: "future", href: "https://www.njspotlightnews.org/future/", publishedAt: "2027-01-01T00:00:00Z" };
    const unsafe = { ...newer, id: "unsafe", href: "javascript:alert(1)", publishedAt: "2026-10-11T14:30:00Z" };
    const card = selectNotFoundCards({ posts: [], sources: feed([spotlightStory, unsafe, future, newer]), cutoffAt })[2];
    expect(card).toMatchObject({ href: newer.href, fallback: false });
  });

  it("does not resurrect legacy articles when the current admitted source is empty or unavailable", () => {
    const unavailable: HomeCardSnapshot[] = [
      { status: "ready", checkedAt: cutoffAt, cards: [] }, { status: "error" },
    ];
    for (const snapshot of unavailable) {
      const input = sources(snapshot);
      input.spotlight.cards = [{ title: "Old legacy title", href: spotlightStory.href, image: "", category: "New Jersey", dateLabel: "" }];
      const card = selectNotFoundCards({ posts: [], sources: input, cutoffAt })[2];
      expect(card).toMatchObject({ fallback: true, href: "https://www.njspotlightnews.org/" });
      expect(card.title).not.toBe("Old legacy title");
    }
  });

  it("keeps a safe home fallback without the posts route and refuses an invalid cutoff", () => {
    expect(selectNotFoundCards({ posts: [], cutoffAt })[1].href).toBe("/");
    expect(() => selectNotFoundCards({ posts: [], cutoffAt: "not-a-date" })).toThrow();
  });
});

it.each([true, false])("retains a station story's custom destination and new-tab choice (%s) on 404 recovery cards", contentLinkNewTab => {
  const settings = { contentLinkMode: "custom" as const, contentLinkUrl: "https://example.test/coverage", contentLinkNewTab };
  const card = selectNotFoundCards({ posts: [{ ...story, ...settings }], cutoffAt })[1];
  expect(card).toMatchObject({ href: "https://example.test/coverage", ...settings });
  expect(contentLink(card, card.href)).toEqual(contentLinkNewTab
    ? { href: "https://example.test/coverage", external: true, newTab: true, target: "_blank", rel: "noopener noreferrer" }
    : { href: "https://example.test/coverage", external: true, newTab: false });
});
