import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeHeroLayoutPreview } from "../src/components/HomeHeroLayoutPreview";
import { HomeShelfLayoutPreview } from "../src/components/HomeShelfLayoutPreview";
import { adaptHomeSpotlight } from "../../packages/content-core/src/home-spotlight-source";
import { homeCatalogJson, type HomeEditorialCatalog } from "../../packages/content-core/src/home-source-catalog";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { renderHomeCuratedShelf } from "../../packages/content-core/src/home-curated-render";
import { resolveHomeHero, type HomeHeroConfig } from "../../packages/content-core/src/home-hero";
import type { ContentShelfBlock } from "../../packages/content-core/src/content-model";

const checkedAt = "2026-10-15T01:00:00.000Z";
describe("Home metadata parity at the mounted Boardwalk boundary", () => {
  it.each(["account-only", "coauthors"])("matches public and saved-preview markup with %s feed data", async state => {
    const path = state === "coauthors" ? "./tests/fixtures/spotlight-coauthors.xml" : "./tests/fixtures/spotlight-account-only.xml";
    // Normalize synthetic XML at the external data boundary.
    const xml = new DOMParser().parseFromString(readFileSync(path, "utf8"), "application/xml");
    const cards = [...xml.getElementsByTagName("item")].slice(0, 8).map(item => ({
      source: "nj-spotlight-news-rss", title: item.getElementsByTagName("title")[0].textContent!,
      href: item.getElementsByTagName("link")[0].textContent!,
      publishedAt: item.getElementsByTagName("pubDate")[0].textContent!,
      sourceCategories: [...item.getElementsByTagName("category")].map(node => node.textContent!), category: "News",
      byline: item.getElementsByTagName("njspotlight:byline")[0]?.textContent ?? item.getElementsByTagName("dc:creator")[0]?.textContent,
      ...(item.getElementsByTagName("njspotlight:byline").length ? { bylineSource: "coauthors-plus" } : {}),
    }));
    const feed = { status: "ready" as const, source: "nj-spotlight-news-rss", checkedAt, cards };
    const admitted = adaptHomeSpotlight(feed, { cutoffAt: checkedAt }).cards;
    // Inject a published source response at the network boundary. Site tests
    // cover its producer; this test mounts the actual Boardwalk consumers.
    const publication = { buildBatchId: "cards3513-fixture", generation: 1, commitSha: "a".repeat(40) };
    const catalog: HomeEditorialCatalog = { schemaVersion: 1, cutoffAt: checkedAt, sources: {
      "home-featured": { status: "error" }, "home-more": { status: "error" }, "home-posts": { status: "error" },
      "home-spotlight": { status: "ready", checkedAt, cards: admitted },
    } };
    const source: HomeSourceSnapshot = { schemaVersion: 1, publication,
      pbs: { source: "media-manager", checkedAt: null, featured: [], more: [] },
      spotlight: { source: "spotlight-rss", checkedAt, cards: [] },
      heroCatalog: admitted.map(card => ({ ...card, source: "spotlight", summary: "", categories: [], tags: [] })),
      editorial: { catalog, receipt: { ...publication, digest: createHash("sha256").update(homeCatalogJson(catalog)).digest("hex") } },
    };
    const load = async () => source;
    const config: HomeHeroConfig = { mode: "manual", presentation: "editorial", supportingCount: 2,
      items: feed.cards.slice(0, 5).map((card, index) => ({ itemId: `story-${index}`, source: "spotlight", sourceId: card.href, title: "", summary: "", href: card.href })) };
    const expectedHero = renderHomeEditorialHero(resolveHomeHero(config, source.heroCatalog!), config);
    const view = render(<HomeHeroLayoutPreview value={config} loadSources={load} />);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const frame = document.querySelector("iframe")!;
    const doc = frame.contentDocument!;
    Object.defineProperty(doc, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
    await waitFor(() => expect(doc.querySelectorAll("time")).toHaveLength(5));
    const expected = document.createElement("div"); expected.innerHTML = expectedHero;
    expect(doc.querySelector(".home-editorial")?.textContent).toBe(expected.querySelector(".home-editorial")?.textContent);
    expect([...doc.querySelectorAll("time")].map(time => time.textContent)).toEqual(["Oct. 14, 2026", "Oct. 14, 2026", "Oct. 14, 2026", "Oct. 13, 2026", "Oct. 13, 2026"]);
    expect(doc.body.textContent).not.toContain("example-account");
    expect(Boolean(doc.querySelector(".home-editorial__byline"))).toBe(state === "coauthors");
    view.unmount();
    const block: ContentShelfBlock = { id: "spotlight", type: "content_shelf", section: "home-spotlight", order: 0, visible: true,
      data: { source: "spotlight_news", title: "NJ Spotlight News", itemLimit: 8, moreLabel: "More news", moreHref: "https://www.njspotlightnews.org/", presentation: "list" } };
    const expectedShelf = renderHomeCuratedShelf(block, source.editorial!.catalog);
    expected.innerHTML = expectedShelf;
    const shelf = render(<HomeShelfLayoutPreview block={{ ...block, data: { ...block.data } }} homeV2 loadSources={load}
      render={html => <div data-testid="shelf" dangerouslySetInnerHTML={{ __html: html }} />} />);
    await waitFor(() => expect(shelf.getByTestId("shelf").innerHTML).toBe(expected.innerHTML));
    expect(shelf.getByTestId("shelf")).toHaveTextContent("Oct. 14, 2026");
    expect(shelf.getByTestId("shelf")).not.toHaveTextContent("example-account");
  });
});
