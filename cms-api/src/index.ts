import { CONTENT_LINK_DIRECTORY_MAX_BYTES } from "../../packages/content-core/src/content-link.ts";
import { wakeAcceptedPreviewPair, type PreviewPairWakeEnvironment } from "./preview-pair-wake";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairServingDecision } from "../../functions/lib/public-release-serving";
import { parseSelectorReceipt, type SelectorReceipt } from "../../packages/content-core/src/public-release-routing";
import { consumeReleaseRate, ReleaseRateRefusal, reportReleaseRateRefusal } from "./public-release-rate-control";
import type { ReleaseAdmissionReply } from "../../workers/src/public-release-rate-control";
import type { CodePostReply } from "../../packages/content-core/src/code-post-context";
import { handlePrivateRecordCode, type RecordCodeBinding } from "./record-code";
import publicAssetHosts from "../../functions/lib/public-asset-hosts.json";
import pageReaderContract from "../../functions/lib/page-reader-contract.js";
import installedPageReader from "./page-reader-contract.json";
import { heroBackgroundMetadata } from "../../packages/content-core/src/hero-background";
import { WorkerEntrypoint } from "cloudflare:workers";
import { LiveProductionRelay, LIVE_STREAM_PATH, streamBinding, readLiveReply, isLiveCommandRequest } from "./live-production-relay";
import { parseLiveCommand } from "../../packages/content-core/src/live-production";
import { visibleLayoutBlocks } from "../../packages/content-core/src/content-layout";
import {
  isPageTheme,
  parseBlocks,
  type ImageData,
  type PageBlock,
  type PageTheme,
  type SearchMetadata,
  type SocialMetadata,
} from "../../packages/content-core/src/content-model";
import {
  validateSection,
  type SectionId,
} from "../../packages/content-core/src/editor-admin";
import {
  isPublicPageId,
  publicPage,
  isPublicPagePath,
  type PublicPageFamily,
  type PublicPageId,
} from "../../packages/content-core/src/public-pages";
import { parsePublishInstant } from "../../packages/content-core/src/publish-instant";
import { endpointPolicy, RATE_POLICIES, type RateClass } from "./config";
import { cmsReaderVersion, dispatchCmsReaderMount, READER_POLICY } from "./cms-reader-mount";
import { DEV_API_ENDPOINTS } from "./dev-endpoints";
import { CONTENT_OPS_ENDPOINT, CONTENT_OPS_POLICY, handleContentOps, isContentOpsPublish } from "./content-ops-route";
import { bylineFailureReason, readBylineDirectory } from "./byline-directory";
import {
  FirebaseTokenError,
  verifyFirebaseIdToken,
} from "./firebase-auth";
import {
  CmsRateLimiter,
  type ConsumeResult,
} from "./rate-limiter";

export { CmsRateLimiter, LiveProductionRelay };

export type CmsApiEnv = PreviewPairWakeEnvironment & Omit<Env, "ALLOW_LOCAL_ORIGINS" | "CMS_BYLINE_EDGE_ENABLED" | "RATE_LIMITERS" | "PREVIEW_RENDERER" | "FIREBASE_PROJECT_ID" | "FUNCTIONS_ORIGIN" | "LIVE_PRODUCTION_RELAYS" | "LIVE_PRODUCTION_STREAM_ENABLED"> & {
  ALLOW_LOCAL_ORIGINS: string;
  CMS_DEPLOYMENT_ENVIRONMENT?: string;
  CMS_DEV_REPORT_INTAKE_MODE?: string;
  PUBLIC_RELEASE_READERS_ENABLED?: string;
  PUBLIC_RELEASE_RATE_CONTROLS_ENABLED?: string;
  CMS_READER_BRIDGE_ENABLED?: string;
  CMS_READER_BRIDGE_OPERATION_ID?: string;
  CMS_API_WORKER_VERSION?: { id: string };
  PUBLIC_RELEASE_ROUTING_MEASUREMENT_ENABLED?: string;
  FIREBASE_PROJECT_ID: string;
  FUNCTIONS_ORIGIN: string;
  ADMIN_ORIGIN?: string;
  CMS_EDGE_ORIGIN_SECRET: string;
  CMS_BYLINE_EDGE_ENABLED?: string;
  FIREBASE_WEB_API_KEY?: string;
  RATE_LIMITERS: DurableObjectNamespace<CmsRateLimiter>;
  LIVE_PRODUCTION_RELAYS?: DurableObjectNamespace<LiveProductionRelay>;
  LIVE_PRODUCTION_STREAM_ENABLED?: string;
  PREVIEW_RENDERER?: { wake(rendererSha: string, requestId?: string): Promise<void> } & RecordCodeBinding;
};

interface HandlerDependencies {
  fetchOrigin?: typeof fetch;
  now?: () => number;
  randomUUID?: () => string;
  verifyToken?: typeof verifyFirebaseIdToken;
}

interface PublicContentDependencies {
  fetchOrigin?: typeof fetch;
}

interface PublicPageImageAsset {
  credit?: string;
  url: string;
  mimeType:
    | "image/jpeg"
    | "image/png"
    | "image/webp"
    | "image/gif"
    | "image/avif";
  width: number;
  height: number;
}

interface PublicPageDocumentAsset {
  url: string;
  mimeType: "application/pdf";
}

type PublicPageAsset = PublicPageImageAsset | PublicPageDocumentAsset;

interface PublicPageProjectionData {
  pageId: PublicPageId;
  childDirected?: boolean;
  path: string;
  family: PublicPageFamily;
  template: SectionId;
  title: string;
  pageTheme?: PageTheme;
  description: string;
  heroBackgroundImage?: string;
  heroBackgroundPosition?: "center" | "top" | "bottom";
  homeHeroTitle?: string;
  homeHeroSubtitle?: string;
  noindex: boolean;
  seo?: SearchMetadata;
  social?: SocialMetadata;
  blocks: PageBlock[];
  assets: Record<string, PublicPageAsset>;
  contentMode: "published";
  sourceVersion: number;
  publishedAt: string;
}

export type PublicPageProjection =
  | { apiVersion: 1; state: "unmanaged"; pageId: PublicPageId }
  | { apiVersion: 1; state: "withdrawn"; pageId: PublicPageId }
  | { apiVersion: 1; state: "live"; page: PublicPageProjectionData };

const PUBLIC_CONTENT_FUNCTION = "cmsGetPublicPage";
const MAX_PUBLIC_PROJECTION_BYTES = 1_500_000;
const PUBLIC_IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

class PublicContentRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicContentRpcError";
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedImageData(data: ImageData): ImageData {
  return {
    ...(data.itemId !== undefined ? { itemId: data.itemId } : {}),
    assetId: data.assetId,
    alt: data.alt,
    ...(data.altDecorative !== undefined
      ? { altDecorative: data.altDecorative }
      : {}),
    ...(data.caption !== undefined ? { caption: data.caption } : {}),
  };
}

