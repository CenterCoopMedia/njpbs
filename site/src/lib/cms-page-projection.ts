import { contentLinkMetadata } from "../../../packages/content-core/src/content-link.ts";
import { cmsImageThumbnails } from "../../../packages/content-core/src/cms-image-variants.ts";
import { dataHubPageError, parseDataHubCompositionVersion } from "../../../packages/content-core/src/data-hub-composition.ts";
import { parseDataHubReporting } from "../../../packages/content-core/src/data-hub-reporting.ts";
import { parseHomeHero, homeHeroAssetIds } from "../../../packages/content-core/src/home-hero.ts";
import { heroBackgroundMetadata } from "../../../packages/content-core/src/hero-background.ts";
import { isCmsImageUrl, isCmsMediaUrl } from "../../../packages/content-core/src/media-origin.ts";
import { serviceCompositionError } from "../../../packages/content-core/src/service-composition.ts";
import { homeCompositionError } from "../../../packages/content-core/src/home-composition-contract.ts";
import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout.ts";
import { isPageTheme, parseBlocks, type PageBlock, type PageMetadata, type SearchMetadata, type SocialMetadata } from "../../../packages/content-core/src/content-model.ts";
import { validateSection, type SectionId } from "../../../packages/content-core/src/editor-admin.ts";
import { publicPagePath, isAvailablePageSlug, publicPage } from "../../../packages/content-core/src/public-pages.ts";
import { isPublishable } from "./publish-gate.ts";
import { projectDatasetFigures } from "./dataset-figures-projection.ts";
import type { CmsPageDoc, CmsPageBuildData, CmsPublicAsset, CmsContentSelection } from "./cms-loader.ts";

