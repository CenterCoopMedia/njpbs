import { isPostLeadMedia } from "./post-lead-media.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const imageUrl = (value: unknown): value is { url: string } =>
  object(value) && typeof value.url === "string" && value.url.length > 0;

type PostImageInput = { heroImage?: unknown; heroImageAlt?: unknown;
  heroImageDecorative?: unknown; leadMedia?: unknown; assets?: unknown };
type CardImage<T> = { image: T; alt: string; decorative: boolean } | undefined;

/** Public projections own URL admission. Retained projections may have a lead
 * asset without the legacy hero field; keep its contextual alt with the image. */
export function postCardImage<T extends { url: string }>(post: PostImageInput & {
  heroImage?: T | string | null; assets?: Readonly<Record<string, T>> }): CardImage<T>;
export function postCardImage(post: PostImageInput): CardImage<{ url: string }>;
export function postCardImage(post: PostImageInput): CardImage<{ url: string }> {
  if (imageUrl(post.heroImage)) return { image: post.heroImage,
    alt: post.heroImageDecorative === true ? "" : typeof post.heroImageAlt === "string" ? post.heroImageAlt : "",
    decorative: post.heroImageDecorative === true };
  const lead = post.leadMedia;
  if (!isPostLeadMedia(lead) || lead.kind !== "image") return undefined;
  const image = object(post.assets) ? post.assets[lead.data.assetId] : undefined;
  if (!imageUrl(image)) return undefined;
  return { image, alt: lead.data.altDecorative === true ? "" : lead.data.alt,
    decorative: lead.data.altDecorative === true };
}
