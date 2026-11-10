import { resolveHomeNewscastPacket } from "../../../packages/content-core/src/home-newscast-published.ts";
import { forwardHomeServiceSources, createHomeNewsletterSnapshot } from "../../../packages/content-core/src/home-service-sources.ts";
import { createHash } from "node:crypto";
import { curateHomeSource, type HomeCardSnapshot, type HomeSourceCard, type HomeSourceSection } from "../../../packages/content-core/src/home-source-curation.ts";
import { adaptHomeSpotlight } from "../../../packages/content-core/src/home-spotlight-source.ts";
import { adaptHomeStationPosts } from "../../../packages/content-core/src/home-station-posts-source.ts";
import { boundHomeNewsletterCatalog, readHomeEditorialCatalog, readHomeEditorialSourceReceipt, homeCatalogJson,
  type HomeEditorialSourceReceipt } from "../../../packages/content-core/src/home-source-catalog.ts";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { CmsPostBuildData } from "./cms-posts-projection";
import { readHomeSourceSnapshot } from "../../../packages/content-core/src/home-published-sources.ts";

export function createHomeEditorialCatalog(snapshot: HomeSourceSnapshot,
  spotlight: { checkedAt?: string; cards?: unknown[] }, posts: readonly CmsPostBuildData[], cutoffAt: string, selectedPostIds: readonly string[] = [], recordCards?: readonly unknown[], selectedNewsletterIds: readonly string[] = []): HomeEditorialSourceReceipt {
  if (!snapshot.publication) throw new Error("Home selection catalogs require a published generation.");
  const pbs = (section: "home-featured" | "home-more", pool: HomeSourceSnapshot["pbs"]["featured"]): HomeCardSnapshot => {
    const checkedAt = snapshot.pbs.checkedAt ?? cutoffAt;
    const cards: HomeSourceCard[] = pool.map(card => ({ id: card.href,
      source: section === "home-featured" ? "pbs_featured" : "pbs_more", title: card.title, href: card.href,
      ...(card.description.trim() ? { summary: card.description } : {}), sourceLabel: "PBS · NJ PBS",
      ...(card.image ? { image: { url: card.image, alt: "" } } : {}) }));
    return { status: "ready", checkedAt, cards: cards.flatMap(card => curateHomeSource(section,
      { status: "ready", checkedAt, cards: [card] }, { cutoffAt }).cards) };
  };
  const checkedAt = spotlight.checkedAt ?? cutoffAt;
  const sourceCards = (spotlight.cards ?? []).slice(0, 200).flatMap(card => adaptHomeSpotlight({
    status: "ready", source: "nj-spotlight-news-rss", checkedAt, cards: [card] }, { cutoffAt }).cards);
  const sortedPosts = [...posts].sort((a, b) => (b.sortInstant ?? 0) - (a.sortInstant ?? 0) || a.postId.localeCompare(b.postId));
  // Retain still-published saved selections outside the recent picker window.
  // Rule-based shelves keep chronological order after this bounded admission.
  const required = new Set(selectedPostIds);
  const chosen = new Set([...sortedPosts.filter(post => required.has(post.postId)), ...sortedPosts].slice(0, 200).map(post => post.postId));
  const postCards = sortedPosts.filter(post => chosen.has(post.postId)).flatMap(post => adaptHomeStationPosts({ status: "ready", checkedAt: cutoffAt, posts: [post] }, { cutoffAt }).cards);
  const unique = (cards: HomeSourceCard[]) => cards.filter(card => cards.filter(candidate => candidate.id === card.id).length === 1);
  const catalog = boundHomeNewsletterCatalog({ schemaVersion: 1, cutoffAt,
    ...(recordCards || snapshot.pbs.newscast ? { services: {
      newsletters: recordCards ? createHomeNewsletterSnapshot(recordCards, cutoffAt, cutoffAt, selectedNewsletterIds) : { status: "error" },
      ...(snapshot.pbs.newscast ? { newscast: resolveHomeNewscastPacket(snapshot.pbs.newscast, cutoffAt) } : {}),
    } } : {}), sources: {
    "home-featured": pbs("home-featured", snapshot.pbs.featured),
    "home-more": pbs("home-more", snapshot.pbs.more),
    "home-spotlight": { status: "ready", checkedAt, cards: unique(sourceCards) },
    "home-posts": { status: "ready", checkedAt: cutoffAt, cards: unique(postCards) },
  } satisfies Record<HomeSourceSection, HomeCardSnapshot> }, selectedNewsletterIds);
  return { catalog, receipt: { ...snapshot.publication,
    digest: createHash("sha256").update(homeCatalogJson(catalog)).digest("hex") } };
}
export function assertHomeSourcePublication(sources: HomeSourceSnapshot, publication: HomeSourceSnapshot["publication"]): HomeSourceSnapshot {
  if (!publication || homeCatalogJson(sources.publication) !== homeCatalogJson({ buildBatchId: publication.buildBatchId,
    generation: publication.generation, commitSha: publication.commitSha })) throw new Error("Home sources do not match this publication.");
  if (sources.editorial) {
    const editorial = readHomeEditorialSourceReceipt(sources.editorial);
    if (editorial.receipt.buildBatchId !== publication.buildBatchId || editorial.receipt.generation !== publication.generation ||
        editorial.receipt.commitSha !== publication.commitSha ||
        createHash("sha256").update(homeCatalogJson(editorial.catalog)).digest("hex") !== editorial.receipt.digest) {
      throw new Error("Home catalog does not match this publication.");
    }
  }
  return readHomeSourceSnapshot(sources, { schemaVersion: 1, buildBatchId: publication.buildBatchId,
    generation: publication.generation, commitSha: publication.commitSha });
}

/** Re-render a fast Post generation using retained provider pools and current published Posts. */
export function rebuildHomeSourcesForPosts(sources: HomeSourceSnapshot, posts: readonly CmsPostBuildData[],
  publication: NonNullable<HomeSourceSnapshot["publication"]>, cutoffAt: string, selectedPostIds: readonly string[] = []): HomeSourceSnapshot {
  if (!sources.editorial || Date.parse(cutoffAt) < Date.parse(sources.editorial.catalog.cutoffAt)) {
    throw new Error("A current retained Home catalog and forward cutoff are required.");
  }
  const rebuilt = createHomeEditorialCatalog({ ...sources, publication }, {}, posts, cutoffAt, selectedPostIds);
  const catalog = readHomeEditorialCatalog({ ...sources.editorial.catalog, cutoffAt,
    ...(sources.editorial.catalog.services ? { services: forwardHomeServiceSources(sources.editorial.catalog.services, cutoffAt) } : {}),
    sources: { ...sources.editorial.catalog.sources, "home-posts": rebuilt.catalog.sources["home-posts"] } });
  const editorial = { catalog, receipt: { ...publication,
    digest: createHash("sha256").update(homeCatalogJson(catalog)).digest("hex") } };
  return assertHomeSourcePublication({ ...sources, publication, editorial,
    ...(sources.heroCatalog ? { heroCatalog: sources.heroCatalog.filter(card => card.source !== "cms_posts" && card.source !== "cms_pages") } : {}) }, publication);
}
