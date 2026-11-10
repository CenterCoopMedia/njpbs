import { useCoverageLabels } from "../context/CoverageLabelsContext";
import { CoverageLabelPreviewStatus } from "./CoverageLabelPreviewStatus";
import { useContext, useEffect, useState } from "react";
import { parseHomeHero, resolveHomeHero, type HomeHeroCard, type HomeHeroCatalogItem, type HomeHeroConfig } from "../../../packages/content-core/src/home-hero";
import { renderHomeEditorialHero } from "../../../packages/content-core/src/home-editorial-render";
import { ContentShelfSources } from "./ContentShelfPicker";
import { loadBoundHomeHeroCatalog } from "../lib/home-hero-published-catalog";
import { loadHomeSourceSnapshot } from "../lib/home-source-snapshot";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { ComponentPhoneFrame } from "./ComponentPhonePreview";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import { mediaPreviewUrl } from "../lib/media-image";

type PreviewResources = { key: string; loader?: MediaPickerLoader; assets: Record<string, NonNullable<HomeHeroCard["image"]>>; catalog: HomeHeroCatalogItem[] };

/** A manual layout preview, using the same resolver and markup as the public page. */
export function HomeHeroLayoutPreview({ value, loadMedia, backgroundAssetId, backgroundPosition, loadSources = loadHomeSourceSnapshot }: {
  value: unknown;
  loadSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  loadMedia?: MediaPickerLoader;
  backgroundAssetId?: string;
  backgroundPosition?: "center" | "top" | "bottom";
}) {
  const sources = useContext(ContentShelfSources);
  let config: HomeHeroConfig | undefined;
  let invalid = false;
  try { config = parseHomeHero(value); } catch { invalid = true; }
  const coverage = useCoverageLabels(config?.mode === "manual" && Boolean(config.items?.length));
  const manual = config?.mode === "manual" && config.presentation === "editorial";
  const ids = manual ? [...new Set([
    ...(config?.items ?? []).map(item => item.imageAssetId).filter((id): id is string => Boolean(id)),
    ...(backgroundAssetId ? [backgroundAssetId] : []),
  ])].sort() : [];
  // Native Post attribution resolves by destination from the published catalog.
  const needsCatalog = Boolean(manual && config?.items?.length);
  const key = JSON.stringify([ids, needsCatalog, config?.items?.map(item => [item.source, item.sourceId])]);
  const [resources, setResources] = useState<PreviewResources>();
  const [failedKey, setFailedKey] = useState<string>();

  useEffect(() => {
    if (!manual) return;
    let current = true;
    const controller = new AbortController();
    setFailedKey(undefined);
    void Promise.resolve().then(async () => {
      const [assetIds, usePublishedCatalog] = JSON.parse(key) as [string[], boolean];
      const assets: PreviewResources["assets"] = {};
      let catalog: HomeHeroCatalogItem[] = [];
      if (usePublishedCatalog) {
        const snapshot = await loadSources(controller.signal);
        if (!current) return;
        if (!snapshot.publication || !snapshot.heroCatalog) throw new Error("Published story catalog unavailable");
        const resolved = await loadBoundHomeHeroCatalog(snapshot, config?.items ?? [], sources, loadMedia, controller.signal);
        if (resolved.unverifiedIds.length) throw new Error("Selected story could not be verified");
        catalog = resolved.catalog;
      }
      for (let offset = 0; offset < assetIds.length; offset += 12) {
        if (!current) return;
        if (!loadMedia) throw new Error("Image preview unavailable");
        const batch = assetIds.slice(offset, offset + 12);
        const result = await loadMedia({ q: "", assetIds: batch, categories: [], kinds: ["image"], sort: "updatedAt", direction: "desc", page: 1 });
        for (const id of batch) {
          const asset = result.records.find(item => item.id === id);
          if (!asset) throw new Error("Image preview unavailable");
          assets[id] = { url: mediaPreviewUrl(asset, 960), width: asset.width ?? undefined, height: asset.height ?? undefined };
        }
      }
      if (current) setResources({ key, loader: loadMedia, assets, catalog });
    }).catch(() => { if (current) setFailedKey(key); });
    return () => { current = false; controller.abort(); };
  }, [manual, key, loadMedia, loadSources, sources.loadRecord]);

  if (invalid) return <p role="status">Complete the hero's fields to see this layout.</p>;
  if (!config || !manual) return <p>Open the saved page preview to see the stories selected by this category or tag.</p>;
  if (!config.items?.length) return <p>No stories selected. Home will use its existing heading, image and watch buttons.</p>;
  if (!resources || resources.key !== key || resources.loader !== loadMedia) return <p role="status">{failedKey === key
    ? "The story preview could not be loaded. Your draft is unchanged; use the saved page preview to verify it."
    : "Loading the selected story preview…"}</p>;
  const cards = resolveHomeHero(config, resources.catalog, resources.assets);
  const html = renderHomeEditorialHero(cards, { ...config, coverageLabels: coverage.registry,
    ...(backgroundAssetId && resources.assets[backgroundAssetId] ? { fallbackImage: resources.assets[backgroundAssetId] } : {}),
    ...(backgroundPosition ? { fallbackPosition: backgroundPosition } : {}),
  });
  return <>
    {cards.some(card => card.coverageLabelId) ? <CoverageLabelPreviewStatus /> : null}
    <p className="muted">Draft layout using your manual selection.{needsCatalog ? " Bylines, dates, publication labels and source artwork come from the published catalog." : ""} Use the saved page preview to verify the complete page.</p>
    <ComponentPhoneFrame html={html} title="Home lead story and headlines" styles="" />
  </>;
}
