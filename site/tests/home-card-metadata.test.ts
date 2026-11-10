// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSpotlightFeed } from "../scripts/sync-spotlight-news.mjs";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";
import { adaptHomeSpotlight } from "../../packages/content-core/src/home-spotlight-source";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { renderHomeCuratedShelf } from "../../packages/content-core/src/home-curated-render";
import type { HomeEditorialCatalog } from "../../packages/content-core/src/home-source-catalog";
import type { ContentShelfBlock } from "../../packages/content-core/src/content-model";
import { readHomeHeroCatalog, resolveHomeHero } from "../../packages/content-core/src/home-hero";
import * as serverHero from "../../functions/lib/home-hero.js";

const raw = readFileSync(new URL("./fixtures/spotlight-feed-2026-10-14.xml", import.meta.url), "utf8");
const contract = readFileSync(new URL("./fixtures/public-contracts/feed-metadata.xml", import.meta.url), "utf8");
const checkedAt = "2026-10-15T01:00:00.000Z";
const selection = { cutoffAt: checkedAt };

function projected(xml: string) {
  const cards = parseSpotlightFeed(xml);
  const feed = { status: "ready" as const, source: "nj-spotlight-news-rss", checkedAt, cards };
  return { cards, hero: createHomeSourceSnapshot({ cards: [] }, feed).heroCatalog!,
    shelf: adaptHomeSpotlight(feed, selection).cards };
}

function shelfHtml(cards: ReturnType<typeof projected>["shelf"], presentation: "rail" | "grid" | "two_features" | "list") {
  const catalog: HomeEditorialCatalog = { schemaVersion: 1, cutoffAt: checkedAt, sources: {
    "home-featured": { status: "error" }, "home-more": { status: "error" }, "home-posts": { status: "error" },
    "home-spotlight": { status: "ready", checkedAt, cards },
  } };
  const block: ContentShelfBlock = { id: "spotlight", type: "content_shelf", section: "home-spotlight", order: 0, visible: true,
    data: { source: "spotlight_news", title: "NJ Spotlight News", itemLimit: 8, moreLabel: "More news", moreHref: "https://www.njspotlightnews.org/", presentation } };
  return renderHomeCuratedShelf(block, catalog);
}

