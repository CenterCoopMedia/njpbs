// @vitest-environment node
import { describe, expect, it } from "vitest";
import feed from "./fixtures/home-sources/spotlight-feed.json";
import oldFeed from "./fixtures/spotlight-news-pre-oct14.json";
import { adaptHomeSpotlight } from "../../packages/content-core/src/home-spotlight-source";

const snapshot = { ...feed, status: "ready" as const };
const cutoffAt = "2026-10-11T15:00:00Z";
describe("Spotlight feature sources", () => {
  it("preserves the publisher, date and destination while omitting the recorded posting account", () => {
    const result = adaptHomeSpotlight(snapshot, { cutoffAt, selectedIds: [feed.cards[0].href] });
    expect(result.cards).toEqual([{
      id: "https://www.njspotlightnews.org/2026/10/from-delaney-hall-hunger-strike-to-freedom/",
      source: "spotlight_news", title: "From Delaney Hall hunger strike to freedom",
      href: "https://www.njspotlightnews.org/2026/10/from-delaney-hall-hunger-strike-to-freedom/",
      sourceLabel: "NJ Spotlight News", publishedAt: "2026-10-08T21:00:00.000Z",
      displayDate: "2026-10-08", image: { url: "/brand/spotlight/immigration-02.jpg", alt: "" },
    }]);
  });

  it("labels Opinion only from publisher categories and never invents a byline", () => {
    const opinion = feed.cards.find(card => card.sourceCategories.includes("Opinion"))!;
    expect(adaptHomeSpotlight(snapshot, { cutoffAt, selectedIds: [opinion.href] }).cards[0].opinion).toBe(true);
    const old = adaptHomeSpotlight({ ...oldFeed, status: "ready" }, { cutoffAt, selectedIds: [oldFeed.cards[0].href] });
    expect(old.cards[0].title).toContain("Op-Ed:");
    expect(old.cards[0]).not.toHaveProperty("opinion");
    expect(old.cards[0]).not.toHaveProperty("byline");
  });

  it("does not replace withdrawn cards, admit future stories or reassign its source", () => {
    const selectedIds = [feed.cards[0].href];
    expect(adaptHomeSpotlight({ ...snapshot, cards: feed.cards.slice(1) }, { cutoffAt, selectedIds }))
      .toMatchObject({ cards: [], missingIds: selectedIds, emptyReason: "selection_unavailable" });
    const future = { ...feed.cards[0], publishedAt: "2027-01-01T00:00:00Z" };
    expect(adaptHomeSpotlight({ ...snapshot, cards: [future] }, { cutoffAt }).cards).toEqual([]);
    expect(() => adaptHomeSpotlight({ ...snapshot, source: "station_posts" }, { cutoffAt })).toThrow();
    expect(adaptHomeSpotlight({ status: "error" }, { cutoffAt }).emptyReason).toBe("source_error");
    const bad = { ...feed.cards[0], publishedAt: "Mon, 30 Feb 2026 00:00:00 +0000" };
    expect(adaptHomeSpotlight({ ...snapshot, cards: [bad] }, { cutoffAt }).cards).toEqual([]);
  });
});
