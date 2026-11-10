import {
  isRichTextDoc,
  richTextRendersEmpty,
  type RichTextDoc,
} from "../../../packages/content-core/src/content-model.ts";
import { resolveImage, type CmsPublicImage } from "./cms-posts-projection.ts";
import { isPublishable } from "./publish-gate.ts";
import {
  isPublicContentSlug,
  programPublicPath,
} from "./public-content-routes.ts";
import { routesOf } from "./slug-routes.ts";

export interface CmsProgramDoc {
  id: string;
  status?: unknown;
  publiclyVisible?: unknown;
  publishAt?: unknown;
  deleted?: unknown;
  published?: unknown;
  [key: string]: unknown;
}

export interface CmsProgramBuildData {
  programId: string;
  slug: string;
  /** Route-safe retired slugs, each of which gets a canonical redirect stub. */
  previousSlugs: string[];
  locale: string;
  path: string;
  title: string;
  /** The genre label, or null when the editor left it blank. */
  genre: string | null;
  /** The frozen synopsis, rendered through the shared rich-text renderer. */
  description: RichTextDoc;
  /** True only when the record says so; a malformed value is not a claim. */
  memberOnly: boolean;
  keyArt: CmsPublicImage | null;
  keyArtAlt: string;
  keyArtDecorative: boolean;
  watchUrl: string | null;
  assets: Record<string, CmsPublicImage>;
  sourceVersion: number;
  publishedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function programWatchUrl(value: unknown): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("published Program watch URL must be a string");
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "watch.njpbs.org" &&
        !url.username && !url.password && !url.port) return url.href;
  } catch { /* One error below covers a malformed URL. */ }
  throw new Error("published Program watch URL must use watch.njpbs.org over HTTPS");
}

/** Project one stored program document into what the public route renders, or
 * null when it is not admitted. Throws for an admitted program whose snapshot
 * is malformed.
 */
export function projectCmsProgram(
  doc: CmsProgramDoc,
  options: { now: Date; assets?: ReadonlyMap<string, { url?: unknown; mimeType?: unknown; width?: unknown; height?: unknown }> },
): CmsProgramBuildData | null {
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
    throw new Error(`program ${doc.id} has no published snapshot`);
  }
  const snapshot = doc.published;
  const metadata = snapshot.metadata;
  if (!isPlainObject(metadata)) {
    throw new Error(`program ${doc.id} has no published metadata`);
  }
  if (metadata.type !== "program") {
    return null;
  }
  if (typeof metadata.title !== "string" || metadata.title.trim() === "") {
    throw new Error(`program ${doc.id} has no published title`);
  }
  if (!isPublicContentSlug(metadata.slug)) {
    throw new Error(`program ${doc.id} has no route-safe published slug`);
  }
  if (
    !isRichTextDoc(metadata.description) ||
    richTextRendersEmpty(metadata.description)
  ) {
    throw new Error(`program ${doc.id} has no readable published synopsis`);
  }
  const previousSlugs = Array.isArray(metadata.previousSlugs)
    ? metadata.previousSlugs
    : [];
  if (previousSlugs.some((slug) => typeof slug !== "string")) {
    throw new Error(`program ${doc.id} has a malformed previousSlugs list`);
  }
  const routableRedirects = routesOf({
    slug: metadata.slug,
    previousSlugs: previousSlugs as string[],
  }).redirects.filter((slug) => isPublicContentSlug(slug));

  if (typeof snapshot.publishedAt !== "string") {
    throw new Error(`program ${doc.id} published snapshot has no publish time`);
  }
  if (!Number.isInteger(snapshot.sourceVersion) || Number(snapshot.sourceVersion) < 1) {
    throw new Error(`program ${doc.id} published snapshot has no source version`);
  }

  const genre =
    typeof metadata.genre === "string" && metadata.genre.trim() !== ""
      ? metadata.genre.trim()
      : null;
  const keyArtId = typeof metadata.keyArtAssetId === "string" && metadata.keyArtAssetId.trim() ? metadata.keyArtAssetId : null;
  const keyArt = keyArtId ? resolveImage(keyArtId, options.assets ?? new Map()) : null;
  const watchUrl = programWatchUrl(metadata.watchUrl);

  return {
    programId: doc.id,
    slug: metadata.slug,
    previousSlugs: routableRedirects,
    locale:
      typeof metadata.locale === "string" && metadata.locale !== ""
        ? metadata.locale
        : "en",
    path: programPublicPath(metadata.slug),
    title: metadata.title,
    genre,
    description: metadata.description,
    memberOnly: metadata.memberOnly === true,
    keyArt,
    keyArtAlt: typeof metadata.keyArtAlt === "string" ? metadata.keyArtAlt : "",
    keyArtDecorative: metadata.keyArtDecorative === true,
    watchUrl,
    assets: keyArtId && keyArt ? { [keyArtId]: keyArt } : {},
    sourceVersion: Number(snapshot.sourceVersion),
    publishedAt: snapshot.publishedAt,
  };
}
