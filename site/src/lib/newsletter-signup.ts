import type { PageBlock } from "../../../packages/content-core/src/content-model";
import type { NewsletterCardData } from "../../../packages/content-core/src/newsletter-card-data";
import type { RecordCardPayload } from "./record-card-resolution";
import { resolveCmsResponsiveImage, type CmsImageOptimizer } from "./cms-responsive-image";
import type { ResolvedRenderAsset } from "../../../packages/content-core/src/content-render";

/** Resolve signup blocks from the same fixed-cutoff export as record cards. */
export async function newsletterSignupResolution(
  blocks: readonly PageBlock[], optimizer: CmsImageOptimizer, records: readonly RecordCardPayload[],
): Promise<{ cards: ReadonlyMap<string, NewsletterCardData>; images: ReadonlyMap<string, ResolvedRenderAsset> }> {
  const ids = new Set(blocks.filter(block => block.type === "newsletter_signup" && block.visible)
    .flatMap(block => block.type === "newsletter_signup" ? block.data.newsletterIds : []));
  const selected = records.filter(record => record.kind === "newsletter" && ids.has(record.id) && !!record.newsletter?.card.signupUrl);
  const cards = new Map(selected.map(record => [record.id, record.kind === "newsletter" ? record.newsletter!.card : null] as const)
    .filter((entry): entry is readonly [string, NewsletterCardData] => entry[1] !== null));
  const images = new Map<string, ResolvedRenderAsset>();
  await Promise.all(selected.map(async record => {
    if (record.kind !== "newsletter") return;
    const id = record.newsletter?.card.imageAssetId;
    const image = record.newsletter?.image;
    if (!id || !image || images.has(id)) return;
    images.set(id, await resolveCmsResponsiveImage(image as never, "grid", optimizer));
  }));
  return { cards, images };
}
