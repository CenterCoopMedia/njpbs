// Shared row grammar and grouping. Catalog admission, transport and editor
// controls must land together before a saved document can use this grammar.
export interface RowData {
  columns: number[];
}

export interface BlockLayout {
  rowId: string;
  column: number;
}

export interface LayoutBlock {
  readonly id: string;
  type: string;
  order: number;
  visible: boolean;
  section?: string;
  layout?: BlockLayout;
  data: object;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRowData(value: unknown): value is RowData {
  if (!isRecord(value) || Object.keys(value).some(key => key !== "columns")) return false;
  const columns = value.columns;
  return Array.isArray(columns) && columns.length >= 1 && columns.length <= 4 &&
    Array.from(columns).every(width => Number.isInteger(width) && width >= 1 && width <= 12) &&
    columns.reduce((sum, width) => sum + width, 0) === 12;
}

function isBlockLayout(value: unknown): value is BlockLayout {
  return isRecord(value) &&
    Object.keys(value).every(key => key === "rowId" || key === "column") &&
    typeof value.rowId === "string" && value.rowId.length > 0 &&
    Number.isInteger(value.column) && (value.column as number) >= 0;
}

/** Call after ordinary envelope and content validation, including unique IDs. */
export function contentLayoutError(blocks: readonly LayoutBlock[]): string | null {
  if (!blocks.some(block => block.type === "row" || block.layout !== undefined)) return null;
  let row: { id: string; columns: number[] } | null = null;
  let previousColumn = 0;
  for (const [index, block] of blocks.entries()) {
    // Public projections sort by order. Requiring the same array order avoids
    // accepting one grouping in the editor and another in a public build.
    if (block.order !== index) return "Row layouts require block order to match array position";
    if (block.type === "row") {
      if (!isRowData(block.data)) return `Row ${block.id} has invalid column widths`;
      if (block.section !== undefined || block.layout !== undefined) {
        return `Row ${block.id} cannot be nested or own a named page region`;
      }
      row = { id: block.id, columns: block.data.columns };
      previousColumn = 0;
      continue;
    }
    if (block.layout === undefined) {
      row = null;
      continue;
    }
    if (!isBlockLayout(block.layout)) return `Block ${block.id} has invalid row membership`;
    if (block.section !== undefined) return `Block ${block.id} cannot move a named page region into a row`;
    if (!row || row.id !== block.layout.rowId) return `Block ${block.id} must follow its row and its other content`;
    if (block.layout.column >= row.columns.length) return `Block ${block.id} refers to a missing column`;
    if (block.layout.column < previousColumn) return `Row ${row.id} content must follow column reading order`;
    previousColumn = block.layout.column;
  }
  return null;
}

/** Filter a whole validated composition, before projecting individual blocks. */
export function visibleLayoutBlocks<B extends LayoutBlock>(blocks: readonly B[]): B[] {
  if (!blocks.some(block => block.type === "row" || block.layout !== undefined)) {
    return blocks.filter(block => block.visible);
  }
  const hiddenRows = new Set(blocks.filter(block => block.type === "row" && !block.visible).map(block => block.id));
  return blocks.filter(block => block.visible && (!block.layout || !hiddenRows.has(block.layout.rowId)))
    .map((block, order) => ({ ...block, order }));
}

export interface ContentRow<B> {
  // A null row is legacy, ungrouped content; render it without a new wrapper.
  row: B | null;
  columns: B[][];
}

/** Group already validated content without cloning or rewriting its payloads. */
export function groupContentRows<B extends LayoutBlock>(blocks: readonly B[]): ContentRow<B>[] {
  const error = contentLayoutError(blocks);
  if (error) throw new Error(error);
  const groups: ContentRow<B>[] = [];
  for (const block of blocks) {
    if (block.type === "row") {
      const data = block.data as RowData;
      groups.push({ row: block, columns: data.columns.map(() => []) });
    } else if (block.layout) {
      // The validator above proves the immediately preceding group is its row.
      groups[groups.length - 1].columns[block.layout.column].push(block);
    } else {
      groups.push({ row: null, columns: [[block]] });
    }
  }
  return groups;
}

/** Remap membership with the same ID receipt used for the blocks themselves. */
export function remapRowMembership<B extends LayoutBlock>(blocks: readonly B[], ids: Readonly<Record<string, string>>): B[] {
  return blocks.map(block => {
    const rowId = block.layout?.rowId;
    if (rowId === undefined || !Object.hasOwn(ids, rowId)) return block;
    return { ...block, layout: { ...block.layout!, rowId: ids[rowId] } };
  });
}