/** Public fields from a block already validated by parseBlocks. */
export function selectedBlock(block: PageBlock): Record<string, unknown> {
  let data: unknown;
  switch (block.type) {
    case "bio_card":
    case "data_figure":
    case "data_hub_section":
    case "election_results":
    case "home_newscast":
    case "newsletter_signup":
    case "record_card":
    case "sponsor_strip":
    case "video":
      // These schemas reject unknown keys, including nested payload fields.
      // Keep their validated public data without a second, drifting field list.
      data = structuredClone(block.data);
      break;
    case "county_comparison":
      data = { datasetVersion: block.data.datasetVersion, heading: block.data.heading,
        intro: block.data.intro, source: block.data.source };
      break;
    case "row":
      data = { columns: [...block.data.columns] };
      break;
    case "headline":
      data = {
        text: block.data.text,
        ...(block.data.level !== undefined ? { level: block.data.level } : {}),
      };
      break;
    case "prose":
      data = { content: structuredClone(block.data.content) };
      break;
    case "image":
      data = {
        ...selectedImageData(block.data),
        ...(block.data.href !== undefined ? { href: block.data.href } : {}),
        ...(block.data.newTab !== undefined ? { newTab: block.data.newTab } : {}),
      };
      break;
    case "image_gallery":
      data = {
        images: block.data.images.map(selectedImageData),
        ...(block.data.presentation !== undefined
          ? { presentation: block.data.presentation }
          : {}),
      };
      break;
    case "document_list":
      data = {
        documents: block.data.documents.map((document) => ({
          itemId: document.itemId,
          assetId: document.assetId,
          title: document.title,
          ...(document.publisher !== undefined ? { publisher: document.publisher } : {}),
          addedAt: document.addedAt,
        })),
      };
      break;
    case "support_appeal":
      data = {
        heading: block.data.heading, copy: block.data.copy,
        buttonLabel: block.data.buttonLabel, href: block.data.href, style: block.data.style,
        ...(block.data.backgroundImageAssetId !== undefined ? { backgroundImageAssetId: block.data.backgroundImageAssetId } : {}),
      };
      break;
    case "cta_row":
      data = {
        ctas: block.data.ctas.map((cta) => ({
          label: cta.label,
          href: cta.href,
          ...(cta.variant !== undefined ? { variant: cta.variant } : {}),
        })),
      };
      break;
    case "card_grid":
      data = {
        cards: block.data.cards.map((card) => ({
          ...(card.itemId !== undefined ? { itemId: card.itemId } : {}),
          ...(card.label !== undefined ? { label: card.label } : {}),
          title: card.title,
          ...(card.body !== undefined
            ? { body: structuredClone(card.body) }
            : {}),
          ...(card.imageAssetId !== undefined
            ? { imageAssetId: card.imageAssetId }
            : {}),
          ...(card.href !== undefined ? { href: card.href } : {}),
        })),
      };
      break;
    case "link_card":
      data = {
        title: block.data.title,
        url: block.data.url,
        ...(block.data.source !== undefined ? { source: block.data.source } : {}),
        ...(block.data.date !== undefined ? { date: block.data.date } : {}),
        ...(block.data.summary !== undefined ? { summary: block.data.summary } : {}),
      };
      break;
    case "faq_item":
      data = {
        question: block.data.question,
        answer: structuredClone(block.data.answer),
      };
      break;
    case "coverage_list":
      data = {
        entries: block.data.entries.map((entry) => ({
          title: entry.title,
          outlet: entry.outlet,
          date: entry.date,
          url: entry.url,
        })),
      };
      break;
    case "town_lookup":
      data = { heading: block.data.heading, introduction: block.data.introduction, sourceLine: block.data.sourceLine };
      break;
    case "data_table":
      data = { title: block.data.title, csv: block.data.csv, source: block.data.source, sourceHref: block.data.sourceHref };
      break;
    case "embed":
      data = {
        url: block.data.url,
        ...(block.data.host !== undefined ? { host: block.data.host } : {}),
        ...(block.data.caption !== undefined
          ? { caption: block.data.caption }
          : {}),
        ...(block.data.width !== undefined ? { width: block.data.width } : {}),
        ...(block.data.height !== undefined ? { height: block.data.height } : {}),
        ...(block.data.heading !== undefined ? { heading: block.data.heading } : {}),
        ...(block.data.mapSize !== undefined ? { mapSize: block.data.mapSize } : {}),
        ...(block.data.mobileHeight !== undefined ? { mobileHeight: block.data.mobileHeight } : {}),
        ...(block.data.mapWidth !== undefined ? { mapWidth: block.data.mapWidth } : {}),
      };
      break;
    case "html":
      data = {
        html: block.data.html,
        ...(block.data.title !== undefined ? { title: block.data.title } : {}),
      };
      break;
    case "content_shelf":
      data = {
        title: block.data.title,
        source: block.data.source,
        itemLimit: block.data.itemLimit,
        moreLabel: block.data.moreLabel,
        moreHref: block.data.moreHref,
        ...(block.data.presentation !== undefined
          ? { presentation: block.data.presentation }
          : {}),
        ...(block.data.columns !== undefined
          ? { columns: block.data.columns }
          : {}),
      };
      break;
    case "promotion_playlist":
      data = {
        title: block.data.title,
        placement: block.data.placement,
        ...(block.data.presentation !== undefined
          ? { presentation: block.data.presentation }
          : {}),
        ...(block.data.columns !== undefined
          ? { columns: block.data.columns }
          : {}),
        cards: block.data.cards.map((card) => ({ ...card })),
      };
      break;
    case "topic_shelf":
      data = {
        title: block.data.title,
        topic: block.data.topic,
        source: block.data.source,
        itemLimit: block.data.itemLimit,
        sort: block.data.sort,
        ...(block.data.pinned !== undefined
          ? { pinned: block.data.pinned.map(({ id }) => ({ id })) }
          : {}),
      };
      break;
    case "video_playlist":
      data = {
        title: block.data.title,
        topic: block.data.topic,
        library: block.data.library,
        itemLimit: block.data.itemLimit,
        sort: block.data.sort,
        ...(block.data.pinned !== undefined
          ? { pinned: block.data.pinned.map(({ id }) => ({ id })) }
          : {}),
      };
      break;
    case "divider":
      data = {};
      break;
    default: {
      const exhaustive: never = block;
      throw new PublicContentRpcError("Invalid projection");
    }
  }
  return {
    id: block.id,
    type: block.type,
    ...(block.section !== undefined ? { section: block.section } : {}),
    ...(block.layout !== undefined
      ? { layout: { rowId: block.layout.rowId, column: block.layout.column } }
      : {}),
    order: block.order,
    visible: block.visible,
    data,
  };
}

function selectedBlocks(blocks: PageBlock[]): PageBlock[] {
  const selected = visibleLayoutBlocks(blocks)
    .sort((left, right) => left.order - right.order)
    .map(selectedBlock);
  const parsed = parseBlocks(selected);
  if (!parsed.ok) throw new PublicContentRpcError("Invalid projection");
  return parsed.blocks;
}

function selectedMetadataGroup(
  value: unknown,
  owner: "seo" | "social",
): SearchMetadata | SocialMetadata | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value)) throw new PublicContentRpcError("Invalid projection");
  const selected: Record<string, string | boolean> = {};
  for (const field of ["title", "description"] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== "string") {
        throw new PublicContentRpcError("Invalid projection");
      }
      selected[field] = value[field];
    }
  }
  if (owner === "seo" && value.noindex !== undefined) {
    if (typeof value.noindex !== "boolean") {
      throw new PublicContentRpcError("Invalid projection");
    }
    selected.noindex = value.noindex;
  }
  if (owner === "social" && value.imageAssetId !== undefined) {
    if (typeof value.imageAssetId !== "string") {
      throw new PublicContentRpcError("Invalid projection");
    }
    selected.imageAssetId = value.imageAssetId;
  }
  return selected;
}

function selectedAsset(value: unknown, dev = false): PublicPageAsset {
  if (!plainObject(value)) throw new PublicContentRpcError("Invalid projection");
  if (
    typeof value.url !== "string" ||
    typeof value.mimeType !== "string" ||
    (value.mimeType !== "application/pdf" &&
      (!PUBLIC_IMAGE_MIME_TYPES.has(value.mimeType) ||
        !Number.isSafeInteger(value.width) ||
        Number(value.width) <= 0 ||
        !Number.isSafeInteger(value.height) ||
        Number(value.height) <= 0))
  ) {
    throw new PublicContentRpcError("Invalid projection");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new PublicContentRpcError("Invalid projection");
  }
  const hosts = publicAssetHosts[dev ? "development" : "production"];
  const approved =
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    ((hosts.media.includes(url.hostname) &&
      url.pathname.startsWith("/cms-media/") &&
      url.pathname.length > 11) ||
      (value.mimeType !== "application/pdf" &&
        hosts.brand.includes(url.hostname) &&
        url.pathname.startsWith("/brand/") &&
        url.pathname.length > 7));
  if (!approved) throw new PublicContentRpcError("Invalid projection");
  if (value.mimeType === "application/pdf") {
    return { url: value.url, mimeType: "application/pdf" };
  }
  if (value.credit !== undefined && (typeof value.credit !== "string" || value.credit.length > 300)) {
    throw new PublicContentRpcError("Invalid projection");
  }
  return {
    ...(typeof value.credit === "string" && value.credit.trim() ? { credit: value.credit.trim() } : {}),
    url: value.url,
    mimeType: value.mimeType as PublicPageImageAsset["mimeType"],
    width: Number(value.width),
    height: Number(value.height),
  };
}

function validateAssetSlots(
  blocks: PageBlock[],
  assets: Record<string, PublicPageAsset>,
  metadata: Record<string, unknown>,
) {
  const documents = new Set<string>();
  const images = new Set<unknown>([
    metadata.heroBackgroundImage,
    plainObject(metadata.social) ? metadata.social.imageAssetId : undefined,
  ]);
  if (plainObject(metadata.homeHero) && Array.isArray(metadata.homeHero.items)) {
    for (const item of metadata.homeHero.items) {
      if (plainObject(item)) images.add(item.imageAssetId);
    }
  }
  for (const block of blocks) {
    switch (block.type) {
      case "support_appeal":
        images.add(block.data.backgroundImageAssetId);
        break;
      case "document_list":
        for (const document of block.data.documents) documents.add(document.assetId);
        break;
      case "image":
        images.add(block.data.assetId);
        break;
      case "image_gallery":
        for (const image of block.data.images) images.add(image.assetId);
        break;
      case "card_grid":
      case "promotion_playlist":
        for (const card of block.data.cards) images.add(card.imageAssetId);
        break;
      case "bio_card":
        images.add(block.data.image?.assetId);
        break;
    }
  }
  for (const assetId of documents) {
    if (assets[assetId]?.mimeType !== "application/pdf") {
      throw new PublicContentRpcError("Invalid projection");
    }
  }
  for (const [assetId, asset] of Object.entries(assets)) {
    if (asset.mimeType === "application/pdf" &&
        (!documents.has(assetId) || images.has(assetId))) {
      throw new PublicContentRpcError("Invalid projection");
    }
  }
}

