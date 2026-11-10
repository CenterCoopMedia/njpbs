import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DATA_TABLE_FIELD_LIMITS, parseDataTableForEditing, type ParsedDataTable } from "../../../packages/content-core/src/data-table";
import { serializeDataTable } from "../lib/data-table-grid";
import { ActionControl } from "./ui/ActionControl";

interface DataTableGridProps {
  csv: string;
  onChange: (csv: string) => void;
  readOnly?: boolean;
  id?: string;
  actions?: ReactNode;
}

function gridFromCsv(csv: string): ParsedDataTable | null {
  if (!csv) return { headers: ["", ""], rows: [["", ""]] };
  try { return parseDataTableForEditing(csv); }
  catch { return null; }
}

export function DataTableGrid({ csv, onChange, readOnly = false, id, actions }: DataTableGridProps) {
  const grid = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  useEffect(() => () => {
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
  }, []);
  const [editError, setEditError] = useState<string | null>(null);
  useEffect(() => { setEditError(null); }, [csv]);
  const [selection, setSelection] = useState({ row: 0, column: 0 });
  const generatedId = useId();
  const gridId = id ?? generatedId;
  const [draft, setDraft] = useState(() => ({ csv, table: gridFromCsv(csv) }));
  // Keep incomplete cells and exact typing locally until an external CSV replaces them.
  const table = csv === draft.csv ? draft.table : gridFromCsv(csv);

  const selectedRow = Math.min(selection.row, Math.max(0, (table?.rows.length ?? 1) - 1));
  const selectedColumn = Math.min(selection.column, Math.max(0, (table?.headers.length ?? 1) - 1));

  function change(next: ParsedDataTable, focus?: { row: number; column: number; header?: boolean }) {
    if (readOnly) return;
    const nextCsv = serializeDataTable(next);
    if (nextCsv.length > DATA_TABLE_FIELD_LIMITS.csv) {
      setEditError("This edit exceeds the 80,000-character CSV limit, including quotation marks. Shorten a cell or remove a row or column, then try again. Your previous table is unchanged.");
      return;
    }
    setEditError(null);
    setDraft({ csv: nextCsv, table: next });
    onChange(nextCsv);
    if (focus) {
      setSelection(focus);
      if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
      pendingFocus.current = requestAnimationFrame(() => grid.current?.querySelector<HTMLTextAreaElement>(
        focus.header ? `[data-header="${focus.column}"]` : `[data-row="${focus.row}"][data-column="${focus.column}"]`
      )?.focus());
    }
  }

  if (!table) return <div className="data-table-grid">
    <div className="data-table-grid__actions">{actions}</div>
    <p id={gridId} tabIndex={-1} className="data-table-grid__invalid" role="status">
      This CSV needs a correction before it can open in the grid. Open Advanced CSV to correct it, or upload a valid CSV file.
    </p>
  </div>;

  return <div ref={grid} className="data-table-grid">
    {editError && <p role="alert" className="error-text">{editError}</p>}
    <div className="data-table-grid__actions">
      {actions}
      <ActionControl action="table-add-row" disabled={readOnly || table.rows.length >= 100}
        onClick={() => change({ ...table, rows: [...table.rows, table.headers.map(() => "")] }, { row: table.rows.length, column: selectedColumn })} />
      <ActionControl action="table-remove-row" label={`Delete selected row ${selectedRow + 1}`} disabled={readOnly || table.rows.length <= 1}
        onClick={() => change({ ...table, rows: table.rows.filter((_, index) => index !== selectedRow) }, { row: Math.min(selectedRow, table.rows.length - 2), column: selectedColumn })} />
      <ActionControl action="table-add-column" disabled={readOnly || table.headers.length >= 12}
        onClick={() => change({ headers: [...table.headers, ""], rows: table.rows.map((row) => [...row, ""]) }, { row: selectedRow, column: table.headers.length, header: true })} />
      <ActionControl action="table-remove-column" label={`Delete selected column ${selectedColumn + 1}`} disabled={readOnly || table.headers.length <= 1}
        onClick={() => change({ headers: table.headers.filter((_, index) => index !== selectedColumn), rows: table.rows.map((row) => row.filter((_, index) => index !== selectedColumn)) }, { row: selectedRow, column: Math.min(selectedColumn, table.headers.length - 2) })} />
    </div>
    <div className="data-table-grid__scroll" role="region" aria-label="Data table cells" tabIndex={0}>
      <table className="data-table-grid__table">
        <caption>Editable data table</caption>
        <thead><tr>
          <th scope="col">Row</th>
          {table.headers.map((header, columnIndex) => <th scope="col" key={columnIndex} className="data-table-grid__column" data-selected-column={columnIndex === selectedColumn || undefined}>
            <textarea data-header={columnIndex} id={columnIndex === 0 ? gridId : undefined} aria-label={`Column ${columnIndex + 1} header`} rows={1} readOnly={readOnly} value={header} onFocus={() => setSelection({ row: selectedRow, column: columnIndex })}
              onChange={(event) => change({ ...table, headers: table.headers.map((value, index) => index === columnIndex ? event.target.value : value) })} />
          </th>)}
        </tr></thead>
        <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex} data-selected-row={rowIndex === selectedRow || undefined}>
          <th scope="row" className="data-table-grid__row">
            {rowIndex + 1}
          </th>
          {row.map((cell, columnIndex) => <td key={columnIndex} className="data-table-grid__cell" data-selected-column={columnIndex === selectedColumn || undefined}>
            <textarea data-row={rowIndex} data-column={columnIndex} aria-label={`Row ${rowIndex + 1}, column ${columnIndex + 1}`} rows={1} readOnly={readOnly} value={cell} onFocus={() => setSelection({ row: rowIndex, column: columnIndex })}
              onChange={(event) => change({ ...table, rows: table.rows.map((values, index) => index === rowIndex ? values.map((value, column) => column === columnIndex ? event.target.value : value) : values) })} />
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}
