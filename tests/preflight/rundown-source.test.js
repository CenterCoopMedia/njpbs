import { describe, it, expect } from "vitest";
import structure from "../../functions/lib/rundown-document-structure.js";
import google from "../../functions/lib/google-rundown-source.js";
import { rundownDocument, paragraph, sourceConfig } from "../fixtures/rundown.js";

describe("selected Google Docs rundown structure", () => {
  it("accepts Google's dotted tab IDs while keeping document IDs separate from URLs", () => {
    const config = { ...sourceConfig, tabIds: ["t.0"] };
    expect(structure.parseSourceConfig(config)).toEqual(config);
    const doc = rundownDocument(); doc.tabs[0].tabProperties.tabId = "t.0";
    expect(structure.structureDocument(doc, config).blocks[0].tabId).toBe("t.0");
    expect(() => structure.parseSourceConfig({ ...config, documentId: "https://example.test" })).toThrow();
  });
  it("keeps selected parent/child tabs, headings, table cell paths and empty paragraphs in order", () => {
    const doc = rundownDocument();
    doc.tabs[0].documentTab.body.content.push({ table: { tableRows: [{ tableCells: [
      { content: [paragraph("Graphics")] }, { content: [paragraph("RA BANNER #2: SYNTHETIC RIVER UPDATE"), paragraph("")] },
    ] }] } });
    const result = structure.structureDocument(doc, sourceConfig);
    expect(result.blocks.map(block => block.text)).toEqual(["City hearing", "BANNER: SYNTHETIC CITY HEARING", "Graphics", "RA BANNER #2: SYNTHETIC RIVER UPDATE", "",
      "Interview", "LOWER THIRDS:", "NAME: ALEX EXAMPLE", "TITLE: SYNTHETIC REPORTER"]);
    expect(result.blocks[3]).toMatchObject({ tabId: "show", segmentId: "story-city", location: "body/2/r0/c1/0" });
    expect(result.blocks.some(block => block.tabId === "reference")).toBe(false);
  });
  it("retains repeated heading contexts, supports explicit legacy body and excludes pending insertion/annotation runs", () => {
    const doc = { documentId: "synthetic_doc", suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS", body: { content: [
      paragraph("Repeated", { namedStyleType: "HEADING_1" }),
      { paragraph: { elements: [{ textRun: { content: "BANNER: KEPT" }, suggestedDeletionIds: ["not-accepted"] },
        { textRun: { content: " DO NOT TAKE" }, suggestedInsertionIds: ["not-accepted"] }, { footnoteReference: { footnoteId: "note" } }] } },
      paragraph("Repeated", { namedStyleType: "HEADING_1" }), paragraph(""),
    ] } };
    const result = structure.structureDocument(doc, { ...sourceConfig, tabIds: ["legacy"] });
    expect(result.blocks[1].text).toBe("BANNER: KEPT");
    expect(result.blocks[0].segmentId).not.toBe(result.blocks[2].segmentId);
    expect(result.diagnostics[0].code).toBe("non_text_omitted");
  });
  it("hashes selected structure rather than revision metadata or Google offsets", () => {
    const first = rundownDocument(), next = rundownDocument();
    next.revisionId = "metadata-only";
    next.tabs[0].documentTab.body.content[0].startIndex = 900;
    next.tabs[1].documentTab.body.content[0] = paragraph("BANNER: REFERENCE CHANGED");
    expect(structure.structureDocument(first, sourceConfig).hash).toBe(structure.structureDocument(next, sourceConfig).hash);
    next.tabs[0].documentTab.body.content[1] = paragraph("BANNER: ACTUAL EDIT");
    expect(structure.structureDocument(first, sourceConfig).hash).not.toBe(structure.structureDocument(next, sourceConfig).hash);
  });
  it("rejects missing tabs, wrong document/view, invalid selection and over-budget content", () => {
    expect(() => structure.parseSourceConfig({ ...sourceConfig, documentId: "https://example.com" })).toThrow();
    expect(() => structure.parseSourceConfig({ ...sourceConfig, tabIds: ["show", "show"] })).toThrow();
    expect(() => structure.structureDocument(rundownDocument(), { ...sourceConfig, tabIds: ["missing"] })).toThrow(/unavailable/);
    expect(() => structure.structureDocument({ ...rundownDocument(), suggestionsViewMode: "SUGGESTIONS_INLINE" }, sourceConfig)).toThrow(/exclude/);
    expect(() => structure.structureDocument(rundownDocument("x".repeat(100001)), sourceConfig)).toThrow(/budget/);
  });
});

describe("read-only Google boundary", () => {
  const metadata = version => ({ id: "synthetic_doc", mimeType: "application/vnd.google-apps.document", version, modifiedTime: "2026-10-26T12:00:00Z" });
  function reader(responses) {
    const requests = [];
    return { requests, read: google.createGoogleRundownSource({ allowedDocumentIds: ["synthetic_doc"], getClient: async () => ({
      request: async request => { requests.push(request); return { data: responses.shift() }; },
    }) }) };
  }
  it("uses the exact Doc and readonly suggestion view; skips unchanged metadata and rejects read races", async () => {
    const first = reader([metadata("1"), rundownDocument(), metadata("1")]);
    expect((await first.read(sourceConfig)).snapshot.blocks).toHaveLength(6);
    expect(first.requests[1]).toMatchObject({ url: "https://docs.googleapis.com/v1/documents/synthetic_doc", method: "GET",
      params: { includeTabsContent: true, suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS" }, retry: false, maxRedirects: 0 });
    const same = reader([metadata("1")]);
    expect(await same.read(sourceConfig, { drive: { version: "1" } })).toMatchObject({ unchanged: true, apiRequests: 1 });
    const race = reader([metadata("1"), rundownDocument(), metadata("2")]);
    await expect(race.read(sourceConfig)).rejects.toThrow(/changed during/);
    await expect(first.read({ ...sourceConfig, documentId: "other_doc" })).rejects.toThrow(/not activated/);
  });
});
