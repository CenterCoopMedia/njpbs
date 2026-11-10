import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeHeroLayoutPreview } from "../src/components/HomeHeroLayoutPreview";
import { ContentShelfSources } from "../src/components/ContentShelfPicker";
import { imageAsset } from "./media-tile-fixtures";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { resolveHomeHero, type HomeHeroCatalogItem, type HomeHeroConfig } from "../../packages/content-core/src/home-hero";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import type { MediaPickerLoader } from "../src/components/MediaPickerDialog";

const thumbnails = [480, 960].map(width => ({ url: `https://media.njpbs.org/cms-media/news/photo/${width}.webp`, width, height: width * 9 / 16 }));
const asset = imageAsset({ id: "photo", url: "https://media.njpbs.org/cms-media/news/photo/original.jpg", thumbnails });
const card: HomeHeroCatalogItem = { id: "photo-story", source: "cms_posts", title: "Published photo story", summary: "",
  href: "/posts/photo-story/", categories: [], tags: [], displayDate: "2026-10-08", byline: "Published reporter",
  image: { url: asset.url } };

describe("supporting story image parity", () => {
  it.each(["catalog", "older-post", "manual-image"])("keeps public and mounted Boardwalk image/text parity for %s", async mode => {
    const source: HomeSourceSnapshot = { schemaVersion: 1,
      publication: { buildBatchId: "cards3515-fixture", generation: 1, commitSha: "a".repeat(40) },
      pbs: { source: "media-manager", checkedAt: null, featured: [], more: [] },
      spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] }, heroCatalog: mode === "older-post" ? [] : [card] };
    const config: HomeHeroConfig = { mode: "manual", presentation: "editorial", items: [
      { itemId: "lead", title: "Lead story", summary: "", href: "/posts/lead/" },
      { itemId: "photo", source: "cms_posts", sourceId: card.id, title: "", summary: "", href: "",
        ...(mode === "manual-image" ? { imageAssetId: asset.id } : {}) },
    ] };
    const loadMedia: MediaPickerLoader = async () => ({ success: true, records: [asset], total: 1, allCount: 1,
      page: 1, pageCount: 1, categoryCounts: { news: 1 }, kindCounts: { image: 1 } });
    const loadRecord = async () => ({ status: "ready" as const, record: { version: 1, publiclyVisible: true, publicSourceVersion: 1,
      published: { sourceVersion: 1, metadata: { title: card.title, summary: "", slug: "photo-story", heroImage: asset.id,
        date: "2026-10-08", editorialDateSource: "editorial", credits: [{ kind: "custom", name: "Published reporter" }] } } } });
    const expected = document.createElement("div");
    const expectedUrl = mode === "manual-image" ? thumbnails[1].url : asset.url;
    expected.innerHTML = renderHomeEditorialHero(resolveHomeHero(config, [card], { photo: { url: expectedUrl } }), config);
    render(<ContentShelfSources.Provider value={{ loadRecord }}><HomeHeroLayoutPreview value={config}
      loadSources={async () => source} loadMedia={loadMedia} /></ContentShelfSources.Provider>);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const frame = document.querySelector("iframe")!;
    const doc = frame.contentDocument!;
    Object.defineProperty(doc, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
    await waitFor(() => expect(doc.querySelector(".home-editorial__support img")).not.toBeNull());
    const actual = doc.querySelector(".home-editorial__support")!;
    expect(actual.textContent).toBe(expected.querySelector(".home-editorial__support")!.textContent);
    const image = actual.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(expectedUrl);
    expect(image.getAttribute("srcset")).toBeNull();
    expect(image.getAttribute("fetchpriority")).toBe("low");
    expect(image.alt).toBe("");
    expect(actual.querySelector("h3")?.textContent).toBe(card.title);
  });
});
