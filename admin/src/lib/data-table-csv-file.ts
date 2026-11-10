import { DATA_TABLE_FIELD_LIMITS, parseDataTable, parseDataTableForEditing } from "../../../packages/content-core/src/data-table";

export async function readCsvFile(file: File): Promise<string> {
  if (file.size > DATA_TABLE_FIELD_LIMITS.csv * 4) {
    throw new Error("This CSV file is too large. Use at most 80,000 characters of CSV data.");
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error("Could not read this file. Choose the CSV file again.");
  }

  let csv: string;
  try {
    csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Save the file as CSV UTF-8, then choose it again.");
  }
  parseDataTable(csv);
  return csv;
}

/** Spreadsheet applications can interpret cell text as formulas when opening CSV. */
export function csvHasSpreadsheetFormulas(csv: string): boolean {
  const { headers, rows } = parseDataTableForEditing(csv);
  return [headers, ...rows].some((row) => row.some((cell) => {
    const value = cell.replace(/^[\s\u0000-\u001f\u007f-\u009f]+/, "").trimEnd();
    if (!/^[=+@-]/.test(value)) return false;
    // Ordinary negative decimal numbers, including scientific notation, are data.
    return !/^-(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
  }));
}

export function createCsvDownload(csv: string, title: string): { blob: Blob; filename: string } {
  parseDataTable(csv);
  const name = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100).replace(/-$/, "");
  const filename = !name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name) ? "data-table" : name;
  return {
    blob: new Blob(["\uFEFF", csv.replace(/^\uFEFF+/, "")], { type: "text/csv;charset=utf-8" }),
    filename: `${filename}.csv`,
  };
}
