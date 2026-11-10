import { postCoverageLabelId } from "../../../packages/content-core/src/coverage-labels";
import { readHomeHeroCatalog, type HomeHeroCatalogItem, type HomeHeroManualItem } from "../../../packages/content-core/src/home-hero";
import { resolveDisplayDate } from "../../../packages/content-core/src/editorial-dates";
import { storyCreditsByline } from "../../../packages/content-core/src/story-credits";
import { SPOTLIGHT_PUBLICATION_LABEL } from "../../../packages/content-core/src/post-branding";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { postShelfCard, type ContentShelfSources } from "../components/ContentShelfPicker";
import type { ContextType } from "react";
import type { MediaPickerLoader } from "../components/MediaPickerDialog";

/** Missing from the bounded transport does not mean withdrawn. Read only settled published metadata. */
export async function loadBoundHomeHeroCatalog(snapshot: HomeSourceSnapshot, items: readonly HomeHeroManualItem[],
  sources: ContextType<typeof ContentShelfSources>, loadMedia: MediaPickerLoader | undefined, signal: AbortSignal):
  Promise<{ catalog: HomeHeroCatalogItem[]; unverifiedIds: string[] }> {
  const catalog = readHomeHeroCatalog(snapshot.heroCatalog);
  const unverifiedIds: string[] = [];
  const missing = [...new Set(items.filter(item => item.source === "cms_posts" && item.sourceId &&
    !catalog.some(card => card.source === "cms_posts" && card.id === item.sourceId)).map(item => item.sourceId!))];
  const additions = await Promise.all(missing.map(async id => {
    if (!sources.loadRecord) { unverifiedIds.push(id); return []; }
    try {
      const result = await sources.loadRecord("post", id);
      if (signal.aborted) return [];
      if (result.status !== "ready") {
        if (result.status !== "missing" && result.status !== "deleted") unverifiedIds.push(id);
        return [];
      }
      const record = result.record;
      if (record.deleted === true || record.publiclyVisible === false) return [];
      const copied = postShelfCard(record);
      const metadata = (record.published as { metadata: Record<string, unknown> }).metadata;
      let image: HomeHeroCatalogItem["image"];
      if (copied.imageAssetId) {
        if (!loadMedia) throw new Error("Source artwork unavailable");
        const assets = await loadMedia({ q: "", assetIds: [String(copied.imageAssetId)], categories: [], kinds: ["image"], sort: "updatedAt", direction: "desc", page: 1 });
        const asset = assets.records.find(asset => asset.id === copied.imageAssetId);
        if (!asset) throw new Error("Source artwork unavailable");
        image = { url: asset.url, alt: copied.altDecorative ? "" : String(copied.alt ?? "") };
      }
      const credits = Array.isArray(metadata.credits) ? metadata.credits.flatMap(credit => credit && typeof credit.name === "string" ? [{ kind: "custom" as const, name: credit.name }] : []) : [];
      const displayDate = resolveDisplayDate(metadata);
      return readHomeHeroCatalog([{ id, source: "cms_posts", title: copied.title, summary: copied.summary, href: copied.href,
        categories: Array.isArray(metadata.categories) ? metadata.categories : [], tags: Array.isArray(metadata.tags) ? metadata.tags : [],
        ...(metadata.showInHomeHero === true ? { showInHomeHero: true } : {}),
        eyebrow: metadata.spotlightNews === true ? SPOTLIGHT_PUBLICATION_LABEL : "NJ PBS",
        ...(postCoverageLabelId(metadata) ? { coverageLabelId: postCoverageLabelId(metadata) } : {}),
        ...(metadata.spotlightNews === true ? { spotlightNews: true } : {}), ...(displayDate ? { displayDate } : {}),
        ...(credits.length ? { byline: storyCreditsByline(credits) } : {}), ...(image ? { image } : {}),
      }]);
    } catch { if (!signal.aborted) unverifiedIds.push(id); return []; }
  }));
  return { catalog: [...catalog, ...additions.flat()], unverifiedIds };
}
