import { createApp } from "astro/app/entrypoint";
import { recordPaths, type PublishedRecordContent } from "../src/lib/published-record-render";
import { assertProgramImageCatalog, verifyProgramImageCatalog, ProgramImagePreparationError } from "../src/lib/published-record-images";
import { projectPageScheduleInputs } from "../src/lib/published-page-render";
import type { PublishedPageContent } from "../src/lib/published-page-render";
import type { PublishedPostContent } from "../src/lib/published-post-shadow";
import type { PublicPageContextContent } from "../src/lib/public-page-context-render";
import type { HomeSourceSnapshot } from "../src/lib/home-sources";
import { isPublicPagePath, publicPage } from "../../packages/content-core/src/public-pages";
import { assertPublishedResources } from "../src/lib/published-resource-check";
import { renderPublishedPost as renderPostContent } from "./compiled-post-shadow-entry";

declare const __CMS_RENDERER_SHA__: string;
declare const __CMS_DATA_HUB_PUBLIC__: boolean;
export const rendererSha = __CMS_RENDERER_SHA__;
const app = createApp({ streaming: false });
// The compiler seals this deployment setting; CMS content cannot select it.
const resourceOrigin = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ? "https://dev-public.example.org" : "https://njpbs.org";
const emptySources: HomeSourceSnapshot = { schemaVersion: 1, publication: null, heroCatalog: [],
  pbs: { source: "manual", checkedAt: null, featured: [], more: [] },
  spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } };

function admitPublicHtml(html: string, path: string): string {
  try { assertPublishedResources(html, path, resourceOrigin); }
  catch (error) {
    // Serving callers can fall back on a render failure. Keep this sanitized
    // host diagnostic visible before their catch discards the error.
    if (error instanceof Error && error.message.startsWith("Published resource check failed: ")) console.error(error.message);
    throw error;
  }
  return html;
}

async function renderPageContent(content: PublishedPageContent | PublicPageContextContent | PublishedRecordContent): Promise<string> {
  if (content.target.documentId === "data-hub" && !__CMS_DATA_HUB_PUBLIC__) throw new Error("The Data Hub publication gate is closed");
  const request = new Request(new URL(content.target.pagePath, "https://njpbs.org"));
  if (new URL(request.url).pathname !== content.target.pagePath) throw new Error("Invalid published Page route");
  const response = await app.render(request, { locals: { cmsRender: {
    content, homeSources: content.homeSources ?? emptySources,
  } } });
  if (response.status !== 200) throw new Error("Published Page rendering failed");
  const html = await response.text();
  return admitPublicHtml(html, content.target.pagePath);
}

/** The public entry checks completed Post HTML; the staff shadow stays inspectable. */
export async function renderPublishedPost(content: PublishedPostContent): Promise<string> {
  const html = await renderPostContent(content);
  return admitPublicHtml(html, content.target.pagePath);
}

/** A committed frame carries public-context identity, never an editorial op. */
export async function renderPublicPageContext(content: PublicPageContextContent): Promise<string> {
  const target = content.target;
  const page = content.pages[0];
  if (content.kind !== "public-page-context" || target.rendererSha !== rendererSha ||
      !isPublicPagePath(target.documentId, target.pagePath) ||
      !Number.isSafeInteger(target.contextRevision) || target.contextRevision < 1 ||
      !Number.isSafeInteger(target.codeGeneration) || target.codeGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(target.contextDigest) ||
      (target.source === "site" ? content.pages.length !== 0 || target.sourceVersion !== undefined || target.documentId.startsWith("page-") ||
        (target.pagePath !== publicPage(target.documentId)!.path && !(target.documentId === "give" && target.pagePath === "/donate/")) :
        target.source !== "cms" || content.pages.length !== 1 || page.pageId !== target.documentId ||
        page.path !== target.pagePath || page.contentMode !== "published" || page.sourceVersion !== target.sourceVersion) ||
      (target.documentId === "home" && !content.homeSources)) throw new Error("Invalid public Page context target");
  await projectPageScheduleInputs({ schedule: content.schedule, sourceSeal: {
    rendererSha, contextRevision: target.contextRevision, contextDigest: target.contextDigest,
    codeGeneration: target.codeGeneration,
  } }, target.documentId, rendererSha);
  return renderPageContent(content);
}

/** The public Page entry accepts only one exact projected published target. */
export async function renderPublishedPage(content: PublishedPageContent): Promise<string> {
  const page = content.pages.find(page => page.pageId === content.target.documentId);
  if (content.kind !== "public-page" || content.target.rendererSha !== rendererSha || !page ||
      content.pages.length !== 1 || page.contentMode !== "published" || page.sourceVersion !== content.target.sourceVersion ||
      page.path !== content.target.pagePath || !isPublicPagePath(page.pageId, page.path) ||
      !Number.isSafeInteger(page.sourceVersion) || Number(page.sourceVersion) < 1 ||
      !Number.isSafeInteger(content.target.contextRevision) || content.target.contextRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(content.target.contextDigest) ||
      (page.pageId === "home" && !content.homeSources)) throw new Error("Invalid published Page target");
  await projectPageScheduleInputs({ schedule: content.schedule, sourceSeal: {
    rendererSha, contextRevision: content.target.contextRevision, contextDigest: content.target.contextDigest,
    codeGeneration: content.target.codeGeneration,
  } }, content.target.documentId, rendererSha);
  return renderPageContent(content);
}

/** Exact public record target; aliases render the existing permanent stubs. */
export async function renderPublishedRecordFamily(content: PublishedRecordContent): Promise<string> {
  const target = content.target;
  const records = target.family === "programs" ? content.programs : content.events;
  const index = target.pagePath === `/${target.family}/` || target.family === "programs" && target.pagePath === "/shows/";
  const record = records.find(record => ("programId" in record ? record.programId : record.eventId) === target.documentId);
  if (content.kind !== "public-record-family" || target.rendererSha !== rendererSha ||
      !["programs", "events"].includes(target.family) ||
      !Number.isSafeInteger(target.contextRevision) || target.contextRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(target.contextDigest) || !Number.isFinite(Date.parse(target.renderedAt)) ||
      (index ? target.documentId !== null || target.sourceVersion !== null :
        !record || record.sourceVersion !== target.sourceVersion || !recordPaths(target.family, record).includes(target.pagePath))) {
    throw new Error("Invalid published record target");
  }
  if (target.family === "programs" && content.programImageDescriptors) {
    assertProgramImageCatalog(content.programImageDescriptors, content.programs, { rendererSha });
    await verifyProgramImageCatalog(content.programImageDescriptors);
  }
  if (content.programs.some(program => program.keyArt && program.keyArt.mimeType !== "image/gif") && !content.programImageDescriptors) {
    throw new ProgramImagePreparationError("program_image_contract");
  }
  return renderPageContent(content);
}
