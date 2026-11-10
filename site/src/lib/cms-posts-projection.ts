import { contentLinkMetadata } from "../../../packages/content-core/src/content-link.ts";
import { cmsImageThumbnails, type CmsImageThumbnail } from "../../../packages/content-core/src/cms-image-variants.ts";
import type { ContentLinkMetadata } from "../../../packages/content-core/src/content-link.ts";
import { isCoverageLabelId } from "../../../packages/content-core/src/cms-settings.ts";
import { postCoverageLabelId } from "../../../packages/content-core/src/coverage-labels.ts";
import { liveBlogMediaAssetIds } from "../../../packages/content-core/src/live-blog.ts";
import { readPostLeadMedia, leadMediaAssetIds, leadMediaTitle, type PostLeadMedia } from "../../../packages/content-core/src/post-lead-media.ts";
import { heroBackgroundMetadata } from "../../../packages/content-core/src/hero-background.ts";
import { publicLiveBlogData, previewLiveBlogData, type LiveBlogData } from "../../../packages/content-core/src/live-blog.ts";
import { isCmsImageUrl } from "../../../packages/content-core/src/media-origin.ts";
// The public Post loader: Firestore `cmsPosts` published snapshots -> /posts/{slug}/.
//
// This mirrors `cms-loader.ts` deliberately rather than sharing its body. The two
// collections answer different questions. `cmsPages` is a fixed roster of 18
// canonical documents whose routes are declared in code, so a missing page is a
// build failure. `cmsPosts` is an open set whose routes come from the content
// itself, so the questions here are which posts are admitted, what route each one
// claims, and whether two of them claim the same route. What is shared is the
// philosophy: published snapshots only, no working document ever reaches a public
// page, and body metadata fails closed; an invalid lead is omitted so the header still renders.
//
// Three things this projection will not do, each for a reason:
//
// - It never reads the working document's title, body, byline, or dates. Those
//   live on the mutable record and a draft edit must not reach a live page.
// - It never emits `firstPublishedBy` or `meaningfulUpdatedBy`. Those are uids.
//   They are frozen into the server-side snapshot as a publication receipt and
//   they have no business in a static file served to the public.
// - It never resolves a registered credit against the author directory. The
//   display name (and the slug, when the profile was public) were frozen at
//   publish time by the credits contract. Public presentation resolves current
//   registered-author names and links through public-author-links, with these
//   frozen fields as the missing-profile fallback.

import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout.ts";
import {
  parseBlocks,
  type PageBlock,
  type PostPublishedMetadata,
  type SearchMetadata,
  type SocialMetadata,
} from "../../../packages/content-core/src/content-model.ts";
import {
  editorialSortInstant,
  resolveDisplayDate,
  resolveUpdateDisplay,
} from "../../../packages/content-core/src/editorial-dates.ts";
import {
  STORY_CREDITS_MAX,
  creditsFromLegacyAuthor,
  normalizeCustomCreditName,
  type StoryCredit,
} from "../../../packages/content-core/src/story-credits.ts";
import { isAuthorId } from "../../../packages/content-core/src/author-profiles.ts";
import type { DatasetFigures } from "../../../packages/content-core/src/dataset-figures.ts";
import { isPublishable } from "./publish-gate.ts";
import { projectDatasetFigures } from "./dataset-figures-projection.ts";
import { routesOf } from "./slug-routes.ts";
import {
  POST_PUBLIC_ROUTE_BASE,
  isPublicContentSlug,
  postPublicPath,
} from "./public-content-routes.ts";
export interface CmsPostDoc {
  id: string;
  status?: unknown;
  publiclyVisible?: unknown;
  publishAt?: unknown;
  deleted?: unknown;
  published?: unknown;
  [key: string]: unknown;
}

/** One media projection, the same shape the page loader resolves. */
export interface CmsPublicImage {
  thumbnails?: CmsImageThumbnail[];
  credit?: string;
  assetId: string;
  url: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif";
  width: number;
  height: number;
}

/** A byline entry as the public page renders it. */
export interface PublicCredit {
  name: string;
  /** Present only when the author's profile was public at this publish. */
  slug?: string;
  /** Present for a registered credit; the join key the author pages group on. */
  authorId?: string;
}

