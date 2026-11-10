// Generated from packages/content-core/src/data-table.ts.
// Regenerate with: node scripts/generate-data-table-contract.mjs
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/content-core/src/data-table.ts
var data_table_exports = {};
__export(data_table_exports, {
  DATA_TABLE_FIELD_LIMITS: () => DATA_TABLE_FIELD_LIMITS,
  dataTableError: () => dataTableError,
  isDataTableData: () => isDataTableData,
  parseDataTable: () => parseDataTable,
  parseDataTableForEditing: () => parseDataTableForEditing
});
module.exports = __toCommonJS(data_table_exports);

// packages/content-core/src/safe-href.ts
var SAFE_SCHEMES = /* @__PURE__ */ new Set(["http", "https", "mailto", "tel"]);
function safeHref(raw) {
  if (typeof raw !== "string") return null;
  const href = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (href.length === 0) return null;
  if (href.replace(/\\/g, "/").startsWith("//")) return null;
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
  const protocol = scheme?.[1].toLowerCase();
  if (protocol && !SAFE_SCHEMES.has(protocol)) return null;
  if (protocol === "http" || protocol === "https") {
    try {
      const url = new URL(href);
      if (url.username || url.password) return null;
    } catch {
      return null;
    }
  }
  return href;
}

// packages/content-core/src/data-table.ts
var DATA_TABLE_FIELD_LIMITS = Object.freeze({
  title: 250,
  csv: 8e4,
  source: 500,
  sourceHref: 2e3
});
function csvRows(csv, preserveCellText = false) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      if (csv[i + 1] === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      quoted = false;
      closedQuote = true;
      continue;
    }
    if (char === '"' && !cell && !closedQuote) {
      quoted = true;
      continue;
    }
    const newline = char === "\n" || preserveCellText && char === "\r";
    if (char !== "," && !newline) {
      if (closedQuote || char === '"') throw new Error("Check the quotation marks in the CSV.");
      cell += char;
      continue;
    }
    row.push(preserveCellText ? cell : cell.trim());
    cell = "";
    closedQuote = false;
    if (row.length > 12) throw new Error("Use at most 12 columns.");
    if (newline) {
      rows.push(row);
      row = [];
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
    }
    if (rows.length > 101) throw new Error("Use at most 100 data rows.");
  }
  if (quoted) throw new Error("Close the quotation marks in the CSV.");
  if (cell || closedQuote || row.length) {
    row.push(preserveCellText ? cell : cell.trim());
    rows.push(row);
  }
  return rows;
}
function parseDataTable(csv) {
  if (csv.length > DATA_TABLE_FIELD_LIMITS.csv) throw new Error("Use at most 80,000 characters of CSV data.");
  const rows = csvRows(csv.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  const headers = rows.shift() ?? [];
  if (!headers.length || headers.some((header) => !header)) throw new Error("Give each column a header in the first row.");
  if (headers.length > 12) throw new Error("Use at most 12 columns.");
  if (!rows.length || rows.length > 100) throw new Error("Add 1\u2013100 data rows after the header row.");
  if (rows.some((row) => row.every((cell) => !cell))) throw new Error("Remove empty data rows.");
  if (rows.some((row) => row.length !== headers.length)) throw new Error("Use the same number of columns in every row.");
  return { headers, rows };
}
function parseDataTableForEditing(csv) {
  parseDataTable(csv);
  const rows = csvRows(csv.replace(/^\uFEFF/, ""), true);
  return { headers: rows.shift() ?? [], rows };
}
function dataTableError(data) {
  if (data.title.length > DATA_TABLE_FIELD_LIMITS.title) return "Use 250 characters or fewer for the table title.";
  if (data.source.length > DATA_TABLE_FIELD_LIMITS.source) return "Use 500 characters or fewer for the source label.";
  if (data.sourceHref.length > DATA_TABLE_FIELD_LIMITS.sourceHref) return "Use 2,000 characters or fewer for the source URL.";
  if (!data.title.trim()) return "Give the data table a title.";
  if (data.sourceHref.trim() && (!data.source.trim() || safeHref(data.sourceHref) === null)) return "Give the source link a label and an approved URL.";
  try {
    parseDataTable(data.csv);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Check the CSV data.";
  }
}
function isDataTableData(data, publishable) {
  if (Object.keys(data).some((key) => !Object.hasOwn(DATA_TABLE_FIELD_LIMITS, key))) return false;
  if (!Object.entries(DATA_TABLE_FIELD_LIMITS).every(([key, limit]) => typeof data[key] === "string" && data[key].length <= limit)) return false;
  return !publishable || dataTableError(data) === null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DATA_TABLE_FIELD_LIMITS,
  dataTableError,
  isDataTableData,
  parseDataTable,
  parseDataTableForEditing
});
