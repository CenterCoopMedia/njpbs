import type { CollectionEntry } from "astro:content";
import { withAuthorPortraitDisplay } from "./author-portrait-display.ts";
import type { PublishedPostContent } from "./published-post-shadow";
import type { PublishedRecordContent } from "./published-record-render";
import type { PublishedPageContent } from "./published-page-render";
import type { PublicPageContextContent } from "./public-page-context-render";
import type { CmsPreviewContent } from "./cms-preview-content";
import type { HomeSourceSnapshot } from "./home-sources";
import type { RecordCardPayload } from "./record-card-resolution";
import type { PageScheduleInputs } from "./page-schedule-packet";
import type { RenderBlockOptions } from "../../../packages/content-core/src/content-render.ts";
import type { PairAuthorContent } from "../../scripts/public-release-pair-author";
import {
  createDatasetFigureResolver,
  type DatasetFigures,
} from "../../../packages/content-core/src/dataset-figures.ts";

/** Internal template inputs. Admission and byte validation stay in the processor. */
export interface CmsRenderContext {
  content: CmsPreviewContent | PublishedPostContent | PublishedPageContent | PublicPageContextContent | PublishedRecordContent | PairAuthorContent;
  homeSources: HomeSourceSnapshot;
  /** Validated only by the sealed private pair's static alias entry. */
  staticRedirect?: Readonly<{ from: string; to: string }>;
}

/**
 * A private draft preview. Posts carry no content mode: the compiled preview renderer
 * marks one in its render context, and the build-based preview sets CMS_CONTENT_MODE.
 */
export function isPrivatePreviewRender(context: CmsRenderContext | undefined): boolean {
  if (context) return context.content.kind === "private-preview";
  return typeof process !== "undefined" && (process.env.CMS_CONTENT_MODE ?? "").trim().toLowerCase() === "draft";
}

export function renderPage(context: CmsRenderContext, id: string | null): CollectionEntry<"cmsPages"> | undefined {
  if (id === null) return undefined;
  const data = context.content.pages.find(page => page.pageId === id);
  if (!data) return undefined;
  const { template } = data;
  if (template !== "home" && template !== "programLanding" && template !== "genericPage") {
    throw new Error("Compiled renderer Page template is invalid");
  }
  return { id, collection: "cmsPages", data: {
    ...data, template,
    seo: data.seo ? { ...data.seo } : undefined,
    social: data.social ? { ...data.social } : undefined,
  } };
}

/** Compiled Post routes read the projected cards. A full build keeps the collection. */
export function renderRecordCards(
  context: CmsRenderContext | undefined,
  collected: readonly RecordCardPayload[],
): readonly RecordCardPayload[] {
  return context ? context.content.recordCards : collected;
}

/** Bind a block renderer to the immutable dataset projections on its Page or Post. */
export function renderDatasetFigures(
  figures: DatasetFigures | undefined,
): NonNullable<RenderBlockOptions["resolveDataFigure"]> {
  return createDatasetFigureResolver(figures);
}

export function renderAuthors(context: CmsRenderContext): CollectionEntry<"cmsAuthorsPublic">[] {
  return context.content.authors.map(data => ({
    id: data.authorId,
    collection: "cmsAuthorsPublic",
    data: withAuthorPortraitDisplay(data),
  }));
}

/** Page processors supply the qualified Schedule packet. Full builds retain
 * their normal loader when no packet is in the render context. */
export function renderSchedule(context: CmsRenderContext | undefined): PageScheduleInputs | undefined {
  return context && "schedule" in context.content ? context.content.schedule : undefined;
}
