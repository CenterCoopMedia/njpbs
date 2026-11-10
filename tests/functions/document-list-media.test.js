import { describe, expect, it } from "vitest";
import usagePkg from "../../functions/lib/media-usage.js";
import previewPkg from "../../functions/lib/preview-snapshot.js";
import safetyPkg from "../../functions/lib/published-media-safety.js";
import contract from "../../functions/lib/media-contract.js";
import blocksPkg from "../../functions/lib/content-blocks.js";
const { collectWorkingMediaUsage, collectPublishedMediaUsage, prepareMediaUsageWrites } = usagePkg;
const block = { id: "notices", type: "document_list", order: 0, visible: true,
  data: { documents: [{ itemId: "notice", assetId: "pdf-notice", title: "Meeting notice", addedAt: "2026-10-07T12:00:00.000Z" }] } };
const record = { lifecycle: "active", source: "site_seed", url: "https://media.njpbs.org/cms-media/notice.pdf",
  mimeType: "application/pdf", altText: null, width: null, height: null };
function fixture() {
  const refs = new Map([
    ["media_assets/pdf-notice", { exists: true, data: () => record }],
    ["media_assets_public/pdf-notice", { exists: true, data: () => contract.mediaProjection(record) }],
  ]);
  return { firestore: { collection: name => ({ doc: id => ({ path: `${name}/${id}` }) }) },
    transaction: { get: async ref => refs.get(ref.path) ?? { exists: false } } };
}
describe("PDF notice publication boundaries", () => {
  it("accepts the canonical block and tracks PDF usage in working and public states", async () => {
    expect(blocksPkg.parseBlocks([block]).ok).toBe(true);
    const working = collectWorkingMediaUsage({ collection: "cmsPages", document: { blocks: [block] } });
    expect(working).toEqual({ assetIds: ["pdf-notice"], documentAssetIds: ["pdf-notice"], imageAssetIds: [], occurrenceCount: 1 });
    const published = collectPublishedMediaUsage({ collection: "cmsPages", snapshot: { blocks: [block], metadata: {} } });
    expect(published).toEqual(working);
    await expect(prepareMediaUsageWrites({ ...fixture(), collection: "cmsPages", documentId: "public-meetings",
      states: [{ state: "working", sourceVersion: 1, usage: working }, { state: "published", sourceVersion: 1, usage: published }] })).resolves.toBeDefined();
    expect(collectPublishedMediaUsage({ collection: "cmsPages", snapshot: { blocks: [{ ...block, visible: false }], metadata: {} } }).assetIds).toEqual([]);
  });
  it("rejects PDFs in image slots, including simultaneous image and document references", async () => {
    for (const blocks of [[{ id: "image", type: "image", visible: true, data: { assetId: "pdf-notice" } }],
      [block, { id: "image", type: "image", visible: true, data: { assetId: "pdf-notice" } }]]) {
      const usage = collectWorkingMediaUsage({ collection: "cmsPages", document: { blocks } });
      await expect(prepareMediaUsageWrites({ ...fixture(), collection: "cmsPages", documentId: "public-meetings",
        states: [{ state: "working", sourceVersion: 1, usage }] })).rejects.toThrow(/must be/);
    }
  });
  it("freezes only PDF URL and MIME, keeping the HTTPS and image-only defaults", () => {
    expect(previewPkg.referencedPreviewAssetIds({ id: "public-meetings", blocks: [block] })).toEqual(["pdf-notice"]);
    expect(previewPkg.createPreviewAssetSnapshot("pdf-notice", record, { pdf: true })).toEqual({
      id: "pdf-notice", url: record.url, mimeType: "application/pdf",
    });
    expect(() => previewPkg.createPreviewAssetSnapshot("pdf-notice", record)).toThrow(/image/);
    expect(() => previewPkg.createPreviewAssetSnapshot("pdf-notice", { ...record, url: "http://example.com/a.pdf" }, { pdf: true })).toThrow(/https/);
    expect(safetyPkg.assertPublishedAssetProjection({ assetId: "pdf-notice", owner: "notices", requiresPdf: true,
      privateSnapshot: { exists: true, data: () => record }, publicSnapshot: { exists: true, data: () => contract.mediaProjection(record) } })).toEqual(contract.mediaProjection(record));
    expect(() => safetyPkg.assertPublishedAssetProjection({ assetId: "pdf-notice", owner: "image", requiresPdf: true, requiresImage: true,
      privateSnapshot: { exists: true, data: () => record }, publicSnapshot: { exists: true, data: () => contract.mediaProjection(record) } })).toThrow();
  });
});
