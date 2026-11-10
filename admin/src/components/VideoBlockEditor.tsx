import { useCallback, useEffect, useId, useRef, useState } from "react";
import { editorFieldsForBlock } from "../../../packages/content-core/src/editor-admin";
import { VIDEO_BLOCK_LIMITS, VIDEO_BLOCK_SOURCE_ID } from "../../../packages/content-core/src/video-block";
import { editorFieldValidationMessage } from "../lib/field-validation";
import type { AdminBlock } from "../lib/block-factory";
import {
  createSourceMediaRead,
  listSourceMedia,
  type SourceMediaAssetSummary,
} from "../lib/source-media";
import { useOptionalShell } from "../routes/ShellContext";
import { useVideoRightsWarnings, videoRightsWarning, VIDEO_MISSING_WARNING } from "../lib/video-rights";
import { FieldRenderer } from "./FieldRenderer";
import { Button, TextInput } from "./ui/Primitives";
import "./VideoBlockEditor.css";
import { useVideoRightsReview } from "./useVideoRightsReview";

type GetIdToken = () => Promise<string>;

export { videoRightsWarning };

function isReady(asset: SourceMediaAssetSummary) {
  return asset.viewingCopy?.state === "ready";
}

function duration(seconds?: number) {
  if (seconds === undefined) return "";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function VideoPickerDialog({ open, getIdToken, onClose, onChoose }: {
  open: boolean;
  getIdToken: GetIdToken | undefined;
  onClose: () => void;
  onChoose: (asset: SourceMediaAssetSummary) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  // A new value reruns the first-page request (search, retry). `cursor` loads more.
  const [request, setRequest] = useState<{ attempt: number; cursor: string | null }>({ attempt: 0, cursor: null });
  const [state, setState] = useState<{
    busy: boolean;
    error: string;
    records: SourceMediaAssetSummary[];
    posters: Map<string, string>;
    nextCursor: string | null;
  }>({ busy: false, error: "", records: [], posters: new Map(), nextCursor: null });

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      element.querySelector("input")?.focus();
    } else if (!open && element.open) {
      element.close();
      opener.current?.focus();
    }
  }, [open]);

  // A closed picker starts again at the first page, so a reopen never repeats the last cursor.
  useEffect(() => {
    if (open) return;
    setRequest(previous => previous.cursor === null ? previous : { ...previous, cursor: null });
    setState(previous => previous.records.length === 0 && previous.nextCursor === null
      ? previous
      : { ...previous, records: [], posters: new Map(), nextCursor: null });
  }, [open]);

  useEffect(() => {
    if (!open || !getIdToken) return;
    let current = true;
    const more = request.cursor !== null;
    setState(previous => ({ ...previous, busy: true, error: "" }));
    getIdToken()
      .then(token => listSourceMedia(token, {
        sourceId: VIDEO_BLOCK_SOURCE_ID,
        limit: 48,
        posters: true,
        ...(submitted ? { q: submitted } : {}),
        ...(more ? { cursor: request.cursor as string } : {}),
      }))
      .then(page => {
        if (!current) return;
        const posters = (page.posters ?? []).map(poster => [poster.assetId, poster.url] as const);
        setState(previous => ({
          busy: false,
          error: "",
          records: [...(more ? previous.records : []), ...page.records.filter(isReady)],
          posters: new Map([...(more ? previous.posters : []), ...posters]),
          nextCursor: page.hasMore ? page.nextCursor : null,
        }));
      })
      .catch((error: unknown) => {
        if (!current) return;
        setState(previous => ({
          ...previous,
          busy: false,
          error: error instanceof Error ? error.message : "Videos could not be loaded.",
        }));
      });
    return () => { current = false; };
  }, [open, getIdToken, submitted, request]);

  const search = () => {
    setSubmitted(query.trim());
    setRequest(previous => ({ attempt: previous.attempt + 1, cursor: null }));
  };

  // The picker renders inside the editor's RecordForm, so it must not be a form or
  // submit one: a search would also save the post.
  return <dialog className="video-picker-dialog" ref={dialog} aria-label="Choose a video" onCancel={onClose} onClose={onClose}>
    <div className="video-picker-header"><h2>Choose a video</h2><Button onClick={onClose}>Close</Button></div>
    <p>Only videos with a ready viewing copy are listed. The page plays that 1080p copy.</p>
    <div className="video-picker-search" role="search">
      <label htmlFor={searchId}>Search videos</label>
      <TextInput id={searchId} value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          search();
        }} />
      <Button onClick={search}>Search</Button>
    </div>
    {!getIdToken ? <p role="alert">Sign in to choose a video.</p>
      : state.busy && state.records.length === 0 ? <p role="status">Loading videos…</p>
      : state.error ? <div role="alert"><p>{state.error}</p><Button onClick={() => setRequest(previous => ({ ...previous, attempt: previous.attempt + 1 }))}>Try again</Button></div>
      : <>
        <p role="status">{state.records.length} {state.records.length === 1 ? "ready video" : "ready videos"} found</p>
        <ul className="video-picker-results">{state.records.map(asset => {
          const warning = videoRightsWarning(asset);
          const poster = state.posters.get(asset.id);
          return <li key={asset.id}>
            <Button className="video-picker-choice" aria-label={`${asset.name}${warning ? `. ${warning}` : ""}`}
              onClick={() => { onChoose(asset); onClose(); }}>
              {poster ? <img src={poster} alt="" loading="lazy" /> : <span className="video-picker-noposter" aria-hidden="true" />}
              <strong>{asset.name}</strong>
              <small>{[duration(asset.viewingCopy?.durationSeconds), asset.credit].filter(Boolean).join(" · ")}</small>
              {warning ? <small className="video-picker-warning">{warning}</small> : null}
            </Button>
          </li>;
        })}</ul>
        {state.nextCursor ? <Button disabled={state.busy}
          onClick={() => setRequest(previous => ({ ...previous, cursor: state.nextCursor }))}>
          {state.busy ? "Loading more videos…" : "Load more videos"}
        </Button> : null}
      </>}
  </dialog>;
}