type ProjectOptions = CmsContentSelection & { now: Date; assets?: ReadonlyMap<string, CmsPublicAsset> };
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, owner: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${owner} must be a string`);
  return value;
}

function childDirectedMetadata(value: unknown): { childDirected?: boolean } {
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new Error("childDirected must be a boolean");
  return { childDirected: value };
}

function optionalMetadataGroup<T extends SearchMetadata | SocialMetadata>(
  value: unknown,
  owner: "seo" | "social",
): T | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error(`${owner} must be an object`);
  const output = { ...value };
  for (const field of ["title", "description"]) {
    if (output[field] !== undefined && typeof output[field] !== "string") {
      throw new Error(`${owner}.${field} must be a string`);
    }
  }
  if (
    owner === "seo" &&
    output.noindex !== undefined &&
    typeof output.noindex !== "boolean"
  ) {
    throw new Error("seo.noindex must be a boolean");
  }
  if (
    owner === "social" &&
    output.imageAssetId !== undefined &&
    typeof output.imageAssetId !== "string"
  ) {
    throw new Error("social.imageAssetId must be a string");
  }
  return output as unknown as T;
}

function pagePreviousSlugs(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(slug => typeof slug !== "string")) {
    throw new Error("Page previousSlugs must be a list of slugs");
  }
  return value;
}

function pageMetadata(value: unknown): PageMetadata {
  if (!isPlainObject(value)) {
    throw new Error("published snapshot metadata must be an object");
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    throw new Error("published snapshot metadata title must be a non-empty string");
  }
  return {
    title: value.title,
    ...childDirectedMetadata(value.childDirected),
    ...contentLinkMetadata(value as unknown as Record<string, unknown>),
    ...(isPageTheme(value.pageTheme) ? { pageTheme: value.pageTheme } : {}),
    ...heroBackgroundMetadata(value),
    ...(value.dataHubCompositionVersion === undefined ? {} : { dataHubCompositionVersion: parseDataHubCompositionVersion(value.dataHubCompositionVersion) }),
    ...(value.dataHubReporting === undefined ? {} : { dataHubReporting: parseDataHubReporting(value.dataHubReporting) }),
    ...(value.homeHero === undefined ? {} : { homeHero: parseHomeHero(value.homeHero) }),
    ...(value.slug !== undefined ? { slug: optionalString(value.slug, "slug") } : {}),
    ...(value.previousSlugs !== undefined ? { previousSlugs: pagePreviousSlugs(value.previousSlugs) } : {}),
    ...(optionalString(value.description, "description") !== undefined
      ? { description: value.description as string }
      : {}),
    ...(optionalString(value.homeHeroTitle, "homeHeroTitle") !== undefined
      ? { homeHeroTitle: value.homeHeroTitle as string }
      : {}),
    ...(optionalString(value.homeHeroSubtitle, "homeHeroSubtitle") !== undefined
      ? { homeHeroSubtitle: value.homeHeroSubtitle as string }
      : {}),
    ...(value.seo !== undefined
      ? { seo: optionalMetadataGroup<SearchMetadata>(value.seo, "seo") }
      : {}),
    ...(value.social !== undefined
      ? { social: optionalMetadataGroup<SocialMetadata>(value.social, "social") }
      : {}),
  };
}

function workingPageMetadata(doc: CmsPageDoc): PageMetadata {
  if (typeof doc.title !== "string" || doc.title.trim() === "") {
    throw new Error("working page title must be a non-empty string");
  }
  return {
    title: doc.title,
    ...childDirectedMetadata(doc.childDirected),
    ...contentLinkMetadata(doc as unknown as Record<string, unknown>),
    ...(isPageTheme(doc.pageTheme) ? { pageTheme: doc.pageTheme } : {}),
    ...heroBackgroundMetadata(doc),
    ...(doc.dataHubCompositionVersion === undefined ? {} : { dataHubCompositionVersion: parseDataHubCompositionVersion(doc.dataHubCompositionVersion) }),
    ...(doc.dataHubReporting === undefined ? {} : { dataHubReporting: parseDataHubReporting(doc.dataHubReporting) }),
    ...(doc.homeHero === undefined ? {} : { homeHero: parseHomeHero(doc.homeHero) }),
    ...(doc.slug !== undefined ? { slug: optionalString(doc.slug, "slug") } : {}),
    ...(doc.previousSlugs !== undefined ? { previousSlugs: pagePreviousSlugs(doc.previousSlugs) } : {}),
    ...(optionalString(doc.description, "description") !== undefined
      ? { description: doc.description as string }
      : {}),
    ...(optionalString(doc.homeHeroTitle, "homeHeroTitle") !== undefined
      ? { homeHeroTitle: doc.homeHeroTitle as string }
      : {}),
    ...(optionalString(doc.homeHeroSubtitle, "homeHeroSubtitle") !== undefined
      ? { homeHeroSubtitle: doc.homeHeroSubtitle as string }
      : {}),
    ...(doc.seo !== undefined
      ? { seo: optionalMetadataGroup<SearchMetadata>(doc.seo, "seo") }
      : {}),
    ...(doc.social !== undefined
      ? { social: optionalMetadataGroup<SocialMetadata>(doc.social, "social") }
      : {}),
  };
}

export function isLegacyBlockOnlySnapshot(doc: CmsPageDoc): boolean {
  return (
    isPlainObject(doc.published) &&
    doc.published.metadata === undefined &&
    doc.published.sourceVersion === undefined
  );
}

function projectedBlocks(
  raw: unknown,
  template: SectionId,
  pageId: string,
  homeVersion: unknown,
  { complete = true }: { complete?: boolean } = {},
): PageBlock[] {
  const parsed = parseBlocks(raw, { complete });
  if (!parsed.ok) throw new Error(`blocks are invalid: ${parsed.error}`);
  const sectionError = validateSection(template, parsed.blocks);
  if (sectionError) {
    throw new Error(`blocks are invalid for ${template}: ${sectionError.detail}`);
  }
  const homeError = homeCompositionError(pageId, homeVersion, parsed.blocks, { complete });
  if (homeError) throw new Error(homeError);
  const visible = visibleLayoutBlocks(parsed.blocks);
  const visibleIds = new Set(visible.map(block => block.id));
  const hasRows = parsed.blocks.some(block => block.type === "row");
  return homeVersion === 2
    ? parsed.blocks.filter(block => visibleIds.has(block.id) || (block.section !== undefined && block.type !== "promotion_playlist"))
        .map((block, index) => hasRows ? { ...block, order: index } : block)
    : visible.sort((left, right) => left.order - right.order);
}

function referencedImageAssetIds(blocks: readonly PageBlock[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if ("backgroundImageAssetId" in block.data && block.data.backgroundImageAssetId) ids.add(block.data.backgroundImageAssetId);
    if (block.type === "image") ids.add(block.data.assetId);
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
  return ids;
}

function referencedPdfAssetIds(blocks: readonly PageBlock[]): Set<string> {
  return new Set(blocks.flatMap(block => block.type === "document_list"
    ? block.data.documents.map(item => item.assetId).filter(Boolean) : []));
}

export function referencedAssetIds(blocks: readonly PageBlock[]): Set<string> {
  return new Set([...referencedImageAssetIds(blocks), ...referencedPdfAssetIds(blocks)]);
}

const supportedImageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const);

type SupportedImageMimeType = Exclude<CmsPageBuildData["assets"][string]["mimeType"], "application/pdf">;

function approvedMediaUrl(url: URL): boolean {
  return isCmsImageUrl(url);
}

function pageAssets(
  blocks: readonly PageBlock[],
  available: ReadonlyMap<string, CmsPublicAsset>,
  additionalIds: readonly string[] = [],
): CmsPageBuildData["assets"] {
  const resolved: CmsPageBuildData["assets"] = {};
  const imageIds = referencedImageAssetIds(blocks);
  const pdfIds = referencedPdfAssetIds(blocks);
  for (const id of additionalIds) imageIds.add(id);
  const referenced = new Set([...imageIds, ...pdfIds]);
  for (const id of referenced) {
    const asset = available.get(id);
    if (!asset) throw new Error(`missing media asset ${id}`);
    let url: URL;
    try {
      url = new URL(asset.url);
    } catch {
      throw new Error(`media asset ${id} has an invalid URL`);
    }
    if (!approvedMediaUrl(url)) {
      throw new Error(
        `media asset ${id} URL must use an approved origin and path`,
      );
    }
    if (pdfIds.has(id)) {
      if (asset.mimeType !== "application/pdf" || imageIds.has(id) || !isCmsMediaUrl(url)) {
        throw new Error(`media asset ${id} must be a PDF used only in PDF notices`);
      }
      resolved[id] = { url: asset.url, mimeType: "application/pdf" };
      continue;
    }
    if (
      !supportedImageMimeTypes.has(asset.mimeType as SupportedImageMimeType)
    ) {
      throw new Error(`media asset ${id} is not a supported image`);
    }
    if (
      !Number.isSafeInteger(asset.width) ||
      Number(asset.width) <= 0 ||
      !Number.isSafeInteger(asset.height) ||
      Number(asset.height) <= 0
    ) {
      throw new Error(`media asset ${id} must have positive dimensions`);
    }
    const thumbnails = cmsImageThumbnails(asset);
    resolved[id] = {
      url: asset.url,
      mimeType: asset.mimeType as SupportedImageMimeType,
      width: Number(asset.width),
      height: Number(asset.height),
      ...(thumbnails.length ? { thumbnails } : {}),
    };
  }
  return resolved;
}

export function projectCmsPage(
  doc: CmsPageDoc,
  options: ProjectOptions,
): CmsPageBuildData | null {
  const definition = publicPage(doc.id);
  // Old template-keyed singleton documents are migration seeds, not public
  // route identities. They may coexist with page-id docs until every page saves.
  if (!definition) return null;
  if (options.mode === "draft" && doc.id !== options.pageId) return null;
  // A published build only renders admitted, non-deleted public snapshots. Decide
  // admission before validating the template so a draft, scheduled, or deleted
  // page that still carries a stale template value cannot throw and abort the
  // whole build; an unadmitted page just keeps its committed route frame.
  if (
    options.mode === "published" &&
    (doc.deleted || !isPublishable({
      status: doc.status as never,
      publishAt: doc.publishAt as never,
      publiclyVisible: doc.publiclyVisible as never,
      published: doc.published,
      deleted: doc.deleted as never,
    }, options.now))
  ) {
    return null;
  }
  if (doc.template !== undefined && doc.template !== definition.editorTemplate) {
    throw new Error(
      `page ${doc.id} requires the ${definition.editorTemplate} editor template`,
    );
  }

  let metadata: PageMetadata;
  let blocks: PageBlock[];
  let datasetFigures: CmsPageBuildData["datasetFigures"];
  let sourceVersion: number | null;
  let publishedAt: string | null;
  let homeCompositionVersion: unknown;
  let serviceCompositionVersion: unknown;

  if (options.mode === "published") {
    // The first CMS save foundation wrote block-only snapshots. It never rendered
    // them publicly, and it cannot guarantee immutable metadata. Treat that exact
    // shape as unmigrated so the committed route frame remains live until the
    // guarded publish action can create a complete snapshot.
    if (!isPlainObject(doc.published)) {
      throw new Error(`page ${doc.id} has no published snapshot`);
    }
    const hasSnapshotMetadata = doc.published.metadata !== undefined;
    const hasSnapshotSourceVersion = doc.published.sourceVersion !== undefined;
    if (isLegacyBlockOnlySnapshot(doc)) return null;
    if (hasSnapshotMetadata !== hasSnapshotSourceVersion) {
      throw new Error(`page ${doc.id} has an incomplete published snapshot`);
    }
    if (
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
    serviceCompositionVersion = isPlainObject(doc.published.metadata) ? doc.published.metadata.serviceCompositionVersion : undefined;
    homeCompositionVersion = isPlainObject(doc.published.metadata) ? doc.published.metadata.homeCompositionVersion : undefined;
    blocks = projectedBlocks(doc.published.blocks, definition.editorTemplate, doc.id, homeCompositionVersion);
    datasetFigures = projectDatasetFigures(
      doc.published.datasetFigures,
      blocks,
      `page ${doc.id}`,
    );
    metadata = pageMetadata(doc.published.metadata);
    if (
      !Number.isInteger(doc.published.sourceVersion) ||
      Number(doc.published.sourceVersion) < 1
    ) {
      throw new Error(`page ${doc.id} published snapshot has no source version`);
    }
    sourceVersion = Number(doc.published.sourceVersion);
    if (typeof doc.published.publishedAt !== "string") {
      throw new Error(`page ${doc.id} published snapshot has no publish time`);
    }
    publishedAt = doc.published.publishedAt;
  } else {
    if (doc.deleted) return null;
    metadata = workingPageMetadata(doc);
    homeCompositionVersion = doc.homeCompositionVersion;
    serviceCompositionVersion = doc.serviceCompositionVersion;
    blocks = projectedBlocks(
      doc.blocks,
      definition.editorTemplate,
      doc.id,
      homeCompositionVersion,
      { complete: false },
    );
    datasetFigures = projectDatasetFigures(
      doc.datasetFigures,
      blocks,
      `page ${doc.id}`,
      { required: false },
    );
    sourceVersion =
      Number.isInteger(doc.version) && Number(doc.version) > 0
        ? Number(doc.version)
        : null;
    publishedAt = null;
  }

  const hubError = dataHubPageError(doc.id, metadata.dataHubCompositionVersion, blocks);
  if (hubError) throw new Error(hubError);
  const serviceError = serviceCompositionError(doc.id, serviceCompositionVersion);
  if (serviceError) throw new Error(serviceError);
  const pagePath = publicPagePath(doc.id, metadata);
  if (!pagePath || metadata.previousSlugs?.some(slug => !isAvailablePageSlug(doc.id, slug))) {
    throw new Error(`page ${doc.id} has an invalid public URL`);
  }
  return {
    pageId: definition.id,
    ...(homeCompositionVersion === 1 || homeCompositionVersion === 2 ? { homeCompositionVersion } : {}),
    ...(serviceCompositionVersion === 1 ? { serviceCompositionVersion } : {}),
    path: pagePath,
    ...(metadata.previousSlugs ? { previousSlugs: metadata.previousSlugs } : {}),
    family: definition.family,
    template: definition.editorTemplate,
    title: metadata.title,
    ...childDirectedMetadata(metadata.childDirected),
    ...contentLinkMetadata(metadata as unknown as Record<string, unknown>),
    ...(metadata.pageTheme !== undefined ? { pageTheme: metadata.pageTheme } : {}),
    ...heroBackgroundMetadata(metadata as unknown as Record<string, unknown>),
    ...(metadata.dataHubCompositionVersion === undefined ? {} : { dataHubCompositionVersion: parseDataHubCompositionVersion(metadata.dataHubCompositionVersion) }),
    ...(metadata.dataHubReporting === undefined ? {} : { dataHubReporting: parseDataHubReporting(metadata.dataHubReporting) }),
    ...(metadata.homeHero === undefined ? {} : { homeHero: parseHomeHero(metadata.homeHero) }),
    description: metadata.description ?? "",
    ...(metadata.homeHeroTitle !== undefined
      ? { homeHeroTitle: metadata.homeHeroTitle }
      : {}),
    ...(metadata.homeHeroSubtitle !== undefined
      ? { homeHeroSubtitle: metadata.homeHeroSubtitle }
      : {}),
    // A draft artifact is always noindex even if the editor is previewing a
    // future public index setting.
    noindex: options.mode === "draft" ? true : metadata.seo?.noindex ?? false,
    ...(metadata.seo ? { seo: metadata.seo } : {}),
    ...(metadata.social ? { social: metadata.social } : {}),
    blocks,
    ...(datasetFigures ? { datasetFigures } : {}),
    assets: pageAssets(
      homeCompositionVersion === 2 ? visibleLayoutBlocks(blocks) : blocks,
      options.assets ?? new Map(),
      [metadata.social?.imageAssetId, metadata.heroBackgroundImage, ...homeHeroAssetIds(metadata.homeHero)].filter((id): id is string => !!id),
    ),
    contentMode: options.mode,
    sourceVersion,
    publishedAt,
  };
}
