import type { ContentLinkMetadata } from "../../../packages/content-core/src/content-link.ts";
import { COVERAGE_LABELS_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings.ts";
import { projectCoverageLabels } from "../../../packages/content-core/src/coverage-labels.ts";
import { projectCmsPage, isLegacyBlockOnlySnapshot, referencedAssetIds } from "./cms-page-projection.ts";
export { projectCmsPage } from "./cms-page-projection.ts";
import { resolveApprovedLibraryVersions, type HistoryQuery, type HistoryDatabase } from "./approved-library-records.ts";
import { homeHeroAssetIds, type HomeHeroConfig } from "../../../packages/content-core/src/home-hero.ts";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Loader } from "astro/loaders";
import { previewAssetSnapshots, resolveCmsPreviewInput } from "./cms-preview-input.ts";
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout.ts";
import {
  parseBlocks,
  type PageBlock,
  type PageMetadata,
  type PageTheme,
  type PublishedSnapshot,
  type SearchMetadata,
  type SocialMetadata,
} from "../../../packages/content-core/src/content-model.ts";
import {
  type SectionId,
} from "../../../packages/content-core/src/editor-admin.ts";
import type { DatasetFigures } from "../../../packages/content-core/src/dataset-figures.ts";
import {
  isAvailablePageSlug,
  isPublicPageId,
  publicPage,
  type PublicPageFamily,
} from "../../../packages/content-core/src/public-pages.ts";
import {
  assertStoredDeployedPublicArtifactBatch,
  assertStoredPublicArtifactReservation,
  assertStoredBackgroundArtifactReservation,
  createPublicArtifactInventoryReceipt,
  type PublicArtifactInventoryReceipt,
  type PublicArtifactSettingsFallback,
  type PublicArtifactSettingsInput,
  type PublicBuildReservation,
} from "./public-artifact-inventory.ts";
import { isPublishable } from "./publish-gate.ts";
import { exportRecordCards, approvedLibraryCardAssetIds, type RecordCardPayload } from "./record-card-resolution.ts";
import {
  assertPostRouteUniqueness,
  projectCmsPost,
  type CmsPostBuildData,
  type CmsPostDoc,
} from "./cms-posts-loader.ts";
import {
  assertProgramRouteUniqueness,
  projectCmsProgram,
  type CmsProgramBuildData,
} from "./cms-programs-loader.ts";
import { assertEventRouteUniqueness, projectCmsEvent, type CmsEventBuildData } from "./cms-events-loader.ts";
import {
  assertAuthorRouteUniqueness,
  projectAuthorSnapshot,
  type CmsAuthorBuildData,
} from "./cms-authors-loader.ts";
import { authorPublicPath } from "../../../packages/content-core/src/author-profiles.ts";
import { eventPublicPath, postPublicPath, programPublicPath } from "./public-content-routes.ts";
import {
  readPublicArtifactBundle,
  resolvePublicArtifactBundlePath,
} from "./public-artifact-bundle.ts";
import {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  projectPublicHomepageBannerArtifact,
  type PublicHomepageBannerDocument,
} from "./public-homepage-banner.ts";
import {
  SITE_NAVIGATION_SETTINGS_ID,
  projectSiteNavigationArtifact,
  type SiteNavigationDocument,
} from "./site-navigation.ts";
import {
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  projectPublicSiteChromeArtifact,
  type PublicSiteChromeDocument,
} from "./public-site-chrome.ts";
import type { PublicSettingBuildData } from "./public-artifact-bundle.ts";
import { NJ_DECIDES_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings.ts";
import { projectNjDecidesSettings } from "./nj-decides-settings.ts";

const requireModule = createRequire(import.meta.url);
const { collectPublishedMediaUsage } = requireModule(
  "../../../functions/lib/media-usage.js",
) as {
  collectPublishedMediaUsage: (input: {
    collection: "cmsPages" | "cmsPosts" | "cmsAuthorProfilesPublic";
    snapshot: unknown;
  }) => { assetIds: string[]; occurrenceCount: number };
};

// Firestore remains a build-time input only. A normal developer build without
// credentials clears this collection and leaves the committed launch pages in
// place. A strict publish build fails closed on configuration, read, or admitted
// content errors; it never quietly deploys an older fallback over a broken CMS
// page.

type Env = Record<string, string | undefined>;

export interface CmsPageDoc {
  id: string;
  title?: unknown;
  pageTheme?: unknown;
  description?: unknown;
  dataHubCompositionVersion?: unknown;
  dataHubReporting?: unknown;
  homeHero?: unknown;
  homeHeroTitle?: unknown;
  homeHeroSubtitle?: unknown;
  seo?: unknown;
  social?: unknown;
  template?: unknown;
  status?: unknown;
  publiclyVisible?: unknown;
  publishAt?: unknown;
  deleted?: unknown;
  blocks?: unknown;
  version?: unknown;
  published?: PublishedSnapshot<PageMetadata> | unknown;
  [key: string]: unknown;
}

export interface CmsPageBuildData extends ContentLinkMetadata {
  pageId: string;
  childDirected?: boolean;
  pageTheme?: PageTheme;
  homeCompositionVersion?: 1 | 2;
  serviceCompositionVersion?: 1;
  path: string;
  previousSlugs?: string[];
  family: PublicPageFamily;
  template: SectionId;
  title: string;
  description: string;
  heroBackgroundImage?: string;
  heroBackgroundPosition?: "center" | "top" | "bottom";
  dataHubCompositionVersion?: 1;
  dataHubReporting?: import("../../../packages/content-core/src/data-hub-reporting").DataHubReporting;
  homeHero?: HomeHeroConfig;
  homeHeroTitle?: string;
  homeHeroSubtitle?: string;
  noindex: boolean;
  seo?: SearchMetadata;
  social?: SocialMetadata;
  blocks: PageBlock[];
  datasetFigures?: DatasetFigures;
  assets: Record<
    string,
    {
      url: string;
      mimeType:
        | "image/jpeg"
        | "image/png"
        | "image/webp"
        | "image/gif"
        | "image/avif";
      width: number;
      height: number;
      thumbnails?: import("../../../packages/content-core/src/cms-image-variants").CmsImageThumbnail[];
    } | { url: string; mimeType: "application/pdf" }
  >;
  contentMode: "published" | "draft";
  sourceVersion: number | null;
  publishedAt: string | null;
}

export interface CmsPublicAsset {
  thumbnails?: import("../../../packages/content-core/src/cms-image-variants").CmsImageThumbnail[];
  credit?: string;
  id: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export type CmsContentSelection =
  | { mode: "published" }
  | {
      mode: "draft";
      pageId: string;
      queueId?: string;
      rendererSha?: string;
    };

type FirestoreConnection =
  | { mode: "emulator"; projectId: string }
  | { mode: "credentials"; projectId: string; credentialsPath: string };

interface CmsFirestoreDocumentSnapshot {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown>;
}

interface CmsFirestoreDocumentReference {
  id?: string;
  get: () => Promise<CmsFirestoreDocumentSnapshot>;
}

interface CmsFirestoreCollection {
  get: () => Promise<{ docs: CmsFirestoreDocumentSnapshot[] }>;
  doc: (id: string) => CmsFirestoreDocumentReference;
}

interface CmsFirestoreReadTransaction {
  get: (
    query: CmsFirestoreCollection | HistoryQuery,
  ) => Promise<{ docs: CmsFirestoreDocumentSnapshot[] }>;
  getAll: (
    ...refs: CmsFirestoreDocumentReference[]
  ) => Promise<CmsFirestoreDocumentSnapshot[]>;
}

interface CmsFirestoreDatabase {
  collection: (name: string) => CmsFirestoreCollection;
  runTransaction?: <T>(
    callback: (transaction: CmsFirestoreReadTransaction) => Promise<T>,
    options: { readOnly: true; readTime: PublicBuildReservation["cutoffAt"] },
  ) => Promise<T>;
}

export interface PublicArtifactBuildRequest {
  buildBatchId: string;
  commitSha: string;
  outputPath: string;
  bundlePath: string;
  batchMode: "reserved" | "deployed" | "background";
}

export interface PublicArtifactContentRead {
  pages: CmsPageDoc[];
  posts: CmsPostDoc[];
  authors: { authorId: string; data: Record<string, unknown> }[];
  setting?: PublicHomepageBannerDocument;
  navigation?: SiteNavigationDocument;
  chrome?: PublicSiteChromeDocument;
  njDecides?: { id: string; [key: string]: unknown };
  coverageLabels?: { id: string; [key: string]: unknown };
  assets: CmsPublicAsset[];
  reservation: PublicBuildReservation;
  admissionTime: Date;
}

type ProjectOptions = CmsContentSelection & {
  now: Date;
  assets?: ReadonlyMap<string, CmsPublicAsset>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasToMillis(value: unknown): value is { toMillis(): number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  );
}

function assetIdsForBuild(
  docs: readonly CmsPageDoc[],
  selection: CmsContentSelection,
  buildNow: Date,
): string[] {
  const ids = new Set<string>();
  for (const doc of docs) {
    if (!publicPage(doc.id)) continue;
    if (selection.mode === "draft") {
      if (doc.id !== selection.pageId || doc.deleted) continue;
    } else {
      if (
        doc.deleted ||
        isLegacyBlockOnlySnapshot(doc) ||
        !isPublishable(
          {
            status: doc.status as never,
            publishAt: doc.publishAt as never,
            publiclyVisible: doc.publiclyVisible as never,
            published: doc.published,
            deleted: doc.deleted as never,
          },
          buildNow,
        )
      ) {
        continue;
      }
    }

    const rawBlocks =
      selection.mode === "published" && isPlainObject(doc.published)
        ? doc.published.blocks
        : doc.blocks;
    const parsed = parseBlocks(rawBlocks, { complete: selection.mode === "published" });
    if (parsed.ok) {
      for (const id of referencedAssetIds(
        visibleLayoutBlocks(parsed.blocks),
      )) {
        ids.add(id);
      }
    }
    const rawMetadata =
      selection.mode === "published" && isPlainObject(doc.published)
        ? doc.published.metadata
        : doc;
    if (isPlainObject(rawMetadata)) for (const id of homeHeroAssetIds(rawMetadata.homeHero)) ids.add(id);
    if (isPlainObject(rawMetadata) && typeof rawMetadata.heroBackgroundImage === "string") {
      ids.add(rawMetadata.heroBackgroundImage);
    }
    if (
      isPlainObject(rawMetadata) &&
      isPlainObject(rawMetadata.social) &&
      typeof rawMetadata.social.imageAssetId === "string"
    ) {
      ids.add(rawMetadata.social.imageAssetId);
    }
  }
  // Firestore document ids cannot contain a slash. Invalid references are left
  // unread so projectCmsPage reports the existing "missing media asset" error
  // instead of turning malformed content into an unrelated SDK path error.
  return [...ids].filter((id) => id !== "" && !id.includes("/")).sort();
}

export function resolveCmsContentMode(env: Env = process.env): CmsContentSelection {
  const raw = (env.CMS_CONTENT_MODE ?? "published").trim().toLowerCase();
  const queueId = (env.CMS_PREVIEW_QUEUE_ID ?? "").trim();
  const rendererSha = (env.CMS_PREVIEW_RENDERER_SHA ?? "").trim();
  if (raw === "published") {
    if (queueId || rendererSha) {
      throw new Error(
        "CMS preview queue settings are only valid when CMS_CONTENT_MODE=draft",
      );
    }
    return { mode: "published" };
  }
  if (raw !== "draft") {
    throw new Error("CMS_CONTENT_MODE must be either published or draft");
  }
  const pageId = (env.CMS_PREVIEW_PAGE_ID ?? "").trim();
  if (!pageId) {
    throw new Error("CMS_PREVIEW_PAGE_ID is required when CMS_CONTENT_MODE=draft");
  }
  const privatePost = env.CMS_PREVIEW_COLLECTION === "cmsPosts" && resolveCmsPreviewInput(env);
  if (!isPublicPageId(pageId) && !privatePost) {
    throw new Error(`Unknown preview page ${pageId}`);
  }
  if (queueId && !/^[A-Za-z0-9]{1,128}$/.test(queueId)) {
    throw new Error("CMS_PREVIEW_QUEUE_ID is invalid");
  }
  if (queueId && !/^[0-9a-f]{40}$/i.test(rendererSha)) {
    throw new Error(
      "CMS_PREVIEW_RENDERER_SHA is required for a queued preview",
    );
  }
  if (!queueId && rendererSha) {
    throw new Error(
      "CMS_PREVIEW_RENDERER_SHA is only valid with CMS_PREVIEW_QUEUE_ID",
    );
  }
  return {
    mode: "draft",
    pageId,
    ...(queueId ? { queueId } : {}),
    ...(rendererSha ? { rendererSha } : {}),
  };
}

export function resolvePublicArtifactBuildRequest(
  selection: CmsContentSelection,
  env: Env = process.env,
): PublicArtifactBuildRequest | null {
  const values = {
    buildBatchId: (env.PUBLIC_BUILD_BATCH_ID ?? "").trim(),
    commitSha: (env.PUBLIC_BUILD_COMMIT_SHA ?? "").trim(),
    outputPath: (env.PUBLIC_ARTIFACT_INVENTORY_PATH ?? "").trim(),
    bundlePath: (env.PUBLIC_ARTIFACT_BUNDLE_PATH ?? "").trim(),
  };
  const present = Object.values(values).filter((value) => value !== "").length;
  const batchMode = (env.PUBLIC_ARTIFACT_BATCH_MODE ?? "reserved").trim();
  if (present === 0) {
    if (env.PUBLIC_ARTIFACT_BATCH_MODE?.trim()) {
      throw new Error(
        "PUBLIC_ARTIFACT_BATCH_MODE requires an exact public artifact build",
      );
    }
    return null;
  }
  if (present !== Object.keys(values).length) {
    throw new Error(
      "Public artifact inventory settings must be configured together",
    );
  }
  if (selection.mode !== "published") {
    throw new Error("Public artifact inventory requires published CMS content");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(values.buildBatchId)) {
    throw new Error("PUBLIC_BUILD_BATCH_ID is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(values.commitSha)) {
    throw new Error("PUBLIC_BUILD_COMMIT_SHA is invalid");
  }
  if (!["reserved", "deployed", "background"].includes(batchMode)) {
    throw new Error("PUBLIC_ARTIFACT_BATCH_MODE must be reserved, deployed or background");
  }
  if (!path.isAbsolute(values.outputPath) || !path.isAbsolute(values.bundlePath)) {
    throw new Error("Public artifact inventory paths must be absolute");
  }
  return { ...values, batchMode: batchMode as PublicArtifactBuildRequest["batchMode"] };
}

export function resolveFirestoreConnection(
  env: Env = process.env,
): FirestoreConnection | null {
  const projectId =
    env.FIREBASE_PROJECT_ID ||
    env.GCLOUD_PROJECT ||
    env.GOOGLE_CLOUD_PROJECT ||
    "";
  if (env.FIRESTORE_EMULATOR_HOST) {
    return { mode: "emulator", projectId: projectId || "demo-njpbs" };
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS && projectId) {
    return {
      mode: "credentials",
      projectId,
      credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS,
    };
  }
  return null;
}

function isStrictLoaderMode(env: Env = process.env): boolean {
  const value = env.CMS_LOADER_STRICT?.toLowerCase();
  return value === "1" || value === "true";
}

export async function readCmsContentFromDatabase(
  database: CmsFirestoreDatabase,
  selection: CmsContentSelection,
  buildNow: Date,
): Promise<{ pages: CmsPageDoc[]; assets: CmsPublicAsset[] }> {
  const pageCollection = database.collection("cmsPages");
  const pageDocuments =
    selection.mode === "draft"
      ? [await pageCollection.doc(selection.pageId).get()]
      : (await pageCollection.get()).docs;
  const pages = pageDocuments
    .filter((document) => document.exists)
    .map((document) => ({
      ...document.data(),
      // Firestore path identity is authoritative. A stale or hostile stored id
      // field cannot alias a noncanonical document onto a public route.
      id: document.id,
    }));
  const assetCollection = database.collection("media_assets_public");
  const assetDocuments = await Promise.all(
    assetIdsForBuild(pages, selection, buildNow).map((id) =>
      assetCollection.doc(id).get(),
    ),
  );
  return {
    pages,
    assets: assetDocuments
      .filter((document) => document.exists)
      .map((document) => ({
        id: document.id,
        ...document.data(),
      })) as CmsPublicAsset[],
  };
}

export async function readPublicArtifactContentFromDatabase(
  database: CmsFirestoreDatabase & HistoryDatabase,
  request: Pick<PublicArtifactBuildRequest, "buildBatchId" | "commitSha"> &
    Partial<Pick<PublicArtifactBuildRequest, "batchMode">> & { preparationId?: string },
  wallClock: Date,
): Promise<PublicArtifactContentRead> {
  if (typeof database.runTransaction !== "function") {
    throw new Error("Public artifact inventory requires a read-time transaction");
  }
  if (request.preparationId !== undefined &&
      (request.batchMode !== undefined || request.buildBatchId !== `cms-${request.preparationId}`)) {
    throw new Error("Invalid detached release preparation request");
  }
  const background = request.batchMode === "background"
    ? /^post-background-([A-Za-z0-9]{20})-([a-f0-9]{64})$/.exec(request.buildBatchId) : null;
  if (request.batchMode === "background" && !background) throw new Error("Invalid background publication identity");
  const batchSnapshot = await database.collection(request.preparationId !== undefined ? "system/publicReleasePreparations/entries" : background
    ? `cmsPublishQueue/${background[1]}/backgroundPreparation` : "system/publicDeployment/buildBatches")
    .doc(request.preparationId ?? (background ? background[2] : request.buildBatchId)).get();
  if (!batchSnapshot.exists) throw new Error("The public publication reservation does not exist");
  const stored = request.preparationId === undefined ? batchSnapshot.data() :
    requireModule("../../../functions/lib/public-release-preparation.js").projectPublicReleasePreparationReservation(
      batchSnapshot.data(), { preparationId: request.preparationId, commitSha: request.commitSha });
  const backgroundReservation = isPlainObject(stored?.reservation) ? stored.reservation : null;
  if (background && (stored?.schemaVersion !== 1 || stored.status !== "building" ||
      stored.contextDigest !== background[2] || backgroundReservation?.commitSha !== request.commitSha)) {
    throw new Error("The background publication reservation is unavailable");
  }
  const validateStoredBatch = request.batchMode === "deployed"
    ? assertStoredDeployedPublicArtifactBatch
    : background ? assertStoredBackgroundArtifactReservation : assertStoredPublicArtifactReservation;
  const reservation = validateStoredBatch({ value: background ? backgroundReservation : stored,
    buildBatchId: request.buildBatchId, commitSha: request.commitSha, now: wallClock });
  const admissionTime = new Date(reservation.cutoffAt.toMillis());
  const pageCollection = database.collection("cmsPages");
  const postCollection = database.collection("cmsPosts");
  const authorCollection = database.collection("cmsAuthorProfilesPublic");
  const settingsCollection = database.collection("cmsSettings");
  const assetCollection = database.collection("media_assets_public");
  return database.runTransaction(async (transaction) => {
    const [pageSnapshot, settingsSnapshots, postSnapshot, authorSnapshot] = await Promise.all([
      transaction.get(pageCollection),
      transaction.getAll(
        settingsCollection.doc(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID),
        settingsCollection.doc(SITE_NAVIGATION_SETTINGS_ID),
        settingsCollection.doc(PUBLIC_SITE_CHROME_SETTINGS_ID),
        settingsCollection.doc(NJ_DECIDES_SETTINGS_ID),
        settingsCollection.doc(COVERAGE_LABELS_SETTINGS_ID),
      ),
      transaction.get(postCollection),
      transaction.get(authorCollection),
    ]);
    if (settingsSnapshots.length !== 5) throw new Error("The canonical settings read is incomplete");
    const [settingsSnapshot, navigationSnapshot, chromeSnapshot, njDecidesSnapshot, coverageLabelsSnapshot] = settingsSnapshots;
    // All page identities, including custom pages, share this reservation's historical read time.
    const pages = pageSnapshot.docs.filter(snapshot => snapshot.exists)
      .map(snapshot => ({ ...snapshot.data(), id: snapshot.id }) as CmsPageDoc);
    const storedPosts = postSnapshot.docs
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => ({ ...snapshot.data(), id: snapshot.id }) as CmsPostDoc);
    const posts = await resolveApprovedLibraryVersions(database, storedPosts, query => transaction.get(query));
    const authors = authorSnapshot.docs
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => ({ authorId: snapshot.id, data: snapshot.data() }));
    if (settingsSnapshot.id !== PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID) {
      throw new Error("The canonical cmsSettings read returned the wrong document");
    }
    if (
      navigationSnapshot.id !== SITE_NAVIGATION_SETTINGS_ID ||
      chromeSnapshot.id !== PUBLIC_SITE_CHROME_SETTINGS_ID || njDecidesSnapshot.id !== NJ_DECIDES_SETTINGS_ID ||
      coverageLabelsSnapshot.id !== COVERAGE_LABELS_SETTINGS_ID
    ) {
      throw new Error("The canonical cmsSettings read returned the wrong document");
    }
    const setting = settingsSnapshot.exists
      ? {
          ...settingsSnapshot.data(),
          id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
        }
      : undefined;
    const navigation = navigationSnapshot.exists
      ? {
          ...navigationSnapshot.data(),
          id: SITE_NAVIGATION_SETTINGS_ID,
        }
      : undefined;
    const chrome = chromeSnapshot.exists
      ? {
          ...chromeSnapshot.data(),
          id: PUBLIC_SITE_CHROME_SETTINGS_ID,
        }
      : undefined;
    const assetIdSet = new Set(
      assetIdsForBuild(pages, { mode: "published" }, admissionTime),
    );
    const coverageLabels = coverageLabelsSnapshot.exists ? { ...coverageLabelsSnapshot.data(), id: COVERAGE_LABELS_SETTINGS_ID } : undefined;
    const njDecides = njDecidesSnapshot.exists ? { ...njDecidesSnapshot.data(), id: NJ_DECIDES_SETTINGS_ID } : undefined;
    const brand = projectNjDecidesSettings(njDecides);
    const optionalBrandAssets = new Set<string>();
    if (brand.status === "published") {
      for (const id of [brand.data.logoAssetId, brand.data.backgroundAssetId]) if (id) {
        if (!assetIdSet.has(id)) optionalBrandAssets.add(id);
        assetIdSet.add(id);
      }
    }
    for (const post of posts) {
      for (const id of approvedLibraryCardAssetIds(post, admissionTime)) { assetIdSet.add(id); optionalBrandAssets.delete(id); }
      if (
        !isPublishable(
          {
            status: post.status as never,
            publishAt: post.publishAt as never,
            publiclyVisible: post.publiclyVisible as never,
            published: post.published,
            deleted: post.deleted as never,
          },
          admissionTime,
        ) ||
        !isPlainObject(post.published) ||
        !isPlainObject(post.published.metadata) ||
        !["post", "program", "event"].includes(String(post.published.metadata.type))
      ) {
        continue;
      }
      const usage = collectPublishedMediaUsage({
        collection: "cmsPosts",
        snapshot: post.published,
      });
      for (const assetId of usage.assetIds) { assetIdSet.add(assetId); optionalBrandAssets.delete(assetId); }
    }
    for (const author of authors) {
      const usage = collectPublishedMediaUsage({
        collection: "cmsAuthorProfilesPublic",
        snapshot: author.data,
      });
      for (const assetId of usage.assetIds) { assetIdSet.add(assetId); optionalBrandAssets.delete(assetId); }
    }
    const assetIds = [...assetIdSet].sort();
    const assetSnapshots = assetIds.length === 0
      ? []
      : await transaction.getAll(...assetIds.map((id) => assetCollection.doc(id)));
    if (
      assetSnapshots.length !== assetIds.length ||
      assetSnapshots.some((snapshot, index) => snapshot.id !== assetIds[index] || (!snapshot.exists && !optionalBrandAssets.has(snapshot.id)))
    ) {
      throw new Error("The exact public media read is incomplete");
    }
    const assets = assetSnapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => ({
        id: snapshot.id,
        ...snapshot.data(),
      })) as CmsPublicAsset[];
    return { pages, posts, authors, setting, navigation, chrome, njDecides, coverageLabels, assets, reservation, admissionTime };
  }, { readOnly: true, readTime: reservation.cutoffAt });
}