describe("Home story metadata from the public Spotlight feed", () => {
  it.each(["carousel", "editorial", undefined])("omits retained posting accounts before %s hero rendering in both runtimes", presentation => {
    const { cards, hero } = projected(raw);
    const retained = { ...hero.find(card => card.href === cards[0].href)!, categories: ["News"], byline: "jmooney" };
    const config = { mode: "manual", ...(presentation ? { presentation } : {}), items: [{
      itemId: "retained", source: "spotlight", sourceId: retained.id, href: retained.href, title: "", summary: "",
    }] };
    for (const resolve of [resolveHomeHero, serverHero.resolveHomeHero]) {
      expect(resolve(config, [retained])[0]).not.toHaveProperty("byline");
      expect(resolve({ mode: "category", source: "spotlight", value: "News", presentation }, [retained])[0]).not.toHaveProperty("byline");
      expect(resolve(config, [{ ...retained, byline: "John Mooney" }])[0]).not.toHaveProperty("byline");
      expect(resolve(config, [{ ...retained, byline: "John Mooney, et al.", bylineSource: "coauthors-plus" }])[0].byline).toBe("John Mooney, et al.");
    }
  });

  it.each(["Staff", "WHYY"])("preserves the explicit single-word co-author %s through both card paths", name => {
    const { cards, hero, shelf } = projected(contract.replace("Benjamin J. Hulac", name));
    expect(cards[0].byline).toBe(name);
    const catalog = readHomeHeroCatalog(JSON.parse(JSON.stringify(hero)));
    const selected = resolveHomeHero({ mode: "manual", items: [{ itemId: "author", source: "spotlight",
      sourceId: cards[0].href, href: cards[0].href, title: "", summary: "" }] }, catalog);
    expect(selected[0].byline).toBe(name);
    expect(renderHomeEditorialHero(selected)).toContain(`By ${name}`);
    expect(shelfHtml(shelf, "list")).toContain(`NJ Spotlight News · ${name} · Oct. 14, 2026`);
  });

  it("omits the posting account from the recorded feed and both card projections", () => {
    expect(raw).toContain("jmooney");
    const { cards, hero, shelf } = projected(raw);
    expect(cards.every(card => !card.byline)).toBe(true);
    expect(hero.filter(card => cards.some(feed => feed.href === card.href)).every(card => !card.byline)).toBe(true);
    expect(shelf.every(card => !card.byline)).toBe(true);
  });

  it("uses only the explicit Co-Authors Plus field, with the approved Most read spelling", () => {
    const { cards, hero, shelf } = projected(contract);
    const expected = ["Benjamin J. Hulac", "David Mosca, NJ Urban News", "John Mooney, et al.", "Dr. Stephanie Navarro Silvera, et al."];
    expect(cards.slice(0, 4).map(card => card.byline)).toEqual(expected);
    expect(shelf.slice(0, 4).map(card => card.byline)).toEqual(expected);
    expect(cards.slice(0, 4).map(card => hero.find(item => item.href === card.href)?.byline)).toEqual(expected);
    expect(cards[4]).not.toHaveProperty("byline");
    // Exact esc_xml output from the WordPress hook, also checked by its PHP test.
    const apostrophe = projected(contract.replace("Benjamin J. Hulac", "Julie O&apos;Connor"));
    expect(apostrophe.cards[0].byline).toBe("Julie O'Connor");
    expect(apostrophe.shelf[0].byline).toBe("Julie O'Connor");
    expect(apostrophe.hero.find(card => card.href === apostrophe.cards[0].href)?.byline).toBe("Julie O'Connor");
    for (const value of ["jmooney", "jmooney, et al.", "NJ Spotlight", "NJ Spotlight News"]) {
      const invalid = contract.replace("Benjamin J. Hulac", value);
      expect(projected(invalid).cards[0]).not.toHaveProperty("byline");
    }
  });

  it("normalizes the real RFC dates before hero admission, preserving station publication days", () => {
    const { cards, hero } = projected(raw);
    const sources = createHomeSourceSnapshot({ cards: [] }, { cards });
    expect(sources.spotlight.cards[0].dateLabel).toBe("Oct. 14, 2026");
    expect(hero.find(card => card.href === cards[0].href)?.displayDate).toBe("2026-10-14");
    expect(hero.find(card => card.href === cards[3].href)?.displayDate).toBe("2026-10-13");
    const late = raw.replace("Wed, 14 Oct 2026 09:15:00 +0000", "Wed, 14 Oct 2026 03:15:00 +0000");
    const midnight = projected(late);
    expect(midnight.hero.find(card => card.href === midnight.cards[0].href)?.displayDate).toBe("2026-10-13");
  });

  it("prints the house date on lead, Latest stories, More stories and every shelf layout", () => {
    const { cards, hero, shelf } = projected(contract);
    const selected = cards.slice(0, 5).map(card => hero.find(item => item.href === card.href)!);
    const html = renderHomeEditorialHero(selected, { supportingCount: 2 });
    expect(html.match(/<time /g)).toHaveLength(5);
    expect(html.match(/>Oct\. 14, 2026<\/time>/g)).toHaveLength(3);
    expect(html.match(/>Oct\. 13, 2026<\/time>/g)).toHaveLength(2);
    expect(renderHomeEditorialHero([{ ...selected[0], displayDate: undefined }])).not.toContain("<time");
    for (const layout of ["rail", "grid", "two_features", "list"] as const) {
      const output = shelfHtml(shelf, layout);
      expect(output).toContain("Oct. 14, 2026");
      expect(output).not.toContain("2026-10-14");
      expect(output).toContain("John Mooney, et al.");
      expect(shelfHtml([{ ...shelf[0], byline: "jmooney" }], layout)).not.toContain("jmooney");
      expect(shelfHtml([{ ...shelf[0], byline: "Posting Editor", bylineSource: undefined }], layout)).not.toContain("Posting Editor");
    }
  });
});
