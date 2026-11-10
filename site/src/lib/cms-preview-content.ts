import { readFile } from "node:fs/promises";
import {
  decodeCmsPreviewInput, resolveCmsPreviewInput, type CmsPreviewInputRequest,
} from "./cms-preview-input.ts";
import { projectCmsPage, type CmsPageBuildData } from "./cms-loader.ts";
import {
  assertPostRouteUniqueness, projectCmsPost, type CmsPostBuildData,
} from "./cms-posts-loader.ts";
import type { CmsEventBuildData } from "./cms-events-loader";
import { projectCmsEvent, assertEventRouteUniqueness } from "./cms-events-loader.ts";
import type { CmsProgramBuildData } from "./cms-programs-loader";
import { projectCmsProgram, assertProgramRouteUniqueness } from "./cms-programs-loader.ts";
import type { RecordCardPayload } from "./record-card-resolution";
import { withAuthorPortraitDisplay } from "./author-portrait-display.ts";
import type { CmsAuthorBuildData } from "./cms-authors-loader";
import type { PublicSettingBuildData } from "./public-artifact-bundle";
import type { PublicArtifactInventoryReceipt } from "./public-artifact-inventory";

/** Deliberately not a PublicArtifactBundle: a draft overlay must never be
 * accepted by the publication transport as an activated public generation.
 */
export interface CmsPreviewContent {
  contentLinks?: readonly import("./content-link-render").ContentLinkEntry[];
  readonly kind: "private-preview";
  readonly target: Readonly<{
    collection: "cmsPages" | "cmsPosts";
    documentId: string;
    sourceVersion: number;
    queueId: string;
    rendererSha: string;
    inputSha256: string;
    pagePath: string;
    persistent: boolean;
    expiresAtMs: number;
  }>;
  readonly pages: readonly CmsPageBuildData[];
  readonly posts: readonly CmsPostBuildData[];
  readonly programs: readonly CmsProgramBuildData[];
  readonly recordCards: readonly RecordCardPayload[];
  readonly events?: readonly CmsEventBuildData[];
  readonly authors: readonly CmsAuthorBuildData[];
  readonly settings: readonly PublicSettingBuildData[];
  readonly publicContextReceipt: PublicArtifactInventoryReceipt;
  readonly dataHubSources?:import("../../../packages/content-core/src/data-hub-reporting-sources.ts").DataHubSources;
  readonly homeSources?: import("../../../packages/content-core/src/home-rail-render").HomeSourceSnapshot;
  /** Fresh public Page dependencies for Home pins; never additional render targets. */
  readonly homeHeroPages?: readonly CmsPageBuildData[];
}

/** These values come from JSON and projections, not Maps, SDK objects or
 * credential-bearing clients. Protect nested data shared by concurrent loaders.
 */
function freezeContent<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeContent(child);
    Object.freeze(value);
  }
  return value;
}

/** Stateless projection for one content operation. Existing Page/Post
 * projectors remain the owners of schema, media and presentation validation.
 */