export function projectPublicArtifactContent(
  read: PublicArtifactContentRead,
): {
  pages: CmsPageBuildData[];
  posts: CmsPostBuildData[];
  programs: CmsProgramBuildData[];
  recordCards: RecordCardPayload[];
  events: CmsEventBuildData[];
  authors: CmsAuthorBuildData[];
  settings: PublicSettingBuildData[];
  receipt: PublicArtifactInventoryReceipt;
} {
  const pageAssetMap = new Map(read.assets.map((asset) => [asset.id, asset]));
  const postAssetMap = new Map(
    read.assets.map((asset) => [asset.id, { ...asset } as Record<string, unknown>]),
  );
  const eventAssetMap = new Map(read.assets.map((asset) => [asset.id, asset]));
  const documents = new Map(read.pages.map((document) => [document.id, document]));
  const projectedPages: CmsPageBuildData[] = [];
  const receiptPages = [];
  for (const [pageId, document] of documents) {
    const projected = projectCmsPage(document, {
      mode: "published",
      now: read.admissionTime,
      assets: pageAssetMap,
    });
    if (!projected) continue;
    if (
      !Number.isSafeInteger(projected.sourceVersion) ||
      Number(projected.sourceVersion) < 1 ||
      !isPlainObject(document.published)
    ) {
      throw new Error(`A complete canonical cmsPages artifact requires ${pageId}`);
    }
    projectedPages.push(projected);
    receiptPages.push({
      documentId: pageId,
      sourceVersion: Number(projected.sourceVersion),
      publishedSnapshot: document.published,
    });
  }
  const projectedPosts: CmsPostBuildData[] = [];
  const projectedPrograms: CmsProgramBuildData[] = [];
  const projectedEvents: CmsEventBuildData[] = [];
  const postDocuments = new Map(read.posts.map((document) => [document.id, document]));
  for (const document of read.posts) {
    const post = projectCmsPost(document, { now: read.admissionTime, assets: postAssetMap });
    if (post) projectedPosts.push(post);
    const program = projectCmsProgram(document, { now: read.admissionTime, assets: postAssetMap });
    if (program) projectedPrograms.push(program);
    const event = projectCmsEvent(document, { now: read.admissionTime, assets: eventAssetMap });
    if (event) projectedEvents.push(event);
  }
  assertPostRouteUniqueness(projectedPosts);
  assertProgramRouteUniqueness(projectedPrograms);
  assertEventRouteUniqueness(projectedEvents);

  const projectedAuthors = read.authors.map(({ authorId, data }) => {
    const author = projectAuthorSnapshot(authorId, data);
    if (!author) {
      throw new Error(`Public author snapshot ${authorId} is unusable`);
    }
    return author;
  });
  assertAuthorRouteUniqueness(projectedAuthors);
  const projectedSetting = projectPublicHomepageBannerArtifact(read.setting);
  // Navigation never fails the build. Missing or unpublished navigation renders
  // the seed and leaves no receipt entry. An addressable snapshot that fails the
  // contract renders the seed and names its exact version as a fallback, so a
  // navigation-only publication still reaches the public site.
  const projectedNavigation = projectSiteNavigationArtifact(read.navigation);
  if (projectedNavigation.status === "invalid") {
    console.warn(
      `site navigation: the published snapshot is invalid; rendering the default navigation (${projectedNavigation.reason})`,
    );
  }
  // Header chrome follows the same rule: it never fails the build.
  const projectedChrome = projectPublicSiteChromeArtifact(read.chrome);
  const projectedCoverageLabels = projectCoverageLabels(read.coverageLabels);
  const projectedNjDecides = projectNjDecidesSettings(read.njDecides, pageAssetMap);
  if (projectedChrome.status === "invalid") {
    console.warn(
      `public-site chrome: the published snapshot is invalid; rendering the default header action (${projectedChrome.reason})`,
    );
  }
  const settings: PublicSettingBuildData[] = [];
  const receiptSettings: PublicArtifactSettingsInput[] = [];
  if (projectedCoverageLabels) {
    settings.push(projectedCoverageLabels.data);
    receiptSettings.push({ documentId: COVERAGE_LABELS_SETTINGS_ID, sourceVersion: projectedCoverageLabels.data.sourceVersion, publishedSnapshot: projectedCoverageLabels.publishedSnapshot });
  }
  if (projectedNjDecides.status === "published") {
    settings.push(projectedNjDecides.data);
    receiptSettings.push({ documentId: NJ_DECIDES_SETTINGS_ID, sourceVersion: projectedNjDecides.data.sourceVersion,
      publishedSnapshot: projectedNjDecides.publishedSnapshot, assetIds: Object.keys(projectedNjDecides.data.assets).sort() });
  }
  if (projectedSetting) {
    settings.push(projectedSetting.data);
    receiptSettings.push({
      documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      sourceVersion: projectedSetting.data.sourceVersion,
      publishedSnapshot: projectedSetting.publishedSnapshot,
    });
  }
  if (projectedNavigation.status === "published") {
    settings.push(projectedNavigation.data);
    receiptSettings.push({
      documentId: SITE_NAVIGATION_SETTINGS_ID,
      sourceVersion: projectedNavigation.data.sourceVersion,
      publishedSnapshot: projectedNavigation.publishedSnapshot,
    });
  }
  if (projectedChrome.status === "published") {
    settings.push(projectedChrome.data);
    receiptSettings.push({
      documentId: PUBLIC_SITE_CHROME_SETTINGS_ID,
      sourceVersion: projectedChrome.data.sourceVersion,
      publishedSnapshot: projectedChrome.publishedSnapshot,
    });
  }
  const settingsFallbacks: PublicArtifactSettingsFallback[] = [];
  const coverageSource = (read.coverageLabels?.published as { sourceVersion?: unknown } | undefined)?.sourceVersion;
  if (!projectedCoverageLabels && Number.isSafeInteger(coverageSource) && Number(coverageSource) > 0) {
    settingsFallbacks.push({ documentId: COVERAGE_LABELS_SETTINGS_ID, sourceVersion: Number(coverageSource) });
  }
  if (projectedNjDecides.status === "invalid" && projectedNjDecides.sourceVersion !== null) {
    settingsFallbacks.push({ documentId: NJ_DECIDES_SETTINGS_ID, sourceVersion: projectedNjDecides.sourceVersion });
  }
  if (projectedNavigation.status === "invalid" && projectedNavigation.sourceVersion !== null) {
    settingsFallbacks.push({
      documentId: SITE_NAVIGATION_SETTINGS_ID,
      sourceVersion: projectedNavigation.sourceVersion,
    });
  }
  if (projectedChrome.status === "invalid" && projectedChrome.sourceVersion !== null) {
    settingsFallbacks.push({
      documentId: PUBLIC_SITE_CHROME_SETTINGS_ID,
      sourceVersion: projectedChrome.sourceVersion,
    });
  }

  const recordCards = exportRecordCards(read.posts, projectedPrograms, read.admissionTime, read.assets, projectedEvents);
  const libraryCards = recordCards.flatMap((card) => {
    if (card.kind !== "sponsor" && card.kind !== "newsletter") return [];
    const source = postDocuments.get(card.id);
    const imageId = card.kind === "sponsor"
      ? card.sponsor?.logoUrl && source ? approvedLibraryCardAssetIds(source, read.admissionTime)[0] : null
      : card.newsletter?.image ? card.newsletter.card.imageAssetId : null;
    return [{
      documentId: card.id,
      sourceVersion: card.sourceVersion ?? 1,
      kind: card.kind,
      assetIds: imageId ? [imageId] : [],
    }];
  });

  return {
    pages: projectedPages,
    posts: projectedPosts,
    programs: projectedPrograms,
    recordCards,
    events: projectedEvents,
    authors: projectedAuthors,
    settings,
    receipt: createPublicArtifactInventoryReceipt({
      reservation: read.reservation,
      pages: receiptPages,
      posts: projectedPosts.map((post) => ({
        kind: "post",
        documentId: post.postId,
        sourceVersion: post.sourceVersion,
        canonicalPath: post.path,
        aliases: post.previousSlugs.map(postPublicPath),
        publishedSnapshot: postDocuments.get(post.postId)?.published,
      })),
      events: projectedEvents.map((event) => ({
        kind: "event", documentId: event.eventId, sourceVersion: event.sourceVersion,
        canonicalPath: event.path, aliases: event.previousSlugs.map(eventPublicPath),
        publishedSnapshot: postDocuments.get(event.eventId)?.published,
      })),
      programs: projectedPrograms.map((program) => ({
        kind: "program",
        documentId: program.programId,
        sourceVersion: program.sourceVersion,
        canonicalPath: program.path,
        aliases: program.previousSlugs.map(programPublicPath),
        publishedSnapshot: postDocuments.get(program.programId)?.published,
      })),
      libraryCards,
      authors: projectedAuthors.map((author) => ({
        documentId: author.authorId,
        sourceVersion: author.sourceVersion,
        canonicalPath: author.path,
        aliases: author.previousSlugs.map(authorPublicPath),
        publishedSnapshot: read.authors.find(({ authorId }) => authorId === author.authorId)?.data,
      })),
      settings: receiptSettings,
      settingsFallbacks,
    }),
  };
}

