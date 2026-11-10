import homeCurrentCatalogFixture from "../../../site/tests/fixtures/home-v2-current-catalog.json";
import { readHomeEditorialSourceReceipt } from "../../../packages/content-core/src/home-source-catalog";
import type { ComponentProps } from "react";
import type { EditorWorkspace, PageContent } from "../components/EditorWorkspace";
import type { AdminBlock } from "../lib/block-factory";
import type { MediaAssetSummary } from "../lib/functions";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { homeCompositionDefaults } from "../../../packages/content-core/src/home-composition";
import { createHomeNewscastBlock } from "../../../packages/content-core/src/home-newscast-section";
import postFixture from "./fixtures/study-post.json";
import photo from "./fixtures/study-post-photo.webp";
import background from "./fixtures/study-post-background.webp";

type Api = ComponentProps<typeof EditorWorkspace>;
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

/** Captured content only. No production record, media file, rights or version is verified here. */
export function createStudyReferenceFixtures({ homeBlocks }: { homeBlocks?: readonly AdminBlock[] } = {}) {
  const defaults = homeCompositionDefaults() as AdminBlock[];
  const named = (section: string) => structuredClone(defaults.find(block => block.section === section)!);
  const passport = named("home-passport-copy");
  passport.data.content = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Stream more with PBS Passport" }] },
    paragraph("Members unlock a library of PBS and NJ PBS programs on demand. Learn how the Passport member benefit works through PBS."),
  ] };
  const blocks: AdminBlock[] = [
    named("home-spotlight"), createHomeNewscastBlock("study-home-newscast") as unknown as AdminBlock,
    named("home-featured"), named("home-more"),
    { id: "study-home-newsletter", section: "home-newsletter", type: "newsletter_signup" as const, visible: true, order: 0, data: { newsletterIds: [], actionLabel: "Sign up by email" } },
    passport, named("home-passport-action"),
    { id: "study-home-embed", type: "embed" as const, visible: true, order: 0, data: { url: "https://youtube.com/live/E8PthYt_OUE?feature=share", caption: "Latest newscast" } },
  ].map((block, order) => ({ ...block, order }));
  let page: PageContent = {
    blocks: structuredClone(homeBlocks ?? blocks) as AdminBlock[], homeCompositionVersion: 2, version: 51, contentVersion: 51, status: "draft",
    publiclyVisible: true, publicSourceVersion: 50, publishedSourceVersion: 50,
    metadata: { title: "Home", summary: "", homeHero: { mode: "tag", source: "cms_posts", value: "announcement", presentation: "editorial", limit: 4 } },
  };
  let post: Record<string, unknown> = structuredClone(postFixture);
  const sources: HomeSourceSnapshot = {
    schemaVersion: 1, publication: homeCurrentCatalogFixture.receipt, heroCatalog: [],
    editorial: readHomeEditorialSourceReceipt(homeCurrentCatalogFixture),
    pbs: { source: "media-manager", checkedAt: null, featured: [], more: [] },
    spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] },
  };
  const image = (id: string, name: string, url: string, sizeBytes: number, width: number, height: number): MediaAssetSummary => ({
    id, name, originalName: `${id}.webp`, category: "news", categories: ["news"], tags: [],
    description: "Synthetic rectangle image for local editor examples.",
    altText: null, license: null, credit: null, mimeType: "image/webp", kind: "image", sizeBytes, width, height,
    url, lifecycle: "active", version: 1, etag: `"${id}"`, createdAt: null, updatedAt: null, createdBy: null, updatedBy: null,
  });
  const media = [image("study-photo", "Story image", photo, 154, 960, 858), image("study-background", "Header background", background, 132, 960, 640)];
  const loadPage: Api["loadPage"] = async () => structuredClone(page);
  const loadRecord: Api["loadRecord"] = async () => ({ status: "ready", record: structuredClone(post) });
  const savePage: Api["savePage"] = async (_id, _section, next, baseVersion) => {
    if (baseVersion !== page.version) throw Object.assign(new Error("Reload before saving this local fixture."), { status: 409 });
    page = { ...page, blocks: structuredClone(next), version: page.version! + 1 };
    return structuredClone(page);
  };
  const savePageMetadata: Api["savePageMetadata"] = async (_id, _section, next, baseVersion) => {
    if (baseVersion !== page.version) throw Object.assign(new Error("Reload before saving this local fixture."), { status: 409 });
    page = { ...page, metadata: structuredClone(next), version: page.version! + 1 };
    return structuredClone(page);
  };
  const saveRecord: Api["saveRecord"] = async (_kind, next) => {
    post = { ...structuredClone(next), version: Number(post.version) + 1 };
    return structuredClone(post);
  };
  const loadMedia: Api["loadMedia"] = async query => {
    const records = media.filter(asset => !query.assetIds || query.assetIds.includes(asset.id));
    return { success: true, records, total: records.length, allCount: media.length, page: 1, pageCount: 1, categoryCounts: { news: media.length }, kindCounts: { image: media.length } };
  };
  const loadHomeSources: Api["loadHomeSources"] = async () => structuredClone(sources);
  return { loadPage, loadRecord, savePage, savePageMetadata, saveRecord, loadMedia, loadHomeSources };
}
