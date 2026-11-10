import { describe, expect, it } from "vitest";
import { parseDataTable, parseDataTableForEditing } from "../../packages/content-core/src/data-table";
import { serializeDataTable } from "../src/lib/data-table-grid";

describe("editable data table serialization", () => {
  it("round-trips quoted headers and cells, Unicode, and multiline values", () => {
    const table = {
      headers: ['County, "district"', "Notes"],
      rows: [["Essex", 'She said "hello".\nCafé 東京'], ["Mercer", "=1+1"]],
    };
    expect(parseDataTable(serializeDataTable(table))).toEqual(table);
  });

  it("preserves raw cell whitespace and carriage returns without sanitizing values", () => {
    expect(serializeDataTable({ headers: [" Name "], rows: [["  value\r\nline  "]] }))
      .toBe(' Name \n"  value\r\nline  "');
  });

  it("retains blank cells and column counts in valid rows", () => {
    const table = { headers: ["County", "Total", "Note"], rows: [["Essex", "", ""], ["", "10", ""]] };
    expect(serializeDataTable(table)).toBe('County,Total,Note\nEssex,"",""\n"",10,""');
    expect(parseDataTable(serializeDataTable(table))).toEqual(table);
  });

  it("serializes an empty header without bypassing canonical validation", () => {
    const csv = serializeDataTable({ headers: ["County", ""], rows: [["Essex", "10"]] });
    expect(csv).toBe('County,""\nEssex,10');
    expect(() => parseDataTable(csv)).toThrow("Give each column a header");
  });

  it.each([
    { headers: ["County"], rows: [["Essex"], [""]] },
    { headers: ["County", "Total"], rows: [["Essex", "10"], ["", ""]] },
  ])("keeps a final empty draft row so validation can reject it", (table) => {
    const csv = serializeDataTable(table);
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv.split("\n")[2]).toBe(table.headers.map(() => '""').join(","));
    expect(() => parseDataTable(csv)).toThrow("Remove empty data rows");
  });
});

describe("lossless editing parser", () => {
  it.each(["\r\n", "\r", "\n"])("preserves cells while accepting row separator %j", (separator) => {
    const csv = `\uFEFF Name ,Note${separator}  Essex  ,"Quoted\r\nline with ""quotes""  "${separator}Mercer,End`;
    expect(parseDataTableForEditing(csv)).toEqual({ headers: [" Name ", "Note"], rows: [["  Essex  ", 'Quoted\r\nline with "quotes"  '], ["Mercer", "End"]] });
    expect(parseDataTable(csv)).toEqual({ headers: ["Name", "Note"], rows: [["Essex", 'Quoted\nline with "quotes"'], ["Mercer", "End"]] });
  });

  it("keeps canonical validation for editing", () => {
    expect(() => parseDataTableForEditing("Header\n   ")).toThrow("Remove empty data rows");
    expect(() => parseDataTableForEditing('Header\n"Unclosed')).toThrow("Close the quotation marks");
  });
});