async function readCmsContent(
  conn: FirestoreConnection,
  selection: CmsContentSelection,
  buildNow: Date,
  publicArtifactBuild: PublicArtifactBuildRequest | null,
): Promise<
  | { pages: CmsPageDoc[]; assets: CmsPublicAsset[] }
  | PublicArtifactContentRead
> {
  const requireModule = createRequire(import.meta.url);
  const { initializeApp, getApps, deleteApp, applicationDefault } =
    requireModule("firebase-admin/app");
  const { getFirestore } = requireModule("firebase-admin/firestore");
  const appName = "cms-pages-loader";
  const existing = getApps().find((app: { name: string }) => app.name === appName);
  // Validate the ADC path before constructing Firestore. Google Auth otherwise
  // discovers a missing file lazily inside gRPC setup, where the rejected
  // background promise can outlive the loader's own fail-closed error handling.
  if (conn.mode === "credentials") realpathSync(conn.credentialsPath);
  const options =
    conn.mode === "credentials"
      ? { projectId: conn.projectId, credential: applicationDefault() }
      : { projectId: conn.projectId };
  const app = existing || initializeApp(options, appName);
  try {
    const database = getFirestore(app);
    if (selection.mode === "draft" && selection.queueId) {
      const queueSnapshot = await database
        .collection("cmsPreviewQueue")
        .doc(selection.queueId)
        .get();
      if (!queueSnapshot.exists) {
        throw new Error(`preview queue ${selection.queueId} was not found`);
      }
      const queue = queueSnapshot.data();
      if (!isPlainObject(queue)) {
        throw new Error(`preview queue ${selection.queueId} is malformed`);
      }
      if (queue.transport !== "github") {
        throw new Error(
          `preview queue ${selection.queueId} is not owned by the GitHub preview transport`,
        );
      }
      if (queue.status !== "pending" && queue.status !== "building") {
        throw new Error(
          `preview queue ${selection.queueId} is ${String(queue.status)}`,
        );
      }
      if (queue.pageId !== selection.pageId) {
        throw new Error(
          `preview queue ${selection.queueId} belongs to ${String(queue.pageId)}`,
        );
      }
      if (queue.rendererSha !== selection.rendererSha) {
        throw new Error(
          `preview queue ${selection.queueId} renderer revision does not match its request`,
        );
      }
      if (
        !Number.isInteger(queue.sourceVersion) ||
        Number(queue.sourceVersion) < 1
      ) {
        throw new Error(
          `preview queue ${selection.queueId} has no source version`,
        );
      }
      if (!isPlainObject(queue.snapshot)) {
        throw new Error(
          `preview queue ${selection.queueId} has no content snapshot`,
        );
      }
      const assets = previewAssetSnapshots(queue.assets, selection.queueId);
      if (
        queue.snapshot.id !== selection.pageId ||
        queue.snapshot.version !== queue.sourceVersion
      ) {
        throw new Error(
          `preview queue ${selection.queueId} snapshot identity does not match its request`,
        );
      }
      if (!hasToMillis(queue.expiresAt)) {
        throw new Error(
          `preview queue ${selection.queueId} has no valid expiry`,
        );
      }
      const expiresAtMillis = queue.expiresAt.toMillis();
      if (!Number.isFinite(expiresAtMillis)) {
        throw new Error(
          `preview queue ${selection.queueId} has no valid expiry`,
        );
      }
      if (expiresAtMillis <= buildNow.getTime()) {
        throw new Error(`preview queue ${selection.queueId} is expired`);
      }
      return {
        pages: [{ ...(queue.snapshot as CmsPageDoc) }],
        assets,
      };
    }

    return publicArtifactBuild
      ? readPublicArtifactContentFromDatabase(
          database as unknown as CmsFirestoreDatabase & HistoryDatabase,
          publicArtifactBuild,
          buildNow,
        )
      : readCmsContentFromDatabase(
          database as unknown as CmsFirestoreDatabase,
          selection,
          buildNow,
        );
  } finally {
    if (!existing) await deleteApp(app).catch(() => {});
  }
}