export function VideoBlockEditor({ block, readOnly = false, hasError = false, allowCaptionName = false, onChange, onMediaPickerDirtyChange }: {
  block: AdminBlock;
  readOnly?: boolean;
  hasError?: boolean;
  allowCaptionName?: boolean;
  onChange: (value: Record<string, unknown>) => void;
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
}) {
  const shell = useOptionalShell();
  const getIdToken = shell?.getIdToken;
  const unavailableReasonId = useId();
  const unavailableReason = readOnly ? "Editing is unavailable in this read-only view."
    : !getIdToken ? "Sign in to choose a library video." : "";
  const [pickerOpen, setPickerOpen] = useState(false);
  const [preview, setPreview] = useState<{ assetId: string; url: string; poster?: string } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const assetId = typeof block.data.assetId === "string" ? block.data.assetId : "";
  const rights = useVideoRightsReview(assetId, onMediaPickerDirtyChange);
  const previewTitle = String(block.data.title ?? "").trim() || (allowCaptionName ? String(block.data.caption ?? "").trim() : "") || "Video";
  // The library's current rights, read when the block opens and on every pick, even of the
  // same video, since its rights may have changed (#2759).
  const [picks, setPicks] = useState(0);
  const warning = useVideoRightsWarnings(assetId ? [assetId] : [], picks)[0]?.message ?? null;
  const fields = editorFieldsForBlock("video").filter(field => field.key !== "assetId").map(field =>
    allowCaptionName && field.key === "title" ? { ...field, required: false, help: "Provide a title or caption to name this video for screen readers." } : field);

  const loadPreview = useCallback(async () => {
    if (!getIdToken || !assetId) return;
    setPreviewError("");
    try {
      const token = await getIdToken();
      const [video, poster] = await Promise.all([
        createSourceMediaRead(token, VIDEO_BLOCK_SOURCE_ID, assetId, "preview"),
        createSourceMediaRead(token, VIDEO_BLOCK_SOURCE_ID, assetId, "poster").catch(() => null),
      ]);
      setPreview({ assetId, url: video.url, ...(poster ? { poster: poster.url } : {}) });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "The preview could not be loaded.");
    }
  }, [assetId, getIdToken]);

  const rightsAction = assetId && warning !== VIDEO_MISSING_WARNING ? <Button onClick={rights.open}>Review rights</Button> : null;
  return <section className="inline-block-surface video-block-editor" aria-label="Video editor" tabIndex={-1}>
    <div className="video-editor-actions">
      <Button disabled={readOnly || !getIdToken} aria-describedby={unavailableReason ? unavailableReasonId : undefined} onClick={() => setPickerOpen(true)}>
        {assetId ? "Choose a different video" : "Choose a video"}
      </Button>
      {/* The preview URL expires after five minutes, so staff can always load a fresh one. */}
      {assetId && getIdToken
        ? <Button onClick={() => void loadPreview()}>{preview?.assetId === assetId ? "Reload preview" : "Preview video"}</Button>
        : null}
    </div>
    {unavailableReason ? <p id={unavailableReasonId} className="video-editor-note">{unavailableReason}</p> : null}
    {warning || rightsAction ? <div className={warning ? "video-editor-warning" : "video-editor-rights"} role={warning ? "status" : undefined}>
      {warning ? <p>{warning}</p> : null}{rightsAction}
    </div> : null}
    {rights.dialog}
    {previewError ? <p role="alert">{previewError}</p> : null}
    {preview && preview.assetId === assetId
      ? <video className="video-editor-preview" controls preload="metadata" playsInline src={preview.url}
        poster={preview.poster} aria-label={`Preview: ${previewTitle}`} />
      : null}
    {assetId ? <fieldset disabled={readOnly} className="video-editor-fields">
      <legend className="sr-only">Video details</legend>
      {fields.map(field => <div key={field.key} data-field-name={field.key}><FieldRenderer field={field}
        fieldId={`video-${block.id}-${field.key}`} value={block.data[field.key] ?? ""}
        error={hasError ? editorFieldValidationMessage(field, block.data[field.key], { siblings: block.data, fields }) ?? undefined : undefined}
        onChange={value => {
          const next: Record<string, unknown> = { ...block.data, [field.key]: value };
          if (field.key === "caption" && value === "") delete next.caption;
          onChange(next);
        }} /></div>)}
      <p className="video-editor-note">When you publish, Boardwalk copies this video's viewing copy and poster to the public media site. Pages with a video load no analytics.</p>
    </fieldset> : hasError ? <p role="alert">Choose a video to complete this block.</p> : null}
    <VideoPickerDialog open={pickerOpen} getIdToken={getIdToken} onClose={() => setPickerOpen(false)} onChoose={asset => {
      if (readOnly) return;
      setPreview(null);
      setPicks(previous => previous + 1);
      // A source name may be longer than a block title allows, so the default is cut to fit.
      const title = typeof block.data.title === "string" && block.data.title.trim()
        ? block.data.title
        : asset.name.trim().slice(0, VIDEO_BLOCK_LIMITS.title);
      const { public: _server, ...rest } = block.data;
      onChange({ ...rest, sourceId: VIDEO_BLOCK_SOURCE_ID, assetId: asset.id, title });
    }} />
  </section>;
}
