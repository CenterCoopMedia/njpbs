// Pure public author projection shared by the full build and Post Worker.

import { isCmsMediaUrl } from "../../../packages/content-core/src/media-origin.ts";
import {
  AUTHOR_BIO_MAX,
  AUTHOR_HIDDEN_POSTS_MAX,
  AUTHOR_JOB_TITLE_MAX,
  AUTHOR_NAME_MAX,
  SOCIAL_PLATFORMS,
  authorPublicPath,
  isAuthorId,
  isPostReference,
  isValidAuthorSlug,
  normalizeSocialLink,
  type SocialPlatform,
} from "../../../packages/content-core/src/author-profiles.ts";
import { routesOf } from "./slug-routes.ts";

export interface AuthorPhotoBuildData {
  /** Original address. Social cards and structured data keep this. */
  url: string;
  /** Square portrait address. A covering thumbnail, or the original. */
  displayUrl: string;
  mimeType: string;
  width: number;
  height: number;
  /** Percentages, ready for `object-position`. */
  focalX: number;
  focalY: number;
  credit: string | null;
}

export interface CmsAuthorBuildData {
  profilePageReady?: boolean;
  authorId: string;
  slug: string;
  previousSlugs: string[];
  path: string;
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  photo: AuthorPhotoBuildData | null;
  links: { platform: SocialPlatform; url: string }[];
  pinnedPostId: string | null;
  hiddenPostIds: string[];
  sourceVersion: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

function approvedCmsMediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return isCmsMediaUrl(url) ? value : null;
}

// The author portrait is 19rem and a staff card can be wider than its 18rem
// minimum. Two device pixels is 608. A thumbnail has to cover that square on
// its short side; a wide file resized by width can be shorter than the original.
const AUTHOR_PORTRAIT_SHORT_SIDE = 608;

function portraitUrl(photo: Record<string, unknown>, original: string): string {
  const thumbnails = Array.isArray(photo.thumbnails)
    ? photo.thumbnails.flatMap((item) => {
      if (!isPlainObject(item)) return [];
      const url = approvedCmsMediaUrl(item.url);
      if (
        url === null ||
        !Number.isSafeInteger(item.width) ||
        Number(item.width) < 1 ||
        !Number.isSafeInteger(item.height) ||
        Number(item.height) < 1
      ) return [];
      return [{ url, width: Number(item.width), height: Number(item.height) }];
    })
    : [];
  thumbnails.sort((left, right) => left.width - right.width);
  const selected = thumbnails.find((item) =>
    Math.min(item.width, item.height) >= AUTHOR_PORTRAIT_SHORT_SIDE);
  return selected?.url ?? original;
}

/**
 * The photograph as the page renders it, or null.
 *
 * The snapshot already carries the address, the dimensions, and any library
 * thumbnails, so this reads no media library. It still re-checks the origin
 * and the dimensions, because an unsized `<img>` fails the CLS deploy gate and
 * an off-origin one would be a silent third-party request from a public page.
 * A photograph that fails either check is dropped and the page falls back to
 * initials, which is a complete page; refusing the whole author over a bad
 * crop would not be. The rendered address is a suitable thumbnail when the
 * snapshot has one. Width and height stay the original dimensions so the crop
 * aspect does not change.
 */
export function projectAuthorPhoto(value: unknown): AuthorPhotoBuildData | null {
  if (!isPlainObject(value)) return null;
  const original = approvedCmsMediaUrl(value.url);
  if (original === null) return null;
  if (typeof value.mimeType !== "string" || !value.mimeType.startsWith("image/")) {
    return null;
  }
  if (
    !Number.isSafeInteger(value.width) ||
    Number(value.width) <= 0 ||
    !Number.isSafeInteger(value.height) ||
    Number(value.height) <= 0
  ) {
    return null;
  }
  const focal = (raw: unknown): number => {
    const parsed = typeof raw === "number" && Number.isFinite(raw) ? raw : 0.5;
    return Math.round(Math.min(1, Math.max(0, parsed)) * 1000) / 10;
  };
  return {
    url: original,
    displayUrl: portraitUrl(value, original),
    mimeType: value.mimeType,
    width: Number(value.width),
    height: Number(value.height),
    focalX: focal(value.focalX),
    focalY: focal(value.focalY),
    credit: boundedText(value.credit, 300),
  };
}

