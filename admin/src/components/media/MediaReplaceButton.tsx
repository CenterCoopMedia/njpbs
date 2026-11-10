import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { hasCapability, type Principal } from "../../../../packages/content-core/src/rbac";
import { canManageMediaMetadata } from "../../lib/access";
import { cmsListMedia, cmsReplaceMediaBinary, HttpError, type MediaAssetSummary } from "../../lib/functions";
import { duplicateUploadAssetId, HIDDEN_DUPLICATE_MESSAGE, IMAGE_UPLOAD_MIME_TYPES, validateMediaUploadFile } from "../../lib/media-upload";
import { mediaImagesPath } from "../../lib/routes";
import { Button } from "../ui/Primitives";
import "./MediaReplaceButton.css";

function refusalMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "The image could not be replaced.";
  if (error instanceof HttpError && error.status === 409 && error.data?.duplicateAssetId === null) {
    return HIDDEN_DUPLICATE_MESSAGE;
  }
  if (error instanceof HttpError && (error.status === 412 || error.status === 428)) {
    return `${message} Refresh the asset before trying again.`;
  }
  if (error instanceof HttpError && error.status === 409 &&
      message === "This media asset cannot be replaced until coordinated media deployment is active.") {
    return `${message} Republish the affected page without this image, or unpublish it, before replacing the file.`;
  }
  if (error instanceof HttpError && error.status === 503) {
    return /try again later/i.test(message) ? message : `${message} Try again later.`;
  }
  return message;
}

