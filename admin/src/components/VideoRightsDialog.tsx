import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { VIDEO_BLOCK_SOURCE_ID } from "../../../packages/content-core/src/video-block";
import { HttpError } from "../lib/functions";
import { listMediaSources, listSourceMedia, updateSourceMediaMetadata, type SourceMediaAssetSummary } from "../lib/source-media";
import { videoRightsSaved } from "../lib/video-rights";
import { useOptionalShell } from "../routes/ShellContext";
import { VideoRightsFields, type VideoRightsValues } from "./media/VideoRightsFields";
import { AsyncActionButton, Button, InlineMessage } from "./ui/Primitives";
import { ActionControl } from "./ui/ActionControl";
import "./content-picker.css";
import "./VideoRightsDialog.css";

const valuesOf = (asset: SourceMediaAssetSummary): VideoRightsValues => ({
  rightsStatus: asset.rightsStatus, credit: asset.credit ?? "", license: asset.license ?? "",
});
type Loaded = { asset: SourceMediaAssetSummary; canEdit: boolean; permissionError: boolean };

function containFocus(event: KeyboardEvent<HTMLDialogElement>) {
  event.stopPropagation();
  if (event.key !== "Tab") return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"))
    .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[hidden], [inert]") && element.getClientRects().length > 0);
  const first = controls[0]; const last = controls.at(-1);
  if (!first) { event.preventDefault(); return; }
  if (!controls.includes(document.activeElement as HTMLElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
    event.preventDefault(); (event.shiftKey ? last : first)?.focus({ preventScroll: true });
  }
}

export function VideoRightsDialog({ assetId, onClose, onDirtyChange }: {
  assetId: string; onClose: () => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const getIdToken = useOptionalShell()?.getIdToken;
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  const savingRef = useRef(false);
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>();
  const [values, setValues] = useState<VideoRightsValues>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty = Boolean(loaded && values && JSON.stringify(values) !== JSON.stringify(valuesOf(loaded.asset)));

  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    element?.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => { alive.current = false; element?.close(); };
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
    return () => { onDirtyChange?.(false); };
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => { if (loading || saving) heading.current?.focus({ preventScroll: true }); }, [loading, saving]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, saving]);
  useEffect(() => {
    let current = true;
    setLoading(true); setLoadError(""); setLoaded(undefined); setValues(undefined);
    setError(""); setConflict(false); setSaved(false); setDiscard(false);
    if (!getIdToken) { setLoading(false); setLoadError("Sign in to review this video's rights."); return; }
    void getIdToken().then(async token => {
      const [page, access] = await Promise.all([
        listSourceMedia(token, { sourceId: VIDEO_BLOCK_SOURCE_ID, assetId }),
        listMediaSources(token).then(value => ({ value, failed: false }), () => ({ value: null, failed: true })),
      ]);
      const asset = page.records.find(asset => asset.id === assetId && asset.sourceId === VIDEO_BLOCK_SOURCE_ID);
      if (!asset) throw new Error("This video is no longer in the media library. Choose another video.");
      if (current) {
        setLoaded({ asset, canEdit: access.value?.sources.find(source => source.id === VIDEO_BLOCK_SOURCE_ID)?.canEditMetadata === true,
          permissionError: access.failed });
        setValues(valuesOf(asset));
      }
    }).catch(error => { if (current) setLoadError(error instanceof Error ? error.message : "Video rights could not be loaded."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [assetId, getIdToken, attempt]);

  function close() { dialog.current?.close(); onClose(); }
  function requestClose() {
    if (savingRef.current) return;
    if (dirty) setDiscard(true); else close();
  }
  async function save() {
    if (!getIdToken || !loaded?.canEdit || !values || !dirty || savingRef.current || conflict) return;
    savingRef.current = true; setSaving(true); setError(""); setSaved(false); setDiscard(false);
    const asset = loaded.asset;
    try {
      const token = await getIdToken();
      const response = await updateSourceMediaMetadata(token, asset.sourceId, asset.id, asset.version, values);
      if (!response.asset || response.asset.id !== asset.id || response.asset.sourceId !== asset.sourceId || response.asset.kind !== "video" ||
        !Number.isSafeInteger(response.asset.version) || response.asset.version <= asset.version) {
        if (alive.current) {
          setConflict(true);
          setError("The rights save could not be confirmed. Your edits are still here. Reload current rights before trying again.");
        }
        return;
      }
      videoRightsSaved(response.asset);
      if (alive.current) {
        setLoaded({ ...loaded, asset: response.asset }); setValues(valuesOf(response.asset)); setSaved(true);
      }
    } catch (error) {
      if (alive.current) {
        const conflict = error instanceof HttpError && error.status === 409;
        setConflict(conflict);
        setError(conflict ? "This video changed. Your edits are still here. Reload current rights to replace them with the latest saved values."
          : error instanceof Error ? error.message : "Video rights could not be saved. Your edits are still here.");
      }
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return createPortal(<dialog className="content-picker-dialog video-rights-dialog" ref={dialog} aria-labelledby={titleId}
    onClick={event => event.stopPropagation()} onKeyDown={containFocus}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); requestClose(); }}>
    <header className="content-picker-head"><h2 id={titleId} ref={heading} tabIndex={-1}>Video rights</h2>
      <ActionControl action="close" variant="ghost" size="standard" disabled={saving} onClick={requestClose}
        accessibleName="Close video rights" tooltipLabel="Close video rights" /></header>
    <form className="video-rights-form" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void save(); }}>
      <div className="content-picker-body">
        {loading ? <p role="status">Loading video rights…</p> : loadError ? <InlineMessage tone="error" role="alert" title="Video rights are unavailable">
          <p>{loadError}</p>{getIdToken ? <Button onClick={() => setAttempt(value => value + 1)}>Retry rights check</Button> : null}
        </InlineMessage> : loaded && values ? <>
          <p className="video-rights-name">{loaded.asset.name}</p>
          <p>These rights apply wherever this video is used.</p>
          <fieldset className="video-rights-fields" disabled={saving}><legend className="sr-only">Video rights fields</legend>
            <VideoRightsFields values={values} disabled={saving} onChange={loaded.canEdit ? next => { setValues(next); setSaved(false); } : undefined} />
          </fieldset>
          {!loaded.canEdit ? <p>{loaded.permissionError
            ? "Read-only: media edit access could not be checked. Retry to check your permission to edit media."
            : "Read-only: staff with permission to edit media can change these rights."}</p> : null}
          {loaded.permissionError ? <Button onClick={() => setAttempt(value => value + 1)}>Retry rights check</Button> : null}
          <p>Rights checks are reminders. They do not prevent selection or publishing.</p>
        </> : null}
        {error ? <InlineMessage tone="error" role="alert" title="Video rights save was not confirmed"><p>{error}</p>
          {conflict ? <Button onClick={() => setAttempt(value => value + 1)}>Reload current rights</Button> : null}
        </InlineMessage> : null}
        {saved ? <p role="status">Video rights saved.</p> : null}
        {discard ? <InlineMessage tone="warning" title="Discard rights changes?">
          <p>Your content edits will stay as they are.</p><div className="button-row">
            <Button onClick={() => setDiscard(false)}>Keep editing rights</Button><Button variant="danger" onClick={close}>Discard rights changes</Button>
          </div>
        </InlineMessage> : null}
      </div>
      {loaded ? <footer className="content-picker-footer">{loaded.canEdit ? <AsyncActionButton type="submit" variant="primary" label="Save rights"
        pendingLabel="Saving rights…" pending={saving} disabled={loading || conflict || !dirty} /> : <Button onClick={requestClose}>Close</Button>}</footer> : null}
    </form>
  </dialog>, document.body);
}
