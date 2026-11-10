import type { ParsedDataTable } from "../../../packages/content-core/src/data-table";

/** Keep incomplete cells in the draft; save and export validate separately. */
export function serializeDataTable({ headers, rows }: ParsedDataTable): string {
  // Quote empty cells too, so a final empty one-column row remains a CSV row.
  return [headers, ...rows].map((row) =>
    row.map((cell) => !cell || /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(",")
  ).join("\n");
}
