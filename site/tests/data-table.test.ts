import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseDataTable, dataTableError, isDataTableData } from "../../packages/content-core/src/data-table";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { renderDataTable } from "../../packages/content-core/src/data-table-render";
import { postPresentationError } from "../../packages/content-core/src/post-formats";
const require = createRequire(import.meta.url);
const server = require("../../functions/lib/content-blocks.js");
const contract = require("../../functions/lib/data-table.js");
const data = { title: "County totals", csv: 'County,Total\nMercer,10\nEssex,2', source: "Sample data", sourceHref: "" };
const block = { id: "table", type: "data_table" as const, order: 0, visible: true, data };

describe("native data table", () => {
  it("reads CSV quoting, newlines, escaped quotes, BOM and CRLF", () => {
    expect(parseDataTable('\uFEFFName,Note\r\n"River, town","Two ""quotes""\nand a line"\r\n')).toEqual({ headers: ["Name", "Note"], rows: [["River, town", 'Two "quotes"\nand a line']] });
  });
  it.each(['A,B\n1', 'A,\n1,2', 'A\n"unfinished', 'A\n"closed"oops', 'A\n', 'A\n\n'])('refuses invalid CSV: %s', (csv) => {
    expect(() => parseDataTable(csv)).toThrow();
    expect(contract.isDataTableData({ ...data, csv }, true)).toBe(false);
  });
  it("bounds rows and columns", () => {
    for (const csv of ['A\n' + Array(101).fill('1').join('\n'), Array(13).fill('A').join(',') + '\n' + Array(13).fill('1').join(','), 'x'.repeat(80001)]) {
      expect(() => parseDataTable(csv)).toThrow();
    }
    expect(dataTableError({ ...data, sourceHref: 'javascript:alert(1)' })).toMatch(/approved URL/);
  });
  it.each([
    [{ ...data, title: "t".repeat(251) }, "Use 250 characters or fewer for the table title."],
    [{ ...data, source: "s".repeat(501) }, "Use 500 characters or fewer for the source label."],
    [{ ...data, sourceHref: "u".repeat(2001) }, "Use 2,000 characters or fewer for the source URL."],
  ])("reports a specific field limit before strict save", (candidate, message) => {
    expect(dataTableError(candidate)).toBe(message);
    expect(isDataTableData(candidate, true)).toBe(false);
    expect(contract.isDataTableData(candidate, true)).toBe(false);
    expect(parseBlocks([{ ...block, data: candidate }]).ok).toBe(false);
  });
  it("preserves one grammar through the trusted server and public parser", () => {
    expect(parseBlocks([block]).ok).toBe(true);
    for (const candidate of [block, { ...block, data: { ...data, csv: 'A\n' } }, { ...block, visible: false, data: { ...data, csv: '' } }]) {
      expect(server.parseBlocks([candidate])).toEqual(parseBlocks([candidate]));
    }
  });
  it("escapes every cell and keeps the full table without JavaScript", () => {
    const markup = renderDataTable({ ...data, csv: 'Name,Value\n<script>,"<img src=x onerror=alert(1)>"' });
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('<caption>County totals</caption>');
    expect(markup).toContain('scope="col"');
    expect(markup).toContain('hidden data-table-sort');
  });
  it("counts complete visible tables as interactive modules", () => {
    expect(postPresentationError({ tags: ['format:interactive'], blocks: [block] })).toBeNull();
    expect(postPresentationError({ tags: ['format:interactive'], blocks: [{ ...block, visible: false }] })).not.toBeNull();
  });

});