export function cmsPagesLoader(previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource()): Loader {
  // The mode and page id are part of loader identity, not just values read in
  // `load`. Astro persists the content store between builds; a fixed name lets a
  // published build's cached entries survive into a later draft build in the
  // same checkout without invoking the loader again.
  const previewInput = previewContent?.request;
  const selection: CmsContentSelection = previewInput
    ? { mode: "draft", pageId: previewInput.pageId, queueId: previewInput.queueId, rendererSha: previewInput.rendererSha }
    : resolveCmsContentMode();
  const artifactBundlePath = resolvePublicArtifactBundlePath();
  const publicArtifactBuild = resolvePublicArtifactBuildRequest(selection);
  const selectionKey =
    selection.mode === "draft"
      ? `draft-${selection.pageId}${selection.queueId ? `-${selection.queueId}` : ""}`
      : publicArtifactBuild
        ? `published-${publicArtifactBuild.buildBatchId}`
        : "published";
  return {
    name: `cms-pages-firestore-${selectionKey}${previewInput ? `-${previewInput.sha256}` : ""}`,
    load: async ({ store, logger, parseData }) => {
      if (previewContent) {
        const content = await previewContent.load();
        store.clear();
        for (const page of content.pages) {
          store.set({ id: page.pageId,
            data: await parseData({ id: page.pageId, data: { ...page } }) });
        }
        logger.info("cmsPages loader: loaded the exact private preview input without Firestore.");
        return;
      }
      if (artifactBundlePath) {
        const bundle = await readPublicArtifactBundle(artifactBundlePath);
        store.clear();
        for (const page of bundle.pages) {
          store.set({
            id: page.pageId,
            data: await parseData({ id: page.pageId, data: { ...page } }),
          });
        }
        logger.info(`cmsPages loader: loaded ${bundle.pages.length} page(s) from the exact public artifact bundle.`);
        return;
      }
      const strict = isStrictLoaderMode() || publicArtifactBuild !== null;
      const conn = resolveFirestoreConnection();
      if (!conn) {
        if (strict) {
          throw new Error("cmsPages loader: Firestore is not configured in strict mode.");
        }
        store.clear();
        logger.info("cmsPages loader: Firestore not configured; skipping (0 pages).");
        return;
      }

      let docs: CmsPageDoc[];
      let assets: CmsPublicAsset[];
      // One instant governs both admission-time asset reads and every page
      // projection, so a page at its publish boundary cannot be treated
      // differently based on iteration timing.
      let buildNow = new Date();
      try {
        const read = await readCmsContent(
          conn,
          selection,
          buildNow,
          publicArtifactBuild,
        );
        ({ pages: docs, assets } = read);
      } catch (error) {
        if (strict) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `cmsPages loader: Firestore read failed in strict mode: ${message}`,
          );
        }
        store.clear();
        logger.warn(
          `cmsPages loader: Firestore unreachable, skipping (${error instanceof Error ? error.message : String(error)}).`,
        );
        return;
      }

      store.clear();
      let loaded = 0;
      let skipped = 0;
      const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
      for (const doc of docs) {
        try {
          if (
            selection.mode === "published" &&
            isLegacyBlockOnlySnapshot(doc)
          ) {
            logger.warn(
              `cmsPages loader: ${doc.id} uses a legacy block-only snapshot; retaining the committed route until it is republished.`,
            );
            continue;
          }
          const projected = projectCmsPage(doc, {
              ...selection,
              now: buildNow,
              assets: assetMap,
            } as ProjectOptions);
          if (!projected) continue;
          const data = await parseData({ id: doc.id, data: { ...projected } });
          store.set({ id: doc.id, data });
          loaded += 1;
        } catch (error) {
          if (strict) {
            throw new Error(
              `cmsPages loader: invalid document ${doc.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          skipped += 1;
          logger.warn(
            `cmsPages loader: skipped malformed document ${doc.id} (${
              error instanceof Error ? error.message : String(error)
            }).`,
          );
        }
      }
      if (strict && selection.mode === "draft" && loaded !== 1) {
        throw new Error(
          `cmsPages loader: draft page ${selection.pageId} was not found or is deleted.`,
        );
      }
      logger.info(
        `cmsPages loader: loaded ${loaded} page(s)${
          skipped ? `, skipped ${skipped} malformed` : ""
        } from ${selection.mode} content.`,
      );
    },
  };
}
