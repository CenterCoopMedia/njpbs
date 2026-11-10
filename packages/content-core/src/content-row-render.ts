import { escapeHtml, type PageBlock } from "./content-model";
import { groupContentRows, isRowData } from "./content-layout";

interface RenderedContent {
  html: string;
  id?: string;
  generatedHeadingLevel?: number;
}

export interface RenderedContentGroup extends RenderedContent {
  block: PageBlock;
  /** Present when Astro must render a record card component inside this row. */
  columns?: RenderedContentGroup[][];
}

export function contentBlockHtml({ block, html, id }: RenderedContentGroup): string {
  const anchor = id === undefined ? "" : ` id="${escapeHtml(id)}"`;
  return `<div class="cms-block cms-block--${block.type}"${anchor} data-block-id="${escapeHtml(block.id)}" data-block-type="${block.type}">${html}</div>`;
}

/** Render a validated composition, or its adapter-owned added-content subset. */
export function renderContentGroups(
  blocks: readonly PageBlock[],
  renderLeaf: (block: PageBlock, index: number) => RenderedContent,
): RenderedContentGroup[] {
  // A service adapter removes named regions before rendering the remainder.
  // Reindex that subset for grouping, without changing the source document.
  const ordered = blocks.some(block => block.type === "row" || block.layout !== undefined)
    ? blocks.map((block, order) => ({ ...block, order })) : blocks;
  const indices = new Map(blocks.map((block, index) => [block.id, index]));
  return groupContentRows(ordered).map(({ row, columns }) => {
    if (!row) {
      const block = columns[0][0];
      return { block, ...renderLeaf(block, indices.get(block.id)!) };
    }
    if (!isRowData(row.data)) throw new Error("Invalid row widths");
    const widths = row.data.columns.map(width => `minmax(0, ${width}fr)`).join(" ");
    const renderedColumns = columns.map(column => column.map(block =>
      ({ block, ...renderLeaf(block, indices.get(block.id)!) })));
    const html = renderedColumns.map(column => `<div class="cms-row__column">${column.map(
      contentBlockHtml,
    ).join("")}</div>`).join("");
    return {
      block: row,
      html: `<div class="cms-row" style="--cms-columns: ${widths}">${html}</div>`,
      ...(renderedColumns.some(column => column.some(item => item.block.type === "record_card"))
        ? { columns: renderedColumns } : {}),
    };
  });
}
