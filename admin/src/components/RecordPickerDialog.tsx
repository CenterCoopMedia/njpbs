import { useContext, useEffect, useId, useRef, useState } from "react";
import type { RecordCardKind } from "../../../packages/content-core/src/content-model";
import { DEFAULT_CONTENT_QUERY } from "../lib/content-query";
import type { ContentRecordSummary } from "../lib/content-records";
import { ContentShelfSources } from "./ContentShelfPicker";
import { Button, Select, TextInput } from "./ui/Primitives";
import "./RecordPickerDialog.css";

const kinds: readonly RecordCardKind[] = ["program", "event", "sponsor", "newsletter"];

export function RecordPickerDialog({ open, onClose, onChoose }: {
  open: boolean;
  onClose: () => void;
  onChoose: (record: ContentRecordSummary) => void;
}) {
  const { loadLibrarySelection } = useContext(ContentShelfSources);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const searchId = useId();
  const [kind, setKind] = useState<RecordCardKind | "all">("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<ContentRecordSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [loadedKey, setLoadedKey] = useState("");
  const updating = searchDraft !== query;
  const requestKey = `${kind}|${query}|${page}`;
  const loadingResults = busy || updating || loadedKey !== requestKey;

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      setQuery(searchDraft);
      setPage(1);
    }, 200);
    return () => globalThis.clearTimeout(timer);
  }, [searchDraft]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement
        ? document.activeElement : null;
      element.showModal();
      element.querySelector("input")?.focus();
    }
    if (!open) {
      if (element.open) element.close();
      opener.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!open) {
      setLoadedKey("");
      return;
    }
    if (!loadLibrarySelection) {
      setError("Record search is unavailable. Reopen this editor and try again.");
      return;
    }
    let current = true;
    setBusy(true);
    setError("");
    setRecords([]);
    void loadLibrarySelection({
      ...DEFAULT_CONTENT_QUERY,
      types: kind === "all" ? [...kinds] : [kind],
      statuses: [],
      q: query.trim(),
      page,
    }).then(result => {
      if (!current) return;
      setRecords(result.records.filter(record => kinds.includes(record.kind as RecordCardKind)));
      setPageCount(result.pageCount);
      setLoadedKey(requestKey);
    }).catch(() => {
      if (current) setError("Records could not be loaded. Try again.");
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [open, loadLibrarySelection, kind, query, page, requestKey]);

  return <dialog ref={dialog} aria-label="Choose a record" onClose={onClose} onCancel={onClose}
    className="record-picker-dialog">
    <div className="record-picker-dialog__head">
      <h2>Choose a record</h2>
      <Button onClick={onClose}>Close</Button>
    </div>
    <div className="record-picker-dialog__filters">
      <label htmlFor={searchId}>Search by title or name</label>
      <TextInput id={searchId} value={searchDraft} onChange={event =>
        setSearchDraft(event.target.value)} />
      <label htmlFor={`${searchId}-kind`}>Record type</label>
      <Select id={`${searchId}-kind`} value={kind} onChange={event => {
        setKind(event.target.value as RecordCardKind | "all"); setPage(1);
      }}>
        <option value="all">All types</option>
        {kinds.map(value => <option key={value} value={value}>{value}</option>)}
      </Select>
    </div>
    {loadingResults && !error ? <p role="status">Loading records…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!loadingResults && !error ? <p role="status" aria-live="polite">
      {records.length === 0
        ? "No records found."
        : `${records.length} ${records.length === 1 ? "record" : "records"} on this page.`}
    </p> : null}
    <ul className="record-picker-dialog__results">
      {!loadingResults && !error ? records.map(record => <li key={`${record.kind}:${record.id}`}>
        <Button onClick={() => { onChoose(record); onClose(); }}>
          {record.thumbnailUrl ? <img src={record.thumbnailUrl} alt="" width="56" height="42" /> : null}
          <span>{record.title}</span>
          <span>{record.kind} · {record.status}</span>
        </Button>
      </li>) : null}
    </ul>
    {pageCount > 1 ? <div className="button-row">
      <Button disabled={page <= 1 || loadingResults} onClick={() => setPage(value => value - 1)}>Previous</Button>
      <span>Page {page} of {pageCount}</span>
      <Button disabled={page >= pageCount || loadingResults} onClick={() => setPage(value => value + 1)}>Next</Button>
    </div> : null}
  </dialog>;
}
