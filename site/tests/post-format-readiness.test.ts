import { describe, expect, it } from "vitest";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { postPresentationError, tagsWithPostPresentation } from "../../packages/content-core/src/post-formats";

const chapters: PageBlock = { id: "report", type: "prose", order: 0, visible: true, data: {
  content: { type: "doc", content: ["The river", "The towns"].map(text => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] })) },
} };
const module: PageBlock = { id: "module", type: "embed", order: 1, visible: true,
  data: { url: "https://example.org/river", caption: "Explore river levels" } };
const hiddenRow: PageBlock = { id: "row", type: "row", order: 0, visible: false, data: { columns: [12] } };

describe("Post presentation readiness", () => {
  it("keeps Standard unchanged and replaces markers without changing ordinary topics", () => {
    expect(postPresentationError({ tags: ["New Jersey"], blocks: [] })).toBeNull();
    expect(tagsWithPostPresentation(["New Jersey", "FORMAT:MULTIMEDIA"], "interactive")).toEqual(["New Jersey", "format:interactive"]);
    expect(tagsWithPostPresentation(["New Jersey", "format:interactive"], "standard")).toEqual(["New Jersey"]);
  });
  it("requires two visible chapters for a report", () => {
    expect(postPresentationError({ tags: ["format:special-report"], blocks: [] })).toMatch(/two named/);
    expect(postPresentationError({ tags: ["format:special-report"], blocks: [chapters] })).toBeNull();
    expect(postPresentationError({ tags: ["format:special-report"], blocks: [hiddenRow, { ...chapters, layout: { rowId: "row", column: 0 } }] })).toMatch(/two named/);
  });
  it("counts selected media, excluding blank image controls and hidden row children", () => {
    const tags = ["format:multimedia"];
    const blank: PageBlock = { id: "image", type: "image", order: 0, visible: true, data: { assetId: "", alt: "" } };
    expect(postPresentationError({ tags, blocks: [blank], heroImage: " " })).toMatch(/must include/);
    expect(postPresentationError({ tags, blocks: [], heroImage: "selected-image" })).toBeNull();
    expect(postPresentationError({ tags, blocks: [hiddenRow, { ...module, layout: { rowId: "row", column: 0 } }] })).toMatch(/must include/);
  });
  it("requires a visible, safe and labeled interactive module", () => {
    const tags = ["format:interactive"];
    expect(postPresentationError({ tags, blocks: [] })).toMatch(/at least one/);
    expect(postPresentationError({ tags, blocks: [module] })).toBeNull();
    expect(postPresentationError({ tags, blocks: [{ ...module, data: { ...module.data, caption: "" } }] })).toMatch(/caption/);
    expect(postPresentationError({ tags, blocks: [{ ...module, data: { ...module.data, url: "javascript:alert(1)" } }] })).toMatch(/approved/);
    expect(postPresentationError({ tags, blocks: [hiddenRow, { ...module, layout: { rowId: "row", column: 0 } }] })).toMatch(/at least one/);
  });
});
