import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../packages/content-core/src/content-model";
import { defaultDataHubBlocks, isDataHubSectionData, isDefaultDataHubComposition } from "../packages/content-core/src/data-hub-composition";
import { renderBlock } from "../packages/content-core/src/content-render";
import { validateSection } from "../packages/content-core/src/editor-admin";

const require = createRequire(import.meta.url);
const server = require("../functions/lib/content-blocks");
const serverSection = require("../functions/lib/editor-section-contract");
const ownership = require("../functions/lib/no-build-page-ownership");
const section = { id: "figure-a", type: "data_hub_section", visible: true, order: 0,
  data: { sectionId: "unemployment", heading: "", introduction: "" } };

describe("Data Hub composition boundary", () => {
  it("treats whitespace-only copy as inherited without an empty heading", () => {
    const blocks = defaultDataHubBlocks().map(block => ({ ...block, data: { ...block.data, heading: "  ", introduction: "\n " } }));
    expect(isDefaultDataHubComposition(blocks)).toBe(true);
    expect(renderBlock(blocks.find(block => block.data.sectionId === "unemployment")!)).toContain("Unemployment</h2>");
    expect(renderBlock(blocks[0])).not.toContain("<p>\n </p>");
  });
  it("seeds 18 figures, Featured and the surrounding Page sections without source data", () => {
    const blocks = defaultDataHubBlocks();
    expect(blocks).toHaveLength(25);
    expect(blocks.map(block => block.data.sectionId)).toContain("featured");
    expect(parseBlocks(blocks, { pageId: "data-hub" }).ok).toBe(true);
    expect(validateSection("genericPage", blocks)).toBeNull();
    expect(serverSection.validateSection("genericPage", blocks)).toBeNull();
    expect(isDefaultDataHubComposition(blocks)).toBe(true);
    expect(isDefaultDataHubComposition(blocks.map((block, index) => ({ ...block, id: `canonical-${index}` })))).toBe(true);
    for (const block of blocks) expect(Object.keys(block.data).sort()).toEqual(["heading", "introduction", "sectionId"]);
  });

  it.each([
    ["unknown figure", { ...section.data, sectionId: "unreviewed" }],
    ["value override", { ...section.data, value: 1 }],
    ["source override", { ...section.data, sourceUrl: "https://example.test/" }],
    ["date override", { ...section.data, checked: "2026-10-23" }],
    ["markup field", { ...section.data, html: "<script>alert(1)</script>" }],
    ["long heading", { ...section.data, heading: "a".repeat(301) }],
    ["long introduction", { ...section.data, introduction: "a".repeat(4001) }],
    ["nontext", { ...section.data, heading: null }],
    ["missing text", { sectionId: "unemployment" }],
    ["control byte", { ...section.data, introduction: "text\u0000text" }],
  ])("refuses %s in both deployed and shared validators", (_name, data) => {
    expect(isDataHubSectionData(data)).toBe(false);
    const input = [{ ...section, data }];
    expect(parseBlocks(input, { pageId: "data-hub" }).ok).toBe(false);
    expect(server.parseBlocks(input, { pageId: "data-hub" })).toEqual(parseBlocks(input, { pageId: "data-hub" }));
  });

  it("refuses cross-page placement, duplicate references and Post placement", () => {
    for (const pageId of ["home", "about", "contact"]) {
      expect(parseBlocks([section], { pageId }).ok).toBe(false);
      expect(server.parseBlocks([section], { pageId })).toEqual(parseBlocks([section], { pageId }));
    }
    const duplicate = [section, { ...section, id: "figure-b", visible: false }];
    expect(parseBlocks(duplicate, { pageId: "data-hub" }).ok).toBe(false);
    expect(server.parseBlocks(duplicate, { pageId: "data-hub" })).toEqual(parseBlocks(duplicate, { pageId: "data-hub" }));
    const parsed = parseBlocks([section]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(validateSection("post", parsed.blocks)).not.toBeNull();
    expect(serverSection.validateSection("post", parsed.blocks)).not.toBeNull();
  });

  it("treats rearrangement, removal, hiding and copy edits as explicit changes", () => {
    const blocks = defaultDataHubBlocks();
    expect(isDefaultDataHubComposition([...blocks].reverse())).toBe(false);
    expect(isDefaultDataHubComposition(blocks.slice(1))).toBe(false);
    expect(isDefaultDataHubComposition(blocks.map((block, index) => index ? block : { ...block, visible: false }))).toBe(false);
    expect(isDefaultDataHubComposition(blocks.map((block, index) => index ? block : { ...block, data: { ...block.data, heading: "New heading" } }))).toBe(false);
  });

  it("escapes headings and introductions in the shared editor representation", () => {
    const block = { ...defaultDataHubBlocks()[0], data: { sectionId: "featured" as const,
      heading: '<img src=x onerror="alert(1)">', introduction: "<script>alert(1)</script>" } };
    const html = renderBlock(block);
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(renderBlock(block, { generatedHeadingLevel: 3 })).toContain("<h3>");
    expect(renderBlock(block, { generatedHeadingLevel: 3 })).not.toContain("<h2>");
  });

  it("accepts only the exact composition capability with the Data Hub gate", () => {
    const capability = { schemaVersion: 1, rendererSha: "a".repeat(40), servingEnabled: true, generation: 1 };
    expect(ownership.validateNoBuildPageCapability(capability)).toEqual(capability);
    const supported = { ...capability, dataHubReportingVersion: 1, dataHubCompositionVersion: 1 };
    expect(ownership.validateNoBuildPageCapability(supported)).toEqual(supported);
    for (const dataHubCompositionVersion of [0, 2, "1", null])
      expect(() => ownership.validateNoBuildPageCapability({ ...supported, dataHubCompositionVersion })).toThrow();
    expect(() => ownership.validateNoBuildPageCapability({ ...capability, dataHubCompositionVersion: 1 })).toThrow();
    const candidate = { schemaVersion: 1, rendererSha: "a".repeat(40), enabled: true, authoritative: true,
      dataHubReportingVersion: 1, dataHubCompositionVersion: 1 };
    expect(ownership.candidateNoBuildPageContract(candidate)).toEqual(candidate);
    expect(() => ownership.candidateNoBuildPageContract({ ...candidate, dataHubCompositionVersion: 2 })).toThrow();
  });
});
