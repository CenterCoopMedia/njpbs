import { safeHref } from "./safe-href.ts";

export interface DataTableData {
  title: string;
  csv: string;
  source: string;
  sourceHref: string;
}
export interface ParsedDataTable { headers: string[]; rows: string[][] }
export const DATA_TABLE_FIELD_LIMITS = Object.freeze({
  title: 250,
  csv: 80000,
  source: 500,
  sourceHref: 2000,
} as const);

/** CSV with quoted commas, escaped quotes and quoted newlines. No formulas execute. */
function csvRows(csv: string, preserveCellText = false): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char !== '"') { cell += char; continue; }
      if (csv[i + 1] === '"') { cell += '"'; i += 1; continue; }
      quoted = false;
      closedQuote = true;
      continue;
    }
    if (char === '"' && !cell && !closedQuote) { quoted = true; continue; }
    const newline = char === "\n" || (preserveCellText && char === "\r");
    if (char !== "," && !newline) {
      if (closedQuote || char === '"') throw new Error("Check the quotation marks in the CSV.");
      cell += char;
      continue;
    }
    row.push(preserveCellText ? cell : cell.trim()); cell = ""; closedQuote = false;
    if (row.length > 12) throw new Error("Use at most 12 columns.");
    if (newline) {
      rows.push(row); row = [];
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
    }
    if (rows.length > 101) throw new Error("Use at most 100 data rows.");
  }
  if (quoted) throw new Error("Close the quotation marks in the CSV.");
  if (cell || closedQuote || row.length) { row.push(preserveCellText ? cell : cell.trim()); rows.push(row); }
  return rows;
}

export function parseDataTable(csv: string): ParsedDataTable {
  if (csv.length > DATA_TABLE_FIELD_LIMITS.csv) throw new Error("Use at most 80,000 characters of CSV data.");
  const rows = csvRows(csv.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  const headers = rows.shift() ?? [];
  if (!headers.length || headers.some((header) => !header)) throw new Error("Give each column a header in the first row.");
  if (headers.length > 12) throw new Error("Use at most 12 columns.");
  if (!rows.length || rows.length > 100) throw new Error("Add 1–100 data rows after the header row.");
  if (rows.some((row) => row.every((cell) => !cell))) throw new Error("Remove empty data rows.");
  if (rows.some((row) => row.length !== headers.length)) throw new Error("Use the same number of columns in every row.");
  return { headers, rows };
}

/** Validate with the public contract, but retain original cell text for editing. */
export function parseDataTableForEditing(csv: string): ParsedDataTable {
  parseDataTable(csv);
  const rows = csvRows(csv.replace(/^\uFEFF/, ""), true);
  return { headers: rows.shift() ?? [], rows };
}

export function dataTableError(data: DataTableData): string | null {
  if (data.title.length > DATA_TABLE_FIELD_LIMITS.title) return "Use 250 characters or fewer for the table title.";
  if (data.source.length > DATA_TABLE_FIELD_LIMITS.source) return "Use 500 characters or fewer for the source label.";
  if (data.sourceHref.length > DATA_TABLE_FIELD_LIMITS.sourceHref) return "Use 2,000 characters or fewer for the source URL.";
  if (!data.title.trim()) return "Give the data table a title.";
  if (data.sourceHref.trim() && (!data.source.trim() || safeHref(data.sourceHref) === null)) return "Give the source link a label and an approved URL.";
  try { parseDataTable(data.csv); return null; }
  catch (error) { return error instanceof Error ? error.message : "Check the CSV data."; }
}

export function isDataTableData(data: Record<string, unknown>, publishable: boolean): boolean {
  if (Object.keys(data).some((key) => !Object.hasOwn(DATA_TABLE_FIELD_LIMITS, key))) return false;
  if (!Object.entries(DATA_TABLE_FIELD_LIMITS).every(([key, limit]) => typeof data[key] === "string" && data[key].length <= limit)) return false;
  return !publishable || dataTableError(data as unknown as DataTableData) === null;
}
