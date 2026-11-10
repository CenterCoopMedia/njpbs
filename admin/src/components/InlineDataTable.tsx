import { useEffect, useRef, useState } from "react";
import { FieldRenderer } from "./FieldRenderer";
import type { AdminBlock } from "../lib/block-factory";
import { editorFieldsForBlock } from "../../../packages/content-core/src/editor-admin";
import { dataTableError, parseDataTable, type DataTableData } from "../../../packages/content-core/src/data-table";
import { DataTableGrid } from "./DataTableGrid";
import "./DataTableGrid.css";
import { ActionControl } from "./ui/ActionControl";
import { createCsvDownload, csvHasSpreadsheetFormulas, readCsvFile } from "../lib/data-table-csv-file";
import "./InlineDataTable.css";

export function InlineDataTable({ block, onChange, readOnly = false }: { block: AdminBlock; onChange: (data: Record<string, unknown>, discrete?: boolean) => void; readOnly?: boolean }) {
  const data: DataTableData = { title: String(block.data.title ?? ""), csv: String(block.data.csv ?? ""), source: String(block.data.source ?? ""), sourceHref: String(block.data.sourceHref ?? "") };
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ block, onChange, readOnly });
  latest.current = { block, onChange, readOnly };
  const importSequence = useRef(0);
  const [fileStatus, setFileStatus] = useState<{ message: string; error?: boolean } | null>(null);
  useEffect(() => {
    setFileStatus(null);
    return () => { importSequence.current += 1; };
  }, [block.id, readOnly]);

  let counts: string | null = null;
  try {
    const table = parseDataTable(data.csv);
    counts = `${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"} · ${table.headers.length} ${table.headers.length === 1 ? "column" : "columns"}`;
  } catch { /* The existing validation message explains incomplete CSV. */ }

  async function importFile(file: File) {
    if (latest.current.readOnly || fileInput.current?.matches(":disabled")) return;
    const sequence = ++importSequence.current;
    const original = latest.current.block;
    setFileStatus({ message: "Reading CSV file…" });
    const isCurrent = () => {
      if (sequence !== importSequence.current) return false;
      if (latest.current.block.id !== original.id
        || latest.current.block.data.csv !== original.data.csv
        || latest.current.readOnly || fileInput.current?.matches(":disabled")) {
        setFileStatus(null);
        return false;
      }
      return true;
    };
    try {
      const csv = await readCsvFile(file);
      if (!isCurrent()) return;
      latest.current.onChange({ ...latest.current.block.data, csv }, true);
      setFileStatus({ message: "CSV imported. Review the table before saving." });
    } catch (error) {
      if (!isCurrent()) return;
      setFileStatus({ error: true, message: error instanceof Error ? error.message : "Could not import this CSV. Choose the file again." });
    }
  }

  function changeCsv(csv: string) {
    importSequence.current += 1;
    setFileStatus(null);
    onChange({ ...block.data, csv });
  }

  function exportFile() {
    try {
      if (csvHasSpreadsheetFormulas(data.csv) && !window.confirm(
        "Some cells begin with spreadsheet formula characters. Spreadsheet apps may run these cells as formulas. Export the original CSV anyway?"
      )) return;
      const { blob, filename } = createCsvDownload(data.csv, data.title);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      try { link.click(); }
      finally { window.setTimeout(() => URL.revokeObjectURL(url), 0); }
    } catch (error) {
      setFileStatus({ error: true, message: error instanceof Error ? error.message : "Could not export this CSV. Try again." });
    }
  }
  const error = dataTableError(data);
  return <div className="inline-block-surface inline-data-table">
    {editorFieldsForBlock("data_table").map((field) => {
      const id = `block-${block.id}-${field.key}`;
      return <div key={field.key} className={`inline-data-table__field inline-data-table__field--${field.key}`}><FieldRenderer field={field.key === "csv" ? { ...field, label: "Table data", help: "Edit column headers and cells. Use up to 12 columns and 100 data rows." } : field} fieldId={id} value={data[field.key as keyof DataTableData]}
        onChange={(value) => onChange({ ...block.data, [field.key]: value })}
        control={field.key === "csv" ? <>
          <input ref={fileInput} className="inline-data-table__file-input" type="file" disabled={readOnly} accept=".csv,text/csv" aria-label="Choose CSV file" tabIndex={-1}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void importFile(file);
            }} />
          <DataTableGrid id={id} csv={data.csv} readOnly={readOnly} onChange={changeCsv} actions={<>
            <ActionControl action="upload-csv" disabled={readOnly} onClick={() => fileInput.current?.click()} />
            <ActionControl action="export-csv" disabled={readOnly || !counts} onClick={exportFile} />
          </>} />
          {counts && <span className="inline-data-table__counts">{counts}</span>}
          <details className="inline-data-table__advanced">
            <summary>Advanced CSV</summary>
            <label htmlFor={`${id}-raw`}>CSV data</label>
            <textarea id={`${id}-raw`} readOnly={readOnly} value={data.csv} maxLength={80000}
              aria-describedby={`${id}-help ${id}-file-status`}
              onChange={(event) => changeCsv(event.target.value)} />
          </details>
          <p id={`${id}-file-status`} className="inline-data-table__file-status" role={fileStatus?.error ? "alert" : "status"}>{fileStatus?.message}</p>
        </> : undefined} /></div>;
    })}
    {error && <p>{error} Complete the table before saving.</p>}
  </div>;
}
