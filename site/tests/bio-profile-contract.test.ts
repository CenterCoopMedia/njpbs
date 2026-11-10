import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { isBioCardData, type BioCardData } from "../../packages/content-core/src/bio-profiles";
import { isRichTextDoc, parseBlocks, renderRichText, type RichTextDoc } from "../../packages/content-core/src/content-model";
import { validateSection } from "../../packages/content-core/src/editor-admin";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/bio-profiles.js");
const serverBlocks = require("../../functions/lib/content-blocks.js");
const serverSections = require("../../functions/lib/editor-section-contract.js");
const { validateContentFieldValues } = require("../../functions/lib/content-document-contract.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { collectWorkingMediaUsage, collectPublishedMediaUsage } = require("../../functions/lib/media-usage.js");
const { referencedPreviewAssetIds } = require("../../functions/lib/preview-snapshot.js");

const identity = { profileId: "example-person", kind: "person" as const, name: "Example Person", role: "State senator", party: "Democratic", area: "District 1" };
const card: BioCardData = { ...identity, summary: "Represents District 1 in the New Jersey Senate.", sourceUrl: "https://example.org/official-bio", sourceLabel: "Official biography", asOf: "2026-09-01" };
const block = (data: unknown = card) => ({ id: "bio-1", type: "bio_card", visible: true, order: 0, data });
const prose = (marks: unknown[] = [{ type: "bio", attrs: identity }]) => ({
  type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Example Person", marks }] }],
});
const document = (blocks: unknown[]) => ({ type: "post", title: "A story", date: "2026-10-03", tags: [], slug: "a-story", previousSlugs: [], locale: "en", version: 1, blocks });
const publish = (doc: unknown, collection = "cmsPosts") => createPublishedSnapshot({ collection, document: doc, publishedAt: "2026-10-03T12:00:00Z", publishedBy: "editor" });

describe("public bio snapshots", () => {
  it("keeps TS and deployment validators in agreement on allowed and unknown fields", () => {
    for (const value of [card, { ...card, privateNotes: "Do not publish" }, { ...card, sourceUrl: "javascript:alert(1)" },
      { ...card, sourceUrl: "https://user:secret@example.org/" }, { ...card, asOf: "2026-02-30" },
      { ...card, name: "N".repeat(121) }, { ...card, image: { assetId: "photo-1", alt: "Example Person", privateNotes: "No" } }]) {
      expect(server.isBioCardData(value, true)).toBe(isBioCardData(value, true));
      expect(serverBlocks.parseBlocks([block(value)])).toEqual(parseBlocks([block(value)]));
    }
    expect(isBioCardData(card, true)).toBe(true);
    expect(isBioCardData({ ...card, privateNotes: "Do not publish" }, true)).toBe(false);
    expect(isBioCardData({ ...card, finance: {} }, true)).toBe(false);
  });

  it("allows an unfinished draft but refuses an incomplete published card", () => {
    const draft = { profileId: "", kind: "person", name: "", role: "", summary: "", sourceUrl: "", sourceLabel: "", asOf: "" };
    expect(parseBlocks([block(draft)], { complete: false }).ok).toBe(true);
    expect(serverBlocks.parseBlocks([block(draft)], { complete: false }).ok).toBe(true);
    expect(() => publish(document([block(draft)]))).toThrow(/invalid data/);
  });

  it("rejects unsupported inline bio marks at save and publish boundaries", () => {
    const candidates = [
      prose(),
      prose([{ type: "bold" }, { type: "bio", attrs: identity }]),
      prose([{ type: "bio", attrs: { ...identity, notes: "Internal" } }]),
      { type: "doc", content: [{ type: "paragraph", marks: [{ type: "bio", attrs: identity }] }] },
      { type: "doc", content: [{ type: "bio", attrs: identity }] },
    ];
    for (const value of candidates) {
      expect(isRichTextDoc(value)).toBe(false);
      expect(serverBlocks.isRichTextDoc(value)).toBe(false);
      const blocks = [{ id: "copy", type: "prose", visible: true, order: 0, data: { content: value } }];
      expect(parseBlocks(blocks, { complete: false }).ok).toBe(false);
      expect(serverBlocks.parseBlocks(blocks, { complete: false }).ok).toBe(false);
      expect(() => publish(document(blocks))).toThrow(/invalid data/);
    }
  });

  it("renders stale inline marks as ordinary formatted text without biography metadata", () => {
    const value = prose([{ type: "bio", attrs: identity }, { type: "bold" }]);
    expect(renderRichText(value as RichTextDoc)).toBe("<p><strong>Example Person</strong></p>");
  });

  it("rejects cards outside posts, including hidden content", () => {
    const blocks = [block()];
    const hiddenBlocks = [{ ...block(), visible: false }];
    for (const section of ["home", "genericPage", "programLanding"] as const) {
      expect(validateSection(section, blocks as never)).not.toBeNull();
      expect(serverSections.validateSection(section, blocks)).toEqual(validateSection(section, blocks as never));
      expect(serverSections.validateSection(section, hiddenBlocks)).not.toBeNull();
    }
    expect(serverSections.validateSection("post", blocks)).toBeNull();
    expect(() => publish({ title: "Page", version: 1, blocks }, "cmsPages")).toThrow(/only inside Posts/);
    expect(validateContentFieldValues("cmsPages", "page", { blocks })).toMatch(/only inside Posts/);
  });

  it("freezes only the selected article data and its explicit verification date", () => {
    const doc = document([block(), { id: "copy", type: "prose", visible: true, order: 1, data: { content: prose([]) } }]);
    const snapshot = publish(doc);
    expect(snapshot.blocks[0].data).toEqual(card);
    expect(snapshot.blocks[0].data.asOf).toBe("2026-09-01");
    (doc.blocks[0] as { data: unknown }).data = { ...card, role: "Later role" };
    expect(snapshot.blocks[0].data.role).toBe("State senator");
    expect(() => publish(document([block({ ...card, research: { notes: "Private" } })]))).toThrow(/invalid data/);
  });

  it("tracks optional photos through working, public, and private-preview media safety", () => {
    const blocks = [block({ ...card, image: { assetId: "photo-1", alt: "Example Person" } })];
    expect(collectWorkingMediaUsage({ collection: "cmsPosts", document: document(blocks) }).assetIds).toEqual(["photo-1"]);
    expect(collectPublishedMediaUsage({ collection: "cmsPosts", snapshot: { blocks, metadata: {} } }).assetIds).toEqual(["photo-1"]);
    expect(referencedPreviewAssetIds({ id: "story", blocks })).toEqual(["photo-1"]);
    expect(collectPublishedMediaUsage({ collection: "cmsPosts", snapshot: { blocks: [{ ...blocks[0], visible: false }], metadata: {} } }).assetIds).toEqual([]);
    expect(isBioCardData({ ...card, image: { assetId: "photo-1", alt: "" } }, true)).toBe(false);
    expect(isBioCardData({ ...card, image: { assetId: "photo-1", alt: "", altDecorative: true } }, true)).toBe(true);
  });
});
