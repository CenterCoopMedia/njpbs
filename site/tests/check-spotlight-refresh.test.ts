// @vitest-environment node

import { describe, expect, it } from "vitest";
import { shouldRefreshSpotlight } from "../scripts/check-spotlight-refresh.mjs";

const receipt = { generation: 155, buildBatchId: "cms-current" };
const feed = [
  { href: "https://www.njspotlightnews.org/new", publishedAt: "2026-09-28T14:00:00Z" },
  { href: "https://www.njspotlightnews.org/old", publishedAt: "2026-09-28T12:00:00Z" },
];
const live = {
  publication: receipt,
  spotlight: { cards: [{ href: feed[1].href }] },
};

describe("Spotlight refresh check", () => {
  it("queues when the newest feed item is later than a live shelf item on the same day", () => {
    expect(shouldRefreshSpotlight(feed, live, receipt)).toBe(true);
  });

  it("skips when the latest feed item is already on the live shelf", () => {
    expect(shouldRefreshSpotlight(feed, {
      ...live,
      spotlight: { cards: [{ href: feed[0].href }, { href: feed[1].href }] },
    }, receipt)).toBe(false);
  });

  it("queues when the feed has replaced all live shelf links", () => {
    expect(shouldRefreshSpotlight(feed, {
      ...live,
      spotlight: { cards: [{ href: "https://www.njspotlightnews.org/gone" }] },
    }, receipt)).toBe(true);
  });

  it("fails closed when the public shelf and receipt disagree", () => {
    expect(() => shouldRefreshSpotlight(feed, live, {
      ...receipt,
      generation: 156,
    })).toThrow("live shelf receipt is invalid");
  });

  it("fails closed on an item without a usable time", () => {
    expect(() => shouldRefreshSpotlight([
      { href: feed[0].href, publishedAt: "bad" },
    ], live, receipt)).toThrow("invalid item time");
  });
});