function validatePublicPageProjection(
  value: unknown,
  requestedPageId: PublicPageId,
  dev = false,
): PublicPageProjection {
  if (!plainObject(value) || value.apiVersion !== 1) {
    throw new PublicContentRpcError("Invalid projection");
  }
  if (value.state === "unmanaged" || value.state === "withdrawn") {
    if (value.pageId !== requestedPageId) {
      throw new PublicContentRpcError("Invalid projection");
    }
    return { apiVersion: 1, state: value.state, pageId: requestedPageId };
  }
  if (value.state !== "live" || !plainObject(value.page)) {
    throw new PublicContentRpcError("Invalid projection");
  }
  const pageValue = value.page;
  const definition = publicPage(requestedPageId);
  if (
    !definition ||
    pageValue.pageId !== requestedPageId ||
    !isPublicPagePath(requestedPageId, pageValue.path) ||
    pageValue.family !== definition.family ||
    pageValue.template !== definition.editorTemplate ||
    typeof pageValue.title !== "string" ||
    pageValue.title.trim() === "" ||
    typeof pageValue.description !== "string" ||
    (pageValue.childDirected !== undefined && typeof pageValue.childDirected !== "boolean") ||
    (pageValue.homeHeroTitle !== undefined &&
      typeof pageValue.homeHeroTitle !== "string") ||
    (pageValue.homeHeroSubtitle !== undefined &&
      typeof pageValue.homeHeroSubtitle !== "string") ||
    typeof pageValue.noindex !== "boolean" ||
    pageValue.contentMode !== "published" ||
    !Number.isSafeInteger(pageValue.sourceVersion) ||
    Number(pageValue.sourceVersion) < 1 ||
    typeof pageValue.publishedAt !== "string" ||
    parsePublishInstant(pageValue.publishedAt) === null ||
    !plainObject(pageValue.assets)
  ) {
    throw new PublicContentRpcError("Invalid projection");
  }
  const parsed = parseBlocks(pageValue.blocks);
  if (!parsed.ok || validateSection(definition.editorTemplate, parsed.blocks) ||
      !pageReaderContract.pageReaderSupports(parsed.blocks, requestedPageId, installedPageReader.pageReaderVersion)) {
    throw new PublicContentRpcError("Invalid projection");
  }
  const assets = Object.fromEntries(
    Object.entries(pageValue.assets).map(([assetId, asset]) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) {
        throw new PublicContentRpcError("Invalid projection");
      }
      return [assetId, selectedAsset(asset, dev)];
    }),
  );
  const seo = selectedMetadataGroup(pageValue.seo, "seo") as
    | SearchMetadata
    | undefined;
  const social = selectedMetadataGroup(pageValue.social, "social") as
    | SocialMetadata
    | undefined;
  const pageTheme = isPageTheme(pageValue.pageTheme)
    ? pageValue.pageTheme
    : undefined;
  const blocks = selectedBlocks(parsed.blocks);
  validateAssetSlots(blocks, assets, pageValue);
  return {
    apiVersion: 1,
    state: "live",
    page: {
      pageId: requestedPageId,
      ...(pageValue.childDirected !== undefined ? { childDirected: pageValue.childDirected } : {}),
      path: pageValue.path,
      family: definition.family,
      template: definition.editorTemplate,
      title: pageValue.title,
      ...(pageTheme !== undefined ? { pageTheme } : {}),
      ...heroBackgroundMetadata(pageValue),
      description: pageValue.description,
      ...(pageValue.homeHeroTitle !== undefined
        ? { homeHeroTitle: pageValue.homeHeroTitle }
        : {}),
      ...(pageValue.homeHeroSubtitle !== undefined
        ? { homeHeroSubtitle: pageValue.homeHeroSubtitle }
        : {}),
      noindex: pageValue.noindex,
      ...(seo ? { seo } : {}),
      ...(social ? { social } : {}),
      blocks,
      assets,
      contentMode: "published",
      sourceVersion: Number(pageValue.sourceVersion),
      publishedAt: pageValue.publishedAt,
    },
  };
}

async function boundedJson(response: Response, maximumBytes = MAX_PUBLIC_PROJECTION_BYTES): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!Number.isSafeInteger(Number(declared)) ||
      Number(declared) < 0 ||
      Number(declared) > maximumBytes)
  ) {
    throw new PublicContentRpcError("Invalid projection");
  }
  if (!response.body) throw new PublicContentRpcError("Invalid projection");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new PublicContentRpcError("Invalid projection");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PublicContentRpcError("Invalid projection");
  }
}