export interface CmsPostBuildData extends ContentLinkMetadata {
  postId: string;
  slug: string;
  previousSlugs: string[];
  locale: string;
  path: string;
  title: string;
  /** Absent on older artifacts; reader-facing attribution is opt-in. */
  spotlightNews?: boolean;
  coverageLabelId?: string;
  showInHomeHero?: boolean;
  summary: string;
  excerpt: string;
  categories: string[];
  tags: string[];
  credits: PublicCredit[];
  /** Every registered authorId on the byline, for the author-page join. */
  authorIds: string[];
  /** The station-time calendar day the page prints. Never a publish clock time. */
  displayDate: string | null;
  /** The instant a listing sorts by. Null only for a post with no date at all. */
  sortInstant: number | null;
  /** Whether and what to print for "Updated ...". */
  updateShown: boolean;
  updatedAt: string | null;
  updatedDate: string | null;
  heroBackgroundImage?: CmsPublicImage | null;
  heroBackgroundPosition?: "center" | "top" | "bottom";
  leadMedia?: PostLeadMedia | null;
  heroImage: CmsPublicImage | null;
  heroImageAlt: string;
  heroImageDecorative: boolean;
  heroImageCaption?: string;
  blocks: PageBlock[];
  datasetFigures?: DatasetFigures;
  liveBlog?: LiveBlogData;
  assets: Record<string, CmsPublicImage>;
  noindex: boolean;
  seo?: SearchMetadata;
  social?: SocialMetadata;
  sourceVersion: number;
  /** The trusted first-publication receipt. Null for pre-contract posts. */
  firstPublishedAt: string | null;
  /** The instant this published snapshot revision went live. */
  publishedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function approvedMediaUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return isCmsImageUrl(url);
}

/**
 * Resolve one media id against the public projection, or throw.
 *
 * Fail-closed on purpose, and the same rule the page loader applies: an image a
 * published post references but whose projection is missing, off-origin, or
 * unsized would render either as a broken image or as an unsized `<img>` that
 * trips the CLS deploy gate. Body/social references refuse the post; the caller
 * omits a failed lead-only image and emits a diagnostic.
 */
export function resolveImage(
  assetId: string,
  available: ReadonlyMap<string, { url?: unknown; mimeType?: unknown; width?: unknown; height?: unknown; credit?: unknown; thumbnails?: unknown }>,
): CmsPublicImage {
  const asset = available.get(assetId);
  if (!asset) throw new Error(`missing media asset ${assetId}`);
  if (typeof asset.url !== "string" || !approvedMediaUrl(asset.url)) {
    throw new Error(`media asset ${assetId} URL must use an approved origin and path`);
  }
  if (
    typeof asset.mimeType !== "string" ||
    !SUPPORTED_IMAGE_MIME_TYPES.has(asset.mimeType)
  ) {
    throw new Error(`media asset ${assetId} is not a supported image`);
  }
  if (
    !Number.isSafeInteger(asset.width) ||
    Number(asset.width) <= 0 ||
    !Number.isSafeInteger(asset.height) ||
    Number(asset.height) <= 0
  ) {
    throw new Error(`media asset ${assetId} must have positive dimensions`);
  }
  if (asset.credit !== undefined && (typeof asset.credit !== "string" || asset.credit.length > 300)) {
    throw new Error(`media asset ${assetId} has invalid credit`);
  }
  const thumbnails = cmsImageThumbnails(asset);
  return {
    ...(typeof asset.credit === "string" && asset.credit.trim() ? { credit: asset.credit.trim() } : {}),
    ...(thumbnails.length ? { thumbnails } : {}),
    assetId,
    url: asset.url,
    mimeType: asset.mimeType as CmsPublicImage["mimeType"],
    width: Number(asset.width),
    height: Number(asset.height),
  };
}

/** Every media id a published post body references. */
export function postAssetIds(metadata: unknown, blocks: readonly PageBlock[]): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type === "image") ids.add(block.data.assetId);
    if (block.type === "bio_card" && block.data.image?.assetId) ids.add(block.data.image.assetId);
    if (block.type === "election_results") {
      for (const race of block.data.races) for (const candidate of race.candidates) if (candidate.photo) ids.add(candidate.photo.assetId);
    }
    if (block.type === "image_gallery") {
      for (const image of block.data.images) ids.add(image.assetId);
    }
    if (block.type === "card_grid") {
      for (const card of block.data.cards) {
        if (card.imageAssetId) ids.add(card.imageAssetId);
      }
    }
    if (block.type === "promotion_playlist") {
      for (const card of block.data.cards) {
        if (card.imageAssetId) ids.add(card.imageAssetId);
      }
    }
  }
  if (isPlainObject(metadata)) {
    if (typeof metadata.heroBackgroundImage === "string" && metadata.heroBackgroundImage !== "") ids.add(metadata.heroBackgroundImage);
    for (const id of leadMediaAssetIds(readPostLeadMedia(metadata))) ids.add(id);
    if (metadata.type === "post") for (const id of liveBlogMediaAssetIds(metadata.liveBlog)) ids.add(id);
    if (metadata.type === "program" && typeof metadata.keyArtAssetId === "string" && metadata.keyArtAssetId !== "") ids.add(metadata.keyArtAssetId);
    if (
      isPlainObject(metadata.social) &&
      typeof metadata.social.imageAssetId === "string" &&
      metadata.social.imageAssetId !== ""
    ) {
      ids.add(metadata.social.imageAssetId);
    }
  }
  // A Firestore document id cannot contain a slash. An id that does is left
  // unread so the projection reports "missing media asset" rather than turning
  // malformed content into an unrelated SDK path error.
  return [...ids].filter((id) => id !== "" && !id.includes("/")).sort();
}

