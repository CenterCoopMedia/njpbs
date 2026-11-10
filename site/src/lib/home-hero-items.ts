import { postCardImage } from "../../../packages/content-core/src/post-card-image.ts";
import { parseHomeHero, readHomeHeroCatalog, resolveHomeHero, type HomeHeroCatalogItem, type HomeHeroCard } from "../../../packages/content-core/src/home-hero";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { CmsPostBuildData } from "./cms-posts-loader";
import type { CmsPageBuildData } from "./cms-loader";
import { storyCreditsByline } from "../../../packages/content-core/src/story-credits";
import { SPOTLIGHT_PUBLICATION_LABEL } from "../../../packages/content-core/src/post-branding.ts";
import { resolvePublicCreditLinks, type PublicAuthorLinkInput } from "./public-author-links";

/** Callers pass admitted public Posts (or the retained public context in a Home preview). */
export function homeHeroCatalog(sources: HomeSourceSnapshot | undefined, posts: readonly CmsPostBuildData[], authors: readonly PublicAuthorLinkInput[] = [], pages: readonly CmsPageBuildData[] = []): HomeHeroCatalogItem[] {
  return [
    ...[...posts].sort((left, right) => (right.sortInstant ?? 0) - (left.sortInstant ?? 0) || left.postId.localeCompare(right.postId)).map(post => {
      const selectedImage = postCardImage(post);
      return {
        id: post.postId, source: "cms_posts" as const, title: post.title,
        summary: post.summary || post.excerpt, href: post.path,
        contentLinkMode: post.contentLinkMode, contentLinkUrl: post.contentLinkUrl, contentLinkNewTab: post.contentLinkNewTab,
        ...(post.credits.length ? { byline: storyCreditsByline(resolvePublicCreditLinks(post.credits, authors).map(credit => ({ kind: "custom", name: credit.name }))) } : {}),
        ...(post.coverageLabelId ? { coverageLabelId: post.coverageLabelId } : {}),
        ...(post.spotlightNews === true ? { spotlightNews: true } : {}),
        ...(post.displayDate ? { displayDate: post.displayDate } : {}),
        ...(post.showInHomeHero === true ? { showInHomeHero: true } : {}),
        categories: post.categories, tags: post.tags, eyebrow: post.spotlightNews === true ? SPOTLIGHT_PUBLICATION_LABEL : "NJ PBS",
        ...(selectedImage ? { image: { url: selectedImage.image.url, width: selectedImage.image.width,
          height: selectedImage.image.height, alt: selectedImage.alt, ...(selectedImage.image.thumbnails?.length ? { thumbnails: selectedImage.image.thumbnails } : {}) } } : {}),
      };
    }),
    ...pages.filter(page => page.pageId !== "home" && page.contentMode === "published" && (page.sourceVersion ?? 0) > 0).map(page => {
      const image = page.heroBackgroundImage ? page.assets[page.heroBackgroundImage] : undefined;
      return { id: page.pageId, source: "cms_pages" as const, title: page.title, summary: page.description,
        href: page.path, categories: [], tags: [],
        contentLinkMode: page.contentLinkMode, contentLinkUrl: page.contentLinkUrl, contentLinkNewTab: page.contentLinkNewTab,
        ...(image && image.mimeType !== "application/pdf" ? { image: { url: image.url, width: image.width, height: image.height, alt: "", ...(image.thumbnails?.length ? { thumbnails: image.thumbnails } : {}) } } : {}) };
    }),
    ...(sources?.heroCatalog ?? []).filter(card => card.source !== "cms_pages"),
  ];
}
export function resolveHomeHeroItems(config: unknown, sources: HomeSourceSnapshot | undefined,
  posts: readonly CmsPostBuildData[], assets: Readonly<Record<string, HomeHeroCard["image"]>> = {}, authors: readonly PublicAuthorLinkInput[] = [], pages: readonly CmsPageBuildData[] = [], now = Date.now()): HomeHeroCard[] {
  parseHomeHero(config);
  try { return resolveHomeHero(config, homeHeroCatalog(sources, posts, authors, pages), assets, now); }
  catch { return []; }
}

/** Keep provider selections available; admit recent Posts within the Admin response budget. */
export function homeSourcePreviewSnapshot(sources: HomeSourceSnapshot, posts: readonly CmsPostBuildData[], selectedPostIds: readonly string[] = [], authors: readonly PublicAuthorLinkInput[] = []): HomeSourceSnapshot {
  const snapshot = { ...sources, heroCatalog: [] as HomeHeroCatalogItem[] };
  let bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length + 1;
  const native = homeHeroCatalog(undefined, posts, authors);
  const required = new Set(selectedPostIds);
  const candidates = [...native.filter(card => required.has(card.id)), ...(sources.heroCatalog ?? []).filter(card => card.source !== "cms_pages"), ...native.filter(card => !required.has(card.id))];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const identity = `${candidate.source}:${candidate.id}`;
    if (seen.has(identity)) continue;
    if (snapshot.heroCatalog.length === 500) break;
    let card: HomeHeroCatalogItem;
    try { [card] = readHomeHeroCatalog([candidate]); } catch { continue; }
    const size = new TextEncoder().encode(JSON.stringify(card)).length + 1;
    if (bytes + size > 490_000) continue;
    seen.add(identity);
    snapshot.heroCatalog.push(card);
    bytes += size;
  }
  return snapshot;
}
