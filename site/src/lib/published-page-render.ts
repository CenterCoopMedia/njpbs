import { contentLinkReadFits } from "../../../packages/content-core/src/content-link.ts";
import { isScheduleFixture } from "./schedule-input";
import { parseDataHubSources, type DataHubSources } from "../../../packages/content-core/src/data-hub-reporting-sources.ts";
import { forwardHomeServiceSources } from "../../../packages/content-core/src/home-service-sources.ts";
import { createHomeNewsletterSnapshot, refreshHomeNewsletterSnapshot } from "../../../packages/content-core/src/home-service-sources";
import { projectCmsPage } from "./cms-page-projection";
import type { CmsPageBuildData, CmsPageDoc, CmsPublicAsset } from "./cms-loader";
import { projectChrome, projectJoinedRecords, projectPublishedPostCardRead, type PublishedPostContent } from "./published-post-shadow";
import { readHomeSourceSnapshot } from "../../../packages/content-core/src/home-published-sources";
import { parseHomeHero } from "../../../packages/content-core/src/home-hero";
import { boundHomeNewsletterCatalog, homeCatalogJson } from "../../../packages/content-core/src/home-source-catalog";
import { adaptHomeStationPosts } from "../../../packages/content-core/src/home-station-posts-source";
import { homeSelectedPostIds } from "../../../packages/content-core/src/home-source-catalog";
import type { HomeSourceSnapshot } from "./home-sources";
import type { PublicSettingBuildData } from "./public-artifact-bundle";
import { assertAuthorRouteUniqueness, projectAuthorSnapshot } from "./cms-authors-projection";

