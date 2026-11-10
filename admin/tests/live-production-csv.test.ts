import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { csvRequestFits, previewBannerCsv } from "../src/lib/live-production-csv";
import type { BannerText } from "../../packages/content-core/src/live-production";

// The server parser is used only by this contract test, never by the browser.
const server = createRequire(import.meta.url)("../../functions/lib/live-production-requests.js") as {
  parseBannerCsv(csv: string): BannerText[];
};
const header = "templateId,headline,name,title\n";

describe("browser CSV preview and server import grammar", () => {
  // Expected text comes from the literal CSV grammar in #3334/#3827.
  const golden = [
    { label: "BOM and literal CR/LF, commas and quotes", csv: '\uFEFFtemplateId,headline,name,title\r\nheadline,"  中文, ""news""\r\nsecond line  ",,\r\nname_title,,JULIE O’CONNOR,\r\n',
      text: [{ templateId: "headline", headline: '  中文, "news"\r\nsecond line  ' }, { templateId: "name_title", name: "JULIE O’CONNOR", title: "" }] },
    { label: "formula text and padded name", csv: header + 'headline,=1+1,,\nname_title,,"  María  ","Producer, NJ PBS"',
      text: [{ templateId: "headline", headline: "=1+1" }, { templateId: "name_title", name: "  María  ", title: "Producer, NJ PBS" }] },
    { label: "escaped quotes at EOF", csv: header + 'headline,"""quoted""",,', text: [{ templateId: "headline", headline: '"quoted"' }] },
    { label: "long Unicode name and empty title", csv: header + `name_title,,${"🗳️名字".repeat(1000)},`, text: [{ templateId: "name_title", name: "🗳️名字".repeat(1000), title: "" }] },
  ] as const;
  it.each(golden)("keeps literal text: $label", ({ csv, text }) => {
    expect(previewBannerCsv(csv)).toEqual({ banners: text.map((text, index) => ({ row: index + 2, text })), errors: [] });
    expect(server.parseBannerCsv(csv)).toEqual(text);
  });
  it.each([
    header + 'headline,"unterminated,,', header + 'headline,"closed"junk,,', header + 'headline,un"quoted,,',
    "type,text\nheadline,news", header, header + "third,news,,", header + "headline,news,unused,",
    header + "name_title,unused,Name,", header + "name_title,,,", header + "headline,   ,,",
    header + "headline,news,,extra,cell", header + "\n",
  ])("rejects the same invalid file as the server", csv => {
    expect(previewBannerCsv(csv).errors.length).toBeGreaterThan(0);
    expect(() => server.parseBannerCsv(csv)).toThrow();
  });
  it("lists each row error without hiding the valid rows", () => {
    const preview = previewBannerCsv(header + "headline,valid,,\nthird,bad,,\nname_title,,,\nheadline,text,unused,");
    expect(preview.banners).toEqual([{ row: 2, text: { templateId: "headline", headline: "valid" } }]);
    expect(preview.errors.map(error => error.row)).toEqual([3, 4, 5]);
  });
  it("checks the HTTP byte bound separately from raw CSV bytes without truncating text", () => {
    const csv = header + `headline,"text${"\n".repeat(150000)}",,`;
    expect(previewBannerCsv(csv).errors).toEqual([]);
    expect(server.parseBannerCsv(csv)[0]).toMatchObject({ headline: `text${"\n".repeat(150000)}` });
    expect(csvRequestFits(csv, "rehearsal", false)).toBe(false);
    expect(csvRequestFits(header + "headline,ordinary,,", "rehearsal", true)).toBe(true);
  });
  it("uses UTF-8 bytes and the existing 100-banner physical import bound", () => {
    for (const csv of [header + "headline,news,,\n".repeat(101), header + `headline,${"é".repeat(125000)},,`]) {
      expect(previewBannerCsv(csv).errors.length).toBeGreaterThan(0);
      expect(() => server.parseBannerCsv(csv)).toThrow();
    }
    const csv = header + "headline,news,,\n".repeat(100);
    expect(previewBannerCsv(csv).banners).toHaveLength(100);
    expect(previewBannerCsv(csv).errors).toEqual([]);
    expect(server.parseBannerCsv(csv)).toHaveLength(100);
  });
});
