import type { Loader } from "astro/loaders";
import launchMedia from "../data/launch-media-manager.json";
import committedSpotlightNews from "../data/spotlight-news.json";
import { publicRootRoutesEnabled } from "./build-target";
import { createHomeSourceSnapshot } from "./home-sources";
import { loadSpotlightNewsData } from "./spotlight-news-data";
import { loadLaunchContentData } from "./launch-content-data";
import { readPublicArtifactBundle, resolvePublicArtifactBundlePath } from "./public-artifact-bundle";
import { homeSelectedPostIds } from "../../../packages/content-core/src/home-source-catalog";
import { createHomeEditorialCatalog } from "./home-editorial-catalog";
import { createHash } from "node:crypto";
import { createHomeNewsletterSnapshot } from "../../../packages/content-core/src/home-service-sources";
import { boundHomeNewsletterCatalog, homeCatalogJson } from "../../../packages/content-core/src/home-source-catalog";

export async function loadHomeSourceSnapshot(env: Record<string, string | undefined> = process.env) {
  const [media, spotlight] = await Promise.all([
    loadLaunchContentData(launchMedia, env),
    loadSpotlightNewsData(committedSpotlightNews, env),
  ]);
  const bundlePath = resolvePublicArtifactBundlePath(env);
  const bundle = bundlePath ? await readPublicArtifactBundle(bundlePath, env) : null;
  if (bundle?.homeSources) {
    const retained = bundle.homeSources;
    if (!retained.editorial) return retained;
    const newsletterIds = (bundle.pages.find(page => page.pageId === "home")?.blocks ?? []).flatMap(block =>
      block.type === "newsletter_signup" && block.section === "home-newsletter" ? block.data.newsletterIds : []);
    const cutoffAt = retained.editorial.catalog.cutoffAt;
    const catalog = boundHomeNewsletterCatalog({ ...retained.editorial.catalog,
      services: { ...retained.editorial.catalog.services, newsletters: createHomeNewsletterSnapshot(bundle.recordCards ?? [], cutoffAt, cutoffAt, newsletterIds) } }, newsletterIds);
    return { ...retained, editorial: { catalog, receipt: { ...retained.editorial.receipt,
      digest: createHash("sha256").update(homeCatalogJson(catalog)).digest("hex") } } };
  }
  const sources = createHomeSourceSnapshot(media, spotlight, bundle?.receipt ?? null);
  if (bundle) {
    // Source fetch receipts can follow the CMS export cutoff. This later catalog
    // cutoff is retained with this publication, without changing CMS admission.
    const publicationCutoff = new Date(bundle.receipt.cutoffAt.seconds * 1000 + bundle.receipt.cutoffAt.nanoseconds / 1_000_000).toISOString();
    const cutoffAt = [publicationCutoff, media.checkedAt, sources.pbs.newscast?.checkedAt, spotlight.checkedAt]
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    sources.editorial = createHomeEditorialCatalog(sources, spotlight, bundle.posts, cutoffAt, homeSelectedPostIds(bundle.pages.find(page => page.pageId === "home") ?? {}), bundle.recordCards,
      (bundle.pages.find(page => page.pageId === "home")?.blocks ?? []).flatMap(block =>
        block.type === "newsletter_signup" && block.section === "home-newsletter" ? block.data.newsletterIds : []));
  }
  return sources;
}

// Bundle validation uses source-relative backend modules. Keep it in the content
// loading stage, not in bundled prerender entrypoints. Clear prior build data,
// including when switching to the coming-soon target in the same checkout.
export function homeSourcesLoader(): Loader {
  return {
    name: "public-home-sources",
    load: async ({ store, parseData }) => {
      store.clear();
      if (!publicRootRoutesEnabled(process.env)) return;
      const data = await loadHomeSourceSnapshot();
      store.set({ id: "home", data: await parseData({ id: "home", data: { ...data } }) });
    },
  };
}