function optionalString(value: unknown, owner: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${owner} must be a string`);
  return value;
}

function optionalStringList(value: unknown, owner: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${owner} must be an array of strings`);
  }
  return [...value];
}

function metadataGroup<T extends SearchMetadata | SocialMetadata>(
  value: unknown,
  owner: "seo" | "social",
): T | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error(`${owner} must be an object`);
  for (const field of ["title", "description"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`${owner}.${field} must be a string`);
    }
  }
  if (owner === "seo" && value.noindex !== undefined && typeof value.noindex !== "boolean") {
    throw new Error("seo.noindex must be a boolean");
  }
  if (
    owner === "social" &&
    value.imageAssetId !== undefined &&
    typeof value.imageAssetId !== "string"
  ) {
    throw new Error("social.imageAssetId must be a string");
  }
  return { ...value } as unknown as T;
}

/**
 * The byline as a public page renders it.
 *
 * Registered credits keep their `authorId` so the author pages can group by a
 * stable key, and carry the slug only when one was frozen at publish -- a
 * private or withdrawn profile has no page to link to, and inventing a link to
 * one would 404. A credit with no readable name was already dropped by
 * `freezeStoryCredits`; dropping it again here costs nothing and keeps a raw
 * `au_...` id off a public page under every input.
 */
/**
 * The credits frozen into one published snapshot.
 *
 * Deliberately NOT `resolveStoryCredits`. That resolver is for a WORKING
 * document, where a registered credit is an id and nothing else, and it strips a
 * submitted display name on purpose so a client cannot dictate what a byline
 * says. A published snapshot is the opposite case: the display name and the
 * public slug in it were written by the server at publish time and are the only
 * record of how that byline read then. Running the working-document resolver
 * over a snapshot would throw exactly those frozen names away and leave every
 * registered credit unrenderable.
 *
 * A pre-credits snapshot, which has no `credits` array at all, still converts
 * its single `author` string to one custom credit. An empty array is a real
 * answer -- a post deliberately published with no byline -- and does not fall
 * back to the legacy field.
 */
export function publishedCredits(metadata: Record<string, unknown>): StoryCredit[] {
  if (!Array.isArray(metadata.credits)) {
    return creditsFromLegacyAuthor(metadata.author);
  }
  const credits: StoryCredit[] = [];
  const seen = new Set<string>();
  for (const raw of metadata.credits.slice(0, STORY_CREDITS_MAX)) {
    if (!isPlainObject(raw)) continue;
    if (raw.kind === "custom") {
      const name = normalizeCustomCreditName(raw.name);
      if (name.length > 0) credits.push({ kind: "custom", name });
      continue;
    }
    if (raw.kind !== "registered" || !isAuthorId(raw.authorId) || seen.has(raw.authorId)) {
      continue;
    }
    seen.add(raw.authorId);
    const displayName = normalizeCustomCreditName(raw.displayName);
    credits.push({
      kind: "registered",
      authorId: raw.authorId,
      ...(displayName.length > 0 ? { displayName } : {}),
      ...(typeof raw.slug === "string" && raw.slug.length > 0 ? { slug: raw.slug } : {}),
    });
  }
  return credits;
}

export function publicCredits(credits: readonly StoryCredit[]): PublicCredit[] {
  const out: PublicCredit[] = [];
  for (const credit of credits) {
    if (credit.kind === "custom") {
      if (credit.name.trim() === "") continue;
      out.push({ name: credit.name });
      continue;
    }
    const name = (credit.displayName ?? "").trim();
    if (name === "") continue;
    out.push({
      name,
      authorId: credit.authorId,
      ...(typeof credit.slug === "string" && credit.slug !== ""
        ? { slug: credit.slug }
        : {}),
    });
  }
  return out;
}

/**
 * Project one stored post document into what the public route renders, or null
 * when the post is not admitted (a draft, a scheduled post whose time has not
 * come, a soft-deleted one). Throws for an admitted post whose snapshot is
 * malformed, except an invalid lead is omitted so its header remains readable.
 */
