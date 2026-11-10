/** Opt-in local evidence entry. Synthetic records, no staff session or live API. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { BrowserRouter, useSearchParams } from "react-router";
import { DatasetLibraryDialog } from "../components/DatasetLibraryDialog";
import {
  emptyDatasetRelease,
  validateDatasetRelease,
  type DatasetRecord,
  type DatasetRelease,
} from "../../../packages/content-core/src/datasets";
import type { DatasetApi, DatasetSummary } from "../lib/datasets";
import { Button } from "../components/ui/Primitives";
import { ComponentEditorDialog } from "../components/ComponentEditorDialog";
import { LeaveGuardDialog } from "../routes/LeaveGuardDialog";
import "../styles.css";
import "../cms-workspace.css";

const septemberRelease: DatasetRelease = {
  ...emptyDatasetRelease(),
  label: "Synthetic employment rate - September historical correction",
  unit: "percent",
  value: 4.2,
  period: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" },
  adjustment: "seasonally_adjusted",
  points: [
    { period: "2026-07-31", value: 4.1 },
    { period: "2026-08-31", value: null, missingReason: "Not reported" },
    { period: "2026-09-30", value: 4.2 },
  ],
  chartText: "This synthetic rate is 4.2%. August was not reported. This fixture is not source data.",
  methodNote: "Monthly synthetic values. Missing observations are not interpolated.",
  source: { publisher: "Example agency", title: "Synthetic September release", url: "https://example.test/september" },
  releasedOn: "2026-10-15",
  verifiedOn: "2026-10-16",
  changeKind: "correction",
  changeNote: "Corrected the synthetic September source note.",
  reuse: { display: "allowed", exports: "denied", evidence: "Synthetic permission evidence", note: "Example agency" },
};

const octoberRelease: DatasetRelease = {
  ...structuredClone(septemberRelease),
  label: "Synthetic employment rate - October approved",
  value: 4.3,
  period: { start: "2026-10-01", end: "2026-10-31", label: "October 2026" },
  points: [
    { period: "2026-08-31", value: 4.1 },
    { period: "2026-09-30", value: 4.2 },
    { period: "2026-10-31", value: 4.3 },
  ],
  chartText: "The synthetic October rate is 4.3%.",
  source: { publisher: "Example agency", title: "Synthetic October release", url: "https://example.test/october" },
  releasedOn: "2026-11-15",
  verifiedOn: "2026-11-16",
  changeKind: "new_release",
  changeNote: "",
};

const olderRelease: DatasetRelease = {
  ...structuredClone(septemberRelease),
  label: "Synthetic employment rate - August archive",
  value: 4.1,
  period: { start: "2026-08-01", end: "2026-08-31", label: "August 2026" },
  releasedOn: "2026-09-15",
  verifiedOn: "2026-09-16",
  changeKind: "new_release",
  changeNote: "",
};

let record: DatasetRecord = {
  id: "synthetic-measure",
  title: "Synthetic employment",
  ownerUid: "fixture-editor",
  ownerName: "Example editor",
  version: 4,
  archived: false,
  state: "approved",
  workingRelease: septemberRelease,
  workingReleaseId: "synthetic-september",
  approvedReleaseId: "synthetic-october",
  updatedAt: "2026-11-20T12:00:00Z",
  updatedBy: "fixture-editor",
  canEdit: true,
  canApprove: true,
};

function summary(value: DatasetRecord): DatasetSummary {
  const { workingRelease: _workingRelease, workingReleaseId: _workingReleaseId, updatedBy: _updatedBy, ...result } = value;
  return result;
}

function releaseFor(id: string): DatasetRelease {
  if (id === "synthetic-october") return octoberRelease;
  if (id === "synthetic-september") return septemberRelease;
  if (id === "synthetic-august") return olderRelease;
  throw new Error("The synthetic reporting release was not found.");
}

async function delayInitialList() {
  if (!new URLSearchParams(location.search).has("delay")) return;
  await new Promise(resolve => setTimeout(resolve, 700));
}

const failedGetIds = new Set<string>();
function shouldFailGetOnce(id: string) {
  if (!new URLSearchParams(location.search).has("failGetOnce") || failedGetIds.has(id)) return false;
  failedGetIds.add(id);
  return true;
}

const api: DatasetApi = {
  refresh: async () => ({ refresh: null }),
  retry: async () => ({ refresh: null }),
  figure: async () => { throw new Error("Use the Data figure fixture."); },
  list: async cursor => {
    if (!cursor) await delayInitialList();
    return { datasets: [summary(record)], nextCursor: null };
  },
  get: async id => {
    if (shouldFailGetOnce(id)) throw new Error("The synthetic dataset could not load. Try again.");
    if (id !== record.id) throw new Error("The synthetic dataset was not found.");
    return { dataset: structuredClone(record), useCount: 3 };
  },
  releases: async (_id, cursor) => cursor === "older-releases"
    ? { releases: [{ id: "synthetic-august", label: olderRelease.label, releasedOn: olderRelease.releasedOn, approvedRevision: 1 }], hasMore: false, nextCursor: null }
    : { releases: [
      { id: "synthetic-october", label: octoberRelease.label, releasedOn: octoberRelease.releasedOn, approvedRevision: 4 },
      { id: "synthetic-september", label: septemberRelease.label, releasedOn: septemberRelease.releasedOn, approvedRevision: 3 },
    ], hasMore: true, nextCursor: "older-releases" },
  release: async (_id, releaseId) => ({ release: structuredClone(releaseFor(releaseId)) }),
  owners: async () => ({ owners: [{ uid: "fixture-editor", name: "Example editor" }], nextCursor: null }),
  assign: async input => ({ dataset: record = { ...record, ownerUid: input.ownerUid, version: record.version + 1 } }),
  save: async input => ({ dataset: record = { ...record, title: input.title, workingRelease: input.release, state: "draft", version: record.version + 1 } }),
  transition: async input => {
    if (input.action !== "archive") validateDatasetRelease(record.workingRelease, { complete: true });
    return { dataset: record = { ...record, state: input.action === "review" ? "review" : "approved",
      archived: input.action === "archive", version: record.version + 1 } };
  },
};

function Specimen() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("dataset") ?? undefined;
  const [open, setOpen] = useState(Boolean(selectedId));
  function setSelected(id?: string) {
    setParams(current => {
      const next = new URLSearchParams(current);
      if (id) next.set("dataset", id);
      else next.delete("dataset");
      return next;
    });
  }
  return <main className="content-studio"><h1>Dataset record fixture</h1><p>Synthetic local preview.</p>
    <Button onClick={() => setOpen(true)}>Open dataset library</Button>
    {open ? <DatasetLibraryDialog api={api} principal={{ id: "fixture-editor", grants: [{ role: "super_admin" }] }}
      selectedId={selectedId} onOpenRecord={setSelected} onBack={() => setSelected()}
      onClose={() => { setSelected(); setOpen(false); }} /> : null}
  </main>;
}

function GuardProbe() {
  const [nestedOpen, setNestedOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState("");
  function requestLeave() {
    if (draft) setConfirm(true);
    else setNestedOpen(false);
  }
  return <><ComponentEditorDialog open title="Outer native editor proof" onClose={() => {}}>
    <Button onClick={() => { setNestedOpen(true); setResult(""); }}>Open nested editor</Button>
    {result ? <p role="status">{result}</p> : null}
    {nestedOpen ? <ComponentEditorDialog open title="Nested native editor proof" onClose={requestLeave}>
      <label>Nested draft <input value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <Button onClick={requestLeave}>Leave nested editor</Button>
    </ComponentEditorDialog> : null}
  </ComponentEditorDialog>
  {confirm ? <LeaveGuardDialog onCancel={() => setConfirm(false)} onConfirm={() => {
    setConfirm(false); setNestedOpen(false); setDraft(""); setResult("Nested draft discarded.");
  }} /> : null}</>;
}

const guard = new URLSearchParams(location.search).has("guard");
createRoot(document.getElementById("dataset-root")!).render(guard ? <GuardProbe /> : <BrowserRouter><Specimen /></BrowserRouter>);
