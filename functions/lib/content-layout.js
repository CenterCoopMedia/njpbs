"use strict";

// Deployment-safe CommonJS mirror of the row layout contract in
// packages/content-core/src/content-layout.ts. Keep behavior aligned through
// site/tests/content-layout-parity.test.ts.

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRowData(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "columns")) return false;
  const columns = value.columns;
  return Array.isArray(columns) && columns.length >= 1 && columns.length <= 4 &&
    Array.from(columns).every((width) => Number.isInteger(width) && width >= 1 && width <= 12) &&
    columns.reduce((sum, width) => sum + width, 0) === 12;
}

function isBlockLayout(value) {
  return isRecord(value) &&
    Object.keys(value).every((key) => key === "rowId" || key === "column") &&
    typeof value.rowId === "string" && value.rowId.length > 0 &&
    Number.isInteger(value.column) && value.column >= 0;
}

function contentLayoutError(blocks) {
  if (!blocks.some((block) => block.type === "row" || block.layout !== undefined)) return null;
  let row = null;
  let previousColumn = 0;
  for (const [index, block] of blocks.entries()) {
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

function visibleLayoutBlocks(blocks) {
  if (!blocks.some((block) => block.type === "row" || block.layout !== undefined)) {
    return blocks.filter((block) => block.visible);
  }
  const hiddenRows = new Set(
    blocks.filter((block) => block.type === "row" && !block.visible).map((block) => block.id),
  );
  return blocks
    .filter((block) => block.visible && (!block.layout || !hiddenRows.has(block.layout.rowId)))
    .map((block, order) => ({ ...block, order }));
}

function groupContentRows(blocks) {
  const error = contentLayoutError(blocks);
  if (error) throw new Error(error);
  const groups = [];
  for (const block of blocks) {
    if (block.type === "row") {
      groups.push({ row: block, columns: block.data.columns.map(() => []) });
    } else if (block.layout) {
      groups[groups.length - 1].columns[block.layout.column].push(block);
    } else {
      groups.push({ row: null, columns: [[block]] });
    }
  }
  return groups;
}

function remapRowMembership(blocks, ids) {
  return blocks.map((block) => {
    const rowId = block.layout?.rowId;
    if (rowId === undefined || !Object.hasOwn(ids, rowId)) return block;
    return { ...block, layout: { ...block.layout, rowId: ids[rowId] } };
  });
}

module.exports = {
  contentLayoutError,
  groupContentRows,
  isRowData,
  remapRowMembership,
  visibleLayoutBlocks,
};
