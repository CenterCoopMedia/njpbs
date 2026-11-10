// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";
import { loadHomeSourceSnapshot } from "../src/lib/home-sources-loader";
import { manualLaunchCards } from "../src/data/launch-fallback";

const program = (index: number) => ({
  title: `Program ${index}`, description: "A public description",
  href: `https://watch.njpbs.org/show/${index}/`, image: `/brand/${index}.webp`,
});
const news = {
  title: "Public headline", category: "News", dateLabel: "Sept. 5",
  href: "https://www.njspotlightnews.org/story/", image: "/brand/spotlight/more-issues.jpg", fallbackImage: "/brand/spotlight/more-issues.jpg",
};

describe("Home build source snapshot", () => {
  it("preserves the shared 24-card pool, split, order, and small-catalog fallback", () => {
    const many = Array.from({ length: 30 }, (_, index) => program(index));
    const snapshot = createHomeSourceSnapshot({ cards: many }, { cards: [] });
    expect(snapshot.pbs.featured).toEqual(many.slice(0, 8));
    expect(snapshot.pbs.more).toEqual(many.slice(8, 24));
    for (const count of [1, 8]) {
      const small = createHomeSourceSnapshot({ cards: many.slice(0, count) }, {});
      expect(small.pbs.featured).toEqual(many.slice(0, count));
      expect(small.pbs.more).toEqual(small.pbs.featured);
    }
    const fallback = createHomeSourceSnapshot({ cards: [] }, {});
    expect(fallback.pbs.source).toBe("manual");
    expect(fallback.pbs.checkedAt).toBeNull();
    expect(fallback.pbs.featured.map(card => card.href)).toEqual(manualLaunchCards.map(card => card.href));
    expect(fallback.pbs.more).toEqual(fallback.pbs.featured);
  });

  it("projects only public fields and three validated-bundle identity fields", () => {
    const publication = {
      buildBatchId: "cms-example", generation: 60, commitSha: "a".repeat(40),
      owners: ["private-owner"], cutoffAt: "private-cutoff",
    };
    const snapshot = createHomeSourceSnapshot({
      checkedAt: "2026-09-05T12:00:00Z",
      cards: [{ ...program(0), id: "private-id", request: "private-request" }],
    }, {
      checkedAt: "unknown",
      cards: Array.from({ length: 12 }, () => ({ ...news, internal: "private-note" })),
    }, publication);
    expect(snapshot.publication).toEqual({ buildBatchId: "cms-example", generation: 60, commitSha: "a".repeat(40) });
    expect(snapshot.pbs.checkedAt).toBe("2026-09-05T12:00:00Z");
    expect(snapshot.spotlight.checkedAt).toBeNull();
    expect(snapshot.spotlight.cards).toEqual(Array.from({ length: 8 }, () => news));
    expect(JSON.stringify(snapshot)).not.toContain("private-");
    expect(createHomeSourceSnapshot({}, {}).publication).toBeNull();
  });

  it("rejects malformed card fields and unsafe source URLs before either surface uses them", () => {
    for (const href of ["javascript:alert(1)", "//bad.example/", "data:text/html,bad"]) {
      expect(() => createHomeSourceSnapshot({ cards: [{ ...program(0), href }] }, {})).toThrow("URL is invalid");
      expect(createHomeSourceSnapshot({}, { cards: [{ ...news, image: href }] }).spotlight.cards[0].image).toBe(news.fallbackImage);
    }
    expect(() => createHomeSourceSnapshot({ cards: [{ ...program(0), title: {} }] }, {})).toThrow("text is invalid");
    expect(() => createHomeSourceSnapshot({}, { cards: [null] })).toThrow("card is invalid");
  });

  it("keeps ordinary builds unverified and rejects incomplete exact-bundle configuration", async () => {
    const snapshot = await loadHomeSourceSnapshot({});
    expect(snapshot.publication).toBeNull();
    expect(snapshot.pbs.featured.length).toBeGreaterThan(0);
    await expect(loadHomeSourceSnapshot({ PUBLIC_BUILD_BATCH_ID: "cms-example" })).rejects.toThrow("configuration is incomplete");
  });
});