export function projectCmsPost(
  doc: CmsPostDoc,
  options: {
    now: Date;
    assets?: ReadonlyMap<string, Record<string, unknown>>;
    complete?: boolean;
  },
): (CmsPostBuildData & { spotlightNews: boolean }) | null {
  if (
    doc.deleted ||
    !isPublishable(
      {
        status: doc.status as never,
        publishAt: doc.publishAt as never,
        publiclyVisible: doc.publiclyVisible as never,
        published: doc.published,
        deleted: doc.deleted as never,
      },
      options.now,
    )
  ) {
    return null;
  }
  if (!isPlainObject(doc.published)) {
    throw new Error(`post ${doc.id} has no published snapshot`);
  }
  const snapshot = doc.published;
  const metadata = snapshot.metadata;
  if (!isPlainObject(metadata)) {
    throw new Error(`post ${doc.id} has no published metadata`);
  }
  if (metadata.type !== "post") {
    // Non-post records share the cmsPosts collection (programs, events, staff,
    // sponsors, newsletters). They are not /posts/ routes and are not an error.
    return null;
  }
  if (typeof metadata.title !== "string" || metadata.title.trim() === "") {
    throw new Error(`post ${doc.id} has no published title`);
  }
  if (!isPublicContentSlug(metadata.slug)) {
    throw new Error(`post ${doc.id} has no route-safe published slug`);
  }
  const previousSlugs = Array.isArray(metadata.previousSlugs)
    ? metadata.previousSlugs
    : [];
  if (previousSlugs.some((slug) => typeof slug !== "string")) {
    throw new Error(`post ${doc.id} has a malformed previousSlugs list`);
  }
  // A retired slug that is not route-safe cannot be emitted as a route. That is
  // not a reason to refuse the post: the live page is still correct, and the
  // unroutable old URL simply gets no redirect stub.
  const routableRedirects = routesOf({
    slug: metadata.slug,
    previousSlugs: previousSlugs as string[],
  }).redirects.filter((slug) => isPublicContentSlug(slug));

  if (typeof snapshot.publishedAt !== "string") {
    throw new Error(`post ${doc.id} published snapshot has no publish time`);
  }
  if (!Number.isInteger(snapshot.sourceVersion) || Number(snapshot.sourceVersion) < 1) {
    throw new Error(`post ${doc.id} published snapshot has no source version`);
  }
  const parsed = parseBlocks(snapshot.blocks, { complete: options.complete ?? true });
  if (!parsed.ok) throw new Error(`post ${doc.id} blocks are invalid: ${parsed.error}`);
  const blocks = visibleLayoutBlocks(parsed.blocks)
    .sort((left, right) => left.order - right.order);
  const datasetFigures = projectDatasetFigures(
    snapshot.datasetFigures,
    blocks,
    `post ${doc.id}`,
    { required: options.complete ?? true },
  );

  const dates = metadata as unknown as PostPublishedMetadata;
  const displayDate = resolveDisplayDate(dates);
  if (displayDate === null) {
    throw new Error(`post ${doc.id} has no resolvable publication date`);
  }
  const update = resolveUpdateDisplay(dates);

  const available = options.assets ?? new Map();
  const assets: Record<string, CmsPublicImage> = {};
  const strictIds = new Set(postAssetIds({ ...metadata, leadMedia: null }, blocks));
  for (const id of postAssetIds(metadata, blocks)) {
    try { assets[id] = resolveImage(id, available); }
    catch (error) {
      if (strictIds.has(id)) throw error;
      console.warn("Omitting an invalid Post lead image projection", { postId: doc.id, assetId: id });
    }
  }
  const background = heroBackgroundMetadata(metadata);
  let leadMedia = readPostLeadMedia(metadata, options.complete ?? true);
  if (leadMedia?.kind === "image" && !assets[leadMedia.data.assetId]) leadMedia = null;
  const legacy = metadata.leadMedia === undefined;
  // Keep old metadata checks; new lead validation fails safely without taking down a page.
  const legacyAlt = legacy ? optionalString(metadata.heroImageAlt, "heroImageAlt") ?? "" : "";
  const legacyCaption = legacy ? optionalString(metadata.heroImageCaption, "heroImageCaption") ?? "" : "";
  let heroImage: CmsPublicImage | null = null;
  if (leadMedia?.kind === "image") heroImage = assets[leadMedia.data.assetId] ?? null;
  else if (leadMedia) {
    const poster = leadMedia.posterAssetId ? assets[leadMedia.posterAssetId] : null;
    const publicVideo = leadMedia.kind === "library-video" ? leadMedia.data.public : undefined;
    const url = publicVideo?.posterUrl;
    heroImage = poster ?? (url ? { assetId: "lead-video-poster", url, mimeType: "image/jpeg",
      width: publicVideo?.width ?? 480, height: publicVideo?.height ?? 360 } : null);
  }

  const categories = optionalStringList(metadata.categories, "categories");
  const tags = optionalStringList(metadata.tags, "tags");
  if (metadata.coverageLabelId !== undefined && !isCoverageLabelId(metadata.coverageLabelId)) throw new Error(`post ${doc.id} coverageLabelId is invalid`);
  if (metadata.spotlightNews !== undefined && typeof metadata.spotlightNews !== "boolean") {
    throw new Error(`post ${doc.id} spotlightNews must be a boolean`);
  }
  if (metadata.showInHomeHero !== undefined && typeof metadata.showInHomeHero !== "boolean") {
    throw new Error(`post ${doc.id} showInHomeHero must be a boolean`);
  }
  const credits = publicCredits(publishedCredits(metadata));
  const seo = metadataGroup<SearchMetadata>(metadata.seo, "seo");
  const social = metadataGroup<SocialMetadata>(metadata.social, "social");

  return {
    postId: doc.id,
    slug: metadata.slug,
    previousSlugs: routableRedirects,
    locale: typeof metadata.locale === "string" && metadata.locale !== ""
      ? metadata.locale
      : "en",
    path: postPublicPath(metadata.slug),
    ...contentLinkMetadata(metadata as unknown as Record<string, unknown>),
    title: metadata.title,
    spotlightNews: metadata.spotlightNews === true,
    ...(postCoverageLabelId(metadata) ? { coverageLabelId: postCoverageLabelId(metadata) } : {}),
    ...(metadata.showInHomeHero === undefined ? {} : { showInHomeHero: metadata.showInHomeHero }),
    summary: optionalString(metadata.summary, "summary") ?? "",
    excerpt: optionalString(metadata.excerpt, "excerpt") ?? "",
    categories,
    tags,
    credits,
    authorIds: credits
      .map((credit) => credit.authorId)
      .filter((id): id is string => typeof id === "string"),
    displayDate,
    sortInstant: editorialSortInstant(dates),
    updateShown: update.show,
    updatedAt: update.show ? update.at : null,
    updatedDate: update.show ? update.date : null,
    leadMedia,
    heroImage,
    ...(background.heroBackgroundImage ? { heroBackgroundImage: assets[background.heroBackgroundImage] } : {}),
    ...(background.heroBackgroundPosition ? { heroBackgroundPosition: background.heroBackgroundPosition } : {}),
    heroImageAlt: leadMedia?.kind === "image" ? leadMedia.data.alt : leadMedia ? leadMediaTitle(leadMedia) : legacyAlt,
    heroImageDecorative: leadMedia?.kind === "image" && leadMedia.data.altDecorative === true,
    heroImageCaption: leadMedia?.data.caption ?? legacyCaption,
    blocks,
    ...(datasetFigures ? { datasetFigures } : {}),
    ...(metadata.liveBlog === undefined ? {} : { liveBlog: (options.complete === false ? previewLiveBlogData : publicLiveBlogData)(metadata.liveBlog, snapshot.publishedAt) }),
    assets,
    noindex: seo?.noindex ?? false,
    ...(seo ? { seo } : {}),
    ...(social ? { social } : {}),
    sourceVersion: Number(snapshot.sourceVersion),
    firstPublishedAt:
      optionalString(metadata.firstPublishedAt, "firstPublishedAt") ?? null,
    publishedAt: snapshot.publishedAt,
  };
}

/**
 * Refuse a build in which two admitted posts claim the same public route.
 *
 * Firestore puts no unique constraint on a slug, so this is reachable in
 * ordinary operation: two posts renamed to the same thing, or a new post taking
 * a slug an older one still redirects from. Emitting either shape would let one
 * post silently overwrite the other's `index.html`.
 */
export function assertPostRouteUniqueness(posts: readonly CmsPostBuildData[]): void {
  const owners = new Map<string, string>();
  const collisions: string[] = [];
  for (const post of posts) {
    for (const route of [post.path, ...post.previousSlugs.map(postPublicPath)]) {
      const existing = owners.get(route);
      if (existing !== undefined && existing !== post.postId) {
        collisions.push(`${route} is claimed by ${existing} and ${post.postId}`);
        continue;
      }
      owners.set(route, post.postId);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `${POST_PUBLIC_ROUTE_BASE} routes collide: ${collisions.sort().join("; ")}`,
    );
  }
}
