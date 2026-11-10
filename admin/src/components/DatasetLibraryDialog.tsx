import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { can, type Principal } from "../../../packages/content-core/src/rbac";
import { emptyDatasetRelease, validateDatasetRelease, type DatasetRecord, type DatasetRelease } from "../../../packages/content-core/src/datasets";
import { useAuth } from "../context/AuthContext";
import { datasetApi, type DatasetApi, type DatasetSummary, type DatasetRefreshSummary, type DatasetUse } from "../lib/datasets";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { DatasetReleaseFields } from "./DatasetReleaseFields";
import { AsyncActionButton, Button, InlineMessage, Select, StatusBadge, TextInput } from "./ui/Primitives";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { useRegisterContentQuickEditGuard } from "../context/ContentQuickActionsContext";

export function DatasetLibraryDialog({ api, principal, selectedId, onClose, onBack, onSelect, onOpenRecord, guardNavigation = false }: {
  api: DatasetApi; principal: Principal; selectedId?: string; onClose: () => void; onSelect?: (id: string) => void;
  onBack?: () => void;
  onOpenRecord?: (id: string) => void;
  guardNavigation?: boolean;
}) {
  const [records, setRecords] = useState<DatasetSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [record, setRecord] = useState<DatasetRecord | null>(null);
  const [editing, setEditing] = useState(Boolean(selectedId));
  const [release, setRelease] = useState<DatasetRelease>(emptyDatasetRelease);
  const [title, setTitle] = useState("");
  const [useCount, setUseCount] = useState(0);
  const [totalUseCount, setTotalUseCount] = useState(0);
  const [uses, setUses] = useState<DatasetUse[]>([]);
  const [refresh, setRefresh] = useState<DatasetRefreshSummary | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [operation, setOperation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [discard, setDiscard] = useState<"close" | "list" | null>(null);
  const [draftStarted, setDraftStarted] = useState(false);
  const [archiveDecision, setArchiveDecision] = useState(false);
  const [owners, setOwners] = useState<{ uid: string; name: string }[] | null>(null);
  const [ownerCursor, setOwnerCursor] = useState<string | null>(null);
  const [ownerChoice, setOwnerChoice] = useState("");
  const [releases, setReleases] = useState<{ id: string; label: string; releasedOn: string; approvedRevision: number }[]>([]);
  const [releaseCursor, setReleaseCursor] = useState<string | null>(null);
  const discardReturnFocus = useRef<{ element: HTMLElement; fallback: "close" | "back" | null } | null>(null);
  const createdRecordAddress = useRef<string | null>(null);
  const savedRecordAddress = useRef<string | null>(null);
  useEffect(() => {
    if (busy || dirty || !createdRecordAddress.current || !onOpenRecord) return;
    const id = createdRecordAddress.current; createdRecordAddress.current = null; savedRecordAddress.current = id; onOpenRecord(id);
  }, [busy, dirty, onOpenRecord]);
  const pendingKey = useRef<{ signature: string; id: string } | null>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  const archiveConfirm = useRef<HTMLElement>(null);
  const archiveTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (archiveDecision) archiveConfirm.current?.focus(); }, [archiveDecision]);
  const library = useRef<HTMLDivElement>(null);
  const returnToRecord = useRef<string | null>(null);
  const backTrigger = useRef<HTMLButtonElement>(null);
  const editorFields = useRef<HTMLFieldSetElement>(null);
  const errorId = useId();
  const canCreate = can(principal, "content.create", { ownerId: principal.id, unassignedDraft: true });
  const canEdit = !record || record.canEdit;
  const canChange = canEdit && (!record || record.state !== "approved" || draftStarted) && (!selectedId || Boolean(record));
  useEffect(() => {
    if (editing || busy || !returnToRecord.current) return;
    library.current?.querySelector<HTMLElement>(`[data-dataset-open="${CSS.escape(returnToRecord.current)}"]`)?.focus();
    returnToRecord.current = null;
  }, [editing, busy]);
  useEffect(() => {
    if (discard || busy || !discardReturnFocus.current) return;
    const { element, fallback } = discardReturnFocus.current;
    discardReturnFocus.current = null;
    const dialog = editorFields.current?.closest("dialog");
    const target = element.isConnected ? element : fallback === "close"
      ? dialog?.querySelector<HTMLElement>("[data-action=close]") : fallback === "back" ? backTrigger.current : null;
    if (target?.isConnected && document.activeElement === document.body) target.focus();
  }, [busy, discard]);
  useRegisterContentQuickEditGuard({ label: title || "Dataset", dirty, saving: busy,
    save: async () => ({ status: await save() ? "saved" : "failed" }) });
  useEffect(() => {
    for (const input of editorFields.current?.querySelectorAll<HTMLElement>("[data-dataset-invalid]") ?? []) {
      input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); input.removeAttribute("data-dataset-invalid");
    }
    if (!error) return;
    let path = error.split(":", 1)[0];
    const dialog = errorBox.current?.closest("dialog");
    let field = dialog?.querySelector<HTMLElement>(`[data-dataset-path="${CSS.escape(path)}"]`);
    while (!field && path.includes(".")) {
      path = path.slice(0, path.lastIndexOf(".")); field = dialog?.querySelector<HTMLElement>(`[data-dataset-path="${CSS.escape(path)}"]`);
    }
    const details = field?.closest("details");
    if (details) details.open = true;
    const input = field?.matches("input,textarea,select") ? field : field?.querySelector<HTMLElement>("input,textarea,select");
    if (input) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", errorId); input.setAttribute("data-dataset-invalid", "true"); input.focus(); }
    else errorBox.current?.focus();
  }, [error, errorId]);

  function accept(next: DatasetRecord) {
    setRecord(next); setTitle(next.title); setRelease(next.workingRelease);
    setDirty(false); setEditing(true); setReleases([]); setReleaseCursor(null); pendingKey.current = null;
    setDraftStarted(false); setOwners(null); setArchiveDecision(false);
    setRecords(current => [next, ...current.filter(item => item.id !== next.id)]);
  }
  async function run(task: () => Promise<void>, action = "dataset") {
    if (busy) return false;
    setBusy(true); setOperation(action); setError(""); setNotice("");
    try { await task(); return true; } catch (error) { setError(error instanceof Error ? error.message : "The dataset request failed. Try again."); return false; }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (selectedId && savedRecordAddress.current === selectedId) { savedRecordAddress.current = null; return; }
    let current = true;
    setBusy(true); setEditing(Boolean(selectedId)); setRecord(null); setError(""); setNotice("");
    setUseCount(0); setTotalUseCount(0); setUses([]); setRefresh(null);
    const request = selectedId ? api.get(selectedId).then(async result => {
      if (!current) return;
      accept(result.dataset); setUseCount(result.affectedUseCount ?? result.useCount); setTotalUseCount(result.useCount); setUses(result.uses ?? []);
      if (result.dataset.refreshJobId) {
        const nextRefresh = (await api.refresh(result.dataset.id)).refresh;
        if (current) setRefresh(nextRefresh);
      }
    }) : api.list().then(result => {
      if (!current) return;
      setRecords(result.datasets); setCursor(result.nextCursor);
      setEditing(false); setRecord(null); setDirty(false);
    });
    void request.catch(error => { if (current) setError(error instanceof Error ? error.message : "Datasets could not be loaded."); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [api, selectedId]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  function requestDiscard(destination: "close" | "list") {
    if (discard) return;
    const element = document.activeElement;
    if (element instanceof HTMLElement) {
      discardReturnFocus.current = { element, fallback: element.matches("[data-action=close]") ? "close"
        : element === backTrigger.current ? "back" : null };
    }
    setDiscard(destination);
  }
  function close() { if (dirty && !guardNavigation) requestDiscard("close"); else onClose(); }
  async function list() {
    await run(async () => {
      const result = await api.list(); setRecords(result.datasets); setCursor(result.nextCursor);
      setEditing(false); setRecord(null); setDirty(false); setDiscard(null);
      setUseCount(0); setTotalUseCount(0); setUses([]); setRefresh(null);
    });
  }
  function back() {
    returnToRecord.current = record?.id ?? null;
    if (onBack) onBack();
    else if (dirty) requestDiscard("list");
    else void list();
  }
  async function open(id: string) {
    await run(async () => {
      const result = await api.get(id);
      accept(result.dataset); setUseCount(result.affectedUseCount ?? result.useCount); setTotalUseCount(result.useCount); setUses(result.uses ?? []);
      setRefresh(result.dataset.refreshJobId ? (await api.refresh(result.dataset.id)).refresh : null);
    });
  }
  function key(body: unknown) {
    const signature = JSON.stringify(body);
    if (pendingKey.current?.signature !== signature) pendingKey.current = { signature, id: crypto.randomUUID() };
    return pendingKey.current.id;
  }
  async function save() {
    return run(async () => {
      validateDatasetRelease(release);
      const body = { title, release, ...(record ? { id: record.id, baseVersion: record.version } : {}),
        ...(release.changeKind === "correction" && record ? { releaseId: record.workingReleaseId } : {}) };
      const result = await api.save({ ...body, requestId: key(body) });
      if (!record) createdRecordAddress.current = result.dataset.id;
      accept(result.dataset); setNotice("Draft saved. Approved values stay in use until approval.");
    }, "save");
  }
  async function transition(action: "review" | "approve" | "archive") {
    if (!record || dirty) return;
    await run(async () => {
      if (action === "approve" || action === "archive") {
        const fresh = await api.get(record.id);
        const affected = fresh.affectedUseCount ?? fresh.useCount;
        setUseCount(affected); setTotalUseCount(fresh.useCount);
        if (fresh.dataset.version !== record.version || (action === "approve" ? affected !== useCount : fresh.useCount !== totalUseCount)) throw new Error("This dataset or its uses changed. Reload it, then review approval again.");
      }
      const body = { action, id: record.id, baseVersion: record.version, ...(["approve", "archive"].includes(action) ? { expectedUseCount: action === "archive" ? totalUseCount : useCount } : {}) };
      const result = await api.transition({ ...body, requestId: key(body) });
      accept(result.dataset);
      setRefresh(result.dataset.refreshJobId ? (await api.refresh(result.dataset.id)).refresh : null);
      setNotice(action === "review" ? "Review requested. The approved release stays in use." : action === "archive" ? "Dataset archived. Its history is retained." : "Dataset revision approved. Check the public update receipts below.");
    }, action);
  }
  return <ControlSizingProvider size="standard"><ComponentEditorDialog open className="dataset-editor-dialog" closeActionLabel="Close" title={editing ? "Edit dataset" : "Datasets"} onClose={close}
    closeDisabled={busy} footerNote={editing ? "Save stays a draft. Review and approval are separate actions." : "Shared source records for Data figures."}
    footerActions={editing && canChange ? <>
      <AsyncActionButton variant="primary" disabled={busy || !title.trim() || !dirty} pending={busy && operation === "save"} pendingLabel="Saving draft…" label="Save draft" onClick={() => void save()} />
      {record?.state === "draft" ? <AsyncActionButton disabled={busy || dirty} pending={busy && operation === "review"} pendingLabel="Requesting review…" label="Request review" onClick={() => void transition("review")} /> : null}
      {record?.state === "review" && record.canApprove ? <Button disabled={busy || dirty || Boolean(refresh && refresh.status !== "success")} onClick={() => void transition("approve")}>
        {release.changeKind === "correction" ? `Approve correction and update ${useCount} uses` : `Approve release and update ${useCount} latest uses`}
      </Button> : null}
    </> : undefined}>
    {error ? <div id={errorId} ref={errorBox} tabIndex={-1}><InlineMessage tone="error">{error}</InlineMessage></div> : null}
    {notice ? <InlineMessage tone="success">{notice}</InlineMessage> : null}
    {busy && editing ? <p role="status">{operation === "approve" ? "Approving this release…" : operation === "archive" ? "Archiving this dataset…" : operation === "assign" ? "Changing the dataset owner…" : operation === "review" ? "Requesting review…" : operation === "save" ? "Saving this draft…" : "Loading dataset details…"}</p> : null}
    {discard ? <InlineMessage tone="warning"><p>Discard unsaved dataset changes?</p><div className="button-row"><Button variant="danger" disabled={busy} onClick={() => {
      discardReturnFocus.current = null; if (discard === "list") void list(); else onClose();
    }}>Discard changes</Button><Button disabled={busy} onClick={() => setDiscard(null)}>Keep editing</Button></div></InlineMessage> : null}
    {busy && !editing ? <p role="status">Loading datasets…</p> : null}
    {error && !editing ? <Button disabled={busy} onClick={() => void list()}>Try again</Button> : null}
    {!editing ? <div ref={library} className="dataset-library">
      {canCreate ? <Button disabled={busy} onClick={() => { setRecord(null); setTitle(""); setRelease(emptyDatasetRelease()); setUseCount(0); setTotalUseCount(0); setUses([]); setRefresh(null); setReleases([]); setReleaseCursor(null); setOwners(null); setArchiveDecision(false); setEditing(true); setDirty(false); setDraftStarted(true); }}>New dataset</Button> : null}
      {!busy && records.length === 0 ? <p>No datasets yet. Create a source record, then request review.</p> : null}
      <ul className="dataset-library-list">{records.map(item => <li key={item.id}>
        <span><strong>{item.title}</strong> <StatusBadge tone="neutral">{item.archived ? "Archived" : item.state}</StatusBadge></span>
        <Button data-dataset-open={item.id} disabled={busy} onClick={() => onOpenRecord ? onOpenRecord(item.id) : void open(item.id)}>{item.canEdit ? "Edit dataset" : "View dataset"}</Button>
        {onSelect && item.approvedReleaseId && !item.archived ? <Button disabled={busy} onClick={() => onSelect(item.id)}>Choose</Button> : null}
      </li>)}</ul>
      {cursor ? <Button disabled={busy} onClick={() => void run(async () => {
        const result = await api.list(cursor); setRecords(current => [...current, ...result.datasets]); setCursor(result.nextCursor);
      })}>Load more datasets</Button> : null}
    </div> : (!selectedId || record) ? <>
      <div className="dataset-editor-heading">
        <div className="button-row"><Button ref={backTrigger} disabled={busy} onClick={back}>Back to datasets</Button>
        </div>
        <p className="dataset-owner-status"><span>Owner: {record?.ownerUid === principal.id ? "You" : record?.ownerName ?? "You"}</span><StatusBadge tone="neutral">{record?.archived ? "Archived" : dirty ? "Unsaved draft" : record?.state ?? "New draft"}</StatusBadge></p>
        {record && can(principal, "content.edit.any", {}) && !record.archived ? <Button disabled={busy || dirty} onClick={() => void run(async () => {
          const result = await api.owners(); setOwners(result.owners); setOwnerCursor(result.nextCursor); setOwnerChoice(record.ownerUid);
        })}>Change owner</Button> : null}
        {owners && record ? <div className="dataset-fields">
          <label className="dataset-field"><span>Staff owner</span><Select value={ownerChoice} onChange={event => setOwnerChoice(event.target.value)}>
            <option value="">Choose a staff author</option>{owners.map(owner => <option key={owner.uid} value={owner.uid}>{owner.name}</option>)}
          </Select></label>
          {ownerCursor ? <Button disabled={busy} onClick={() => void run(async () => { const result = await api.owners(ownerCursor); setOwners(current => [...current ?? [], ...result.owners]); setOwnerCursor(result.nextCursor); })}>Load more staff authors</Button> : null}
          <Button disabled={busy || !ownerChoice || ownerChoice === record.ownerUid} onClick={() => void run(async () => {
            const body = { id: record.id, baseVersion: record.version, ownerUid: ownerChoice };
            accept((await api.assign({ ...body, requestId: key(body) })).dataset); setNotice("Dataset owner changed.");
          }, "assign")}>Assign owner</Button>
        </div> : null}
      </div>
      {totalUseCount > 0 ? <p className="dataset-use-summary">This dataset has {totalUseCount} published figures. This approval will update {useCount} uses.</p> : <p className="dataset-use-summary">No published figures use this record.</p>}
      {refresh ? <InlineMessage tone={refresh.status === "success" ? "success" : refresh.status === "partial" ? "warning" : "info"}>
        <p>{refresh.status === "success" ? `Public update verified for all ${refresh.expectedOwnerCount} content records.` :
          `Public update ${refresh.status}. Verified ${refresh.verifiedOwnerCount + refresh.supersededOwnerCount} of ${refresh.expectedOwnerCount} content records; ${refresh.failedOwnerCount} need attention.`}</p>
        {refresh.expectedOwnerCount > 0 ? <p>Review the surrounding text in each affected content record.</p> : null}
        <div className="button-row"><Button disabled={busy} onClick={() => void run(async () => {
          setRefresh((await api.refresh(record!.id)).refresh);
          const fresh = await api.get(record!.id); setTotalUseCount(fresh.useCount); setUseCount(fresh.affectedUseCount ?? fresh.useCount); setUses(fresh.uses ?? []);
        })}>Check public update</Button>
          {refresh.status === "partial" && can(principal, "datasets.approve", {}) ? <Button disabled={busy} onClick={() => void run(async () => { if (!record) return; await api.retry(record.id); setRefresh((await api.refresh(record.id)).refresh); })}>Retry failed updates</Button> : null}</div>
        {refresh.owners.length ? <ul>{refresh.owners.map((owner, index) => <li key={index}>{owner.title}: {owner.status}{owner.error ? `: ${owner.error}` : ""}</li>)}</ul> : null}
      </InlineMessage> : null}
      {uses.length ? <details><summary>Where this dataset is used ({uses.length})</summary><ul>{uses.map((use, index) => <li key={index}>
        {use.publicPath && /^\/[a-z0-9/-]+\/$/.test(use.publicPath) ? <a href={use.publicPath} target="_blank" rel="noopener noreferrer">{use.title} (opens in new tab)</a> : use.title} · {use.policy}
      </li>)}</ul></details> : null}
      {record?.state === "approved" && !dirty ? <div className="button-row">
        <Button disabled={busy || !canEdit} onClick={() => void run(async () => {
          if (!record.approvedReleaseId) throw new Error("The latest approved reporting release is unavailable.");
          const latest = await api.release(record.id, record.approvedReleaseId);
          setRelease({ ...latest.release, changeKind: "new_release", changeNote: "" }); setReleases([]); setReleaseCursor(null); setDirty(true); setDraftStarted(true);
        })}>Start next reporting release</Button>
        <Button disabled={busy || !canEdit} onClick={() => void run(async () => {
          const result = await api.releases(record.id); setReleases(result.releases); setReleaseCursor(result.nextCursor ?? null);
        })}>Correct a reporting release</Button>
      </div> : null}
      {releases.length ? <ul className="dataset-library-list">{releases.map(item => <li key={item.id}><span>{item.label} · Released {item.releasedOn} · Revision {item.approvedRevision}</span>
        <Button disabled={busy} onClick={() => void run(async () => {
          const result = await api.release(record!.id, item.id);
          setRecord(current => current ? { ...current, workingReleaseId: item.id } : current);
          setRelease({ ...result.release, changeKind: "correction", changeNote: "" }); setDirty(true); setReleases([]); setReleaseCursor(null); setDraftStarted(true);
        })}>Correct this release</Button></li>)}</ul> : null}
      {releaseCursor && record ? <Button disabled={busy} onClick={() => void run(async () => {
        const result = await api.releases(record.id, releaseCursor); setReleases(current => [...current, ...result.releases]); setReleaseCursor(result.nextCursor ?? null);
      })}>Load more reporting releases</Button> : null}
      <fieldset ref={editorFields} disabled={busy || !canChange} className="dataset-fields">
        <label className="dataset-field" data-dataset-path="title"><span>Dataset title</span><TextInput maxLength={300} value={title} onChange={event => { setTitle(event.target.value); setDirty(true); }} /></label>
        <p>{release.changeKind === "correction" ? "Correction to the selected reporting release. Explain every change in the change note." : "New release. Figures set to follow the latest approved version will update after this release is approved."}</p>
        <DatasetReleaseFields value={release} onChange={next => { setRelease(next); setDirty(true); }} />
      </fieldset>
      {record?.canApprove && !dirty ? <div className="dataset-archive-action">
        <Button ref={archiveTrigger} variant="danger" disabled={busy || Boolean(refresh && refresh.status !== "success")} onClick={() => setArchiveDecision(true)}>Archive dataset</Button>
        {archiveDecision ? <section ref={archiveConfirm} tabIndex={-1} aria-label="Archive dataset confirmation"><InlineMessage tone="warning">
          <p>Archive this dataset and remove its {totalUseCount} public figures? Its approved history stays private and available to staff.</p>
          <div className="button-row"><Button variant="danger" disabled={busy} onClick={() => void transition("archive")}>Confirm archive</Button>
            <Button onClick={() => { setArchiveDecision(false); archiveTrigger.current?.focus(); }}>Cancel</Button></div>
        </InlineMessage></section> : null}
      </div> : null}
    </> : <div className="button-row"><Button disabled={busy} onClick={() => void open(selectedId!)}>Try again</Button><Button onClick={back}>Back to datasets</Button></div>}
  </ComponentEditorDialog></ControlSizingProvider>;
}

export default function ConnectedDatasetLibrary({ principal }: { principal: Principal }) {
  const { getIdToken } = useAuth();
  const api = useMemo(() => datasetApi(getIdToken), [getIdToken]);
  const [params, setParams] = useSearchParams();
  return <DatasetLibraryDialog api={api} principal={principal} guardNavigation onOpenRecord={id => setParams(current => {
    const next = new URLSearchParams(current); next.set("dataset", id); return next;
  })} selectedId={params.get("dataset") ?? undefined} onClose={() => {
    setParams(current => { const next = new URLSearchParams(current); next.delete("panel"); next.delete("dataset"); return next; });
  }} onBack={params.has("dataset") ? () => setParams(current => { const next = new URLSearchParams(current); next.delete("dataset"); return next; }) : undefined} />;
}
