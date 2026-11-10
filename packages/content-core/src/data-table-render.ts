import { escapeHtml, safeHref } from "./content-model";
import { dataTableError, parseDataTable, type DataTableData } from "./data-table";

export function renderDataTable(data: DataTableData): string {
  const error = dataTableError(data);
  if (error) return `<p class="cms-data-table__message">${escapeHtml(error)}</p>`;
  const { headers, rows } = parseDataTable(data.csv);
  const heading = headers.map((header) => `<th scope="col"><span>${escapeHtml(header)}</span><button type="button" hidden data-table-sort aria-label="Sort by ${escapeHtml(header)}">${escapeHtml(header)}</button></th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  const href = data.sourceHref.trim() ? safeHref(data.sourceHref) : null;
  const source = data.source.trim() ? `<p class="cms-data-table__source">Source: ${href ? `<a href="${escapeHtml(href)}">${escapeHtml(data.source)}</a>` : escapeHtml(data.source)}</p>` : "";
  return `<section class="cms-data-table" aria-label="${escapeHtml(data.title)}"><label class="cms-data-table__search" hidden>Search table<input type="search" autocomplete="off" /></label><p class="cms-data-table__status" role="status" hidden></p><div class="cms-data-table__scroll" tabindex="0" role="region" aria-label="${escapeHtml(data.title)} data"><table><caption>${escapeHtml(data.title)}</caption><thead><tr>${heading}</tr></thead><tbody>${body}</tbody></table></div>${source}</section>`;
}
