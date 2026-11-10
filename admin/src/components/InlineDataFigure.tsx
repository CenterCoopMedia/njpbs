import { useEffect, useMemo, useRef, useState } from "react";
import {
  isDataFigureData,
  type DataFigureData,
  type DatasetPublicProjection,
} from "../../../packages/content-core/src/data-figure";
import {
  formatDatasetValue,
  isDatasetPublicProjection,
  renderDataFigure,
} from "../../../packages/content-core/src/data-figure-render";
import type { Principal } from "../../../packages/content-core/src/rbac";
import type { AdminBlock } from "../lib/block-factory";
import { datasetApi, type DatasetApi } from "../lib/datasets";
import { useOptionalShell } from "../routes/ShellContext";
import { DatasetLibraryDialog } from "./DatasetLibraryDialog";
import {
  DatasetPickerDialog,
  type DataFigureDatasetApi,
} from "./DatasetPickerDialog";
import { Button } from "./ui/Primitives";
import "../../../packages/content-core/src/data-figure.css";
import "../styles/dataset-figures.css";

function supportsFigure(api: DatasetApi | null): api is DataFigureDatasetApi {
  return Boolean(api) && typeof (api as Partial<DataFigureDatasetApi>).figure === "function";
}

export function InlineDataFigure({ block, onChange, readOnly = false, generatedHeadingLevel = 2,
  api: suppliedApi, principal: suppliedPrincipal, getIdToken: suppliedGetIdToken, onResolvedLabel }: {
  onResolvedLabel?: (label: string | null) => void;
  block: AdminBlock;
  onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
  readOnly?: boolean;
  generatedHeadingLevel?: number;
  api?: DataFigureDatasetApi;
  principal?: Principal;
  getIdToken?: () => Promise<string>;
}) {
  const shell = useOptionalShell();
  const principal = suppliedPrincipal ?? shell?.principal;
  const getIdToken = suppliedGetIdToken ?? shell?.getIdToken;
  const connectedApi = useMemo<DatasetApi | null>(() => suppliedApi ??
    (getIdToken ? datasetApi(getIdToken) : null), [getIdToken, suppliedApi]);
  const data = isDataFigureData(block.data) ? block.data : null;
  const datasetId = data?.datasetId ?? "";
  const versionMode = data?.version.mode ?? "pinned";
  const releaseId = data?.version.mode === "pinned" ? data.version.releaseId : "";
  const [projection, setProjection] = useState<DatasetPublicProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const selectedProjection = useRef<DatasetPublicProjection | null>(null);
  const libraryTrigger = useRef<HTMLButtonElement>(null);
  const pinnedVersion = useRef<HTMLInputElement>(null);
  const latestVersion = useRef<HTMLInputElement>(null);
  const focusAfterLoad = useRef<"library" | "pinned" | "latest" | null>(null);

  useEffect(() => {
    setError("");
    if (!datasetId) { setProjection(null); setLoading(false); return; }
    if (!supportsFigure(connectedApi)) {
      setProjection(null); setLoading(false); setError("Approved dataset values are unavailable in this Admin build."); return;
    }
    const selected = selectedProjection.current;
    selectedProjection.current = null;
    if (versionMode === "pinned" && selected?.datasetId === datasetId && selected.releaseId === releaseId) {
      setProjection(selected); setLoading(false); return;
    }
    setProjection(null);
    let current = true;
    setLoading(true);
    const version: DataFigureData["version"] = versionMode === "latestApproved"
      ? { mode: "latestApproved" }
      : { mode: "pinned", releaseId };
    void connectedApi.figure({ id: datasetId, version }).then(result => {
      if (!current) return;
      if (!isDatasetPublicProjection(result) || result.datasetId !== datasetId ||
        (version.mode === "pinned" && result.releaseId !== version.releaseId)) {
        throw new Error("The approved dataset response did not match this figure.");
      }
      setProjection(result);
    }).catch(error => {
      if (current) setError(error instanceof Error ? error.message : "This approved dataset could not be loaded.");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [connectedApi, datasetId, releaseId, retry, versionMode]);
  useEffect(() => {
    const destination = focusAfterLoad.current;
    if (loading || !destination) return;
    focusAfterLoad.current = null;
    const target = destination === "library" ? libraryTrigger.current
      : destination === "pinned" ? pinnedVersion.current : latestVersion.current;
    if (target?.isConnected && document.activeElement === document.body) target.focus();
  }, [loading]);

  const matchingProjection = projection && projection.datasetId === datasetId &&
    (versionMode === "latestApproved" || projection.releaseId === releaseId) ? projection : null;
  const resolvedLabel = matchingProjection && !loading && !error ? matchingProjection.release.label : null;
  useEffect(() => {
    onResolvedLabel?.(resolvedLabel);
    return () => onResolvedLabel?.(null);
  }, [onResolvedLabel, resolvedLabel]);

  function select(next: DatasetPublicProjection) {
    selectedProjection.current = datasetId !== next.datasetId || versionMode !== "pinned" || releaseId !== next.releaseId
      ? next : null;
    setProjection(next); setError("");
    onChange({
      datasetId: next.datasetId,
      version: { mode: "pinned", releaseId: next.releaseId },
      display: data?.display ?? "expanded",
    }, true);
  }

  async function selectFromLibrary(id: string) {
    setLibraryOpen(false);
    if (!supportsFigure(connectedApi)) {
      setError("Approved dataset values are unavailable in this Admin build."); return;
    }
    setLoading(true); setError("");
    try {
      const next = await connectedApi.figure({ id, version: { mode: "latestApproved" } });
      if (!isDatasetPublicProjection(next) || next.datasetId !== id) throw new Error("The approved dataset response did not match this selection.");
      select(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : "This approved dataset could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  if (!data) return <section className="inline-block-surface inline-data-figure">
    <div className="dataset-figure-message dataset-figure-message--error" role="alert">
      <p>This Data figure has invalid settings. Remove it and add a new Data figure.</p>
    </div>
  </section>;

  const preview = matchingProjection && isDataFigureData(data, true)
    ? renderDataFigure(block.id, data, matchingProjection, generatedHeadingLevel)
    : "";
  const ready = projection && matchingProjection && !loading && !error;
  return <section className="inline-block-surface inline-data-figure" aria-label="Data figure">
    {!datasetId ? <div className="dataset-figure-empty">
      <p><strong>Choose an approved dataset</strong></p>
      <p>The dataset owns the value, chart text, source values and method.</p>
    </div> : null}
    {loading ? <p role="status">Loading approved dataset values…</p> : null}
    {error ? <div className="dataset-figure-message dataset-figure-message--error" role="alert">
      <p>{error}</p><div className="button-row">
        <Button disabled={loading} onClick={() => setRetry(value => value + 1)}>Try again</Button>
        {!readOnly && supportsFigure(connectedApi) ? <Button onClick={() => setPickerOpen(true)}>Choose another dataset</Button> : null}
      </div></div> : null}
    {ready ? <div className="dataset-figure-summary">
      <div><p><strong>{projection.release.label}</strong></p>
        <p className="dataset-figure-summary__value">{formatDatasetValue(projection.release.value, projection.release.unit)}</p></div>
      <dl><div><dt>Period</dt><dd>{projection.release.period.label}</dd></div>
        <div><dt>Source</dt><dd>{projection.release.source.publisher}</dd></div>
        <div><dt>Approval</dt><dd>Revision {projection.revision}</dd></div></dl>
    </div> : null}
    <div className="dataset-figure-actions button-row">
      <Button disabled={readOnly || loading || !supportsFigure(connectedApi)} onClick={() => setPickerOpen(true)}>
        {datasetId ? "Change dataset" : "Choose dataset"}
      </Button>
      <Button ref={libraryTrigger} disabled={readOnly || loading || !supportsFigure(connectedApi) || !principal}
        onClick={() => setLibraryOpen(true)}>{datasetId ? "Edit dataset" : "Create or edit datasets"}</Button>
    </div>
    {ready ? <>
      <div className="dataset-figure-options">
        <fieldset disabled={readOnly || loading}><legend>Version</legend>
          <label><input ref={pinnedVersion} type="radio" name={`data-figure-version-${block.id}`} checked={data.version.mode === "pinned"}
            onChange={() => { focusAfterLoad.current = "pinned"; onChange({ datasetId: data.datasetId,
              version: { mode: "pinned", releaseId: projection.releaseId }, display: data.display }, true); }} />
            <span>Keep this reporting release</span></label>
          <label><input ref={latestVersion} type="radio" name={`data-figure-version-${block.id}`} checked={data.version.mode === "latestApproved"}
            onChange={() => { focusAfterLoad.current = "latest"; onChange({ datasetId: data.datasetId,
              version: { mode: "latestApproved" }, display: data.display }, true); }} />
            <span>Use the latest approved release</span></label>
        </fieldset>
        <fieldset disabled={readOnly}><legend>Display</legend>
          <label><input type="radio" name={`data-figure-display-${block.id}`} checked={data.display === "compact"}
            onChange={() => onChange({ datasetId: data.datasetId, version: data.version, display: "compact" }, true)} />
            <span>Compact</span></label>
          <label><input type="radio" name={`data-figure-display-${block.id}`} checked={data.display === "expanded"}
            onChange={() => onChange({ datasetId: data.datasetId, version: data.version, display: "expanded" }, true)} />
            <span>Expanded</span></label>
        </fieldset>
      </div>
      <p className="dataset-figure-shared-note">Shared values change in the dataset. This block keeps only the dataset, version and display choices.</p>
      <div className="dataset-figure-preview" aria-label="Data figure preview" dangerouslySetInnerHTML={{ __html: preview }} />
    </> : null}
    {supportsFigure(connectedApi) ? <DatasetPickerDialog api={connectedApi} open={pickerOpen} selectedId={datasetId || undefined}
      onClose={() => setPickerOpen(false)} onChoose={select} /> : null}
    {libraryOpen && supportsFigure(connectedApi) && principal ? <DatasetLibraryDialog api={connectedApi} principal={principal}
      selectedId={datasetId || undefined} onClose={() => {
        focusAfterLoad.current = "library"; setLibraryOpen(false); setRetry(value => value + 1);
      }}
      onSelect={id => void selectFromLibrary(id)} /> : null}
  </section>;
}
