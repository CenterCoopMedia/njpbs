import { describe, expect, it, vi } from "vitest";
import { parseDataTable } from "../../packages/content-core/src/data-table";
import { createCsvDownload, csvHasSpreadsheetFormulas, readCsvFile } from "../src/lib/data-table-csv-file";

function fileWithBytes(bytes: Uint8Array): File {
  const file = new File([], "table.csv", { type: "text/csv" });
  Object.defineProperties(file, {
    size: { value: bytes.byteLength },
    arrayBuffer: { value: vi.fn().mockResolvedValue(bytes.buffer) },
  });
  return file;
}

function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const quotedCsv = 'Place,Note\r\n"Newark, NJ","She said ""hello"".\nNext line: café"\r\n';

describe("CSV file import", () => {
  it("removes a UTF-8 BOM and preserves quoted cells and line endings", async () => {
    const csv = await readCsvFile(fileWithBytes(new TextEncoder().encode(`\uFEFF${quotedCsv}`)));
    expect(csv).toBe(quotedCsv);
    expect(parseDataTable(csv).rows).toEqual([["Newark, NJ", 'She said "hello".\nNext line: café']]);
  });

  it("rejects invalid UTF-8 instead of replacing cell content", async () => {
    await expect(readCsvFile(fileWithBytes(new Uint8Array([0x61, 0x0a, 0xff]))))
      .rejects.toThrow("Save the file as CSV UTF-8");
  });

  it("rejects oversized files before reading them", async () => {
    const file = fileWithBytes(new Uint8Array(320001));
    await expect(readCsvFile(file)).rejects.toThrow("too large");
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it("reports unreadable files", async () => {
    const file = fileWithBytes(new Uint8Array());
    vi.mocked(file.arrayBuffer).mockRejectedValue(new Error("device unavailable"));
    await expect(readCsvFile(file)).rejects.toThrow("Choose the CSV file again");
  });

  it.each([
    ['Header\n"Unclosed', "Close the quotation marks"],
    [Array.from({ length: 13 }, (_, i) => `Column ${i}`).join(",") + "\n1", "12 columns"],
    ["Header\n" + "value\n".repeat(101), "100 data rows"],
    ["Header\n" + "x".repeat(80000), "80,000 characters"],
  ])("retains canonical parser limits and errors", async (csv, error) => {
    await expect(readCsvFile(fileWithBytes(new TextEncoder().encode(csv)))).rejects.toThrow(error);
  });
});

describe("CSV file export", () => {
  it("exports exact CSV with one UTF-8 BOM and round-trips through import", async () => {
    const { blob, filename } = createCsvDownload(`\uFEFF${quotedCsv}`, "Café / county: figures?");
    expect(filename).toBe("cafe-county-figures.csv");
    expect(blob.type).toBe("text/csv;charset=utf-8");
    const bytes = new Uint8Array(await readBlobBytes(blob));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(`\uFEFF${quotedCsv}`);
    expect(await readCsvFile(fileWithBytes(bytes))).toBe(quotedCsv);
  });

  it("allows a missing title and uses a safe fallback filename", () => {
    expect(createCsvDownload("Header\nValue", "").filename).toBe("data-table.csv");
    expect(createCsvDownload("Header\nValue", "CON").filename).toBe("data-table.csv");
    expect(createCsvDownload("Header\nValue", "../\\").filename).toBe("data-table.csv");
  });

  it("rejects invalid CSV on export", () => {
    expect(() => createCsvDownload("Header", "Table")).toThrow("1–100 data rows");
  });
});

describe("spreadsheet formula detection", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1)", " \t=1+1", "\u0000\u007f+cmd", "\u009f@call"])("flags formula-like text %j", (cell) => {
    expect(csvHasSpreadsheetFormulas(`Header\n"${cell}"`)).toBe(true);
  });

  it("checks column headers too", () => {
    expect(csvHasSpreadsheetFormulas("=1+1\nValue")).toBe(true);
  });

  it.each(["-10", "-0.5", "-.5", "-1.2e-3", "  -12  ", "County", "1+1"])("does not warn for ordinary data %j", (cell) => {
    expect(csvHasSpreadsheetFormulas(`Header\n${cell}`)).toBe(false);
  });
});