/**
 * Project one public author snapshot, or null when it cannot back a page.
 *
 * Null rather than throw for a snapshot with no usable slug or name: those are
 * the two fields a route and a heading need, the write boundary already refuses
 * to create such a snapshot, and one unusable row must not stop a build that
 * would otherwise publish every other author correctly.
 */
export function projectAuthorSnapshot(
  authorId: string,
  value: unknown,
): CmsAuthorBuildData | null {
  if (!isAuthorId(authorId) || !isPlainObject(value)) return null;
  // Firestore path identity is authoritative, as it is in every other loader.
  if (typeof value.authorId === "string" && value.authorId !== authorId) return null;
  if (!isValidAuthorSlug(value.slug)) return null;
  const displayName = boundedText(value.displayName, AUTHOR_NAME_MAX);
  if (displayName === null) return null;
  if (!Number.isSafeInteger(value.snapshotVersion) || Number(value.snapshotVersion) < 1) {
    return null;
  }

  const previousSlugs = routesOf({
    slug: value.slug,
    previousSlugs: (Array.isArray(value.previousSlugs) ? value.previousSlugs : []).filter(
      (entry): entry is string => typeof entry === "string",
    ),
  }).redirects.filter((slug) => isValidAuthorSlug(slug));

  // Links are rebuilt through the shared allowlist rather than copied. A stored
  // link is already canonical, but a public outbound anchor is worth checking
  // twice: this is the one field on the page that sends a reader off-site.
  const links: { platform: SocialPlatform; url: string }[] = [];
  const stored = isPlainObject(value.links) ? value.links : {};
  for (const platform of SOCIAL_PLATFORMS) {
    const entry = stored[platform];
    if (entry === undefined || entry === null) continue;
    const result = normalizeSocialLink(platform, entry);
    if (result.ok && result.value) links.push({ platform, url: result.value.url });
  }

  const pinnedPostId = isPostReference(value.pinnedPostId) ? value.pinnedPostId : null;
  const hiddenPostIds = [
    ...new Set(
      (Array.isArray(value.hiddenPostIds) ? value.hiddenPostIds : []).filter(
        (entry): entry is string => isPostReference(entry) && entry !== pinnedPostId,
      ),
    ),
  ].slice(0, AUTHOR_HIDDEN_POSTS_MAX);

  return {
    authorId,
    slug: value.slug,
    previousSlugs,
    path: authorPublicPath(value.slug),
    displayName,
    jobTitle: boundedText(value.jobTitle, AUTHOR_JOB_TITLE_MAX),
    bio: boundedText(value.bio, AUTHOR_BIO_MAX),
    photo: projectAuthorPhoto(value.photo),
    links,
    pinnedPostId,
    hiddenPostIds,
    sourceVersion: Number(value.snapshotVersion),
  };
}

/** Refuse a build in which two authors claim one `/authors/` route. */
export function assertAuthorRouteUniqueness(authors: readonly CmsAuthorBuildData[]): void {
  const owners = new Map<string, string>();
  const collisions: string[] = [];
  for (const author of authors) {
    for (const route of [author.path, ...author.previousSlugs.map(authorPublicPath)]) {
      const existing = owners.get(route);
      if (existing !== undefined && existing !== author.authorId) {
        collisions.push(`${route} is claimed by ${existing} and ${author.authorId}`);
        continue;
      }
      owners.set(route, author.authorId);
    }
  }
  if (collisions.length > 0) {
    throw new Error(`/authors/ routes collide: ${collisions.sort().join("; ")}`);
  }
}
