import { contentLinkReadFits, contentLinkDirectoryFits, contentLinkMetadata } from "../../../packages/content-core/src/content-link.ts";
import type { ContentLinkEntry } from "./content-link-render";
import { projectCoverageLabels } from "../../../packages/content-core/src/coverage-labels.ts";
import { projectStoryCtas } from "../../../packages/content-core/src/story-ctas.ts";
import { STORY_CTAS_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings.ts";
import { projectPublishedCmsSettings, type PublicSiteChromeSettingsValues } from "../../../packages/content-core/src/cms-settings.ts";
import { NJ_DECIDES_SETTINGS_ID, PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings.ts";
import { projectPublicHomepageBanner } from "./public-homepage-banner-data.ts";
import { projectNjDecidesSettings } from "./nj-decides-settings";
import { publicPagePath } from "../../../packages/content-core/src/public-pages";
import type { SiteNavigationBuildData } from "./site-navigation";
import type { PublicSettingBuildData } from "./public-artifact-bundle";
import type { CmsPreviewContent } from "./cms-preview-content";
import { projectCmsPost } from "./cms-posts-projection";
import { projectCmsProgram, type CmsProgramBuildData, type CmsProgramDoc } from "./cms-programs-projection";
import { projectCmsEvent, type CmsEventBuildData } from "./cms-events-projection";
import { exportRecordCards } from "./record-card-resolution";
import { isPublicContentSlug } from "./public-content-routes";
import { isAuthorId, isValidAuthorSlug } from "../../../packages/content-core/src/author-profiles";
import { SECTION_BLOCK_CATALOG } from "../../../packages/content-core/src/editor-admin";
import { STORY_CREDITS_MAX, STORY_CREDIT_NAME_MAX, normalizeCustomCreditName } from "../../../packages/content-core/src/story-credits";
import { assertAuthorRouteUniqueness, projectAuthorSnapshot, type CmsAuthorBuildData } from "./cms-authors-projection";

/** Published-only boundary. An approved service must enforce visibility and
 * tombstones in a fresh consistent read; it never returns a working draft.
 */
export interface PublishedPostReader {
  read(slug: string): Promise<unknown>;
}
export type PublishedPostContent = Omit<CmsPreviewContent, "kind" | "target" | "posts" | "publicContextReceipt"> & {
  readonly kind: "public-post-shadow";
  readonly posts: readonly NonNullable<ReturnType<typeof projectCmsPost>>[];
  readonly contentLinks?: readonly ContentLinkEntry[];
  readonly navigationPages: readonly { pageId: string; path: string }[];
  readonly target: Readonly<{
    documentId: string;
    sourceVersion: number;
    rendererSha: string;
    pagePath: string;
  }>;
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

function referencedAuthorIds(published: unknown): string[] {
  if (!object(published) || !object(published.metadata)) throw new Error("Invalid published Post snapshot");
  const blog = published.metadata.liveBlog;
  const groups = [published.metadata.credits ?? [], ...(object(blog) && Array.isArray(blog.updates)
    ? blog.updates.flatMap(entry => object(entry) ? [entry.credits, ...(entry.withdrawal === undefined && Array.isArray(entry.followUps)
      ? entry.followUps.map(reply => object(reply) ? reply.credits : null) : [])] : [null]) : [])];
  const ids: string[] = [];
  for (const credits of groups) {
    if (!Array.isArray(credits) || credits.length > STORY_CREDITS_MAX) throw new Error("Invalid published credits");
    const seen = new Set<string>();
    for (const credit of credits) {
      if (!object(credit) || !["registered", "custom"].includes(String(credit.kind))) throw new Error("Invalid published credit");
      const name = credit.kind === "custom" ? credit.name : credit.displayName;
      if (typeof name !== "string" || !name || name.length > STORY_CREDIT_NAME_MAX || normalizeCustomCreditName(name) !== name) {
        throw new Error("Invalid published credit name");
      }
      if (credit.kind === "custom") continue;
      if (!isAuthorId(credit.authorId) || credit.authorId.length !== 35 || seen.has(credit.authorId) ||
          (credit.slug !== undefined && (!isValidAuthorSlug(credit.slug) || credit.slug.trim() !== credit.slug))) {
        throw new Error("Invalid published author identity");
      }
      seen.add(credit.authorId);
      if (!ids.includes(credit.authorId)) ids.push(credit.authorId);
    }
  }
  return ids;
}

function projectAuthors(input: Record<string, unknown>, ids: readonly string[]): CmsAuthorBuildData[] {
  const documents = input.authors === undefined ? [] : input.authors;
  if (!Array.isArray(documents)) throw new Error("Invalid public author context");
  // Same first-100 budget as the reader/dependency collector; overflow keeps the
  // Post readable with frozen names and initials, without loading extra profiles.
  const selected = new Set(ids.slice(0, 100));
  const seen = new Set<string>();
  const authors = new Map<string, CmsAuthorBuildData>();
  for (const document of documents.slice(0, 100)) {
    if (!object(document) || !isAuthorId(document.id) || !ids.includes(document.id) || seen.has(document.id) ||
        (typeof document.authorId === "string" && document.authorId !== document.id)) throw new Error("Invalid public author identity");
    seen.add(document.id);
    if (!selected.has(document.id)) continue;
    const author = projectAuthorSnapshot(document.id, document);
    if (author) authors.set(document.id, author);
  }
  const ordered = ids.flatMap(id => {
    const author = authors.get(id);
    return author ? [author] : [];
  });
  assertAuthorRouteUniqueness(ordered);
  return ordered;
}

export function projectChrome(input: Record<string, unknown>) {
  const documents = input.settings ?? [];
  const pages = input.navigationPages ?? [];
  if (!Array.isArray(documents) || !Array.isArray(pages)) throw new Error("Invalid published chrome");
  const knownIds = ["site-navigation", "public-site-chrome", NJ_DECIDES_SETTINGS_ID, PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, STORY_CTAS_SETTINGS_ID];
  const settings: PublicSettingBuildData[] = documents.flatMap((document): PublicSettingBuildData[] => {
    if (!object(document) || typeof document.id !== "string" || !document.id) {
      throw new Error("Invalid published setting");
    }
    // A newer CMS can add settings this renderer does not consume. Discard
    // them before projection; known documents still use their strict contracts.
    // The complete published read retains its two-megabyte transport bound.
    if (!knownIds.includes(document.id)) return [];
    if (document.id === STORY_CTAS_SETTINGS_ID) {
      const projected = projectStoryCtas(document);
      return projected ? [projected.data] : [];
    }
    if (document.id === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID) {
      const banner = projectPublicHomepageBanner({ ...document, id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID });
      if (!banner) throw new Error("Invalid published election banner");
      return [banner];
    }
    if (document.id === NJ_DECIDES_SETTINGS_ID) {
      const projected = projectNjDecidesSettings({ ...document, id: NJ_DECIDES_SETTINGS_ID },
        new Map(Object.entries(object(document.assets) ? document.assets : {})));
      if (projected.status !== "published") throw new Error("Invalid published NJ Decides setting");
      return [projected.data];
    }
    const snapshot = projectPublishedCmsSettings({ documentId: document.id, document });
    if (!snapshot) throw new Error("Missing published setting");
    const receipt = { sourceVersion: snapshot.sourceVersion, publishedAt: snapshot.publishedAt };
    return [document.id === "site-navigation"
      ? { settingId: "site-navigation", ...snapshot.values as unknown as Pick<SiteNavigationBuildData, "header" | "footer">, ...receipt }
      : { settingId: "public-site-chrome", ...snapshot.values as unknown as PublicSiteChromeSettingsValues, ...receipt }];
  });
  const navigationPages = pages.map(page => {
    if (!object(page) || typeof page.pageId !== "string" || typeof page.path !== "string" ||
        publicPagePath(page.pageId, page.path === "/" ? {} : { slug: page.path.slice(1, -1) }) !== page.path) {
      throw new Error("Invalid published navigation path");
    }
    return { pageId: page.pageId, path: page.path };
  });
  const coverage = projectCoverageLabels(input.coverageLabels);
  if (coverage) settings.push(coverage.data);
  if (new Set(settings.map(setting => setting.settingId)).size !== settings.length ||
      new Set(navigationPages.map(page => page.pageId)).size !== navigationPages.length ||
      new Set(navigationPages.map(page => page.path)).size !== navigationPages.length) throw new Error("Duplicate published chrome");
  const contentLinks = input.contentLinks === undefined ? [] : input.contentLinks;
  if (!contentLinkDirectoryFits(contentLinks)) throw new Error("Invalid content link directory");
  const projectedLinks = (contentLinks as unknown[]).map(entry => {
    if (!object(entry) || typeof entry.path !== "string" || !/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/.test(entry.path)) throw new Error("Invalid content link path");
    return { path: entry.path, ...contentLinkMetadata(entry),
      ...(Array.isArray(entry.previousSlugs) && entry.previousSlugs.every(slug => typeof slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) ? { previousSlugs: entry.previousSlugs as string[] } : {}) };
  });
  return { settings, navigationPages, ...(projectedLinks.length ? { contentLinks: projectedLinks } : {}) };
}

/** Reuse the static projector. Never manufacture public visibility for input. */
export function projectPublishedPostRead(
  input: unknown, slug: string, rendererSha: string, now: Date,
): PublishedPostContent | null {
  if (!isPublicContentSlug(slug) || !/^[a-f0-9]{40}$/.test(rendererSha)) throw new Error("Invalid shadow target");
  if (input === null) return null;
  if (!object(input) || input.kind !== "published-post" || !object(input.document) ||
    typeof input.document.id !== "string" || !Array.isArray(input.assets)) {
    throw new Error("Expected a published Post read");
  }
  if (!contentLinkReadFits(input, 2 * 1024 * 1024)) throw new Error("Published read too large");
  const assets = new Map<string, Record<string, unknown>>();
  for (const asset of input.assets) {
    if (!object(asset) || typeof asset.id !== "string" || assets.has(asset.id)) throw new Error("Invalid public media projection");
    assets.set(asset.id, asset);
  }
  const doc = input.document;
  const authorIds = referencedAuthorIds(doc.published);
  const authors = projectAuthors(input, authorIds);
  const post = projectCmsPost({ id: doc.id as string, status: doc.status,
    publiclyVisible: doc.publiclyVisible, publishAt: doc.publishAt, deleted: doc.deleted,
    published: structuredClone(doc.published) }, { now, assets });
  if (!post) return null;
  if (post.slug !== slug) throw new Error("Published Post does not own this route");
  // The editor's Post catalog is the one list of block types the Post template
  // renders. Any other type is refused by name before it reaches the renderer.
  const outsideCatalog = post.blocks.find(block => !SECTION_BLOCK_CATALOG.post.includes(block.type));
  if (outsideCatalog) throw new Error(`Post block type ${outsideCatalog.type} is outside the Post template`);
  const joined = projectJoinedRecords(input.joinedRecords, assets, now);
  return freeze({ kind: "public-post-shadow", target: {
    documentId: post.postId, sourceVersion: post.sourceVersion, rendererSha, pagePath: post.path,
  }, posts: [post], pages: [], authors, ...projectChrome(input), ...joined });
}

/** Home uses card metadata and bylines, independently of the detail body's
 * instant-render capability. A card-only read cannot enter the detail reader. */
export function projectPublishedPostCardRead(input: unknown, rendererSha: string, now: Date): PublishedPostContent | null {
  if (!object(input) || !["published-post-card", "published-post"].includes(String(input.kind)) ||
      !object(input.document) || !object(input.document.published) || !object(input.document.published.metadata)) {
    throw new Error("Expected a published Post card read");
  }
  const published: Record<string, unknown> = { ...input.document.published, blocks: [] };
  delete published.datasetFigures;
  return projectPublishedPostRead({ ...input, kind: "published-post", document: { ...input.document,
    published }, joinedRecords: [],
  }, String(input.document.published.metadata.slug), rendererSha, now);
}

/** Current referenced records only. A missing or non-public reference is omitted. */
export function projectJoinedRecords(
  records: unknown, assets: Map<string, Record<string, unknown>>, now: Date,
) {
  const programs: CmsProgramBuildData[] = [];
  const events: CmsEventBuildData[] = [];
  const library: (Record<string, unknown> & { id: string })[] = [];
  const view = assets as ReadonlyMap<string, { id?: unknown; url?: unknown; mimeType?: unknown; width?: unknown; height?: unknown }>;
  for (const record of Array.isArray(records) ? records : []) {
    if (!object(record) || typeof record.id !== "string") throw new Error("Invalid joined record");
    const published = object(record.published) && object(record.published.metadata) ? record.published.metadata.type : record.type;
    if (published === "program") {
      const program = projectCmsProgram(record as CmsProgramDoc, { now, assets: view });
      if (program) programs.push(program);
    } else if (published === "event") {
      const event = projectCmsEvent(record as never, { now, assets: view as never });
      if (event) events.push(event);
    } else if (published === "sponsor" || published === "newsletter") {
      library.push(record as Record<string, unknown> & { id: string });
    }
  }
  const assetList = [...assets.values()].flatMap(asset =>
    typeof asset.id === "string" && typeof asset.url === "string" && typeof asset.mimeType === "string"
      ? [{ id: asset.id, url: asset.url, mimeType: asset.mimeType,
        ...(Number.isInteger(asset.width) ? { width: Number(asset.width) } : {}),
        ...(Number.isInteger(asset.height) ? { height: Number(asset.height) } : {}) }] : []);
  return { programs, events, recordCards: exportRecordCards(library, programs, now, assetList, events) };
}

/** Local fake only. No SDK, credentials, network or production data. */
export function createFakePublishedPostReader(initial: Record<string, unknown>) {
  const records = new Map(Object.entries(structuredClone(initial)));
  let failure: Error | undefined;
  return {
    async read(slug: string): Promise<unknown> {
      if (failure) throw failure;
      return structuredClone(records.get(slug) ?? null);
    },
    set(slug: string, value: unknown) { records.set(slug, structuredClone(value)); },
    fail(error: Error) { failure = error; },
    async publish(slug: string, value: unknown, followup: (slugs: string[]) => Promise<void>, previousSlugs: string[] = []) {
      // Local publication stub: Commit the fake snapshot before invalidation.
      records.set(slug, structuredClone(value));
      await followup([...previousSlugs, slug]);
    },
  };
}
