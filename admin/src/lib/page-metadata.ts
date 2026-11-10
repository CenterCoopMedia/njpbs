import { isPageTheme } from "../../../packages/content-core/src/content-model";
import { publicPage, type PublicPageId } from "../../../packages/content-core/src/public-pages";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project one stored page document into the client-owned metadata form. Routing, status,
 * blocks, timestamps, versions, and the published snapshot stay outside the form. Unknown
 * keys inside the two metadata groups ride along so editing one supported field never erases
 * legacy or vendor-specific siblings.
 */
export function pageMetadataFromDocument(
  pageId: PublicPageId,
  document: Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    title:
      typeof document.title === "string" && document.title.trim() !== ""
        ? document.title
        : (publicPage(pageId)?.title ?? pageId),
  };
  if (pageId !== "contact" && isPageTheme(document.pageTheme)) metadata.pageTheme = document.pageTheme;
  // Composition ownership travels with the loaded page; ordinary metadata saves
  // omit it so staff cannot accidentally restore the fixed template.
  if (document.serviceCompositionVersion === 1) metadata.serviceCompositionVersion = 1;
  if (pageId !== "home") {
    metadata.slug = typeof document.slug === "string" ? document.slug : publicPage(pageId)?.path.slice(1, -1) ?? "";
  }
  if (typeof document.heroBackgroundImage === "string") metadata.heroBackgroundImage = document.heroBackgroundImage;
  if (typeof document.heroBackgroundPosition === "string") metadata.heroBackgroundPosition = document.heroBackgroundPosition;
  if (typeof document.description === "string") metadata.description = document.description;
  if (document.dataHubCompositionVersion === 1) metadata.dataHubCompositionVersion = 1;
  if (document.dataHubReporting !== undefined) metadata.dataHubReporting = structuredClone(document.dataHubReporting);
  if (document.homeHero !== undefined) metadata.homeHero = structuredClone(document.homeHero);
  if (typeof document.homeHeroTitle === "string") {
    metadata.homeHeroTitle = document.homeHeroTitle;
  }
  if (typeof document.homeHeroSubtitle === "string") {
    metadata.homeHeroSubtitle = document.homeHeroSubtitle;
  }
  for (const key of ["contentLinkMode", "contentLinkUrl", "contentLinkNewTab"]) if (document[key] !== undefined) metadata[key] = document[key];
  if (isRecord(document.seo)) metadata.seo = { ...document.seo };
  if (isRecord(document.social)) metadata.social = { ...document.social };
  return metadata;
}

/** Strip server-owned and composition fields before a partial page-metadata save. */
export function pageMetadataSaveDocument(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  if (typeof values.title === "string") document.title = values.title;
  // Keep malformed client input visible to the strict server save boundary.
  // Loaded historical values are already omitted by pageMetadataFromDocument.
  if (values.pageTheme !== undefined) document.pageTheme = values.pageTheme;
  if (typeof values.heroBackgroundImage === "string") document.heroBackgroundImage = values.heroBackgroundImage;
  if (typeof values.heroBackgroundPosition === "string") document.heroBackgroundPosition = values.heroBackgroundPosition;
  if (typeof values.description === "string") document.description = values.description;
  if (values.dataHubCompositionVersion === 1) document.dataHubCompositionVersion = 1;
  if (values.dataHubReporting !== undefined) document.dataHubReporting = structuredClone(values.dataHubReporting);
  if (values.homeHero !== undefined) document.homeHero = structuredClone(values.homeHero);
  if (typeof values.homeHeroTitle === "string") {
    document.homeHeroTitle = values.homeHeroTitle;
  }
  if (typeof values.homeHeroSubtitle === "string") {
    document.homeHeroSubtitle = values.homeHeroSubtitle;
  }
  for (const key of ["contentLinkMode", "contentLinkUrl", "contentLinkNewTab"]) if (values[key] !== undefined) document[key] = values[key];
  if (isRecord(values.seo)) document.seo = { ...values.seo };
  if (isRecord(values.social)) document.social = { ...values.social };
  return document;
}