export type PublishedPageContent = Omit<PublishedPostContent, "kind" | "target"> & {
  readonly kind: "public-page";
  readonly target: Readonly<{
    documentId: string; sourceVersion: number; rendererSha: string; pagePath: string; contextRevision: number; contextDigest: string; codeGeneration?: number;
  }>;
  readonly homeSources?: HomeSourceSnapshot;
  readonly dataHubSources?: DataHubSources;
  readonly newsletterCards?: readonly unknown[];
  readonly newsletterUnavailable?: boolean;
  readonly schedule?: import("./page-schedule-packet").PageScheduleInputs;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Catalog seals describe frozen public input, rather than the request clock. */
export function homeProjectionCutoff(input: Record<string, unknown>, sources: HomeSourceSnapshot, now: Date): Date {
  const seal = object(input.sourceSeal) ? input.sourceSeal : {};
  const page = object(input.page) ? input.page : {};
  const times = [sources.editorial?.catalog.cutoffAt, sources.pbs.checkedAt, sources.pbs.newscast?.checkedAt, sources.spotlight.checkedAt,
    seal.cutoffAt, page.publishedAt];
  for (const raw of Array.isArray(input.posts) ? input.posts : []) {
    if (!object(raw) || !object(raw.document)) continue;
    const published = object(raw.document.published) ? raw.document.published : {};
    times.push(published.publishedAt, raw.document.publishAt);
  }
  const instants = times.filter(value => value !== undefined && value !== null).map(value =>
    typeof value === "string" ? Date.parse(value) : NaN);
  if (!instants.length || instants.some(value => !Number.isFinite(value)) || Math.max(...instants) > now.getTime()) {
    throw new Error("Home catalog cutoff is unavailable");
  }
  return new Date(Math.max(...instants));
}

/** Keep retained provider pools and replace only the native Post catalog through
 * the same adapter and bounded selection that the full build uses. */
export async function refreshPublishedPageHomeSources(sources: HomeSourceSnapshot,
  posts: PublishedPageContent["posts"], page: CmsPageBuildData | undefined, rendererSha: string, now: Date,
  publication = sources.publication, recordCards?: readonly unknown[], newsletterCards?: readonly unknown[], newsletterUnavailable = false): Promise<HomeSourceSnapshot> {
  if (!publication || publication.commitSha !== rendererSha) throw new Error("Home renderer source differs");
  const retained = readHomeSourceSnapshot(sources, { schemaVersion: 1, ...sources.publication });
  const editorial = retained.editorial;
  if (!editorial || await digest(homeCatalogJson(editorial.catalog)) !== editorial.receipt.digest ||
      now.getTime() < Date.parse(editorial.catalog.cutoffAt)) throw new Error("Home retained source seal is invalid");
  const cutoffAt = now.toISOString();
  const selected = new Set(page ? homeSelectedPostIds(page) : []);
  const sorted = [...posts].sort((a, b) => (b.sortInstant ?? 0) - (a.sortInstant ?? 0) || a.postId.localeCompare(b.postId));
  const chosen = new Set([...sorted.filter(post => selected.has(post.postId)), ...sorted].slice(0, 200).map(post => post.postId));
  const cards = sorted.filter(post => chosen.has(post.postId)).flatMap(post => adaptHomeStationPosts({
    status: "ready", checkedAt: cutoffAt, posts: [post],
  }, { cutoffAt }).cards);
  const newsletterIds = page?.blocks.filter(block => block.type === "newsletter_signup" && block.section === "home-newsletter")
    .flatMap(block => block.type === "newsletter_signup" ? block.data.newsletterIds : []) ?? [];
  const currentJoinedIds = page?.blocks.filter(block => block.type === "newsletter_signup" && block.section === "home-newsletter" && block.visible)
    .flatMap(block => block.type === "newsletter_signup" ? block.data.newsletterIds : []) ?? [];
  const services = forwardHomeServiceSources(editorial.catalog.services, cutoffAt);
  const catalog = boundHomeNewsletterCatalog({ ...editorial.catalog, cutoffAt,
    ...(services ? { services } : {}),
    ...(newsletterUnavailable ? { services: { ...services, newsletters: { status: "error" } } }
      : newsletterCards ? { services: { ...services, newsletters: createHomeNewsletterSnapshot(newsletterCards, cutoffAt, cutoffAt, newsletterIds) } }
      : recordCards && page && (editorial.catalog.services || page.blocks.some(block => block.section === "home-newsletter")) ? { services: { ...services, newsletters: refreshHomeNewsletterSnapshot(editorial.catalog.services?.newsletters,
        currentJoinedIds, recordCards, cutoffAt) } } : {}), sources: { ...editorial.catalog.sources,
    "home-posts": { status: "ready", checkedAt: cutoffAt, cards } } }, newsletterIds);
  return readHomeSourceSnapshot({ ...retained, publication,
    editorial: { catalog, receipt: { ...publication, digest: await digest(homeCatalogJson(catalog)) } },
    ...(retained.heroCatalog ? { heroCatalog: retained.heroCatalog.filter(card => card.source !== "cms_posts" && card.source !== "cms_pages") } : {}),
  }, { schemaVersion: 1, ...publication });
}

/** Project the public shell and current card/profile dependencies for both
 * editorial Pages and committed frames. Database/route authority stays server-side. */
export function projectPageRenderDependencies(input: Record<string, unknown>, pageId: string,
  rendererSha: string, now: Date) {
  if (!Array.isArray(input.posts) || input.posts.length > 200 ||
      !Array.isArray(input.assets) || input.assets.length > 100 ||
      !Array.isArray(input.joinedRecords) || input.joinedRecords.length > 100) throw new Error("Invalid Page dependencies");
  const assets = new Map<string, Record<string, unknown>>();
  for (const asset of input.assets) {
    if (!object(asset) || typeof asset.id !== "string" || assets.has(asset.id)) throw new Error("Invalid Page joined media");
    assets.set(asset.id, asset);
  }
  const joined = projectJoinedRecords(input.joinedRecords, assets, now);
  let newsletterCards: readonly unknown[] | undefined;
  let newsletterUnavailable = false;
  if (input.homeNewsletters !== undefined) {
    const roster = input.homeNewsletters;
    if (pageId !== "home" || !object(roster)) throw new Error("Invalid Home Newsletter context");
    if (roster.status === "error" && Object.keys(roster).length === 1) newsletterUnavailable = true;
    else {
      if (Object.keys(roster).some(key => !["assets", "joinedRecords"].includes(key)) ||
          !Array.isArray(roster.joinedRecords) || roster.joinedRecords.length > 200 ||
          !Array.isArray(roster.assets) || roster.assets.length > 200 ||
          roster.joinedRecords.some(record => !object(record) || record.type !== "newsletter") ||
          new Set(roster.joinedRecords.map(record => record.id)).size !== roster.joinedRecords.length) throw new Error("Invalid Home Newsletter context");
      const rosterAssets = new Map<string, Record<string, unknown>>();
      for (const asset of roster.assets) {
        if (!object(asset) || typeof asset.id !== "string" || rosterAssets.has(asset.id)) throw new Error("Invalid Home Newsletter media");
        rosterAssets.set(asset.id, asset);
      }
      newsletterCards = projectJoinedRecords(roster.joinedRecords, rosterAssets, now).recordCards;
    }
  }
  const settingsInput = input.settings;
  if (!Array.isArray(settingsInput) || settingsInput.length > 5 || new Set(settingsInput.map(setting => setting?.id)).size !== settingsInput.length) {
    throw new Error("Invalid Page settings");
  }
  const chrome = projectChrome(input);
  const settings: PublicSettingBuildData[] = [...chrome.settings];
  const posts: PublishedPageContent["posts"][number][] = [];
  const authors = new Map<string, PublishedPageContent["authors"][number]>();
  const profiles = input.authors ?? [];
  if (!Array.isArray(profiles) || profiles.length > 1000 || (pageId !== "staff" && profiles.length)) throw new Error("Invalid Staff author context");
  for (const profile of profiles) {
    if (!object(profile) || typeof profile.id !== "string" || authors.has(profile.id)) throw new Error("Invalid Staff author identity");
    const author = projectAuthorSnapshot(profile.id, profile);
    if (!author) throw new Error("Staff public snapshot is unusable");
    if (profile.profilePageReady !== undefined && typeof profile.profilePageReady !== "boolean") throw new Error("Invalid Staff route readiness");
    authors.set(author.authorId, { ...author,
      ...(typeof profile.profilePageReady === "boolean" ? { profilePageReady: profile.profilePageReady } : {}) });
  }
  for (const read of input.posts) {
    const content = projectPublishedPostCardRead(read, rendererSha, now);
    if (!content || posts.some(post => post.postId === content.posts[0].postId || post.path === content.posts[0].path)) {
      throw new Error("Invalid Home Post context");
    }
    posts.push(content.posts[0]);
    for (const author of content.authors) {
      const prior = authors.get(author.authorId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(author)) throw new Error("Home author context changed");
      authors.set(author.authorId, author);
    }
  }
  if (pageId !== "home" && posts.length) throw new Error("Only Home admits native Post context");
  assertAuthorRouteUniqueness([...authors.values()]);
  if (input.dataHubSources !== undefined && pageId !== "data-hub") throw new Error("Reporting belongs only to Data Hub");
  const dataHubSources = parseDataHubSources(input.dataHubSources,now.getTime());
  return { posts, authors: [...authors.values()], ...joined, ...chrome, settings,
    ...(dataHubSources ? {dataHubSources} : {}),
    ...(newsletterCards ? { newsletterCards } : {}), ...(newsletterUnavailable ? { newsletterUnavailable: true } : {}) };
}

/** Fresh read projection for the public compiled graph. The reader owns database
 * authority; the caller owns retained-source loading and the after-render check. */
export async function projectPublishedPageRead(input: unknown, pageId: string, rendererSha: string,
  now: Date, homeSources?: HomeSourceSnapshot, publication = homeSources?.publication): Promise<PublishedPageContent> {
  if (!object(input) || input.kind !== "published-page" || !object(input.page) ||
      !object(input.sourceSeal) || input.sourceSeal.rendererSha !== rendererSha ||
      !/^[a-f0-9]{40}$/.test(rendererSha) || !/^[a-f0-9]{64}$/.test(String(input.sourceSeal.contextDigest)) ||
      !Number.isSafeInteger(input.sourceSeal.contextRevision) || Number(input.sourceSeal.contextRevision) < 1 ||
      input.page.pageId !== pageId || input.page.contentMode !== "published" ||
      !Number.isSafeInteger(input.page.sourceVersion) || Number(input.page.sourceVersion) < 1 ||
      !object(input.page.assets) || !Array.isArray(input.posts) || input.posts.length > 200 ||
      !Array.isArray(input.assets) || input.assets.length > 100 || !Array.isArray(input.joinedRecords) || input.joinedRecords.length > 100 ||
      !contentLinkReadFits(input, 8 * 1024 * 1024)) throw new Error("Invalid published Page read");
  if (await digest(`njpbs-public-context-v1:${input.sourceSeal.contextRevision}`) !== input.sourceSeal.contextDigest) {
    throw new Error("Published Page context seal differs");
  }
  const raw = structuredClone(input.page);
  const metadata = Object.fromEntries(["contentLinkMode", "contentLinkUrl", "contentLinkNewTab", "title", "pageTheme", "description", "childDirected", "slug", "previousSlugs", "homeCompositionVersion", "serviceCompositionVersion",
    "dataHubCompositionVersion", "dataHubReporting", "homeHero", "homeHeroTitle", "homeHeroSubtitle", "heroBackgroundImage", "heroBackgroundPosition", "seo", "social"]
    .filter(key => raw[key] !== undefined).map(key => [key, raw[key]]));
  for (const group of ["seo", "social"]) if (object(raw[group])) {
    const values = raw[group];
    metadata[group] = Object.fromEntries(["title", "description", group === "seo" ? "noindex" : "imageAssetId"]
      .filter(key => values[key] !== undefined).map(key => [key, values[key]]));
  }
  metadata.slug = raw.path === "/" ? undefined : String(raw.path).slice(1, -1);
  const pageAssets = new Map(Object.entries(raw.assets as Record<string, unknown>).map(([id, asset]) =>
    [id, { ...asset as CmsPublicAsset, id }]));
  const document = { id: pageId, template: raw.template, status: "published", publiclyVisible: true,
    publishAt: raw.publishedAt, published: { metadata, blocks: raw.blocks,
      ...(raw.datasetFigures === undefined ? {} : { datasetFigures: raw.datasetFigures }),
      sourceVersion: raw.sourceVersion, publishedAt: raw.publishedAt } };
  const page = projectCmsPage(document as CmsPageDoc, { mode: "published", now, assets: pageAssets });
  if (!page || page.path !== raw.path || page.sourceVersion !== raw.sourceVersion || page.family !== raw.family) {
    throw new Error("Published Page does not own this target");
  }
  const dependencies = projectPageRenderDependencies(input, pageId, rendererSha, now);
  const heroPins = parseHomeHero(page.homeHero)?.pins ?? [];
  // The compiled renderer hashes this projection for its HTML cache. Expiry
  // must alter that input even when no CMS publication changed the source seal.
  if (page.homeHero?.pins) page.homeHero = { ...page.homeHero,
    pins: heroPins.filter(pin => pin.endsAt === undefined || Date.parse(pin.endsAt) > now.getTime())
      // The selection clock is frozen by this projection. Historical paired
      // replay must not evaluate it again against the machine's later clock.
      .map(({ endsAt: _endsAt, ...pin }) => pin) };
  const homeHeroPages: CmsPageBuildData[] = [];
  if (input.homeHeroPages !== undefined) {
    if (pageId !== "home" || !Array.isArray(input.homeHeroPages) || input.homeHeroPages.length > 3) throw new Error("Invalid Home Page pins");
    for (const raw of input.homeHeroPages) {
      if (!object(raw) || raw.contentMode !== "published" || !Number.isSafeInteger(raw.sourceVersion) || Number(raw.sourceVersion) < 1 ||
          !heroPins.some(pin => pin.source === "cms_pages" && pin.sourceId === raw.pageId) ||
          homeHeroPages.some(page => page.pageId === raw.pageId) || !object(raw.assets)) throw new Error("Invalid Home Page pin");
      // These are the existing reader's public projections, never working Pages.
      const candidate = raw as unknown as CmsPageBuildData;
      if (typeof candidate.title !== "string" || typeof candidate.description !== "string" ||
          typeof candidate.path !== "string" || !candidate.path.startsWith("/") || candidate.path.startsWith("//")) throw new Error("Invalid Home Page pin");
      homeHeroPages.push(candidate);
    }
  }
  const { posts } = dependencies;
  if (pageId === "home" && !homeSources) throw new Error("Home requires exact retained sources");
  const schedule = await projectPageScheduleInputs(input, pageId, rendererSha);
  const sources = pageId === "home" ? await refreshPublishedPageHomeSources(homeSources!, posts, page, rendererSha,
    homeProjectionCutoff(input, homeSources!, now), publication, dependencies.recordCards, dependencies.newsletterCards, dependencies.newsletterUnavailable) : undefined;
  return freeze({ kind: "public-page", target: { documentId: pageId, sourceVersion: Number(page.sourceVersion),
    rendererSha, pagePath: page.path, contextRevision: Number(input.sourceSeal.contextRevision), contextDigest: String(input.sourceSeal.contextDigest),
    ...(schedule ? { codeGeneration: Number(input.sourceSeal.codeGeneration) } : {}) },
    pages: [page], ...dependencies,
    ...(homeHeroPages.length ? { homeHeroPages } : {}),
    ...(sources ? { homeSources: sources } : {}), ...(schedule ? { schedule } : {}) });
}

/** Input preparation does not open the Schedule/Live serving or admission gate. */
export async function projectPageScheduleInputs(input: Record<string, unknown>, pageId: string, rendererSha: string) {
  if (!["schedule", "live"].includes(pageId)) return undefined;
  const schedule = input.schedule as import("./page-schedule-packet").PageScheduleInputs | undefined;
  const seal = input.sourceSeal as Record<string, unknown>;
  const receipt = schedule?.receipt;
  if (!schedule || receipt?.schemaVersion !== 1 || receipt.contextRevision !== seal.contextRevision ||
      receipt.contextDigest !== seal.contextDigest || receipt.code.commitSha !== rendererSha ||
      receipt.code.generation !== seal.codeGeneration || receipt.source.runtime.owner !== "cloudflare" ||
      receipt.exportedAt !== new Date(receipt.source.checkedAt).toISOString() ||
      schedule.exported.exportedAt !== receipt.exportedAt || schedule.data.generatedAt !== receipt.generatedAt ||
      await digest(JSON.stringify({ data: schedule.data, exported: schedule.exported })) !== receipt.inputDigest) {
    throw new Error("Schedule render input differs from its qualified context");
  }
  if (isScheduleFixture(schedule.data)) throw new Error("Generated PBS schedule data is invalid");
  return schedule;
}
