import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import home from "../home-composition-v1.json";
import { publicPage, PUBLIC_PAGES } from "../../../../packages/content-core/src/public-pages";
import { projectCmsPage } from "../../../src/lib/cms-page-projection";
import { projectChrome, projectPublishedPostRead } from "../../../src/lib/published-post-shadow";
import { projectJoinedRecords } from "../../../src/lib/published-post-shadow";
import { projectPublicHomepageBanner } from "../../../src/lib/public-homepage-banner";
import { createHomeSourceSnapshot } from "../../../src/lib/home-sources";
import { createHomeEditorialCatalog, rebuildHomeSourcesForPosts } from "../../../src/lib/home-editorial-catalog";
import { chromeSettings } from "../shadow-posts/chrome";
import { registeredAuthor } from "../shadow-posts/fixtures";
import type { CmsPageDoc } from "../../../src/lib/cms-loader";
const require = createRequire(import.meta.url);
const { createPublishedSnapshot } = require("../../../../functions/lib/publish-snapshot.js");
const { projectPublicPageDocument } = require("../../../../functions/lib/public-content-projection.js");

export const now = new Date("2026-10-12T12:00:00.000Z");
export const customId = `page-${"2".repeat(32)}`;
export const pageIds = ["home", "contact", "about", "staff", customId];
export const fallbackPageIds = PUBLIC_PAGES.filter(page => !["schedule", "live", "data-hub"].includes(page.id)).map(page => page.id);
export const mediaAsset = { id: "page-image", url: "https://media.njpbs.org/cms-media/page-image/fixture.webp",
  mimeType: "image/webp", width: 640, height: 360 };
const joinedProgram = { id: "program-one", status: "published", publiclyVisible: true, deleted: false,
  publishAt: "2026-10-12T10:00:00.000Z", published: { sourceVersion: 4, publishedAt: "2026-10-12T10:00:00.000Z",
    blocks: [], metadata: { type: "program", title: "Published joined program", slug: "program-one", previousSlugs: [], locale: "en",
      keyArtAssetId: mediaAsset.id, description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Public joined program synopsis." }] }] } } } };
const banner = { id: "public-homepage-banner", version: 5, published: { schemaVersion: 1,
  sourceVersion: 4, publishedAt: "2026-10-12T10:00:00.000Z", values: { enabled: true,
    message: "Published Home announcement", linkLabel: "Read the update", linkHref: "/about/" } } };
export function pageDocument(pageId: string): CmsPageDoc {
  const working = pageId === "home" ? { ...structuredClone(home),
    homeHero: { mode: "manual", items: [{ itemId: "native", source: "cms_posts", sourceId: registeredAuthor.document.id }] },
  } : { id: pageId, version: 7, title: "Published Page & context", description: "Immutable Page fixture.",
    ...(pageId === customId ? { slug: "renamed-page", previousSlugs: ["earlier-page"] } : {}),
    blocks: [
      { id: "row", type: "row", order: 0, visible: true, data: { columns: [6, 6] } },
      { id: "heading", type: "headline", order: 1, visible: true, layout: { rowId: "row", column: 0 },
        data: { text: "A published heading", level: 2 } },
      { id: "body", type: "prose", order: 2, visible: true, layout: { rowId: "row", column: 1 },
        data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Frozen prose for Page parity." }] }] } } },
      ...(pageId === "contact" ? [
        { id: "image", type: "image", order: 3, visible: true, data: { assetId: mediaAsset.id,
          alt: "Page image fixture", caption: "Immutable image caption." } },
        { id: "record", type: "record_card", order: 4, visible: true, data: { recordKind: "program", recordId: "program-one" } },
      ] : []),
    ],
  };
  const published = createPublishedSnapshot({ collection: "cmsPages", document: working,
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  return { ...working, id: pageId, version: 8, template: publicPage(pageId)!.editorTemplate,
    title: "PRIVATE later working title", blocks: [], publiclyVisible: true, status: "draft", published };
}

export function publishedPageRead(pageId: string, rendererSha = "a".repeat(40)) {
  const document = pageDocument(pageId);
  const projection = projectPublicPageDocument({ pageId, document, now, assets: new Map([[mediaAsset.id, mediaAsset]]) });
  const previousSlugs = (document.published as { metadata: { previousSlugs?: string[] } }).metadata.previousSlugs;
  return { kind: "published-page", page: { ...projection.page,
    ...(previousSlugs === undefined ? {} : { previousSlugs }) },
    assets: pageId === "contact" ? [mediaAsset] : [], joinedRecords: pageId === "contact" ? [joinedProgram] : [],
    settings: [...chromeSettings("Exact Page newsletter"), ...(pageId === "home" ? [banner] : [])],
    navigationPages: pageIds.map(id => ({ pageId: id,
      path: projectCmsPage(pageDocument(id), { mode: "published", now, assets: new Map([[mediaAsset.id, mediaAsset]]) })!.path })),
    posts: pageId === "home" ? [structuredClone(registeredAuthor)] : [],
    authors: pageId === "staff" ? structuredClone(registeredAuthor.authors) : [],
    sourceSeal: { rendererSha, contextRevision: 4, cutoffAt: now.toISOString(),
      contextDigest: createHash("sha256").update("njpbs-public-context-v1:4").digest("hex") } };
}

export function fallbackPageRead(pageId: string, rendererSha = "a".repeat(40)) {
  const dependencies = publishedPageRead(["home", "staff"].includes(pageId) ? pageId : "about", rendererSha);
  return { ...dependencies, kind: "published-page-context", pageId, path: publicPage(pageId)!.path, page: null,
    navigationPages: [], assets: [], joinedRecords: [], sourceSeal: { ...dependencies.sourceSeal, codeGeneration: 5 } };
}

export function retainedHomeSources(rendererSha = "a".repeat(40)) {
  const publication = { buildBatchId: "public-page-fixtures", generation: 5, commitSha: rendererSha };
  const sources = createHomeSourceSnapshot({}, { checkedAt: "2026-10-12T10:00:00.000Z", cards: [] }, publication);
  sources.editorial = createHomeEditorialCatalog(sources, {}, [], "2026-10-12T10:00:00.000Z");
  return sources;
}

/** Independent ordinary static projection: no published-page-render import. */
export function staticFixtureContent(rendererSha = "a".repeat(40)) {
  const assets = new Map([[mediaAsset.id, mediaAsset]]);
  const pages = pageIds.map(pageId => projectCmsPage(pageDocument(pageId), { mode: "published", now, assets })!);
  const postContext = projectPublishedPostRead(registeredAuthor, registeredAuthor.document.published.metadata.slug, rendererSha, now)!;
  const retained = retainedHomeSources(rendererSha);
  const sources = rebuildHomeSourcesForPosts(retained, postContext.posts, retained.publication!, now.toISOString());
  const chrome = projectChrome({ settings: chromeSettings("Exact Page newsletter"),
    navigationPages: pages.map(page => ({ pageId: page.pageId, path: page.path })) });
  const joined = projectJoinedRecords([joinedProgram], assets, now);
  return { pages, posts: [...postContext.posts], authors: [...postContext.authors], ...joined,
    settings: [...chrome.settings, projectPublicHomepageBanner(banner)!], homeSources: sources };
}
