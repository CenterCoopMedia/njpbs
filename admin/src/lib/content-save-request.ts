// The editor's own load and save-request steps for Pages and Posts, outside React so the
// Boardwalk editor and the content API (#4716) compose a save the same way. Pure: no network,
// no Firebase client, and no rich-text runtime, because cms-api bundles this module.
import type { AdminBlock } from "./block-factory";
import { homeLayoutsEnabled } from "./home-layouts";
import { blocksForPublicPageSave } from "./public-page-block-ownership";
import { parseBlocks } from "../../../packages/content-core/src/content-model";
import { dataHubPageError } from "../../../packages/content-core/src/data-hub-composition";
import { homeCompositionError } from "../../../packages/content-core/src/home-composition-contract";
import type { SectionId } from "../../../packages/content-core/src/editor-admin";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";

export interface StoredPageContent {
  blocks: AdminBlock[];
  homeCompositionVersion?: 1 | 2;
  serviceCompositionVersion?: unknown;
}

export function assertHomeV2WriterEnabled(pageId: PublicPageId, version: unknown, baseVersion?: number): void {
  if (pageId !== "home" || version !== 2) return;
  if (!homeLayoutsEnabled()) throw new Error("Version 2 Home editing is not enabled. Its saved draft has been preserved.");
  if (baseVersion !== undefined && (!Number.isSafeInteger(baseVersion) || baseVersion < 1)) {
    throw new Error("Reload Home before saving its current version.");
  }
}

export function storedPageContentFromDocument(
  pageId: PublicPageId,
  document: Record<string, unknown>,
): StoredPageContent {
  const hubError = dataHubPageError(pageId, document.dataHubCompositionVersion, document.blocks);
  if (hubError) throw new Error(hubError);
  assertHomeV2WriterEnabled(pageId, document.homeCompositionVersion);
  if (
    document.blocks === undefined &&
    document.homeCompositionVersion === undefined
  ) {
    return { blocks: [], ...(document.serviceCompositionVersion === undefined ? {} : { serviceCompositionVersion: document.serviceCompositionVersion }) };
  }

  const parsed = parseBlocks(document.blocks, { pageId, complete: document.status !== "draft" });
  if (!parsed.ok) {
    throw new Error(
      "This page's saved content can't be opened for editing. Its stored format looks invalid.",
    );
  }
  const compositionError = homeCompositionError(
    pageId,
    document.homeCompositionVersion,
    parsed.blocks,
    { complete: document.status !== "draft" },
  );
  if (compositionError) throw new Error(compositionError);

  return {
    blocks: parsed.blocks as AdminBlock[],
    ...(document.serviceCompositionVersion === undefined ? {} : { serviceCompositionVersion: document.serviceCompositionVersion }),
    ...(document.homeCompositionVersion === 1 || document.homeCompositionVersion === 2
      ? { homeCompositionVersion: document.homeCompositionVersion }
      : {}),
  };
}

export interface PageBlocksSaveInput {
  pageId: PublicPageId;
  section: SectionId;
  storedPage: StoredPageContent;
  blocks: AdminBlock[];
  enforcePublicPageOwnership: boolean;
  baseVersion?: number;
  createOnly?: boolean;
  seedFromLegacyPage?: { id: SectionId; version?: number };
  saveGroupId?: string;
}

/** The cmsSaveContent body for a Page block save. */
export function pageBlocksSaveRequest(input: PageBlocksSaveInput) {
  const { pageId, section, storedPage, blocks, baseVersion } = input;
  const completeBlocks = input.enforcePublicPageOwnership
    ? blocksForPublicPageSave(
        pageId,
        storedPage.blocks,
        blocks,
        storedPage.homeCompositionVersion,
      )
    : blocks;
  return {
    collection: "cmsPages" as const,
    id: pageId,
    document: { blocks: completeBlocks, template: section,
      ...(pageId === "data-hub" ? { dataHubCompositionVersion: 1 } : {}) },
    baseVersion,
    createOnly: input.createOnly,
    seedFromLegacyPage: input.seedFromLegacyPage,
    saveGroupId: input.saveGroupId,
  };
}

// The stored save count (#530). An invalid value is never evidence that the editor
// has read a current revision; the save boundary refuses a missing claim on updates.
export function readVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

/** A saved legacy document without a version has the explicit first-save claim zero. */
export function readSaveBaseVersion(value: unknown): number | undefined {
  return value === undefined ? 0 : readVersion(value);
}

/** The cmsSaveContent body for a record (Post and other typed record) save. */
export function recordSaveRequest(
  kind: string,
  record: Record<string, unknown>,
  options: { force?: boolean; idempotencyKey?: string } = {},
) {
  // `section` leaves the document and rides the request envelope (#845). It is a
  // server-managed field: the save boundary strips it from the overlay, accepts it only
  // on a record create, and validates it against the live registry inside the write
  // transaction. Sending it as content would be silently dropped and the create would
  // then be refused for having no section at all.
  const { id, version, section, slug, ...content } = record;
  const creating = typeof id !== "string";
  return {
    collection: "cmsPosts" as const,
    slug: ["post", "program", "event"].includes(kind) && typeof slug === "string" ? slug : undefined,
    id: typeof id === "string" ? id : undefined,
    document: { ...content, type: kind },
    baseVersion: creating ? undefined : readSaveBaseVersion(version),
    idempotencyKey: creating ? options.idempotencyKey : undefined,
    section:
      (creating || record.unassignedDraft === true) && typeof section === "string" && section !== ""
        ? section
        : undefined,
  };
}