export function MediaReplaceButton({ asset, principal, getIdToken, onReplaced, onReload, onBusyChange, librarySearch = "", disabled = false }: {
  asset: MediaAssetSummary;
  principal?: Principal;
  getIdToken: () => Promise<string>;
  onReplaced: (asset: MediaAssetSummary) => void;
  onReload: () => void;
  onBusyChange?: (busy: boolean) => void;
  librarySearch?: string;
  disabled?: boolean;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const descriptionId = useId();
  const input = useRef<HTMLInputElement>(null);
  const reload = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusAfterReload = useRef(false);
  const inFlight = useRef(false);
  const reportBusy = useRef(onBusyChange);
  reportBusy.current = onBusyChange;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; reportBusy.current?.(false); };
  }, []);
  const [file, setFile] = useState<File | null>(null);
  // Capture the version at selection, so a later refresh cannot silently approve a new version.
  const [target, setTarget] = useState(asset);
  const [optimize, setOptimize] = useState(true);
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState("");
  const [duplicate, setDuplicate] = useState<MediaAssetSummary | null>(null);
  const [binAssetId, setBinAssetId] = useState<string | null>(null);
  const canOpenRecycleBin = principal && hasCapability(principal, "media.manage");
  const binParams = new URLSearchParams(librarySearch);
  binParams.set("bin", "1");
  binParams.delete("binAsset");
  const [success, setSuccess] = useState("");
  useEffect(() => {
    if (file) {
      dialog.current?.showModal();
      confirm.current?.focus();
    }
    else dialog.current?.close();
  }, [file]);
  useEffect(() => {
    if (focusAfterReload.current && !needsReload) {
      focusAfterReload.current = false;
      trigger.current?.focus();
    }
    if (busy) dialog.current?.focus();
    if (!busy && (success || error)) (needsReload ? reload : trigger).current?.focus();
  }, [busy, success, error, needsReload]);
  const staffProfile = asset.category === "staff-profile";

  async function replace() {
    if (!file || disabled || inFlight.current) return;
    inFlight.current = true;
    reportBusy.current?.(true);
    setBusy(true);
    setError("");
    setDuplicate(null);
    setBinAssetId(null);
    try {
      const result = await cmsReplaceMediaBinary(await getIdToken(), target, file, optimize && !staffProfile);
      if (!mounted.current) return;
      onReplaced(result.asset);
      setFile(null);
      setSuccess(result.changed
        ? "File replaced. Check the alt text for the new image."
        : "This is already the current file. No changes were made.");
    } catch (cause) {
      if (!mounted.current) return;
      setError(refusalMessage(cause));
      const duplicateId = duplicateUploadAssetId(cause);
      if (duplicateId) {
        const existing = await getIdToken()
          .then(token => cmsListMedia(token, { assetIds: [duplicateId] }))
          .then(result => result.records.find(record => record.id === duplicateId) ?? null)
          .catch(() => undefined);
        if (!mounted.current) return;
        if (existing) {
          setDuplicate(existing);
          setError(`This file is already in the media library as "${existing.name}".`);
        } else if (existing === null) {
          setBinAssetId(duplicateId);
          setError(canOpenRecycleBin
            ? "The matching image may be in the Recycle bin. Restore it from the Media library's Recycle bin."
            : "The matching image may be in the Recycle bin. Ask a media manager to restore it.");
        }
      }
      setNeedsReload(cause instanceof HttpError && (cause.status === 412 || cause.status === 428));
      // A retry needs a fresh selection and confirmation, especially after a stale ETag.
      setFile(null);
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        reportBusy.current?.(false);
        setBusy(false);
      }
    }
  }

  return <div className="media-replace-control">
    <Button ref={trigger} disabled={disabled || busy || needsReload} onClick={() => input.current?.click()}>
      Replace file
    </Button>
    <input ref={input} hidden type="file" aria-label={`Choose a replacement image for ${asset.name}`}
      accept={[...IMAGE_UPLOAD_MIME_TYPES].join(",")} disabled={disabled || busy || needsReload}
      onChange={event => {
        const chosen = event.target.files?.[0];
        event.target.value = "";
        if (!chosen) return;
        setSuccess("");
        setDuplicate(null);
        setBinAssetId(null);
        const invalid = validateMediaUploadFile(chosen, true);
        setError(invalid ?? "");
        setFile(invalid ? null : chosen);
        setTarget(asset);
      }} />
    <dialog ref={dialog} tabIndex={-1} className="media-replace-dialog" aria-label={`Confirm replacement of ${asset.name}`}
      aria-describedby={descriptionId} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape" && inFlight.current) event.preventDefault();
      }}
      onClose={() => {
        // Some browser close requests cannot be canceled. Keep editing blocked until completion.
        if (inFlight.current) { dialog.current?.showModal(); dialog.current?.focus(); }
        else setFile(null);
      }}
      onCancel={event => {
        event.preventDefault();
        if (!inFlight.current) { setFile(null); trigger.current?.focus(); }
      }}>
    {file ? <>
      <h2>Replace file</h2>
      <p>Replace the file for "{asset.name}" with "{file.name}"?</p>
      <p id={descriptionId}>The image keeps its ID, name, alt text, credit and usage. The old file goes to the purge queue with a 30-day hold.</p>
      {staffProfile ? <p>Staff profile photos must keep the original file. Profile photo size and dimension limits still apply.</p> :
        <label className="media-upload-processing">
          <input type="checkbox" checked={optimize} disabled={disabled || busy}
            onChange={event => setOptimize(event.target.checked)} />
          Optimize JPEG and PNG files and convert them to WebP
        </label>}
      <div className="media-form-actions">
        <Button ref={confirm} aria-busy={busy} disabled={disabled || busy} onClick={() => void replace()}>Confirm replacement</Button>
        <Button disabled={busy} onClick={() => { setFile(null); trigger.current?.focus(); }}>Cancel</Button>
      </div>
      <p role="status">{busy ? "Replacing image..." : ""}</p>
    </> : null}
    </dialog>
    {error ? <p role="alert">{error}{duplicate ? <> {principal && canManageMediaMetadata(principal, duplicate.category)
      ? <Link to={`${mediaImagesPath()}?asset=${encodeURIComponent(duplicate.id)}`}>Open existing asset</Link>
      : "Ask an editor with media management to use the existing file."}</> : null}
      {binAssetId && canOpenRecycleBin && !busy ? <> <Link
        to={`${mediaImagesPath()}?${binParams}&binAsset=${encodeURIComponent(binAssetId)}`}
        onClick={event => {
          if (inFlight.current) { event.preventDefault(); return; }
          setFile(null);
          dialog.current?.close();
        }}>Find it in the Recycle bin</Link></> : null}</p> : null}
    {needsReload ? <Button ref={reload} onClick={() => { focusAfterReload.current = true; setNeedsReload(false); setError(""); onReload(); }}>Reload asset</Button> : null}
    <p role="status">{success}</p>
  </div>;
}
