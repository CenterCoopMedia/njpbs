import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Inspector, InspectorSection } from "../ui/Inspector";
import { TokenInput, type Token } from "../ui/TokenInput";
import { AsyncActionButton, Button, InlineMessage, TextInput, Textarea } from "../ui/Primitives";
import { MediaDialogContext, MediaDialogNotice } from "../../context/MediaDialogContext";
import { useControlPresentation } from "../../context/ControlPresentationContext";
import { Icon } from "../ui/Icon";
import { HttpError } from "../../lib/functions";
import {
  deleteSourceMedia,
  updateSourceMediaMetadata,
  type SourceMediaAssetSummary,
} from "../../lib/source-media";
import { sourceFrameRateLabel, isBroadcastFrameRate, sourceFramesPerSecond } from "../../lib/video-frame-rate";
import { formatMediaDuration, formatVideoBytes } from "../../lib/media-format";
import { useMediaFeedback, type MediaFeedback } from "../../lib/use-media-feedback";
import { tagsToTokens, tokensToTags } from "../../lib/media-tags";
import { tagKey } from "../ui/tokenInputModel";
import { MediaFeedbackSections, type CommentTiming } from "./MediaFeedbackSections";
import { ViewerTabs } from "./ViewerTabs";
import { VideoRightsFields } from "./VideoRightsFields";
import "./VideoDetailsInspector.css";

const SUGGESTIONS_NOTE = "From this page and your recent tags.";

export interface VideoDetailsEditableValues {
  name: string;
  description: string;
  credit: string;
  license: string;
  tags: string[];
  rightsStatus: SourceMediaAssetSummary["rightsStatus"];
}

export interface VideoDetailsSaveReceipt {
  previous: VideoDetailsEditableValues;
  asset: SourceMediaAssetSummary;
}

export type VideoContextView = "details" | "comments" | "review";

function editableValues(asset: SourceMediaAssetSummary): VideoDetailsEditableValues {
  return {
    name: asset.name,
    description: asset.description ?? "",
    credit: asset.credit ?? "",
    license: asset.license ?? "",
    tags: [...asset.tags],
    rightsStatus: asset.rightsStatus,
  };
}

function currentConflictAsset(error: unknown, asset: SourceMediaAssetSummary): SourceMediaAssetSummary | null {
  if (!(error instanceof HttpError) || error.status !== 409) return null;
  const current = error.data.current;
  return current && typeof current === "object" &&
    (current as Partial<SourceMediaAssetSummary>).id === asset.id &&
    (current as Partial<SourceMediaAssetSummary>).sourceId === asset.sourceId &&
    (current as Partial<SourceMediaAssetSummary>).kind === "video" &&
    Number.isSafeInteger((current as Partial<SourceMediaAssetSummary>).version) &&
    Array.isArray((current as Partial<SourceMediaAssetSummary>).tags)
    ? current as SourceMediaAssetSummary
    : null;
}

