import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  DataFigureVersion,
  DatasetPublicProjection,
} from "../../../packages/content-core/src/data-figure";
import { formatDatasetValue, isDatasetPublicProjection } from "../../../packages/content-core/src/data-figure-render";
import type { DatasetApi, DatasetSummary } from "../lib/datasets";
import { Button, StatusBadge, TextInput } from "./ui/Primitives";

export interface DataFigureDatasetApi extends DatasetApi {
  figure(input: { id: string; version: DataFigureVersion }): Promise<DatasetPublicProjection>;
}

function availability(record: DatasetSummary): { available: boolean; label: string } {
  if (record.archived) return { available: false, label: "Archived. This dataset cannot be selected." };
  if (!record.approvedReleaseId) {
    return record.state === "review"
      ? { available: false, label: "In review. Approve a release before selection." }
      : { available: false, label: "Draft only. Approve a release before selection." };
  }
  if (record.state === "approved") return { available: true, label: "Approved" };
  return { available: true, label: `Approved release available. A ${record.state} update is in progress.` };
}

export function DatasetPickerDialog({ api, open, selectedId, onClose, onChoose }: {
  api: DataFigureDatasetApi;
  open: boolean;
  selectedId?: string;
  onClose: () => void;
  onChoose: (projection: DatasetPublicProjection) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const request = useRef(0);
  const candidateRequest = useRef(0);
  const candidateChoice = useRef<HTMLButtonElement>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<DatasetSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [candidate, setCandidate] = useState<DatasetPublicProjection | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);

  const load = useCallback(async (nextCursor?: string) => {
    const sequence = ++request.current;
    setBusy(true); setError("");
    try {
      const result = await api.list(nextCursor);
      if (sequence !== request.current) return;
      setRecords(current => nextCursor ? [...current, ...result.datasets] : result.datasets);
      setCursor(result.nextCursor);
    } catch (error) {
      if (sequence === request.current) setError(error instanceof Error ? error.message : "Datasets could not be loaded.");
    } finally {
      if (sequence === request.current) setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      element.querySelector<HTMLInputElement>("input")?.focus();
    } else if (!open && element.open) {
      element.close(); opener.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!open) { request.current += 1; candidateRequest.current += 1; return; }
    setQuery(""); setCandidate(null); setCandidateBusy(false); setRecords([]); setCursor(null);
    void load();
  }, [load, open]);
  useEffect(() => {
    if (!open || busy || candidateBusy || document.activeElement !== document.body) return;
    if (candidate) candidateChoice.current?.focus();
    else if (error) errorBox.current?.focus();
    else dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [busy, candidate, candidateBusy, error, open]);

  async function review(record: DatasetSummary) {
    if (!record.approvedReleaseId || candidateBusy) return;
    const sequence = ++candidateRequest.current;
    setCandidateBusy(true); setError(""); setCandidate(null);
    try {
      const projection = await api.figure({
        id: record.id,
        version: { mode: "pinned", releaseId: record.approvedReleaseId },
      });
      if (sequence !== candidateRequest.current) return;
      if (!isDatasetPublicProjection(projection) || projection.datasetId !== record.id ||
        projection.releaseId !== record.approvedReleaseId) throw new Error("The approved dataset response did not match this selection.");
      setCandidate(projection);
    } catch (error) {
      if (sequence === candidateRequest.current) setError(error instanceof Error ? error.message : "The approved dataset could not be loaded.");
    } finally {
      if (sequence === candidateRequest.current) setCandidateBusy(false);
    }
  }

  const terms = query.trim().toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
  const visible = records.filter(record => terms.every(term =>
    [record.title, record.state, record.ownerName].join(" ").toLocaleLowerCase("en-US").includes(term)));

  return <dialog className="dataset-picker-dialog" ref={dialog} aria-labelledby={`${searchId}-title`}
    onCancel={onClose} onClose={onClose}>
    <div className="dataset-picker-dialog__head">
      <div><h2 id={`${searchId}-title`}>Choose an approved dataset</h2>
        <p>Review the approved values before you add the figure.</p></div>
      <Button onClick={onClose}>Close</Button>
    </div>
    <label className="dataset-picker-dialog__search" htmlFor={searchId}>Search this dataset page
      <TextInput id={searchId} value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    {busy && records.length === 0 ? <p role="status">Loading datasets…</p> : null}
    {error ? <div ref={errorBox} tabIndex={-1} role="alert" className="dataset-figure-message dataset-figure-message--error"><p>{error}</p>
      <Button disabled={busy || candidateBusy} onClick={() => void load()}>Try again</Button></div> : null}
    {!busy && !error && visible.length === 0 ? <p>No datasets match this page. Drafts appear after staff save them.</p> : null}
    <ul className="dataset-picker-dialog__results">
      {visible.map(record => {
        const status = availability(record);
        const statusId = `${searchId}-${record.id}-status`;
        return <li key={record.id} data-selected={selectedId === record.id || undefined}>
          <div><strong>{record.title}</strong>
            <span id={statusId}><StatusBadge tone={status.available ? "success" : "neutral"}>{status.label}</StatusBadge></span></div>
          <Button disabled={!status.available || busy || candidateBusy} aria-describedby={statusId}
            onClick={() => void review(record)}>Review values</Button>
        </li>;
      })}
    </ul>
    {cursor ? <Button disabled={busy || candidateBusy} onClick={() => void load(cursor)}>{busy ? "Loading…" : "Load more datasets"}</Button> : null}
    {candidate ? <section className="dataset-picker-dialog__candidate" aria-label="Selected approved dataset">
      <div><h3>{candidate.release.label}</h3><StatusBadge tone="success">Approved revision {candidate.revision}</StatusBadge></div>
      <p className="dataset-picker-dialog__value">{formatDatasetValue(candidate.release.value, candidate.release.unit)}</p>
      <dl><div><dt>Period</dt><dd>{candidate.release.period.label}</dd></div>
        <div><dt>Geography</dt><dd>{candidate.release.geography.label}</dd></div>
        <div><dt>Source</dt><dd><a href={candidate.release.source.url} target="_blank" rel="noopener noreferrer">
          {candidate.release.source.publisher}, {candidate.release.source.title}<span className="sr-only"> (opens in new tab)</span></a></dd></div></dl>
      <p>{candidate.release.chartText}</p>
      <Button ref={candidateChoice} variant="primary" onClick={() => { onChoose(candidate); onClose(); }}>Use this approved dataset</Button>
    </section> : candidateBusy ? <p role="status">Loading approved values…</p> : null}
  </dialog>;
}
