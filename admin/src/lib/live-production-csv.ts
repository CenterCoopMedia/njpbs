import { parseBannerText, type BannerText } from "../../../packages/content-core/src/live-production";

export const LIVE_CSV_MAX_BYTES = 240 * 1024;
export type CsvRowError = { row: number | null; message: string };
export type BannerCsvPreview = {
  banners: { row: number; text: BannerText }[];
  errors: CsvRowError[];
};
export function csvRequestFits(csv: string, sessionId: string, archiveExisting: boolean): boolean {
  const request = { action: "import_csv", sessionId, requestId: "0".repeat(36), csv, ...(archiveExisting ? { archiveExisting: true } : {}) };
  return new TextEncoder().encode(JSON.stringify(request)).byteLength <= 256 * 1024;
}

// Browser-only preview of the documented CSV grammar. The server validates again
// at import; no preview request can mutate the rundown.
export function previewBannerCsv(csv: string): BannerCsvPreview {
  const invalid = (row: number | null, message: string): BannerCsvPreview => ({ banners: [], errors: [{ row, message }] });
  if (new TextEncoder().encode(csv).byteLength > LIVE_CSV_MAX_BYTES) {
    return invalid(null, "CSV must be 240 KiB or smaller.");
  }
  const input = csv.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let cells: string[] = [], value = "";
  let mode: "start" | "plain" | "quoted" | "closed" = "start";
  const cell = () => { cells.push(value); value = ""; mode = "start"; };
  const record = () => { cell(); records.push(cells); cells = []; };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (mode === "quoted") {
      if (char !== '"') value += char;
      else if (input[index + 1] === '"') { value += '"'; index++; }
      else mode = "closed";
    } else if (char === ",") cell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index++;
      record();
    } else if (char === '"' && mode === "start") mode = "quoted";
    else {
      if (mode === "closed" || char === '"') return invalid(records.length + 1, "Invalid CSV quoting.");
      value += char; mode = "plain";
    }
    if (records.length > 101) return invalid(null, "Import at most 100 banners.");
  }
  if (mode === "quoted") return invalid(records.length + 1, "Unclosed CSV quote.");
  if (cells.length || mode !== "start") record();
  if (records.length > 101) return invalid(null, "Import at most 100 banners.");
  if (JSON.stringify(records.shift()) !== JSON.stringify(["templateId", "headline", "name", "title"])) {
    return invalid(1, "CSV header must be templateId,headline,name,title.");
  }
  if (!records.length) return invalid(null, "CSV has no banner rows.");
  const preview: BannerCsvPreview = { banners: [], errors: [] };
  records.forEach((fields, index) => {
    const row = index + 2;
    const error = (message: string) => preview.errors.push({ row, message });
    if (fields.length !== 4) { error("Each banner row needs four cells."); return; }
    const [templateId, headline, name, title] = fields;
    if (templateId !== "headline" && templateId !== "name_title") { error("Use headline or name_title for the template."); return; }
    if (templateId === "headline" && (name !== "" || title !== "")) { error("A headline row must leave name and title empty."); return; }
    if (templateId === "name_title" && headline !== "") { error("A name and title row must leave headline empty."); return; }
    try {
      preview.banners.push({ row, text: parseBannerText(templateId === "headline" ? { templateId, headline } : { templateId, name, title }) });
    } catch { error(templateId === "headline" ? "Enter headline text." : "Enter a name. The title may be empty."); }
  });
  return preview;
}