export async function fetchPublicPageProjection(
  env: CmsApiEnv,
  pageId: string,
  deps: PublicContentDependencies = {},
): Promise<PublicPageProjection> {
  if (!isPublicPageId(pageId)) {
    throw new PublicContentRpcError("Public content request was refused");
  }
  if (env.CMS_DEPLOYMENT_ENVIRONMENT === "development" &&
      env.FIREBASE_PROJECT_ID !== "njpbs-site-dev") {
    throw new PublicContentRpcError("Dev API target was refused");
  }
  if (env.FIREBASE_PROJECT_ID === "njpbs-site-dev" &&
      (env.FUNCTIONS_ORIGIN !== "https://us-central1-njpbs-site-dev.cloudfunctions.net" ||
       env.ADMIN_ORIGIN !== "https://dev-admin.example.org")) {
    throw new PublicContentRpcError("Dev API target was refused");
  }
  if (!env.CMS_EDGE_ORIGIN_SECRET?.trim()) {
    throw new PublicContentRpcError("Public content service is unavailable");
  }
  const fetchOrigin = deps.fetchOrigin ?? fetch;
  let response: Response;
  try {
    response = await fetchOrigin(
      `${env.FUNCTIONS_ORIGIN}/${PUBLIC_CONTENT_FUNCTION}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-njpbs-cms-edge": env.CMS_EDGE_ORIGIN_SECRET,
          "x-njpbs-request-id": crypto.randomUUID(),
        },
        body: JSON.stringify({ pageId }),
        redirect: "manual",
      },
    );
  } catch {
    throw new PublicContentRpcError("Public content service is unavailable");
  }
  if (!response.ok) {
    throw new PublicContentRpcError("Public content service is unavailable");
  }
  const value = await boundedJson(response);
  return validatePublicPageProjection(value, pageId, env.FIREBASE_PROJECT_ID === "njpbs-site-dev");
}

// The gateway checks this tuple over RPC before trusting the dev binding.
function staffSiteEnvironment(env: CmsApiEnv): "production" | "development" | null {
  const dev = env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ||
    env.FIREBASE_PROJECT_ID === "njpbs-site-dev";
  if (!dev) return "production";
  return env.CMS_DEPLOYMENT_ENVIRONMENT === "development" &&
    env.FIREBASE_PROJECT_ID === "njpbs-site-dev" &&
    env.FUNCTIONS_ORIGIN === "https://us-central1-njpbs-site-dev.cloudfunctions.net" &&
    env.ADMIN_ORIGIN === "https://dev-admin.example.org" ? "development" : null;
}

export async function validateStaffSiteAccess(
  env: CmsApiEnv,
  token: string,
  ip: string,
  deps: HandlerDependencies = {},
  preview?: { schemaVersion: 1; queueId: string; persistent: boolean },
): Promise<number> {
  if (staffSiteEnvironment(env) === null) return 503;
  if (preview && (preview.schemaVersion !== 1 || typeof preview.queueId !== "string" || !/^[A-Za-z0-9]{20}$/.test(preview.queueId) ||
      typeof preview.persistent !== "boolean")) return 404;
  if (!/^[A-Za-z0-9._-]{1,3500}$/.test(token)) return 401;
  if (!env.CMS_EDGE_ORIGIN_SECRET?.trim()) return 503;
  const now = (deps.now ?? Date.now)();
  const ipLimit = await consume(env, "ip", "staffSite", ip || "missing", now);
  if (!ipLimit.allowed) return 429;
  let actor: { uid: string };
  try {
    actor = await (deps.verifyToken ?? verifyFirebaseIdToken)(token, env.FIREBASE_PROJECT_ID);
  } catch (error) {
    return error instanceof FirebaseTokenError ? 401 : 503;
  }
  const actorLimit = await consume(env, "actor", "staffSite", actor.uid, now);
  if (!actorLimit.allowed) return 429;
  const response = await (deps.fetchOrigin ?? fetch)(`${env.FUNCTIONS_ORIGIN}/cmsValidateSiteAccess`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-njpbs-cms-edge": env.CMS_EDGE_ORIGIN_SECRET,
      ...(preview ? { "content-type": "application/json" } : {}),
    },
    ...(preview ? { body: JSON.stringify({ preview }) } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  // An older Function can accept this body as generic staff admission. Its
  // success is not a preview authorization decision.
  if (preview) {
    if (response.status === 204) return response.headers.get("x-njpbs-preview-access") === "1" ? 204 : 503;
    return [401, 404].includes(response.status) ? response.status : 503;
  }
  return [204, 401, 403].includes(response.status) ? response.status : 503;
}

// Only a service binding can call this entrypoint. The gateway supplies the
// edge-written client IP; the signed token supplies the actor identity.
export class StaffSiteEntrypoint extends WorkerEntrypoint<CmsApiEnv> {
  async getSiteEnvironment(): Promise<"production" | "development" | null> {
    return staffSiteEnvironment(this.env);
  }

  async validateAccess(token: string, ip: string): Promise<number> {
    return validateStaffSiteAccess(this.env, token, ip);
  }

  async validatePreviewAccess(token: string, ip: string,
    target: { schemaVersion: 1; queueId: string; persistent: boolean }): Promise<number> {
    // Missing identity must never fall through to generic admission.
    if (!target) return 404;
    return validateStaffSiteAccess(this.env, token, ip, {}, target);
  }
}

export interface NoBuildPostReply {
  kind: "pass" | "post" | "alias" | "gone" | "receipts" | "background" | "baseline-probe" | "static";
  receipt?: { schemaVersion: 1; postId: string; operationId: string; rendererSha: string;
    sourceVersion: number; slug: string; ownedSlugs: string[]; generation: number; visible: boolean; contextDigest: string;
    admissionRevision?: number | null; snapshotDigest?: string; datasetFiguresDigest?: string; contentRedirectUrl?: string; mode?: "static" };
  catalog?: { schemaVersion: 1; rendererSha: string; generation: number; contextDigest: string;
    admissionRevision: number; posts: NonNullable<NoBuildPostReply["receipt"]>[] };
  staticFile?: { path: string; bytes: number; digest: string } | null;
  published?: unknown;
  location?: string;
  status?: number;
  headers?: Record<string, string>;
  bytes?: string;
}

export interface NoBuildPageReply {
  decisionCacheUntil?: number;
  kind: "pass" | "page" | "alias" | "gone" | "home-sources" | "context-page" | "context-home-sources" | "redirect" | "schedule-export" | "schedule-unavailable";
  path?: string;
  pageId?: "schedule" | "live";
  // Imported from the type-only module: the packet module that also exports this
  // type reaches PDF code this package does not install.
  scheduleReceipt?: import("../../site/src/lib/page-schedule-receipt").PageScheduleReceipt;
  bytes?: string;
  contextReceipt?: { rendererSha: string; contextRevision: number; contextDigest: string;
    codeGeneration: number; path: string; source: "cms" | "site"; sourceVersion?: number };
  renderContext?: unknown;
  receipt?: { schemaVersion: 1; pageId: string; operationId: string; rendererSha: string;
    sourceVersion: number; snapshotDigest: string; path: string; ownedPaths: string[]; generation: number; operationGeneration?: number; codeGeneration: number;
    visible: boolean; contextDigest: string; admissionRevision: number | null; datasetFiguresDigest?: string; homeRefreshRevision?: number };
  location?: string;
  published?: unknown;
  homeSources?: import("../../site/src/lib/home-sources").HomeSourceSnapshot | null;
  publication?: import("../../site/src/lib/home-sources").HomeSourceSnapshot["publication"];
  needsBaseline?: boolean;
  homeRefresh?: { schemaVersion: number; revision: number; status: string; taskPath: string;
    sourceOperationId: string; postId: string; sourceVersion: number } | null;
}

function pageReaderEnvironment(env: CmsApiEnv): "production" | "development" | null {
  const development = env.CMS_DEPLOYMENT_ENVIRONMENT === "development";
  const project = development ? "njpbs-site-dev" : "njpbs-site";
  const origin = development ? "https://dev-admin.example.org" : PRODUCTION_ADMIN_ORIGIN;
  if (env.CMS_DEPLOYMENT_ENVIRONMENT !== undefined && !["production", "development"].includes(env.CMS_DEPLOYMENT_ENVIRONMENT) ||
      env.FIREBASE_PROJECT_ID !== project || env.FUNCTIONS_ORIGIN !== `https://us-central1-${project}.cloudfunctions.net` ||
      (env.ADMIN_ORIGIN ?? PRODUCTION_ADMIN_ORIGIN) !== origin) return null;
  return development ? "development" : "production";
}

// The runtime decompresses a gzip reply before boundedJson reads it, and the
// decompressed size bound still applies. Gzip cuts Cloud Run egress.
const publicDecisionHeaders = (secret: string) => ({ "content-type": "application/json",
  "accept-encoding": "gzip", "x-njpbs-cms-edge": secret });

export class PublicContentEntrypoint extends WorkerEntrypoint<CmsApiEnv> {
  /** Private service binding only. No HTTP request exposes these admissions. */
  async consumeReleaseViewer(ip: string, budgetMs: number): Promise<ReleaseAdmissionReply> {
    return this.releaseAdmission("viewer", budgetMs, ip);
  }
  async consumeReleaseAuthority(budgetMs: number): Promise<ReleaseAdmissionReply> {
    return this.releaseAdmission("authority", budgetMs);
  }
  async consumeReleaseProof(budgetMs: number): Promise<ReleaseAdmissionReply> {
    return this.releaseAdmission("proof", budgetMs);
  }
  private async releaseAdmission(role: "viewer" | "authority" | "proof", budgetMs: number, ip?: string): Promise<ReleaseAdmissionReply> {
    try {
      if (!pageReaderEnvironment(this.env) || !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_000) {
        const refusal = new ReleaseRateRefusal(503, 1, "malformed");
        reportReleaseRateRefusal(role, refusal); throw refusal;
      }
      await consumeReleaseRate(this.env, role, performance.now() + budgetMs, ip);
      return { status: 200 };
    } catch (error) {
      return { status: error instanceof ReleaseRateRefusal ? error.status : 503,
        retryAfterSeconds: error instanceof ReleaseRateRefusal ? error.retryAfterSeconds : 1 };
    }
  }
  async getReleaseDecision(selection: SelectorReceipt, pair: PublicReleasePair, path: string, budgetMs = 3_000, proof = false): Promise<PairServingDecision | { kind: "reselect" }> {
    const deadline = performance.now() + budgetMs;
    const environment = pageReaderEnvironment(this.env);
    if (this.env.PUBLIC_RELEASE_READERS_ENABLED !== "true" || !environment || !this.env.CMS_EDGE_ORIGIN_SECRET?.trim() ||
        !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_000 || typeof path !== "string" || path.length > 1024 ||
        pair?.environment !== environment || selection?.environment !== environment || typeof proof !== "boolean") throw new PublicContentRpcError("Release decision request was refused");
    await consumeReleaseRate(this.env, proof ? "proof" : "rpc", deadline);
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new PublicContentRpcError("Release decision is unavailable");
    const response = await fetch(`${this.env.FUNCTIONS_ORIGIN}/${PUBLIC_CONTENT_FUNCTION}`, {
      method: "POST", headers: publicDecisionHeaders(this.env.CMS_EDGE_ORIGIN_SECRET), redirect: "manual",
      body: JSON.stringify({ mode: "release-decision-v2", selection, pair, path }), signal: AbortSignal.timeout(remaining),
    });
    if (!response.ok) throw new PublicContentRpcError("Release decision is unavailable");
    const value = await boundedJson(response, 64 * 1024) as PairServingDecision | { kind: "reselect" };
    if (!value || !["decision", "reselect"].includes(value.kind) || value.kind === "decision" &&
        (value.pairId !== pair.pairId || value.path !== path || value.epoch !== selection.selector.epoch)) throw new PublicContentRpcError("Invalid release decision");
    return value;
  }

  /** Private experiment only; never reads the shared development selector. */
  async getRoutingMeasurementSelector(measurementId: string, budgetMs = 3_000): Promise<SelectorReceipt> {
    if (this.env.PUBLIC_RELEASE_ROUTING_MEASUREMENT_ENABLED !== "true" || pageReaderEnvironment(this.env) !== "development" ||
        !this.env.CMS_EDGE_ORIGIN_SECRET?.trim() || !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_000 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(measurementId)) throw new PublicContentRpcError("Routing measurement was refused");
    const response = await fetch(`${this.env.FUNCTIONS_ORIGIN}/${PUBLIC_CONTENT_FUNCTION}`, {
      method: "POST", headers: publicDecisionHeaders(this.env.CMS_EDGE_ORIGIN_SECRET), redirect: "manual",
      body: JSON.stringify({ mode: "release-routing-measurement-v2", measurementId }), signal: AbortSignal.timeout(budgetMs),
    });
    if (!response.ok) throw new PublicContentRpcError("Routing measurement is unavailable");
    return parseSelectorReceipt(await boundedJson(response, 32 * 1024), "development");
  }

  /** Private binding only. The default HTTP router exposes no selector mode. */
  async getReleaseSelector(budgetMs = 3_000, proof = false): Promise<SelectorReceipt> {
    const deadline = performance.now() + budgetMs;
    const environment = pageReaderEnvironment(this.env);
    if (this.env.PUBLIC_RELEASE_READERS_ENABLED !== "true" || !environment || !this.env.CMS_EDGE_ORIGIN_SECRET?.trim() ||
        !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_000 || typeof proof !== "boolean") throw new PublicContentRpcError("Release selector request was refused");
    await consumeReleaseRate(this.env, proof ? "proof" : "rpc", deadline);
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new PublicContentRpcError("Release selector is unavailable");
    const response = await fetch(`${this.env.FUNCTIONS_ORIGIN}/${PUBLIC_CONTENT_FUNCTION}`, {
      method: "POST", headers: publicDecisionHeaders(this.env.CMS_EDGE_ORIGIN_SECRET), redirect: "manual",
      body: JSON.stringify({ mode: "release-selector-v2" }), signal: AbortSignal.timeout(remaining),
    });
    if (!response.ok) throw new PublicContentRpcError("Release selector is unavailable");
    return parseSelectorReceipt(await boundedJson(response, 32 * 1024), environment);
  }

  async getNoBuildCodePost(path: string, rendererSha: string, method = "GET"): Promise<CodePostReply> {
    if (!pageReaderEnvironment(this.env) || !this.env.CMS_EDGE_ORIGIN_SECRET?.trim() ||
        typeof path !== "string" || path.length > 512 || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path) ||
        !/^[a-f0-9]{40}$/.test(rendererSha) || !["GET", "HEAD"].includes(method)) throw new PublicContentRpcError("Code Post request was refused");
    const response = await fetch(`${this.env.FUNCTIONS_ORIGIN}/${PUBLIC_CONTENT_FUNCTION}`, {
      method: "POST", headers: publicDecisionHeaders(this.env.CMS_EDGE_ORIGIN_SECRET), redirect: "manual",
      body: JSON.stringify({ mode: "no-build-code-post-v1", path, rendererSha, method }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new PublicContentRpcError("Code Post context is unavailable");
    const value = await boundedJson(response, 8 * 1024 * 1024) as CodePostReply;
    if (!value || !["pass", "code-post-unavailable", "code-post", "code-post-alias"].includes(value.kind) ||
        (value.kind === "code-post" || value.kind === "code-post-alias") &&
          (value.receipt?.rendererSha !== rendererSha || value.receipt.path !== path)) throw new PublicContentRpcError("Invalid code Post context");
    return value;
  }

  async getNoBuildPage(path: string, rendererSha: string, method = "GET", includeCacheLease = false): Promise<NoBuildPageReply> {
    if (!pageReaderEnvironment(this.env) || !this.env.CMS_EDGE_ORIGIN_SECRET?.trim() ||
        typeof path !== "string" || !path.startsWith("/") || path.length > 512 || /[%?#\\]/.test(path) ||
        !/^[a-f0-9]{40}$/.test(rendererSha) || !["GET", "HEAD"].includes(method)) {
      throw new PublicContentRpcError("Dev Page request was refused");
    }
    const response = await fetch(`${this.env.FUNCTIONS_ORIGIN}/${PUBLIC_CONTENT_FUNCTION}`, {
      method: "POST", headers: publicDecisionHeaders(this.env.CMS_EDGE_ORIGIN_SECRET),
      body: JSON.stringify({ mode: "no-build-page-v1", path, rendererSha, method }),
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new PublicContentRpcError("Public Page service is unavailable");
    const schedulePath = ["/_schedule-sources.json", "/schedule/downloads/nj-pbs-schedule.pdf"].includes(path);
    const value = await boundedJson(response, (schedulePath ? 24 : 8) * 1024 * 1024 + CONTENT_LINK_DIRECTORY_MAX_BYTES) as NoBuildPageReply;
    if (schedulePath) {
      if (value?.kind !== "schedule-export" || value.path !== path ||
          value.scheduleReceipt?.code.commitSha !== rendererSha || typeof value.bytes !== "string") {
        throw new PublicContentRpcError("Invalid Page schedule projection");
      }
    } else if (value?.kind === "schedule-unavailable") {
      if (value.path !== path || !["schedule", "live"].includes(value.pageId ?? "") || value.receipt || value.contextReceipt || value.bytes) {
        throw new PublicContentRpcError("Invalid Page schedule refusal");
      }
    } else if (!value || !["pass", "page", "alias", "gone", "home-sources", "context-page", "context-home-sources", "redirect"].includes(value.kind) ||
        value.kind !== "pass" && (value.receipt ?? value.contextReceipt)?.rendererSha !== rendererSha) throw new PublicContentRpcError("Invalid Page projection");
    delete value.decisionCacheUntil;
    const until = Number(response.headers.get("x-njpbs-public-decision-valid-until"));
    // The origin's existing cache owns the lifetime. Missing, expired or
    // implausible metadata cannot authorize an edge response-cache hit.
    const now = Date.now();
    if (includeCacheLease === true && Number.isSafeInteger(until) && until > now && until <= now + 65_000 &&
        !["schedule-export", "schedule-unavailable"].includes(value.kind) &&
        !["schedule", "live"].includes(value.receipt?.pageId ?? (value.renderContext as { pageId?: string })?.pageId ?? "")) {
      value.decisionCacheUntil = Math.min(until, now + 60_000);
    }
    return value;
  }

  async getNoBuildPost(path: string, rendererSha: string, method = "GET",
    probe?: { buildBatchId: string; versionId: string }): Promise<NoBuildPostReply> {
    const dev = this.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ||
      this.env.FIREBASE_PROJECT_ID === "njpbs-site-dev" ||
      this.env.FUNCTIONS_ORIGIN === "https://us-central1-njpbs-site-dev.cloudfunctions.net" ||
      this.env.ADMIN_ORIGIN === "https://dev-admin.example.org";
    const invalidEnvironment = this.env.CMS_DEPLOYMENT_ENVIRONMENT !== undefined &&
      !["production", "development"].includes(this.env.CMS_DEPLOYMENT_ENVIRONMENT);
    if (invalidEnvironment || dev && staffSiteEnvironment(this.env) !== "development") {
      throw new PublicContentRpcError("Dev API target was refused");
    }
    if (!this.env.CMS_EDGE_ORIGIN_SECRET?.trim() || !path.startsWith("/") || path.length > 512 ||
        !/^[a-f0-9]{40}$/.test(rendererSha) || !["GET", "HEAD"].includes(method)) {
      throw new PublicContentRpcError("Public content request was refused");
    }
    const response = await fetch(`${this.env.FUNCTIONS_ORIGIN}/${PUBLIC_CONTENT_FUNCTION}`, {
      method: "POST", headers: publicDecisionHeaders(this.env.CMS_EDGE_ORIGIN_SECRET),
      body: JSON.stringify({ mode: "no-build-post-v1", path, rendererSha, method, probe }),
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new PublicContentRpcError("Public content service is unavailable");
    const value = await boundedJson(response, 24 * 1024 * 1024) as NoBuildPostReply;
    if (!value || !["pass", "post", "alias", "gone", "receipts", "background", "baseline-probe", "static"].includes(value.kind)) {
      throw new PublicContentRpcError("Invalid projection");
    }
    if (["post", "alias", "gone", "receipts"].includes(value.kind) && value.receipt?.mode !== "static") {
      const catalogReceipt = value.kind === "receipts" && value.receipt === undefined;
      const catalog = value.catalog;
      const identity = catalogReceipt ? catalog : value.receipt;
      if (catalogReceipt && (!catalog || catalog.schemaVersion !== 1 ||
          !Number.isSafeInteger(catalog.generation) || catalog.generation < 1 ||
          !/^[a-f0-9]{64}$/.test(catalog.contextDigest) || !Array.isArray(catalog.posts))) {
        throw new PublicContentRpcError("Invalid admission receipt");
      }
      const revision = identity?.admissionRevision;
      const validRevision = Number.isSafeInteger(revision) && revision! > 0;
      // A missing or paused admission must not restore a withdrawn route.
      if ((!validRevision && !(value.kind === "gone" && revision === null)) ||
          identity?.rendererSha !== rendererSha) {
        throw new PublicContentRpcError("Invalid admission receipt");
      }
    }
    return value;
  }

  async getPublishedPage(pageId: string): Promise<PublicPageProjection> {
    return fetchPublicPageProjection(this.env, pageId);
  }
}

const PRODUCTION_ADMIN_ORIGIN = "https://admin.njpbs.org";
const SETTINGS_CONTRACT_HEADER = "x-njpbs-cms-settings-contract";
const SETTINGS_CONTRACT = "newsroom-milestone-v1";
const SETTINGS_CONTRACT_ENDPOINTS = new Set([
  "cmsGetNewsroomBanner",
  "cmsGetSettings",
  "cmsGetCoverageLabels",
  "cmsPublishSettings",
  "cmsSaveSettings",
]);
const ALLOWED_REQUEST_HEADERS =
  "authorization, content-type, if-match, x-firebase-appcheck";
const EXPOSED_RESPONSE_HEADERS =
  "etag, retry-after, x-njpbs-request-id, x-rate-limit-scope, x-njpbs-cms-settings-contract, x-njpbs-byline-runtime";

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function allowedOrigin(origin: string, allowLocalOrigins: boolean, adminOrigin = PRODUCTION_ADMIN_ORIGIN): boolean {
  if (adminOrigin === "https://dev-admin.example.org") {
    return origin === adminOrigin || /^https:\/\/(?:[a-z0-9-]+\.)?template-dev-admin\.pages\.dev$/.test(origin);
  }
  if (origin === PRODUCTION_ADMIN_ORIGIN) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (
    url.protocol === "https:" &&
    /^(?:[a-z0-9-]+\.)?njpbs-admin\.pages\.dev$/.test(url.hostname)
  ) {
    return true;
  }
  return (
    allowLocalOrigins &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.port.length > 0
  );
}

function corsHeaders(origin: string | null, allowLocalOrigins: boolean, adminOrigin?: string): Headers {
  const headers = new Headers({
    "access-control-allow-headers": ALLOWED_REQUEST_HEADERS,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-expose-headers": EXPOSED_RESPONSE_HEADERS,
    "access-control-max-age": "3600",
    vary: "Origin",
  });
  if (origin && allowedOrigin(origin, allowLocalOrigins, adminOrigin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

function withCors(
  response: Response,
  origin: string | null,
  allowLocalOrigins: boolean,
  adminOrigin?: string,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(origin, allowLocalOrigins, adminOrigin)) {
    headers.set(name, value);
  }
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 16_384) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function contentTypeAllowed(request: Request, type: "json" | "multipart") {
  const value = request.headers.get("content-type") ?? "";
  if (type === "json") {
    return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  }
  return /^multipart\/form-data\s*;.*\bboundary=(?:"[^"]+"|[^;\s]+)(?:;|$)/i.test(
    value,
  );
}

function declaredBodyError(
  request: Request,
  maxBytes: number,
): Response | null {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      return jsonResponse(400, { error: "Content-Length is invalid" });
    }
    if (declaredBytes > maxBytes) {
      return jsonResponse(413, { error: "Request body is too large" });
    }
  }
  return null;
}

async function boundedBody(
  request: Request,
  maxBytes: number,
  admitBytes?: (bytes: number) => Promise<Response | null>,
): Promise<ArrayBuffer | Response> {
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  let body = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > maxBytes - bytesRead) {
        await reader.cancel().catch(() => undefined);
        return jsonResponse(413, { error: "Request body is too large" });
      }
      const refused = await admitBytes?.(bytesRead + value.byteLength);
      if (refused) {
        await reader.cancel().catch(() => undefined);
        return refused;
      }
      if (body.byteLength < bytesRead + value.byteLength) {
        const expanded = new Uint8Array(Math.min(maxBytes,
          Math.max(body.byteLength * 2, bytesRead + value.byteLength)));
        expanded.set(body);
        body = expanded;
      }
      body.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } catch {
    return jsonResponse(400, { error: "Request body could not be read" });
  } finally {
    reader.releaseLock();
  }

  return body.buffer.slice(0, bytesRead);
}

async function hashedName(
  scope: "actor" | "ip",
  rateClass: RateClass,
  value: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${scope}\0${rateClass}\0${value}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const encoded = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `v1:${scope}:${rateClass}:${encoded}`;
}

async function consume(
  env: CmsApiEnv,
  scope: "actor" | "ip",
  rateClass: RateClass,
  value: string,
  nowMs: number,
  cost = 1,
): Promise<ConsumeResult> {
  const policy = RATE_POLICIES[rateClass][scope];
  const name = await hashedName(scope, rateClass, value);
  return env.RATE_LIMITERS.getByName(name).consume({
    ...policy,
    nowMs,
    cost,
  });
}

function sourcePosterCost(endpoint: string, body: ArrayBuffer): number {
  if (endpoint !== "cmsListSourceMedia" && endpoint !== "cmsPremiereRequest") return 0;
  try {
    let value = JSON.parse(new TextDecoder().decode(body));
    if (endpoint === "cmsPremiereRequest") {
      if (value?.operation !== "cmsListSourceMedia") return 0;
      value = value.payload;
    }
    if (value?.posters !== true) return 0;
    if (value.assetId !== undefined) return 1;
    // Match the Function's default and ceiling. Invalid limits are charged at
    // the ceiling; request validation remains with the Function.
    const limit = value.limit === undefined ? 30 : value.limit;
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 100;
  } catch {
    return 0;
  }
}

function isVideoSearchManifest(endpoint: string, body: ArrayBuffer): boolean {
  if (endpoint !== "cmsGetVideoSearchCorpus") return false;
  try {
    return JSON.parse(new TextDecoder().decode(body))?.action === "manifest";
  } catch {
    return false;
  }
}

// Only `liveBlogUpdate: true` selects the direct path in the Function; any
// other value is refused there before work starts.
function isLiveBlogUpdate(endpoint: string, body: ArrayBuffer): boolean {
  if (endpoint !== "cmsSaveContent") return false;
  try {
    return JSON.parse(new TextDecoder().decode(body))?.liveBlogUpdate === true;
  } catch {
    return false;
  }
}

function clientIp(request: Request): string | null {
  // Cloudflare writes this header at the edge. A missing value still shares
  // one restrictive bucket, but it is not forwarded as an audit address.
  return request.headers.get("cf-connecting-ip")?.trim() || null;
}

function logEvent(event: Record<string, unknown>) {
  console.log(JSON.stringify(event));
}

function scheduleAcceptedPreviewWake({ endpoint, status, headers, env, ctx, requestId, now }: {
  endpoint: string; status: number; headers: Headers; env: CmsApiEnv;
  ctx?: ExecutionContext; requestId: string; now: () => number;
}) {
  const wakeSha = headers.get("x-njpbs-preview-wake");
  const wakePair = headers.get("x-njpbs-preview-pair");
  headers.delete("x-njpbs-preview-wake");
  headers.delete("x-njpbs-preview-pair");
  if (endpoint === "cmsPreview" && status === 202 &&
      wakeSha && /^[a-f0-9]{40}$/.test(wakeSha) && ctx) {
    // Acceptance is already durable. Missing bindings, old targets and wake
    // failures leave this response intact; cron recovers the existing queue.
    try {
      ctx.waitUntil(Promise.resolve().then(async () => {
        const wakeStartedAt = now();
        if (wakePair !== null) await wakeAcceptedPreviewPair(env, wakePair, wakeSha, requestId);
        else {
          if (!env.PREVIEW_RENDERER) throw new Error("Wake binding unavailable");
          await env.PREVIEW_RENDERER.wake(wakeSha, requestId);
        }
        logEvent({ event: "cms_preview_wake_completed", requestId,
          rendererSha: wakeSha, durationMs: Math.max(0, now() - wakeStartedAt) });
      }).catch(() => {
        console.warn("CMS preview wake failed", { requestId });
      }));
    } catch {
      console.warn("CMS preview wake could not be scheduled", { requestId });
    }
  }
}

// The Admin's own registerStaffProfile call is only a hint (#4624). A client that skips it still
// reaches the same server decision and the same one-row-per-sign-in key. Each isolate asks once
// per sign-in; the row key absorbs requests from other isolates. An unfinished attempt waits out
// the retry delay, so an account that cannot be admitted cannot spend the admission Function.
const SIGN_IN_AUDIT_MEMORY = 1024;
const SIGN_IN_AUDIT_ENDPOINT = "registerStaffProfile";
const SIGN_IN_AUDIT_TIMEOUT_MS = 20_000;
const SIGN_IN_AUDIT_RETRY_MS = 60_000;

function scheduleSignInAudit({ nextAttempt, sessionKey, token, ip, env, ctx, fetchOrigin, requestId, now }: {
  nextAttempt: Map<string, number>; sessionKey: string; token: string; ip: string | null; env: CmsApiEnv;
  ctx: ExecutionContext; fetchOrigin: typeof fetch; requestId: string; now: () => number;
}) {
  if ((nextAttempt.get(sessionKey) ?? 0) > now()) return;
  if (nextAttempt.size >= SIGN_IN_AUDIT_MEMORY) nextAttempt.clear();
  nextAttempt.set(sessionKey, now() + SIGN_IN_AUDIT_RETRY_MS);
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-njpbs-cms-edge": env.CMS_EDGE_ORIGIN_SECRET!,
    "x-njpbs-request-id": requestId,
  });
  if (ip) headers.set("x-njpbs-client-ip", ip);
  ctx.waitUntil(fetchOrigin(`${env.FUNCTIONS_ORIGIN}/${SIGN_IN_AUDIT_ENDPOINT}`, {
    method: "POST", headers, body: "{}", redirect: "manual", signal: AbortSignal.timeout(SIGN_IN_AUDIT_TIMEOUT_MS),
  }).then(async response => {
    // Only a success or a named admission refusal has reached the audit writer. An unverified
    // address writes no row, and neither verification nor a token refresh changes auth_time.
    const reply = await response.json().catch(() => null) as { code?: unknown; auditPending?: unknown } | null;
    const refused = response.status === 403 && typeof reply?.code === "string" && reply.code !== "unverified_email";
    if (reply === null || (!response.ok && !refused) || reply.auditPending === true) {
      throw new Error("Sign-in audit incomplete");
    }
    nextAttempt.set(sessionKey, Number.POSITIVE_INFINITY);
  }).catch(() => {
    console.warn("CMS sign-in audit failed", { requestId });
  }));
}

export function createCmsApiHandler(deps: HandlerDependencies = {}) {
  const fetchOrigin = deps.fetchOrigin ?? fetch;
  const now = deps.now ?? Date.now;
  const randomUUID = deps.randomUUID ?? crypto.randomUUID.bind(crypto);
  const verifyToken = deps.verifyToken ?? verifyFirebaseIdToken;
  const signInAuditNextAttempt = new Map<string, number>();

  return {
    async fetch(request: Request, env: CmsApiEnv, ctx?: ExecutionContext): Promise<Response> {
      const isDev = env.CMS_DEPLOYMENT_ENVIRONMENT === "development" || env.FIREBASE_PROJECT_ID === "njpbs-site-dev";
      const startedAt = now();
      const requestId = randomUUID();
      const origin = request.headers.get("origin");
      const pathname = new URL(request.url).pathname;
      const readerVersion = cmsReaderVersion(pathname);
      const route = endpointPolicy(pathname) ?? (readerVersion && env.CMS_READER_BRIDGE_ENABLED === "true"
        ? { endpoint: `cmsReaderV${readerVersion}`, policy: READER_POLICY } : null) ??
        (pathname === `/${CONTENT_OPS_ENDPOINT}` ? { endpoint: CONTENT_OPS_ENDPOINT, policy: CONTENT_OPS_POLICY } : null);
      const allowLocalOrigins = !isDev && env.ALLOW_LOCAL_ORIGINS === "true";

      const respond = (response: Response, endpoint = "unknown") => {
        const headers = new Headers(response.headers);
        headers.set("x-njpbs-request-id", requestId);
        if (
          response.status === 401 &&
          SETTINGS_CONTRACT_ENDPOINTS.has(endpoint)
        ) {
          headers.set(SETTINGS_CONTRACT_HEADER, SETTINGS_CONTRACT);
        }
        const finalResponse = withCors(
          new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          }),
          origin,
          allowLocalOrigins,
          isDev ? "https://dev-admin.example.org" : env.ADMIN_ORIGIN,
        );
        logEvent({
          event: "cms_api_request",
          endpoint,
          requestId,
          status: finalResponse.status,
          durationMs: Math.max(0, now() - startedAt),
        });
        return finalResponse;
      };

      if (isDev &&
          (env.CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
           env.FIREBASE_PROJECT_ID !== "njpbs-site-dev" ||
           env.FUNCTIONS_ORIGIN !== "https://us-central1-njpbs-site-dev.cloudfunctions.net" ||
           env.ADMIN_ORIGIN !== "https://dev-admin.example.org" ||
           env.ALLOW_LOCAL_ORIGINS !== "false")) {
        return respond(jsonResponse(503, { error: "Dev API target was refused" }), route?.endpoint);
      }

      if (pathname === "/_internal/record-code") {
        return handlePrivateRecordCode(request, env);
      }
      if (pathname === LIVE_STREAM_PATH) {
        const streamResponse = (response: Response) => {
          logEvent({ event: "cms_live_stream_upgrade", requestId, status: response.status, durationMs: Math.max(0, now() - startedAt) });
          return response;
        };
        if (env.LIVE_PRODUCTION_STREAM_ENABLED !== "true" || !env.LIVE_PRODUCTION_RELAYS) return streamResponse(new Response(null, { status: 503 }));
        const binding = streamBinding(request);
        // Only the outbound native connector subscribes. Browser origins are refused.
        if (!binding || origin || request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return streamResponse(new Response(null, { status: 400 }));
        }
        try {
          const limit = await consume(env, "ip", "liveProductionConnect", clientIp(request) ?? "missing", startedAt);
          if (!limit.allowed) return streamResponse(new Response(null, { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } }));
          const token = bearerToken(request);
          if (!token) return streamResponse(new Response(null, { status: 401 }));
          let uid: string;
          try { ({ uid } = await verifyToken(token, env.FIREBASE_PROJECT_ID)); }
          catch (error) {
            return streamResponse(new Response(null, { status: error instanceof FirebaseTokenError ? 401 : 503 }));
          }
          const actorLimit = await consume(env, "actor", "liveProductionConnect", uid, startedAt);
          if (!actorLimit.allowed) return streamResponse(new Response(null, { status: 429, headers: { "retry-after": String(actorLimit.retryAfterSeconds) } }));
          return streamResponse(await env.LIVE_PRODUCTION_RELAYS.getByName(binding.deviceId).fetch(request));
        } catch { return streamResponse(new Response(null, { status: 503 })); }
      }
      if (pathname === "/health") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return respond(
            jsonResponse(405, { error: "Method not allowed" }, { allow: "GET, HEAD" }),
            "health",
          );
        }
        return respond(
          request.method === "HEAD"
            ? new Response(null, { status: 200 })
            : jsonResponse(200, { ok: true, service: "njpbs-cms-api" }),
          "health",
        );
      }
      if (!route) {
        return respond(jsonResponse(404, { error: "Endpoint not found" }));
      }
      if (origin && !allowedOrigin(origin, allowLocalOrigins, env.ADMIN_ORIGIN)) {
        return respond(
          jsonResponse(403, { error: "Origin is not allowed" }),
          route.endpoint,
        );
      }
      if (route.endpoint === "cmsSubmitBugReport" &&
          (isDev || env.CMS_DEV_REPORT_INTAKE_MODE !== undefined ||
            new URL(request.url).hostname === "dev-api.example.org" ||
            env.FUNCTIONS_ORIGIN === "https://us-central1-njpbs-site-dev.cloudfunctions.net" ||
            env.ADMIN_ORIGIN === "https://dev-admin.example.org") &&
          (env.CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
            env.FIREBASE_PROJECT_ID !== "njpbs-site-dev" ||
            env.FUNCTIONS_ORIGIN !== "https://us-central1-njpbs-site-dev.cloudfunctions.net" ||
            env.ADMIN_ORIGIN !== "https://dev-admin.example.org" ||
            env.ALLOW_LOCAL_ORIGINS !== "false" ||
            env.CMS_DEV_REPORT_INTAKE_MODE !== "stored-only")) {
        return respond(jsonResponse(503, { error: "Dev report intake is not configured" }), route.endpoint);
      }
      if (request.method === "OPTIONS") {
        return respond(new Response(null, { status: 204 }), route.endpoint);
      }
      // DEV_API_ENDPOINTS lists deployed dev Functions. The content API route is not a Function;
      // it calls dev Functions with the caller's token.
      if (env.FIREBASE_PROJECT_ID === "njpbs-site-dev" && !readerVersion && !DEV_API_ENDPOINTS.has(route.endpoint) &&
          route.endpoint !== CONTENT_OPS_ENDPOINT) {
        return respond(jsonResponse(404, { error: "Endpoint not found" }), route.endpoint);
      }
      if (request.method !== "POST") {
        return respond(
          jsonResponse(405, { error: "Method not allowed" }, { allow: "POST, OPTIONS" }),
          route.endpoint,
        );
      }

      const encoding = request.headers.get("content-encoding");
      if (encoding && encoding.toLowerCase() !== "identity") {
        return respond(
          jsonResponse(415, { error: "Compressed request bodies are not allowed" }),
          route.endpoint,
        );
      }
      if (!contentTypeAllowed(request, route.policy.contentType)) {
        return respond(
          jsonResponse(415, { error: "Content-Type is not allowed" }),
          route.endpoint,
        );
      }
      const declaredError = declaredBodyError(request, route.policy.maxBytes);
      if (declaredError) return respond(declaredError, route.endpoint);

      const checkLimit = async (
        scope: "ip" | "actor", value: string,
        rateClass: RateClass = route.policy.rateClass, cost = 1,
      ): Promise<ConsumeResult | Response> => {
        try {
          return await consume(env, scope, rateClass, value, now(), cost);
        } catch {
          console.error("CMS rate limit service failed", { requestId, endpoint: route.endpoint, scope });
          return respond(
            jsonResponse(503, { error: "Request limit service is unavailable. Try again later." }),
            route.endpoint,
          );
        }
      };
      const ip = clientIp(request);
      const ipLimit = await checkLimit("ip", ip ?? "missing");
      if (ipLimit instanceof Response) return ipLimit;
      if (!ipLimit.allowed) {
        return respond(
          jsonResponse(
            429,
            { error: "Too many requests. Try again later." },
            {
              "retry-after": String(ipLimit.retryAfterSeconds),
              "x-rate-limit-scope": "ip",
            },
          ),
          route.endpoint,
        );
      }

      const anonymous = route.policy.auth === "anonymous";
      const worker = route.policy.auth === "worker";
      const desktopPairing = route.policy.auth === "desktop-pairing";
      const desktop = route.policy.auth === "desktop";
      const token = bearerToken(request);
      let uid: string | null = null;
      let authTime: number | undefined;
      let deviceIdentity: true | undefined;
      if (worker) {
        if (!token || !/^[A-Za-z0-9]{48}$/.test(token)) {
          return respond(
            jsonResponse(401, { error: "Worker authentication required" }),
            route.endpoint,
          );
        }
      } else if (desktop) {
        // Session authenticity and fresh staff permissions are checked in the
        // dedicated Function. No desktop principal is trusted from HTTP headers.
        if (!token || !/^pds_[A-Za-z0-9_-]{43}$/.test(token)) {
          return respond(jsonResponse(401, { error: "Premiere sign-in required" }), route.endpoint);
        }
      } else if (!anonymous && !desktopPairing) {
        if (!token) {
          return respond(
            jsonResponse(401, { error: "Missing or invalid authorization header", code: "session_expired" }),
            route.endpoint,
          );
        }
        try {
          ({ uid, authTime, deviceIdentity } = await verifyToken(token, env.FIREBASE_PROJECT_ID));
        } catch (error) {
          if (error instanceof FirebaseTokenError) {
            return respond(
              jsonResponse(401, { error: error.message, code: "session_expired",
                ...(error.reason === "token_expired" ? { reason: error.reason } : {}) }),
              route.endpoint,
            );
          }
          console.error("Firebase token verification failed", { requestId, error });
          return respond(
            jsonResponse(503, { error: "Authentication service is unavailable" }),
            route.endpoint,
          );
        }

        const actorLimit = await checkLimit("actor", uid);
        if (actorLimit instanceof Response) return actorLimit;
        if (!actorLimit.allowed) {
          return respond(
            jsonResponse(
              429,
              { error: "Too many requests. Try again later." },
              {
                "retry-after": String(actorLimit.retryAfterSeconds),
                "x-rate-limit-scope": "actor",
              },
            ),
            route.endpoint,
          );
        }
      } else if (
        anonymous &&
        !request.headers.get("x-firebase-appcheck")?.trim()
      ) {
        return respond(
          jsonResponse(401, { error: "Missing App Check token" }),
          route.endpoint,
        );
      }

      if (!env.CMS_EDGE_ORIGIN_SECRET?.trim()) {
        console.error("CMS edge origin secret is missing", { requestId });
        return respond(
          jsonResponse(503, { error: "CMS API edge is not configured" }),
          route.endpoint,
        );
      }

      // Initial actor/IP admission already paid for the first 2 MiB. Charge actual
      // received bytes before retaining them, even without a Content-Length.
      let imageUnits = 1;
      const admitImageBytes = route.policy.rateClass === "imageUpload"
        ? async (bytes: number): Promise<Response | null> => {
          const units = Math.max(1, Math.ceil(bytes / (2 * 1024 * 1024)));
          const cost = units - imageUnits;
          if (cost <= 0) return null;
          for (const scope of ["actor", "ip"] as const) {
            const limit = await checkLimit(scope, scope === "actor" ? uid! : ip ?? "missing", "imageUpload", cost);
            if (limit instanceof Response) return limit;
            if (!limit.allowed) {
              // A streamed refusal already spent some units. Let a retry rebuild
              // enough allowance for a whole maximum-size upload, rather than
              // repeatedly consuming its partial budget and never finishing.
              const wholeUpload = Math.ceil(route.policy.maxBytes / (2 * 1024 * 1024));
              const retryAfterSeconds = Math.max(limit.retryAfterSeconds,
                Math.ceil((wholeUpload - limit.remaining) / RATE_POLICIES.imageUpload[scope].refillPerSecond));
              return jsonResponse(429, { error: "Too many image upload bytes. Try again later." }, {
                "retry-after": String(retryAfterSeconds), "x-rate-limit-scope": scope,
              });
            }
          }
          imageUnits = units;
          return null;
        } : undefined;
      let body = await boundedBody(request, route.policy.maxBytes, admitImageBytes);
      if (body instanceof Response) return respond(body, route.endpoint);

      // A client's own admission call can fail before it reaches the audit writer, so it never
      // stands in for this check. A studio connector is not a person signing in.
      if (uid && authTime !== undefined && !deviceIdentity && ctx && route.endpoint !== SIGN_IN_AUDIT_ENDPOINT) {
        scheduleSignInAudit({ nextAttempt: signInAuditNextAttempt, sessionKey: `${uid}:${authTime}`, token: token!,
          ip, env, ctx, fetchOrigin, requestId, now });
      }

      if (readerVersion) {
        const result = await dispatchCmsReaderMount({ request, body, version: readerVersion, env,
          context: { requestId, clientIp: ip }, fetchOrigin, verifyToken,
          checkRate: async rateClass => {
            for (const scope of ["actor", "ip"] as const) {
              const limited = await checkLimit(scope, scope === "actor" ? uid! : ip ?? "missing", rateClass);
              if (limited instanceof Response) return limited;
              if (!limited.allowed) return jsonResponse(429, { error: "Too many requests. Try again later." }, {
                "retry-after": String(limited.retryAfterSeconds), "x-rate-limit-scope": scope,
              });
            }
            return null;
          } });
        const headers = new Headers(result.headers);
        // The bridge forwards this header only for a parsed cmsPreview request.
        scheduleAcceptedPreviewWake({ endpoint: headers.has("x-njpbs-preview-wake") ? "cmsPreview" : "",
          status: result.status, headers, env, ctx, requestId, now });
        return respond(new Response(result.body, { status: result.status, headers }), route.endpoint);
      }

      if (isVideoSearchManifest(route.endpoint, body)) {
        // Refused actors do not spend the shared newsroom scan budget.
        for (const scope of ["actor", "ip"] as const) {
          const value = scope === "ip" ? (ip ?? "missing") : (uid ?? "missing");
          const limit = await checkLimit(scope, value, "videoSearchManifest");
          if (limit instanceof Response) return limit;
          if (!limit.allowed) {
            return respond(jsonResponse(429, { error: "Too many search refreshes. Try again later." }, {
              "retry-after": String(limit.retryAfterSeconds),
              "x-rate-limit-scope": scope,
            }), route.endpoint);
          }
        }
      }

      if (isLiveBlogUpdate(route.endpoint, body)) {
        // Charged in addition to the mutation budget. Refused actors do not
        // spend the shared IP budget.
        for (const scope of ["actor", "ip"] as const) {
          const value = scope === "ip" ? (ip ?? "missing") : (uid ?? "missing");
          const limit = await checkLimit(scope, value, "liveBlogUpdate");
          if (limit instanceof Response) return limit;
          if (!limit.allowed) {
            return respond(jsonResponse(429, {
              error: "Too many live updates were published in a short time. Wait a few seconds, then publish again.",
            }, {
              "retry-after": String(limit.retryAfterSeconds),
              "x-rate-limit-scope": scope,
            }), route.endpoint);
          }
        }
      }

      if (route.endpoint === CONTENT_OPS_ENDPOINT && isContentOpsPublish(body)) {
        // A publish through the content API spends the same budget as a publish from Boardwalk.
        for (const scope of ["actor", "ip"] as const) {
          const limit = await checkLimit(scope, scope === "ip" ? (ip ?? "missing") : (uid ?? "missing"), "publish");
          if (limit instanceof Response) return limit;
          if (!limit.allowed) {
            return respond(jsonResponse(429, { error: "Too many requests. Try again later." }, {
              "retry-after": String(limit.retryAfterSeconds),
              "x-rate-limit-scope": scope,
            }), route.endpoint);
          }
        }
      }

      const posterCost = sourcePosterCost(route.endpoint, body);
      if (posterCost > 0) {
        // Refused actors do not spend the shared IP poster budget. Desktop
        // sessions use their opaque token's hash; the Function verifies admission.
        for (const scope of ["actor", "ip"] as const) {
          const value = scope === "ip" ? (ip ?? "missing") : (uid ?? token ?? "missing");
          const limit = await checkLimit(scope, value, "sourcePosters", posterCost);
          if (limit instanceof Response) return limit;
          if (!limit.allowed) {
            // Keep the list available through the existing tile fallback.
            // A positive cost already proved this is a parsed poster request.
            const plainList = JSON.parse(new TextDecoder().decode(body));
            const payload = route.endpoint === "cmsPremiereRequest" ? plainList.payload : plainList;
            delete payload.posters;
            body = new TextEncoder().encode(JSON.stringify(plainList)).buffer;
            break;
          }
        }
      }

      if (route.endpoint === "cmsListBylineAuthors" &&
          env.CMS_BYLINE_EDGE_ENABLED === "true") {
        if (token && uid && authTime !== undefined && env.FIREBASE_WEB_API_KEY) {
          let stage = "request";
          try {
            const result = await readBylineDirectory({
              token,
              uid,
              authTime,
              apiKey: env.FIREBASE_WEB_API_KEY,
              projectId: env.FIREBASE_PROJECT_ID,
              body,
              fetcher: fetchOrigin,
              onStage: current => { stage = current; },
            });
            return respond(jsonResponse(200, { ...result }, {
              "x-njpbs-byline-runtime": "cloudflare",
            }), route.endpoint);
          } catch (error) {
            console.warn("CMS byline edge read failed", { requestId, stage, reason: bylineFailureReason(error) });
          }
        } else {
          console.warn("CMS byline edge read is not configured", { requestId });
        }
      }

      const forwardHeaders = new Headers({
        "content-type": request.headers.get("content-type")!,
        "x-njpbs-cms-edge": env.CMS_EDGE_ORIGIN_SECRET,
        "x-njpbs-request-id": requestId,
      });
      if (token) forwardHeaders.set("authorization", `Bearer ${token}`);
      if (ip) forwardHeaders.set("x-njpbs-client-ip", ip);
      if (route.endpoint === CONTENT_OPS_ENDPOINT) {
        // Each nested video copy spends the lifecycle budget a direct copy request spends.
        const chargeVideoCopy = async (): Promise<Response | null> => {
          for (const scope of ["actor", "ip"] as const) {
            let limit: ConsumeResult;
            try {
              // Copies run long, so each charge uses the current time, not the request start.
              limit = await consume(env, scope, "lifecycle", scope === "ip" ? (ip ?? "missing") : uid!, now());
            } catch {
              console.error("CMS rate limit service failed", { requestId, endpoint: route.endpoint, scope });
              return jsonResponse(503, { error: "Request limit service is unavailable. Try again later." });
            }
            if (!limit.allowed) {
              return jsonResponse(429, { error: "Too many video copies in a short time. Try again later." }, {
                "retry-after": String(limit.retryAfterSeconds),
                "x-rate-limit-scope": scope,
              });
            }
          }
          return null;
        };
        return respond(await handleContentOps({ body, token: token!, uid: uid!, projectId: env.FIREBASE_PROJECT_ID,
          functionsOrigin: env.FUNCTIONS_ORIGIN, forwardHeaders, fetcher: (input, init) => fetchOrigin(input, init), now, randomUUID, chargeVideoCopy }),
        route.endpoint);
      }
      const ifMatch = request.headers.get("if-match");
      if (ifMatch) forwardHeaders.set("if-match", ifMatch);
      const appCheck = request.headers.get("x-firebase-appcheck");
      if (appCheck) forwardHeaders.set("x-firebase-appcheck", appCheck);

      // Only opted-in addressed status waits receive the longer origin budget.
      // The Function keeps its own five-second bound if disconnect propagation fails.
      let statusWait = false;
      if (route.endpoint === "cmsPreviewStatus") {
        try {
          const statusBody = JSON.parse(new TextDecoder().decode(body));
          statusWait = statusBody.pageId === undefined && typeof statusBody.queueId === "string" &&
            Number.isInteger(statusBody.waitMs) && statusBody.waitMs > 0 && statusBody.waitMs <= 5000 &&
            ["pending", "building"].includes(statusBody.observedStatus);
        } catch { /* Body validation stays with the Function. */ }
      }
      let upstream: Response;
      try {
        upstream = await fetchOrigin(
          `${env.FUNCTIONS_ORIGIN}/${route.endpoint}`,
          {
            method: "POST",
            headers: forwardHeaders,
            body,
            redirect: "manual",
            ...(statusWait ? { signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) } : {}),
          },
        );
      } catch (error) {
        console.error("CMS Function request failed", { requestId, error });
        return respond(
          jsonResponse(502, { error: "CMS service is unavailable" }),
          route.endpoint,
        );
      }

      const responseHeaders = new Headers(upstream.headers);
      if (route.endpoint === "cmsLiveProduction" && upstream.ok && isLiveCommandRequest(body) &&
          env.LIVE_PRODUCTION_STREAM_ENABLED === "true" &&
          env.LIVE_PRODUCTION_RELAYS && ctx) {
        // Admission is already durable. A missed wake is recovered by the same one-second journal scan.
        const relay = env.LIVE_PRODUCTION_RELAYS;
        ctx.waitUntil(readLiveReply(upstream.clone())
          .then(async result => {
            const command = result.command ? parseLiveCommand(result.command) : undefined;
            if (command) await relay.getByName(command.deviceId).notify({ sessionId: command.sessionId, deviceId: command.deviceId,
              sessionGeneration: command.sessionGeneration, mappingVersion: command.mappingVersion });
          }).catch(() => { console.warn("Live production wake unavailable", { requestId }); }));
      }
      scheduleAcceptedPreviewWake({ endpoint: route.endpoint, status: upstream.status,
        headers: responseHeaders, env, ctx, requestId, now });
      for (const name of [...responseHeaders.keys()]) {
        if (name.toLowerCase().startsWith("access-control-")) {
          responseHeaders.delete(name);
        }
      }
      return respond(
        new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        }),
        route.endpoint,
      );
    },
  };
}

export default createCmsApiHandler();