export function projectCmsPreviewContent(
  bytes: Uint8Array, request: CmsPreviewInputRequest, now: Date,
): CmsPreviewContent {
  const input = decodeCmsPreviewInput(bytes, request, now);
  const collection = request.collection ?? "cmsPages";
  const assets = new Map(input.assets.map(asset => [asset.id, { ...asset }]));
  let pages = input.publicContext.pages;
  let posts = input.publicContext.posts;
  let programs = input.publicContext.programs;
  let events = input.publicContext.events ?? [];
  let pagePath: string;
  if (collection === "cmsPosts") {
    const published = input.page.published;
    const metadata = published && typeof published === "object" && "metadata" in published &&
      published.metadata && typeof published.metadata === "object" ? published.metadata : null;
    const kind = metadata && "type" in metadata ? metadata.type : null;
    const publishedAt = published && typeof published === "object" && "publishedAt" in published
      ? published.publishedAt : undefined;
    if (kind === "program") {
      const program = projectCmsProgram({ id: input.page.id, status: "published", published,
        publishAt: publishedAt,
      }, { now, assets });
      if (!program || program.sourceVersion !== input.page.version) throw new Error("Private preview program could not be projected");
      programs = [...programs.filter(related => related.programId !== program.programId), program];
      assertProgramRouteUniqueness(programs);
      pagePath = program.path;
    } else if (kind === "event") {
      const event = projectCmsEvent({ id: input.page.id, status: "published", published,
        publishAt: publishedAt,
      }, { now, assets });
      if (!event || event.sourceVersion !== input.page.version) throw new Error("Private preview event could not be projected");
      events = [...events.filter(related => related.eventId !== event.eventId), event];
      assertEventRouteUniqueness(events);
      pagePath = event.path;
    } else {
      const post = projectCmsPost({
        id: input.page.id, status: "published", published,
        publishAt: publishedAt,
      }, { now, assets, complete: false });
      if (!post) throw new Error("Private preview post could not be projected");
      if (post.sourceVersion !== input.page.version) {
        throw new Error("Private preview projected version does not match the saved input");
      }
      post.noindex = true;
      posts = [...posts.filter(related => related.postId !== post.postId), post];
      assertPostRouteUniqueness(posts);
      pagePath = post.path;
    }
  } else {
    const page = projectCmsPage(input.page, {
      mode: "draft", pageId: request.pageId, now, assets,
    });
    if (!page) throw new Error("Private preview page could not be projected");
    if (page.sourceVersion !== input.page.version) {
      throw new Error("Private preview projected version does not match the saved input");
    }
    pages = [...pages.filter(related => related.pageId !== page.pageId), page];
    pagePath = page.path;
  }
  return freezeContent({
    kind: "private-preview",
    target: {
      collection, documentId: request.pageId, sourceVersion: Number(input.page.version),
      queueId: request.queueId, rendererSha: request.rendererSha,
      inputSha256: request.sha256, pagePath, persistent: request.persistent === true,
      expiresAtMs: input.expiresAtMs,
    },
    pages, posts, programs,
    ...(input.homeHeroPages === undefined ? {} : { homeHeroPages: input.homeHeroPages }),
    ...(input.dataHubSources ? {dataHubSources:input.dataHubSources} : {}),
    recordCards: [
      ...(input.publicContext.recordCards ?? []).filter(card =>
        !((card.kind === "sponsor" || card.kind === "newsletter") && input.draftLibraryCards?.recordIds.includes(card.id))),
      ...(input.draftLibraryCards?.cards ?? []),
    ],
    ...(input.publicContext.events !== undefined || events.length ? { events } : {}),
    authors: input.publicContext.authors.map(author => withAuthorPortraitDisplay(author)),
    settings: input.publicContext.settings,
    publicContextReceipt: input.publicContext.receipt,
    ...(input.publicContext.homeSources === undefined ? {} : { homeSources: input.publicContext.homeSources }),
  });
}

export interface CmsPreviewContentSource {
  readonly request: Readonly<CmsPreviewInputRequest>;
  load(): Promise<CmsPreviewContent>;
}

/** One source belongs to one build/render operation. No module-wide cache,
 * environment mutation, database fallback, or sharing between different jobs.
 * Rejected reads stay rejected for that operation; a retry owns a new source.
 */
export function createCmsPreviewContentSource(
  request: CmsPreviewInputRequest | null = resolveCmsPreviewInput(),
  dependencies: {
    read?: (file: string) => Promise<Uint8Array>;
    now?: () => Date;
  } = {},
): CmsPreviewContentSource | null {
  if (!request) return null;
  const identity = Object.freeze({ ...request });
  const read = dependencies.read ?? (file => readFile(file));
  const now = dependencies.now ?? (() => new Date());
  let pending: Promise<CmsPreviewContent> | undefined;
  return Object.freeze({
    request: identity,
    async load() {
      // Capture ownership before I/O (including synchronous injected failures).
      pending ??= Promise.resolve().then(async () =>
        projectCmsPreviewContent(await read(identity.path), identity, now()));
      const content = await pending;
      const instant = now().getTime();
      if (!Number.isFinite(instant) || content.target.expiresAtMs <= instant) {
        throw new Error("Private preview content expiry is invalid or expired");
      }
      return content;
    },
  });
}
