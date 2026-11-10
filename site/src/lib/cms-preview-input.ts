import {parseDataHubSources,type DataHubSources} from "../../../packages/content-core/src/data-hub-reporting-sources.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPublicPageId, isPublicPagePath } from "../../../packages/content-core/src/public-pages.ts";
import type { CmsPageDoc, CmsPageBuildData, CmsPublicAsset } from "./cms-loader";
import { contentLinkError } from "../../../packages/content-core/src/content-link.ts";
import { isCmsImageUrl } from "../../../packages/content-core/src/media-origin.ts";
import { parseHomeHero } from "../../../packages/content-core/src/home-hero.ts";
import { assertRecordCards, normalizePublicArtifactBundle, type PublicArtifactBundle } from "./public-artifact-bundle.ts";
import type { RecordCardPayload } from "./record-card-resolution.ts";

type Env = Record<string, string | undefined>;

export interface CmsPreviewInputRequest {
  path: string;
  sha256: string;
  queueId: string;
  pageId: string;
  rendererSha: string;
  collection?: "cmsPosts";
  persistent?: true;
}

/** Explicit local handoff only. Never reinterpret a public artifact as a draft. */
export function resolveCmsPreviewInput(env: Env = process.env): CmsPreviewInputRequest | null {
  const inputPath = (env.CMS_PREVIEW_INPUT_PATH ?? "").trim();
  const sha256 = (env.CMS_PREVIEW_INPUT_SHA256 ?? "").trim();
  if (!inputPath && !sha256) return null;
  const queueId = (env.CMS_PREVIEW_QUEUE_ID ?? "").trim();
  const pageId = (env.CMS_PREVIEW_PAGE_ID ?? "").trim();
  const rendererSha = (env.CMS_PREVIEW_RENDERER_SHA ?? "").trim();
  const collection = env.CMS_PREVIEW_COLLECTION ?? "cmsPages";
  const persistent = env.CMS_PREVIEW_PERSISTENT;
  const validTarget = collection === "cmsPages" ? isPublicPageId(pageId)
    : collection === "cmsPosts" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(pageId);
  if (
    env.CMS_CONTENT_MODE !== "draft" || !path.isAbsolute(inputPath) ||
    !/^[a-f0-9]{64}$/.test(sha256) || !/^[A-Za-z0-9]{20}$/.test(queueId) ||
    !validTarget || !/^[a-f0-9]{40}$/.test(rendererSha) ||
    (persistent !== undefined && persistent !== "1") ||
    // config-input: PUBLIC_ARTIFACT_BATCH_MODE, PUBLIC_ARTIFACT_BUNDLE_PATH, PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION
    // config-input: PUBLIC_ARTIFACT_INVENTORY_PATH, PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH
    // config-input: PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH, PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH
    Object.keys(env).some(key => key.startsWith("PUBLIC_ARTIFACT_") && env[key]?.trim()) ||
    env.PUBLIC_BUILD_BATCH_ID?.trim() || env.PUBLIC_BUILD_COMMIT_SHA?.trim()
  ) {
    throw new Error("Private preview input requires an exact draft queue and no public artifact settings");
  }
  return { path: inputPath, sha256, queueId, pageId, rendererSha,
    ...(collection === "cmsPosts" ? { collection } : {}),
    ...(persistent === "1" ? { persistent: true } : {}) };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reuse one media-envelope check for both immutable preview transports. */
export function previewAssetSnapshots(value: unknown, queueId: string): CmsPublicAsset[] {
  if (!Array.isArray(value)) throw new Error(`preview queue ${queueId} has no media snapshot`);
  const ids = new Set<string>();
  return value.map((asset, index) => {
    if (
      !record(asset) || typeof asset.id !== "string" || asset.id.length === 0 ||
      typeof asset.url !== "string" || typeof asset.mimeType !== "string" ||
      (asset.width !== undefined && typeof asset.width !== "number") ||
      (asset.height !== undefined && typeof asset.height !== "number") || ids.has(asset.id)
    ) {
      throw new Error(`preview queue ${queueId} has an invalid media snapshot at index ${index}`);
    }
    ids.add(asset.id);
    return {
      id: asset.id, url: asset.url, mimeType: asset.mimeType,
      ...(asset.width !== undefined ? { width: asset.width } : {}),
      ...(asset.height !== undefined ? { height: asset.height } : {}),
    };
  });
}

/** The build gets JSON bytes and their digest, never a database credential.
 * Ordinary page projection still validates all content, ownership and media.
 */
export interface CmsPreviewInput {
  page: CmsPageDoc;
  assets: CmsPublicAsset[];
  publicContext: PublicArtifactBundle;
  /** Working cards for this private render, separate from the public receipt. */
  dataHubSources?:DataHubSources;
  draftLibraryCards?: { recordIds: string[]; cards: RecordCardPayload[] };
  homeHeroPages?: CmsPageBuildData[];
  expiresAtMs: number;
}

function previewHomeHeroPages(value: unknown, snapshot: CmsPageDoc, request: CmsPreviewInputRequest): CmsPageBuildData[] | undefined {
  if (value === undefined) return undefined;
  if (request.pageId !== "home" || request.collection === "cmsPosts" || !Array.isArray(value) || value.length > 3) {
    throw new Error("Private Home Page pins are invalid");
  }
  const pins = parseHomeHero(snapshot.homeHero)?.pins ?? [];
  const pages: CmsPageBuildData[] = [];
  for (const raw of value) {
    if (!record(raw) || raw.contentMode !== "published" || typeof raw.pageId !== "string" ||
      !pins.some(pin => pin.source === "cms_pages" && pin.sourceId === raw.pageId) ||
      pages.some(page => page.pageId === raw.pageId) || !record(raw.assets)) {
      throw new Error("Private Home Page pin is invalid");
    }
    // These are already projected public Pages. Check the card envelope without
    // reconstructing a Firestore document and projecting its body a second time.
    if (!isPublicPagePath(raw.pageId, raw.path) || !Number.isSafeInteger(raw.sourceVersion) ||
      Number(raw.sourceVersion) < 1 || typeof raw.title !== "string" || typeof raw.description !== "string" ||
      typeof raw.publishedAt !== "string" || !Number.isFinite(Date.parse(raw.publishedAt)) ||
      !Array.isArray(raw.blocks) || contentLinkError(raw)) {
      throw new Error("Private Home Page pin shape is invalid");
    }
    for (const asset of Object.values(raw.assets)) {
      if (!record(asset) || typeof asset.url !== "string" || !isCmsImageUrl(new URL(asset.url)) ||
        (asset.mimeType !== "application/pdf" &&
          (typeof asset.mimeType !== "string" || !["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(asset.mimeType) ||
            !Number.isSafeInteger(asset.width) || Number(asset.width) < 1 ||
            !Number.isSafeInteger(asset.height) || Number(asset.height) < 1))) {
        throw new Error("Private Home Page pin media is invalid");
      }
    }
    if (raw.heroBackgroundImage !== undefined && raw.heroBackgroundImage !== "") {
      const image = typeof raw.heroBackgroundImage === "string" ? raw.assets[raw.heroBackgroundImage] : undefined;
      if (!record(image) || image.mimeType === "application/pdf") {
        throw new Error("Private Home Page pin image is invalid");
      }
    }
    pages.push(raw as unknown as CmsPageBuildData);
  }
  return pages;
}

function parseDraftLibraryCards(value: unknown): CmsPreviewInput["draftLibraryCards"] {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error("Private library card selection is invalid");
  const { recordIds, cards } = value;
  if (Object.keys(value).some(key => !["recordIds", "cards"].includes(key)) ||
    !Array.isArray(recordIds) || recordIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
    new Set(recordIds).size !== recordIds.length) throw new Error("Private library card selection is invalid");
  assertRecordCards(cards);
  if (cards.some(card => !["sponsor", "newsletter"].includes(card.kind) || !recordIds.includes(card.id))) {
    throw new Error("Private library cards do not match their selection");
  }
  return { recordIds, cards };
}

/** A renderer can consume the same verified bytes without environment changes,
 * temporary files, a content store, or database access.
 */
export function decodeCmsPreviewInput(
  bytes: Uint8Array, request: CmsPreviewInputRequest, now: Date,
): CmsPreviewInput {
  if (!Number.isFinite(now.getTime())) throw new Error("Private preview input clock is invalid");
  // In-memory callers do not necessarily pass through the environment resolver.
  // Reuse that request-shape contract instead of accepting caller-shaped IDs.
  const verifiedRequest = resolveCmsPreviewInput({
    CMS_CONTENT_MODE: "draft",
    CMS_PREVIEW_INPUT_PATH: request.path,
    CMS_PREVIEW_INPUT_SHA256: request.sha256,
    CMS_PREVIEW_QUEUE_ID: request.queueId,
    CMS_PREVIEW_PAGE_ID: request.pageId,
    CMS_PREVIEW_RENDERER_SHA: request.rendererSha,
    ...(request.collection ? { CMS_PREVIEW_COLLECTION: request.collection } : {}),
    ...(request.persistent !== undefined
      ? { CMS_PREVIEW_PERSISTENT: request.persistent === true ? "1" : "invalid" } : {}),
  });
  if (!verifiedRequest || (["path", "sha256", "queueId", "pageId", "rendererSha"] as const)
    .some(key => verifiedRequest[key] !== request[key])) {
    throw new Error("Private preview input identity is missing or noncanonical");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== request.sha256) {
    throw new Error("Private preview input digest does not match the queued artifact input");
  }
  const input: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    !record(input) || input.schemaVersion !== 2 || input.queueId !== request.queueId ||
    input.pageId !== request.pageId || input.rendererSha !== request.rendererSha ||
    (input.collection ?? "cmsPages") !== (request.collection ?? "cmsPages") ||
    input.persistent !== request.persistent ||
    !Number.isSafeInteger(input.sourceVersion) || Number(input.sourceVersion) < 1 ||
    !record(input.snapshot) || input.snapshot.id !== request.pageId ||
    input.snapshot.version !== input.sourceVersion ||
    !Number.isSafeInteger(input.expiresAtMs) || Number(input.expiresAtMs) <= now.getTime()
  ) {
    throw new Error("Private preview input identity or expiry is invalid");
  }
  if (input.dataHubSources !== undefined && (request.pageId !== "data-hub" || (request.collection ?? "cmsPages") !== "cmsPages")) throw new Error("Reporting belongs only to Data Hub");
  const dataHubSources = parseDataHubSources(input.dataHubSources,now.getTime());
  const overlay = parseDraftLibraryCards(input.draftLibraryCards);
  const homeHeroPages = previewHomeHeroPages(input.homeHeroPages, input.snapshot as CmsPageDoc, request);
  return {
    page: input.snapshot as CmsPageDoc,
    assets: previewAssetSnapshots(input.assets, request.queueId),
    // The processor must bind this retained bundle to a verified live deployment
    // before freezing the input. A working record is never related-page context.
    publicContext: normalizePublicArtifactBundle(input.publicContext),
    ...(overlay === undefined ? {} : { draftLibraryCards: overlay }),
    ...(homeHeroPages === undefined ? {} : { homeHeroPages }),
    ...(dataHubSources ? {dataHubSources} : {}),
    expiresAtMs: Number(input.expiresAtMs),
  };
}

/** Existing isolated-file transport delegates to the same byte boundary. */
export async function readCmsPreviewInput(request: CmsPreviewInputRequest, now: Date): Promise<CmsPreviewInput> {
  return decodeCmsPreviewInput(await readFile(request.path), request, now);
}
