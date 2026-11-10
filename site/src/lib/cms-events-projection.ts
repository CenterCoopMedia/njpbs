import { isRichTextDoc, richTextRendersEmpty, type RichTextDoc } from "../../../packages/content-core/src/content-model.ts";
import { resolveImage, type CmsPublicImage } from "./cms-posts-projection.ts";
import { isPublishable } from "./publish-gate.ts";
import { eventPublicPath, isPublicContentSlug } from "./public-content-routes.ts";
import { routesOf } from "./slug-routes.ts";

export interface CmsEventBuildData {
  eventId: string;
  slug: string;
  previousSlugs: string[];
  locale: string;
  path: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  venueAddress: string | null;
  onlineUrl: string | null;
  description: RichTextDoc;
  image: CmsPublicImage | null;
  imageAlt: string;
  imageDecorative: boolean;
  registrationUrl: string | null;
  registrationLabel: string;
  isFree: boolean;
  priceText: string | null;
  sourceVersion: number;
  publishedAt: string;
}

export type CmsEventDoc = { id: string; status?: unknown; publiclyVisible?: unknown; publishAt?: unknown; deleted?: unknown; published?: unknown; [key: string]: unknown };
type PublicAsset = { id: string; url?: unknown; mimeType?: unknown; width?: unknown; height?: unknown };
const optionalText = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
function httpsUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must use HTTPS`);
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Report one consistent error. */ }
  throw new Error(`${field} must use HTTPS`);
}

/** Only immutable, admitted snapshots reach the public route. */
export function projectCmsEvent(doc: CmsEventDoc, options: { now: Date; assets: ReadonlyMap<string, PublicAsset> }): CmsEventBuildData | null {
  if (doc.deleted || !isPublishable({ status: doc.status as never, publishAt: doc.publishAt as never, publiclyVisible: doc.publiclyVisible as never, published: doc.published, deleted: doc.deleted as never }, options.now)) return null;
  if (!doc.published || typeof doc.published !== "object" || Array.isArray(doc.published)) throw new Error(`event ${doc.id} has no published metadata`);
  const snapshot = doc.published as Record<string, unknown>;
  if (!snapshot.metadata || typeof snapshot.metadata !== "object" || Array.isArray(snapshot.metadata)) throw new Error(`event ${doc.id} has no published metadata`);
  const metadata = snapshot.metadata as Record<string, unknown>;
  if (metadata.type !== "event") return null;
  if (typeof metadata.title !== "string" || !metadata.title.trim()) throw new Error(`event ${doc.id} has no title`);
  if (!isPublicContentSlug(metadata.slug)) throw new Error(`event ${doc.id} has no route-safe slug`);
  if (!isRichTextDoc(metadata.description) || richTextRendersEmpty(metadata.description)) throw new Error(`event ${doc.id} has no readable details`);
  if (typeof metadata.startsAt !== "string" || Number.isNaN(Date.parse(metadata.startsAt))) throw new Error(`event ${doc.id} has no start time`);
  const endsAt = optionalText(metadata.endsAt);
  if (endsAt && (Number.isNaN(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(metadata.startsAt))) throw new Error(`event ${doc.id} has an invalid end time`);
  if (!Array.isArray(metadata.previousSlugs) || metadata.previousSlugs.some(slug => typeof slug !== "string")) throw new Error(`event ${doc.id} has invalid previous slugs`);
  if (!Number.isInteger(snapshot.sourceVersion) || Number(snapshot.sourceVersion) < 1 || typeof snapshot.publishedAt !== "string") throw new Error(`event ${doc.id} has no source version or publish time`);
  const imageAssetId = optionalText(metadata.imageAssetId);
  const imageDecorative = metadata.imageDecorative === true;
  const imageAlt = typeof metadata.imageAlt === "string" ? metadata.imageAlt : "";
  if (imageAssetId && imageDecorative && imageAlt !== "") throw new Error(`event ${doc.id} has decorative art with alt text`);
  const image = imageAssetId ? resolveImage(imageAssetId, options.assets) : null;
  return {
    eventId: doc.id,
    slug: metadata.slug as string,
    previousSlugs: routesOf({ slug: metadata.slug as string, previousSlugs: metadata.previousSlugs as string[] }).redirects.filter(isPublicContentSlug),
    locale: optionalText(metadata.locale) ?? "en",
    path: eventPublicPath(metadata.slug as string),
    title: metadata.title,
    startsAt: metadata.startsAt,
    endsAt,
    location: optionalText(metadata.location),
    venueAddress: optionalText(metadata.venueAddress),
    onlineUrl: httpsUrl(metadata.onlineUrl, "onlineUrl"),
    description: metadata.description,
    image,
    imageAlt,
    imageDecorative,
    registrationUrl: httpsUrl(metadata.registrationUrl, "registrationUrl"),
    registrationLabel: optionalText(metadata.registrationLabel) ?? "Register",
    isFree: metadata.isFree === true,
    priceText: metadata.isFree === true ? null : optionalText(metadata.priceText),
    sourceVersion: Number(snapshot.sourceVersion),
    publishedAt: snapshot.publishedAt as string,
  };
}
