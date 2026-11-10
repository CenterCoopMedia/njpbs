import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { isDocumentListData, newestNoticeDocuments, noticeAddedDate } from "../../packages/content-core/src/document-list";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { projectCmsPage } from "../src/lib/cms-loader";
import { cmsImageAsset } from "../src/lib/cms-responsive-image";
import { allowedBlocksForSection, insertableBlocksForSection, validateSection } from "../../packages/content-core/src/editor-admin";
import { blockContentError } from "../../packages/content-core/src/block-content-validation";
import { pageCompositionSeed } from "../../packages/content-core/src/page-composition-seeds";
const publisherValidation = createRequire(import.meta.url)("../../functions/lib/block-content-validation.js");
const runtimeProjection = createRequire(import.meta.url)("../../functions/lib/public-content-projection.js");
const mediaSafety = createRequire(import.meta.url)("../../functions/lib/published-media-safety.js");
const server = createRequire(import.meta.url)("../../functions/lib/document-list.js");
const first = { itemId: "first", assetId: "pdf-one", title: "Board notice", publisher: "njpba" as const, addedAt: "2026-10-01T12:00:00.000Z" };
const second = { itemId: "second", assetId: "pdf-two", title: "New notice", publisher: "njpbs" as const, addedAt: "2026-10-07T12:00:00.000Z" };
const block = { id: "notices", type: "document_list" as const, order: 0, visible: true, data: { documents: [first, second] } };
describe("PDF notices", () => {
  it.each([undefined, "public-meetings", "meeting-notices", "custom-notices"])(
    "preserves saved notices and custom copy while resolving slug %s", slug => {
      const now = new Date("2026-10-07T19:00:00.000Z");
      const asset = { id: first.assetId, url: "https://media.njpbs.org/cms-media/pdf-one.pdf", mimeType: "application/pdf" };
      const savedBlock = { ...block, data: { documents: [first] } };
      const metadata = { title: "Custom saved heading", description: "Custom saved introduction", ...(slug ? { slug } : {}) };
      const document = { id: "public-meetings", template: "genericPage", status: "published", version: 2,
        ...metadata, publishAt: first.addedAt, blocks: [savedBlock],
        published: { blocks: [savedBlock], metadata, sourceVersion: 2, publishedAt: first.addedAt, publishedBy: "editor" } };
      const original = structuredClone(document);
      const path = slug === "custom-notices" ? "/custom-notices/" : "/meeting-notices/";
      const runtime = runtimeProjection.projectPublicPageDocument({ pageId: document.id, document, now,
        assets: new Map([[first.assetId, { ...asset, width: null, height: null, altText: null }]]) }).page;
      for (const mode of ["published", "draft"] as const) {
        const page = projectCmsPage(document, { mode, pageId: document.id, now, assets: new Map([[first.assetId, asset]]) })!;
        expect(page).toMatchObject({ pageId: "public-meetings", path, title: metadata.title, description: metadata.description });
        expect(page.blocks).toEqual([savedBlock]);
        expect(page.assets[first.assetId]).toEqual({ url: asset.url, mimeType: asset.mimeType });
        expect(runtime.path).toBe(page.path);
        expect(runtime.title).toBe(page.title);
        expect(runtime.blocks).toEqual(page.blocks);
      }
      expect(document).toEqual(original);
    },
  );
  it("accepts the visible empty seed and final-notice removal for complete publication", () => {
    const seed = pageCompositionSeed("public-meetings")!;
    const emptySeed = seed.blocks.find(item => item.type === "document_list")!;
    expect(emptySeed.visible).toBe(true);
    expect(emptySeed.data).toEqual({ documents: [] });
    const afterRemoval = { ...block, data: { documents: [] } };
    for (const blocks of [seed.blocks, [afterRemoval]]) {
      expect(blockContentError(blocks)).toBeNull();
      expect(publisherValidation.blockContentError(blocks)).toBeNull();
      expect(parseBlocks(blocks).ok).toBe(true);
    }
  });
  it.each([undefined, null, {}, "", "not-an-array"])("rejects a missing or nonarray documents value: %j", documents => {
    const data = documents === undefined ? {} : { documents };
    expect(isDocumentListData(data, true)).toBe(false);
    expect(server.isDocumentListData(data, true)).toBe(false);
    expect(parseBlocks([{ ...block, data }]).ok).toBe(false);
  });
  it.each(["title", "assetId"])("still requires each notice's %s for publication", field => {
    const incomplete = [{ ...block, data: { documents: [{ ...first, [field]: "" }] } }];
    const expected = field === "title" ? "Notice title is required." : "PDF is required.";
    expect(blockContentError(incomplete)).toContain(expected);
    expect(publisherValidation.blockContentError(incomplete)).toContain(expected);
  });
  it("allows generic-page notice saves and exposes the PDF notice insertion palette", () => {
    expect(allowedBlocksForSection("genericPage")).toContain("document_list");
    expect(insertableBlocksForSection("genericPage")).toContain("document_list");
    expect(validateSection("genericPage", [block])).toBeNull();
    expect(validateSection("home", [block])).not.toBeNull();
  });
  it("keeps PDFs out of image-only hero consumers while preserving dimensioned images", () => {
    expect(cmsImageAsset({ url: "https://media.njpbs.org/cms-media/notice.pdf", mimeType: "application/pdf" })).toBeUndefined();
    expect(cmsImageAsset({ url: "https://media.njpbs.org/cms-media/notice.pdf", mimeType: "application/pdf", width: 400, height: 300 })).toBeUndefined();
    const image = { url: "https://media.njpbs.org/cms-media/hero.jpg", mimeType: "image/jpeg", width: 1200, height: 675 };
    expect(cmsImageAsset(image)).toEqual(image);
  });
  it("sorts by first addition without mutating stored order, with deterministic ties", () => {
    expect(newestNoticeDocuments([first, second]).map(item => item.itemId)).toEqual(["second", "first"]);
    expect(block.data.documents[0]).toBe(first);
    expect(newestNoticeDocuments([{ ...second, itemId: "z" }, { ...second, itemId: "a" }]).map(item => item.itemId)).toEqual(["a", "z"]);
    expect(noticeAddedDate("2026-10-07T01:00:00.000Z")).toBe("October 6, 2026");
  });
  it.each([
    { documents: [first] }, { documents: [] }, { documents: [first, first] },
    { documents: [{ ...first, addedAt: "2026-02-30T00:00:00.000Z" }] },
    { documents: [{ ...first, title: "" }] }, { documents: [{ ...first, publisher: "other" }] },
    { documents: [{ ...first, assetId: "https://example.com/file.pdf" }] },
    { documents: [{ ...first, url: "https://example.com/file.pdf" }] },
    { documents: [{ itemId: "draft", assetId: "", title: "" }] },
  ])("keeps server and editor validation in agreement: %j", data => {
    for (const complete of [false, true]) expect(server.isDocumentListData(data, complete)).toBe(isDocumentListData(data, complete));
  });
  it("assigns trusted dates and preserves them through edits, replacement and copies", () => {
    const now = "2026-10-07T18:00:00.000Z";
    const input = { ...block, data: { documents: [{ ...first, title: "Edited", assetId: "replacement", addedAt: now }, { ...second, addedAt: first.addedAt }] } };
    const stamped = server.stampDocumentLists([input], [{ ...block, data: { documents: [first] } }], now);
    expect(stamped[0].data.documents.map((item: typeof first) => item.addedAt)).toEqual([first.addedAt, now]);
    expect(server.stampDocumentLists([{ ...input, id: "copy" }], [block], now)[0].data.documents.every((item: typeof first) => item.addedAt === now)).toBe(true);
    expect(server.stampDocumentLists(stamped, stamped, "2026-10-08T18:00:00.000Z")).toEqual(stamped);
  });
  it("renders a native, escaped newest-first PDF list and omits wrong MIME or unsafe links", () => {
    expect(parseBlocks([block]).ok).toBe(true);
    const html = renderBlock(block, { resolveAsset: id => ({ url: `https://media.njpbs.org/cms-media/${id}.pdf`, mimeType: "application/pdf" }) });
    expect(html.indexOf("New notice")).toBeLessThan(html.indexOf("Board notice"));
    expect(html).toContain("<ul"); expect(html).toContain("PDF"); expect(html).toContain("<time datetime=");
    expect(renderBlock(block, { resolveAsset: () => ({ url: "javascript:alert(1)", mimeType: "application/pdf" }) })).not.toContain("<a");
    expect(renderBlock(block, { resolveAsset: () => ({ url: "https://media.njpbs.org/cms-media/photo.jpg", mimeType: "image/jpeg" }) })).not.toContain("<a");
    expect(renderBlock({ ...block, data: { documents: [{ ...first, title: "<script>alert(1)</script>" }] } }, { resolveAsset: () => ({ url: "https://media.njpbs.org/cms-media/x.pdf", mimeType: "application/pdf" }) })).toContain("&lt;script&gt;");
  });
  it("projects saved previews and frozen public notices with PDF URLs and no image dimensions", () => {
    const assets = new Map([first, second].map(item => [item.assetId, {
      id: item.assetId, url: `https://media.njpbs.org/cms-media/${item.assetId}.pdf`, mimeType: "application/pdf",
    }]));
    const now = new Date("2026-10-07T19:00:00.000Z");
    const doc = { id: "public-meetings", template: "genericPage", title: "Draft title", status: "published",
      version: 2, publishAt: first.addedAt, blocks: [{ ...block, data: { documents: [{ ...first, title: "Draft edit" }] } }],
      published: { blocks: [block], metadata: { title: "Public meeting notices" },
        sourceVersion: 2, publishedAt: first.addedAt, publishedBy: "editor" } };
    const live = projectCmsPage(doc, { mode: "published", now, assets })!;
    expect(live.path).toBe("/meeting-notices/");
    expect(live.blocks).toEqual([block]);
    expect(live.assets[first.assetId]).toEqual(assets.get(first.assetId) && {
      url: assets.get(first.assetId)!.url, mimeType: "application/pdf",
    });
    expect(projectCmsPage(doc, { mode: "draft", pageId: doc.id, now, assets })!.blocks[0].data).toEqual(doc.blocks[0].data);
    expect(() => projectCmsPage(doc, { mode: "published", now, assets: new Map([[first.assetId, { ...assets.get(first.assetId)!, mimeType: "image/png" }]]) })).toThrow(/PDF/);
    expect(() => projectCmsPage(doc, { mode: "published", now, assets: new Map([[first.assetId, { ...assets.get(first.assetId)!, url: "https://example.com/private.pdf" }]]) })).toThrow(/approved origin/);
  });
  it("keeps runtime and static PDF projections aligned without weakening media safety", () => {
    const pdf = { url: "https://media.njpbs.org/cms-media/pdf-one.pdf", mimeType: "application/pdf",
      altText: null, width: null, height: null };
    const noticeBlock = { ...block, data: { documents: [first] } };
    const now = new Date("2026-10-07T19:00:00.000Z");
    const document = { id: "public-meetings", template: "genericPage", title: "Draft title", status: "published",
      version: 2, publishAt: first.addedAt, blocks: [],
      published: { blocks: [noticeBlock], metadata: { title: "Public meeting notices" },
        sourceVersion: 2, publishedAt: first.addedAt, publishedBy: "editor" } };
    const projectRuntime = (asset = pdf, blocks = [noticeBlock]) => runtimeProjection.projectPublicPageDocument({
      pageId: document.id, document: { ...document, published: { ...document.published, blocks } }, now,
      assets: new Map([[first.assetId, asset]]),
    });
    const runtime = projectRuntime().page;
    const frozen = projectCmsPage(document, { mode: "published", now,
      assets: new Map([[first.assetId, { id: first.assetId, url: pdf.url, mimeType: pdf.mimeType }]]) })!;
    expect(runtime.blocks).toEqual(frozen.blocks);
    expect(runtime.assets).toEqual(frozen.assets);
    expect(runtimeProjection.publicAssetRequirementsForDocument({ pageId: document.id, document, now }))
      .toEqual({ assetIds: [first.assetId], documentAssetIds: [first.assetId], imageAssetIds: [] });
    for (const url of ["https://njpbs.org/brand/notice.pdf", "https://example.com/notice.pdf",
      "https://media.njpbs.org/other/notice.pdf", "https://media.njpbs.org/cms-media/notice.pdf?token=secret"]) {
      expect(() => projectRuntime({ ...pdf, url })).toThrow();
      expect(() => projectCmsPage(document, { mode: "published", now,
        assets: new Map([[first.assetId, { id: first.assetId, url, mimeType: pdf.mimeType }]]) })).toThrow();
    }
    expect(projectRuntime(pdf, [{ ...noticeBlock, visible: false }]).page.assets).toEqual({});
    const snapshot = (data: object) => ({ exists: true, data: () => data });
    const privateRecord = { ...pdf, lifecycle: "active", source: "site_seed" };
    const input = { assetId: first.assetId, owner: "published notices", requiresPdf: true, requiresImage: false,
      privateSnapshot: snapshot(privateRecord), publicSnapshot: snapshot(pdf) };
    expect(mediaSafety.assertPublishedAssetProjection(input)).toEqual(pdf);
    expect(() => mediaSafety.assertPublishedAssetProjection({ ...input, requiresImage: true })).toThrow();
    expect(() => mediaSafety.assertPublishedAssetProjection({ ...input,
      privateSnapshot: snapshot({ ...privateRecord, lifecycle: "deleted" }) })).toThrow();
    expect(() => mediaSafety.assertPublishedAssetProjection({ ...input,
      privateSnapshot: snapshot({ ...privateRecord, source: "upload" }) })).toThrow();
    expect(mediaSafety.assertPublishedAssetProjection({ ...input, uploadedMediaReady: true,
      privateSnapshot: snapshot({ ...privateRecord, source: "upload" }) })).toEqual(pdf);
    expect(() => mediaSafety.assertPublishedAssetProjection({ ...input,
      publicSnapshot: snapshot({ ...pdf, url: "https://media.njpbs.org/cms-media/other.pdf" }) })).toThrow();
  });

});