function tagSuggestionPool(...sources: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of sources.flat()) {
    const value = tag.trim();
    const key = tagKey(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function displayDate(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not recorded"
    : `${date.toLocaleString("en-US", { timeZone: "America/New_York" })} ET`;
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return <div className="video-inspector-readonly-field"><span>{label}</span><p>{value || "Not recorded"}</p></div>;
}

export function VideoDetailsInspector({
  asset,
  canDelete,
  canEditMetadata,
  commentsTarget,
  contextual = false,
  contextId: suppliedContextId,
  contextView: suppliedContextView,
  commentTiming,
  deleteConfirmationId,
  disabled = false,
  favoriteControl,
  feedback: sharedFeedback,
  footerTarget,
  getIdToken,
  hasOtherDirty = false,
  initialConfirmDelete = false,
  onDeleted,
  onContextViewChange,
  onDetailsRequested,
  onDirtyChange,
  onSavingChange,
  onSaved,
  onSaveSuccess,
  onTagsSaved,
  onUpdated,
  preserveVideoSearchCache,
  pageTags = [],
  recentTags = [],
}: {
  asset: SourceMediaAssetSummary;
  canDelete: boolean;
  canEditMetadata: boolean;
  /** Moves the comments panel into this desktop side pane without remounting its draft state. */
  commentsTarget?: HTMLElement | null;
  /** Mounted contexts under the video preview rather than a separate column. */
  contextual?: boolean;
  contextId?: string;
  contextView?: VideoContextView;
  /** Player controls for comments on a frame or range, when a player is shown. */
  commentTiming?: CommentTiming;
  deleteConfirmationId: string;
  disabled?: boolean;
  favoriteControl?: ReactNode;
  /** Feedback loaded by the viewer, so the player timeline and this list share one state. */
  feedback?: MediaFeedback;
  /** Stable full-viewer action slot; the media frame places it in the header. */
  footerTarget?: HTMLElement | null;
  getIdToken: () => Promise<string>;
  hasOtherDirty?: boolean;
  initialConfirmDelete?: boolean;
  onDeleted: () => void;
  onContextViewChange?: (view: VideoContextView) => void;
  onDetailsRequested?: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  onSaved?: (receipt: VideoDetailsSaveReceipt) => void;
  onSaveSuccess?: (asset: SourceMediaAssetSummary) => void;
  onTagsSaved?: (tags: readonly string[]) => void;
  onUpdated: (asset: SourceMediaAssetSummary, videoSearchRevision?: number) => void;
  preserveVideoSearchCache?: boolean;
  pageTags?: readonly string[];
  recentTags?: readonly string[];
}) {
  const ownFeedback = useMediaFeedback(
    { backend: "s3", sourceId: asset.sourceId, id: asset.id },
    sharedFeedback ? undefined : getIdToken,
  );
  const feedback = sharedFeedback ?? ownFeedback;
  const [ownContextView, setOwnContextView] = useState<VideoContextView>("details");
  const ownContextId = useId();
  const contextView = suppliedContextView ?? ownContextView;
  const contextId = suppliedContextId ?? ownContextId;
  const changeContextView = (view: VideoContextView) => {
    if (suppliedContextView === undefined) setOwnContextView(view);
    onContextViewChange?.(view);
  };
  const [commentDirty, setCommentDirty] = useState(false);
  const metadataFormId = useId();
  const titleInputId = useId();
  useEffect(() => {
    if (commentTiming?.composerRequest || commentTiming?.activeId) changeContextView("comments");
  }, [commentTiming?.composerRequest, commentTiming?.activeId, commentTiming?.navigationRequest]);
  const [detailsOpenRequest, setDetailsOpenRequest] = useState(0);
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description ?? "");
  const [credit, setCredit] = useState(asset.credit ?? "");
  const [license, setLicense] = useState(asset.license ?? "");
  const [tags, setTags] = useState<Token[]>(() => tagsToTokens(asset.tags));
  const [tagDraft, setTagDraft] = useState("");
  const [rightsStatus, setRightsStatus] = useState(asset.rightsStatus);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [conflict, setConflict] = useState<SourceMediaAssetSummary>();
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(initialConfirmDelete && canDelete);
  const [deleteError, setDeleteError] = useState("");
  const [deleteConflict, setDeleteConflict] = useState<SourceMediaAssetSummary>();
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const deleteConfirmation = useRef<HTMLDivElement>(null);
  const committedTags = useRef<string[]>([]);
  const previousAsset = useRef(asset);
  const currentTags = tokensToTags(tags);
  const detailsDirty = name !== asset.name ||
    description !== (asset.description ?? "") ||
    credit !== (asset.credit ?? "") ||
    license !== (asset.license ?? "") ||
    JSON.stringify(currentTags) !== JSON.stringify(asset.tags) ||
    tagDraft.trim() !== "" ||
    rightsStatus !== asset.rightsStatus;
  const feedbackDirty = feedback.reviewDirty || commentDirty;
  const dirty = detailsDirty || feedbackDirty || hasOtherDirty;
  const busy = disabled || saving || deleting || feedback.pending;
  const suggestions = useMemo(
    () => tagSuggestionPool(asset.tags, pageTags, recentTags),
    [asset.tags, pageTags, recentTags],
  );

  useEffect(() => {
    onDirtyChange(detailsDirty || feedbackDirty);
    return () => onDirtyChange(false);
  }, [detailsDirty, feedbackDirty, onDirtyChange]);
  useEffect(() => {
    onSavingChange(saving || deleting || feedback.pending);
    return () => onSavingChange(false);
  }, [deleting, feedback.pending, onSavingChange, saving]);
  const focusDeleteConfirmation = useCallback(() => deleteConfirmation.current?.focus(), []);
  useEffect(() => {
    if (confirmDelete && !initialConfirmDelete) focusDeleteConfirmation();
  }, [confirmDelete, focusDeleteConfirmation, initialConfirmDelete]);

  function loadDetails(next: SourceMediaAssetSummary) {
    setName(next.name);
    setDescription(next.description ?? "");
    setCredit(next.credit ?? "");
    setLicense(next.license ?? "");
    setTags(tagsToTokens(next.tags));
    setTagDraft("");
    setRightsStatus(next.rightsStatus);
    committedTags.current = [];
  }

  useEffect(() => {
    const prior = previousAsset.current;
    previousAsset.current = asset;
    if (prior.id === asset.id && prior.sourceId === asset.sourceId && prior.version === asset.version) return;
    const cleanBeforeUpdate = name === prior.name && description === (prior.description ?? "") &&
      credit === (prior.credit ?? "") && license === (prior.license ?? "") &&
      JSON.stringify(currentTags) === JSON.stringify(prior.tags) && !tagDraft.trim() &&
      rightsStatus === prior.rightsStatus;
    if (prior.id !== asset.id || (cleanBeforeUpdate && !saving)) loadDetails(asset);
  }, [asset]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditMetadata || busy || !detailsDirty) return;
    if (tagDraft.trim()) {
      onDetailsRequested?.();
      changeContextView("details");
      setSaveMessage("Press Enter or comma to add the tag before saving.");
      return;
    }
    setSaving(true);
    setSaveMessage("");
    setConflict(undefined);
    const previous = editableValues(asset);
    try {
      const token = await getIdToken();
      const changes = { name, description, credit, license, tags: currentTags, rightsStatus };
      const response = preserveVideoSearchCache
        ? await updateSourceMediaMetadata(token, asset.sourceId, asset.id, asset.version, changes,
          { preserveVideoSearchCache: true })
        : await updateSourceMediaMetadata(token, asset.sourceId, asset.id, asset.version, changes);
      const savedTags = new Set(response.asset.tags);
      onTagsSaved?.(committedTags.current.filter((tag) => savedTags.has(tag)));
      loadDetails(response.asset);
      if (response.videoSearchRevision === undefined) onUpdated(response.asset);
      else onUpdated(response.asset, response.videoSearchRevision);
      onSaveSuccess?.(response.asset);
      if (response.asset.sourceId === asset.sourceId && response.asset.id === asset.id
        && Number.isSafeInteger(response.asset.version) && response.asset.version > asset.version) {
        onSaved?.({ previous, asset: response.asset });
      }
      setSaveMessage("Video details saved.");
    } catch (error) {
      const current = currentConflictAsset(error, asset);
      setConflict(current ?? undefined);
      setSaveMessage(current
        ? "This video changed. Reload its current details before saving."
        : error instanceof Error ? error.message : "Video details could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function removeVideo() {
    if (!canDelete || busy || dirty) return;
    setDeleting(true);
    setDeleteError("");
    setDeleteConflict(undefined);
    try {
      await deleteSourceMedia(await getIdToken(), asset.sourceId, asset.id, asset.version);
      onDeleted();
    } catch (error) {
      setDeleteConflict(currentConflictAsset(error, asset) ?? undefined);
      setDeleteError(error instanceof HttpError && error.status >= 400 && error.status < 500
        ? error.message : "Could not confirm deletion. Try again to check its status.");
    } finally {
      setDeleting(false);
    }
  }

  const headerSave = useContext(MediaDialogContext).actionsInHeader && Boolean(footerTarget);
  const iconSave = useControlPresentation() === "icons" && headerSave;
  const actions = <div className="video-inspector-actions">{favoriteControl}
    {canEditMetadata ? <AsyncActionButton variant={headerSave ? "ghost" : "primary"}
      className={iconSave ? "media-details-save-icon" : undefined}
      form={metadataFormId} type="submit" disabled={busy || !detailsDirty}
      aria-label={headerSave ? saving ? "Saving details" : "Save details" : undefined}
      label={headerSave ? "Save" : "Save details"} pendingLabel={headerSave ? "Saving" : "Saving details"} pending={saving}
      pendingAnnouncement="Saving video details." icon={headerSave ? "save" : "check"}
      title={!detailsDirty ? "No changes to save." : "Save details"} /> : null}
  </div>;
  const messages = saveMessage || conflict || !canEditMetadata;
  const inFooter = Boolean(footerTarget) && canEditMetadata;
  const footer = inFooter && !messages ? undefined : <div className="video-inspector-footer">
    {saveMessage ? <p role={conflict ? "alert" : "status"}>{saveMessage}</p> : null}
    {conflict ? <Button onClick={() => {
      loadDetails(conflict);
      onUpdated(conflict);
      setConflict(undefined);
      setSaveMessage("");
    }}>Reload details</Button> : null}
    {inFooter ? null : actions}
    {canEditMetadata ? null : <InlineMessage title="Read-only media access">Your role can use this video but cannot edit it.</InlineMessage>}
  </div>;
  const noticeFooter = contextual && headerSave && Boolean(saveMessage || conflict);
  const viewingCopy = asset.viewingCopy;

  const detailsFields = <>
      <InspectorSection id="details" title="Details" openRequest={detailsOpenRequest}
        onOpenRequestHandled={() => document.getElementById(titleInputId)?.focus()}>
        {canEditMetadata ? <>
          <label className="video-inspector-field">Title<TextInput id={titleInputId} required maxLength={500} value={name} disabled={busy}
            onInvalid={() => { onDetailsRequested?.(); changeContextView("details"); setDetailsOpenRequest(request => request + 1); }} onChange={event => setName(event.target.value)} /></label>
          <label className="video-inspector-field">Description<Textarea maxLength={2000} rows={3} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
        </> : <>
          <ReadOnlyField label="Title" value={name} />
          <ReadOnlyField label="Description" value={description} />
        </>}
        {asset.metadataUpdateRequested ? <InlineMessage tone="info" title="Metadata update requested">Request recorded for the metadata pass.</InlineMessage> : null}
      </InspectorSection>

      <InspectorSection count={rightsStatus === "complete" ? "Recorded" : "Needs review"} id="rights" title="Rights">
        <VideoRightsFields values={{ rightsStatus, credit, license }} disabled={busy} onChange={canEditMetadata ? values => {
          setRightsStatus(values.rightsStatus); setCredit(values.credit); setLicense(values.license);
        } : undefined} />
      </InspectorSection>

      <InspectorSection count={tags.length} id="tags" title="Tags">
        {canEditMetadata ? <TokenInput
          disabled={busy}
          draft={tagDraft}
          label="Tags"
          maxCount={30}
          maxLength={80}
          onChange={setTags}
          onCommit={(values) => { committedTags.current.push(...values); }}
          onDraftChange={setTagDraft}
          placeholder="Add tag…"
          suggestions={suggestions}
          suggestionsNote={SUGGESTIONS_NOTE}
          tokens={tags}
        /> : <ReadOnlyField label="Tags" value={currentTags.join(", ")} />}
      </InspectorSection>

  </>;
  const fileFields = <>
      <InspectorSection defaultOpen={false} id="file" title="File information">
        <dl className="video-inspector-facts">
          <div><dt>Uploaded by</dt><dd>{asset.uploadedBy?.name ?? "Not recorded"}</dd></div>
          <div><dt>Added to library</dt><dd>{displayDate(asset.createdAt)}</dd></div>
          <div><dt>Filename</dt><dd>{asset.originalName}</dd></div>
          <div><dt>Original file size</dt><dd>{formatVideoBytes(asset.sizeBytes)}</dd></div>
          {viewingCopy?.state === "ready" && viewingCopy.sizeBytes ? <div><dt>Web copy size</dt><dd>{formatVideoBytes(viewingCopy.sizeBytes)}</dd></div> : null}
          <div><dt>Source frame rate</dt><dd>{sourceFrameRateLabel(viewingCopy)}</dd></div>
          {sourceFramesPerSecond(viewingCopy) !== null && !isBroadcastFrameRate(viewingCopy) ? <div><dt>Broadcast notice</dt><dd>Not the 29.97 fps broadcast standard. CentralCast needs 29.97 fps (30000/1001); this source cannot air. Selection and publishing remain available.</dd></div> : null}
          {viewingCopy?.state === "ready" && viewingCopy.width && viewingCopy.height ? <div><dt>Web copy frame</dt><dd>{viewingCopy.width} × {viewingCopy.height}</dd></div> : null}
          {viewingCopy?.state === "ready" && viewingCopy.durationSeconds !== undefined ? <div><dt>Duration</dt><dd>{formatMediaDuration(viewingCopy.durationSeconds)}</dd></div> : null}
          {viewingCopy?.state === "failed" && viewingCopy.errorCode ? <div><dt>Preview error reference</dt><dd>{viewingCopy.errorCode}</dd></div> : null}
          <div><dt>Type</dt><dd>{asset.mimeType}</dd></div>
        </dl>
      </InspectorSection>

      {canDelete ? <InspectorSection defaultOpen={false} id="delete" onOpenRequestHandled={focusDeleteConfirmation} openRequest={initialConfirmDelete ? 1 : 0} title="Delete from library">
        <p className="video-inspector-help">The original stays retained for recovery. The video will no longer appear in this library.</p>
        {dirty ? <p className="video-inspector-help">Save or discard your edits before deleting.</p> : null}
        {deleteError ? <InlineMessage tone="error" title="Video deletion needs attention">{deleteError}
          {deleteConflict ? <Button onClick={() => {
            loadDetails(deleteConflict);
            onUpdated(deleteConflict);
            setDeleteConflict(undefined);
            setDeleteError("");
            setConfirmDelete(false);
          }}>Reload details</Button> : null}
        </InlineMessage> : null}
        {confirmDelete ? <div id={deleteConfirmationId} role="group" aria-label="Confirm video deletion" tabIndex={-1} ref={deleteConfirmation}>
          <p>Delete {asset.name} from the library?</p>
          <div className="source-video-delete-actions"><Button variant="danger" disabled={busy || dirty || Boolean(deleteConflict)} onClick={() => void removeVideo()}>{deleting ? "Deleting video" : "Yes, delete from library"}</Button>
            <Button disabled={deleting} variant="ghost" onClick={() => { setConfirmDelete(false); requestAnimationFrame(() => deleteTrigger.current?.focus()); }}>Keep video</Button></div>
          {deleting ? <p role="status">Deleting video from the library.</p> : null}
        </div> : <Button ref={deleteTrigger} variant="danger" disabled={busy || dirty} onClick={() => {
          setConfirmDelete(true);
          requestAnimationFrame(() => deleteConfirmation.current?.focus());
        }}>Delete from library</Button>}
      </InspectorSection> : null}
  </>;
  const feedbackSections = <MediaFeedbackSections feedback={feedback} locked={disabled || saving || deleting}
        context={contextual ? { view: contextView, id: contextId } : undefined}
        commentsTarget={commentsTarget}
        onCommentDirtyChange={setCommentDirty} reviewSaveMode="separate" timing={commentTiming} />;

  return <>{inFooter && footerTarget ? createPortal(actions, footerTarget) : null}
    {noticeFooter ? <MediaDialogNotice><InlineMessage title="Video details save">{footer}</InlineMessage></MediaDialogNotice> : null}
    <Inspector docked dirty={detailsDirty} footer={noticeFooter ? undefined : footer} heading={asset.name} label="Video details" open storageKey="video">
    {contextual ? <ViewerTabs className="video-context-tabs viewer-tabs" label="Asset context" value={contextView}
      items={[{ value: "details", label: "Details", panelId: `${contextId}-details` },
        { value: "comments", label: "Comments", panelId: `${contextId}-comments` },
        { value: "review", label: "Your review", panelId: `${contextId}-review` }]} onChange={changeContextView} /> : null}
    <form className="video-inspector-form" id={metadataFormId} onSubmit={save}>
      {contextual ? <>
        <div id={`${contextId}-details`} hidden={contextView !== "details"} role="tabpanel" aria-label="Details">
          {detailsFields}{fileFields}
        </div>
        {feedbackSections}
      </> : <>{detailsFields}{feedbackSections}{fileFields}</>}

    </form>
  </Inspector></>;
}
