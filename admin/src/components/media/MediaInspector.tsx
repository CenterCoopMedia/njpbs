import { ControlSizingProvider } from "../../context/ControlSizingContext";
import { useControlPresentation } from "../../context/ControlPresentationContext";
import { MediaDialogContext } from "../../context/MediaDialogContext";
import { AudioPlayback, type AudioToken } from "./AudioMedia";
import { MediaFeedbackSections } from "./MediaFeedbackSections";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AssetImage } from "../ui/AssetImage";
import { InfoTooltip } from "../ui/InfoTooltip";
import { Inspector, InspectorSection } from "../ui/Inspector";
import { TokenInput, type Token } from "../ui/TokenInput";
import { Icon } from "../ui/Icon";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Textarea,
  TextInput,
} from "../ui/Primitives";
import { formatMediaBytes } from "../../lib/media-display";
import { formatMediaDuration } from "../../lib/media-format";
import {
  HttpError,
  type DeleteMediaResponse,
  type MediaAssetSummary,
  type MediaCategoryDefinition,
  type UpdateMediaMetadata,
  type UpdateMediaMetadataResponse,
} from "../../lib/functions";
import { mediaPreviewImage } from "../../lib/media-image";
import { useMediaFeedback } from "../../lib/use-media-feedback";
import { normalizeMediaTags } from "../../lib/media-upload";
import { tagMatchKey, tagsToTokens, tokensToTags } from "../../lib/media-tags";
import { mediaCategoryLabel } from "../../lib/use-media-categories";
import { mediaOriginLabel } from "../../lib/media-origin";

const MEDIA_FILENAME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/avif": ["avif"],
  "application/pdf": ["pdf"],
  "audio/wav": ["wav"],
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

const SUGGESTIONS_NOTE = "From this page and your recent tags.";
const CATEGORY_HELP = "The primary category is required and cannot be removed. Other categories improve search and filtering.";

function validateMediaFilename(value: string, mimeType: string): string | null {
  const filename = value.trim();
  if (!filename) return "Enter a filename.";
  if (filename.length > 255) return "Use a filename of 255 characters or fewer.";
  const invalid = [...filename].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "/" || character === "\\" || codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
  if (invalid) return "Filename contains invalid characters.";
  const extensions = MEDIA_FILENAME_EXTENSIONS[mimeType];
  if (!extensions) return "This file type does not support filename changes.";
  const separator = filename.lastIndexOf(".");
  const extension = separator > 0 ? filename.slice(separator + 1).toLocaleLowerCase("en-US") : "";
  if (extensions.includes(extension)) return null;
  const allowed = extensions.map((candidate) => `.${candidate}`).join(" or ");
  return `Use ${allowed} for this ${mimeType} file.`;
}

function displayDate(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : DATE_FORMATTER.format(date);
}

function imageTagSuggestionPool(...sources: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of sources.flat()) {
    const value = tag.trim();
    const key = tagMatchKey(value, "case-insensitive");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function MediaCategoryChips({
  categoryIds,
  categories,
}: {
  categoryIds: readonly string[];
  categories: readonly MediaCategoryDefinition[];
}) {
  return (
    <span className="media-category-chips">
      {categoryIds.map((category) => (
        <span className="media-category-chip" key={category}>
          {mediaCategoryLabel(categories, category)}
        </span>
      ))}
    </span>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="media-inspector-readonly-field">
      <span>{label}</span>
      <p>{value || "Not recorded"}</p>
    </div>
  );
}

/** The details preview uses list thumbnails. Open original keeps the full file available. */
function MediaPreview({ asset }: { asset: MediaAssetSummary }) {
  if (asset.kind === "image") {
    return (
      <AssetImage
        {...mediaPreviewImage(asset, 320)}
        alt=""
        decoding="async"
        fallback={(
          <span aria-hidden="true" className="media-document-preview">
            <Icon name="image" />
            <span>Preview unavailable</span>
          </span>
        )}
      />
    );
  }
  return (
    <span aria-hidden="true" className="media-document-preview">
      <Icon name="file" />
      <span>PDF</span>
    </span>
  );
}

interface MediaInspectorBaseProps {
  getIdToken?: AudioToken;
  asset: MediaAssetSummary;
  /** Full-viewer action slot; phones keep Save beside the inspector's fields. */
  footerTarget?: HTMLElement | null;
  categories: readonly MediaCategoryDefinition[];
  canEdit: boolean;
  onDeleted: (asset: MediaAssetSummary) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  onReload: () => void;
  /** Holds the form while a conflict reload replaces the asset. */
  locked?: boolean;
  onSaveReceipt?: (receipt: MediaInspectorSaveReceipt) => void;
  onSaved: (asset: MediaAssetSummary) => void;
  saveMetadata: (
    asset: MediaAssetSummary,
    metadata: UpdateMediaMetadata,
  ) => Promise<UpdateMediaMetadataResponse>;
  deleteMedia: (asset: MediaAssetSummary) => Promise<DeleteMediaResponse>;
  favoriteControl?: ReactNode;
  replaceControl?: ReactNode;
  pageTags?: readonly string[];
  recentTags?: readonly string[];
  onTagsSaved?: (tags: readonly string[]) => void;
  confirmDeleteRequest?: number;
  onConfirmDeleteShown?: () => void;
}

export interface MediaInspectorSaveReceipt {
  previous: UpdateMediaMetadata;
  asset: MediaAssetSummary;
}

export type MediaInspectorProps = MediaInspectorBaseProps & (
  | {
    docked?: false;
    onClose: () => void;
    /** Opens the full-size viewer from the standalone preview. */
    onOpenFullSize?: () => void;
  }
  | {
    docked: true;
    onClose?: never;
    onOpenFullSize?: never;
  }
);

export function MediaInspector(props: MediaInspectorProps) {
  return <ControlSizingProvider size="standard"><MediaInspectorContent {...props} /></ControlSizingProvider>;
}

function MediaInspectorContent({
  asset,
  getIdToken,
  categories,
  canEdit,
  docked = false,
  onClose,
  onDeleted,
  onDirtyChange,
  onReload,
  onSaveReceipt,
  onSaved,
  onSavingChange,
  locked = false,
  saveMetadata,
  deleteMedia,
  favoriteControl,
  replaceControl,
  footerTarget,
  pageTags = [],
  recentTags = [],
  onTagsSaved,
  confirmDeleteRequest = 0,
  onConfirmDeleteShown,
  onOpenFullSize,
}: MediaInspectorProps) {
  const feedback = useMediaFeedback({ backend: "r2", id: asset.id }, getIdToken);
  const [commentDirty, setCommentDirty] = useState(false);
  const feedbackDirty = feedback.reviewDirty || commentDirty;
  const maySave = canEdit || feedback.enabled;
  const formId = useId();
  const descriptionId = useId();
  const [name, setName] = useState(asset.name);
  const [originalName, setOriginalName] = useState(asset.originalName);
  const [description, setDescription] = useState(asset.description ?? "");
  const [altText, setAltText] = useState(asset.altText ?? "");
  const [license, setLicense] = useState(asset.license ?? "");
  const [credit, setCredit] = useState(asset.credit ?? "");
  const [tags, setTags] = useState<Token[]>(() => tagsToTokens(asset.tags));
  const [tagDraft, setTagDraft] = useState("");
  const [assignedCategories, setAssignedCategories] = useState(asset.categories);
  const [saving, setSaving] = useState(false);
  const fieldsLocked = saving || locked || feedback.pending;
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reviewOnlySaved, setReviewOnlySaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteConflict, setDeleteConflict] = useState(false);
  const localSaveEtag = useRef<string | null>(null);
  const committedTags = useRef<string[]>([]);
  const deleteConfirmRef = useRef<HTMLDivElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const returnDeleteFocus = useRef(false);
  const tagSuggestions = useMemo(
    () => imageTagSuggestionPool(asset.tags, pageTags, recentTags),
    [asset.tags, pageTags, recentTags],
  );

  useEffect(() => {
    setName(asset.name);
    setOriginalName(asset.originalName);
    setDescription(asset.description ?? "");
    setAltText(asset.altText ?? "");
    setLicense(asset.license ?? "");
    setCredit(asset.credit ?? "");
    setTags(tagsToTokens(asset.tags));
    setTagDraft("");
    setAssignedCategories(asset.categories);
    setError(null);
    setConflict(false);
    setSaved(localSaveEtag.current === asset.etag);
    setConfirmingDelete(false);
    setDeleteError(null);
    setDeleteConflict(false);
    committedTags.current = [];
    localSaveEtag.current = null;
    // The ETag is the versioned identity for all editable asset metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id, asset.etag]);

  const currentTags = tokensToTags(tags);
  const dirty =
    name !== asset.name ||
    (asset.source === "upload" && originalName !== asset.originalName) ||
    description !== (asset.description ?? "") ||
    altText !== (asset.altText ?? "") ||
    license !== (asset.license ?? "") ||
    credit !== (asset.credit ?? "") ||
    tagDraft.trim() !== "" ||
    JSON.stringify(currentTags) !== JSON.stringify(asset.tags) ||
    JSON.stringify(assignedCategories) !== JSON.stringify(asset.categories);

  useEffect(() => {
    onDirtyChange(dirty || feedbackDirty);
    return () => onDirtyChange(false);
  }, [dirty, feedbackDirty, onDirtyChange]);

  useEffect(() => {
    onSavingChange(saving || deleting || feedback.pending);
    return () => onSavingChange(false);
  }, [deleting, feedback.pending, saving, onSavingChange]);

  useEffect(() => {
    if (!confirmDeleteRequest) return;
    onConfirmDeleteShown?.();
    if (!canEdit || asset.source !== "upload") return;
    returnDeleteFocus.current = false;
    setConfirmingDelete(true);
    // Only a new request opens the confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDeleteRequest]);

  useEffect(() => {
    if (confirmingDelete) deleteConfirmRef.current?.focus();
    else if (returnDeleteFocus.current) {
      returnDeleteFocus.current = false;
      deleteTriggerRef.current?.focus();
    }
  }, [confirmDeleteRequest, confirmingDelete]);

  function reset() {
    feedback.resetReview();
    setName(asset.name);
    setOriginalName(asset.originalName);
    setDescription(asset.description ?? "");
    setAltText(asset.altText ?? "");
    setLicense(asset.license ?? "");
    setCredit(asset.credit ?? "");
    setTags(tagsToTokens(asset.tags));
    setTagDraft("");
    setAssignedCategories(asset.categories);
    setError(null);
    setConflict(false);
    setSaved(false);
    committedTags.current = [];
  }

  function previousMetadata(restoreOriginalName: boolean): UpdateMediaMetadata {
    return {
      ...(restoreOriginalName ? { originalName: asset.originalName } : {}),
      name: asset.name,
      description: asset.description,
      altText: asset.altText,
      ...(asset.altTextGenerated === true && asset.altText?.trim() ? { altTextGenerated: true as const } : {}),
      license: asset.license,
      credit: asset.credit,
      tags: [...asset.tags],
      categories: [...asset.categories],
    };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!maySave || saving || feedback.pending) return;
    if (!dirty || !canEdit) {
      if (!(await feedback.saveReview())) return;
      setReviewOnlySaved(true);
      setSaved(true);
      return;
    }
    setReviewOnlySaved(false);
    const nextName = name.trim();
    const nextOriginalName = originalName.trim();
    const nextLicense = license.trim();
    const tagResult = normalizeMediaTags(currentTags);
    if (tagDraft.trim()) {
      setError("Press Enter or comma to add the tag before saving.");
      return;
    }
    if (!nextName) {
      setError("Enter a media name.");
      return;
    }
    if (asset.source === "upload" && nextOriginalName !== asset.originalName) {
      const filenameError = validateMediaFilename(nextOriginalName, asset.mimeType);
      if (filenameError) {
        setError(filenameError);
        return;
      }
    }
    if (tagResult.error) {
      setError(tagResult.error);
      return;
    }
    if (assignedCategories.length < 1 || assignedCategories.length > 8 || !assignedCategories.includes(asset.category)) {
      setError("Choose up to eight categories and keep the primary category assigned.");
      return;
    }

    const reviewChanged = feedback.reviewDirty;
    if (!(await feedback.saveReview())) return;

    const metadata: UpdateMediaMetadata = {
      ...(asset.source === "upload" && nextOriginalName !== asset.originalName
        ? { originalName: nextOriginalName }
        : {}),
      name: nextName,
      description: description.trim() || null,
      altText: altText.trim() || null,
      license: nextLicense || null,
      credit: credit.trim() || null,
      tags: tagResult.tags,
      categories: [asset.category, ...assignedCategories.filter((category) => category !== asset.category)],
    };

    const restoreOriginalName = metadata.originalName !== undefined;
    const canRestore = (!restoreOriginalName || !validateMediaFilename(asset.originalName, asset.mimeType)) &&
      (asset.altTextGenerated !== true || Boolean(asset.altText?.trim()));
    const previous = previousMetadata(restoreOriginalName);
    setSaving(true);
    setError(null);
    setConflict(false);
    setSaved(false);
    try {
      const response = await saveMetadata(asset, metadata);
      setName(response.asset.name);
      setOriginalName(response.asset.originalName);
      setDescription(response.asset.description ?? "");
      setAltText(response.asset.altText ?? "");
      setLicense(response.asset.license ?? "");
      setCredit(response.asset.credit ?? "");
      setTags(tagsToTokens(response.asset.tags));
      setTagDraft("");
      setAssignedCategories(response.asset.categories);
      localSaveEtag.current = response.asset.etag;
      const savedTags = new Set(response.asset.tags.map((tag) => tagMatchKey(tag, "case-insensitive")));
      onTagsSaved?.(committedTags.current.filter((tag) => savedTags.has(tagMatchKey(tag, "case-insensitive"))));
      committedTags.current = [];
      onSaved(response.asset);
      if (canRestore && response.changed && response.asset.id === asset.id &&
          typeof response.asset.etag === "string" && response.asset.etag.length > 0 &&
          response.asset.etag !== asset.etag) {
        onSaveReceipt?.({ previous, asset: response.asset });
      }
      setSaved(true);
    } catch (saveError) {
      const isConflict = saveError instanceof HttpError && saveError.status === 412;
      setConflict(isConflict);
      const message = isConflict
        ? "This asset changed. Reload it before saving."
        : saveError instanceof Error
          ? saveError.message
          : "Media details could not be saved.";
      setError(reviewChanged ? `Your review was saved. ${message}` : message);
    } finally {
      setSaving(false);
    }
  }

  async function removeFromLibrary(): Promise<void> {
    if (!canEdit || dirty || feedbackDirty || fieldsLocked || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    setDeleteConflict(false);
    try {
      await deleteMedia(asset);
      onDeleted(asset);
    } catch (deleteFailure) {
      const isConflict = deleteFailure instanceof HttpError && deleteFailure.status === 412;
      setDeleteConflict(isConflict);
      setDeleteError(
        isConflict
          ? "This asset changed. Reload it before deleting."
          : deleteFailure instanceof Error
            ? deleteFailure.message
            : "This media asset could not be deleted from the library.",
      );
    } finally {
      setDeleting(false);
    }
  }

  const mediaDialog = useContext(MediaDialogContext);
  const framedActions = mediaDialog.actionsInHeader && Boolean(footerTarget);
  const inlineActions = framedActions && mediaDialog.compactActions;
  const pinFormActions = inlineActions && (dirty || feedback.reviewDirty);
  const actionsTarget = inlineActions ? null : footerTarget;
  const headerSave = framedActions && !inlineActions;
  const cancelControl = useRef<HTMLButtonElement>(null);
  const saveControl = useRef<HTMLDivElement | null>(null);
  const revealFocusedMetadataField = useCallback(() => {
    if (!pinFormActions) return;
    const field = document.activeElement;
    const footer = saveControl.current?.closest<HTMLElement>(".ui-inspector-footer");
    const inspector = saveControl.current?.closest(".ui-inspector");
    if (!(field instanceof HTMLElement) || !inspector?.contains(field) || !footer || footer.contains(field)) return;
    if (field.getBoundingClientRect().bottom > footer.getBoundingClientRect().top) {
      field.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [pinFormActions]);
  useLayoutEffect(() => {
    if (!pinFormActions) return;
    const inspector = saveControl.current?.closest(".ui-inspector");
    revealFocusedMetadataField();
    inspector?.addEventListener("focusin", revealFocusedMetadataField);
    return () => inspector?.removeEventListener("focusin", revealFocusedMetadataField);
  }, [pinFormActions, revealFocusedMetadataField]);
  useEffect(() => {
    if (!framedActions) return;
    let frame: number | undefined;
    const reveal = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const save = saveControl.current?.querySelector<HTMLButtonElement>('button[type="submit"]');
        for (const control of [cancelControl.current, save]) {
          if (control && control === document.activeElement) {
            control.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        }
        revealFocusedMetadataField();
      });
    };
    const body = saveControl.current?.closest("dialog")?.querySelector(".component-editor-dialog-body");
    const observer = body && typeof ResizeObserver === "function" ? new ResizeObserver(reveal) : null;
    if (body) observer?.observe(body);
    reveal();
    window.addEventListener("resize", reveal);
    return () => {
      window.removeEventListener("resize", reveal);
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [mediaDialog.compactActions, framedActions, revealFocusedMetadataField]);
  const restoreSaveFocus = useRef(false);
  const setSaveControl = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      restoreSaveFocus.current = saveControl.current?.querySelector('button[type="submit"]') === document.activeElement;
      saveControl.current = null;
      return;
    }
    saveControl.current = element;
    if (restoreSaveFocus.current) {
      restoreSaveFocus.current = false;
      queueMicrotask(() => {
        if (saveControl.current === element && element.isConnected && document.activeElement === document.body) {
          // The phone form footer may be below the current body scroll position.
          // Native focus reveals the moved control inside that scroll owner.
          element.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
        }
      });
    }
  }, []);
  const iconSave = useControlPresentation() === "icons" && headerSave;
  const cancelAction = <Button
        ref={cancelControl}
        aria-label="Cancel changes"
        disabled={!(dirty || feedback.reviewDirty) || fieldsLocked}
        onClick={reset}
        title={!(dirty || feedback.reviewDirty) ? "No changes to cancel." : undefined}
      >
        {docked ? <><Icon className="button-compact-icon" name="undo" /><span className={inlineActions ? undefined : "button-compact-label"}>Cancel changes</span></> : "Cancel"}
      </Button>;
  const showFramedCancel = framedActions && maySave && (dirty || feedback.reviewDirty);
  const formActions = maySave ? (
    <div className="media-form-actions" ref={setSaveControl}>
      {!framedActions ? cancelAction : null}
      <AsyncActionButton
        size={framedActions ? "standard" : undefined}
        disabled={!(dirty || feedback.reviewDirty) || locked || feedback.comments.mutation !== null}
        form={formId}
        aria-label={headerSave || !docked ? saving || feedback.review.saving ? "Saving details…" : "Save details" : undefined}
        icon={headerSave ? "save" : docked ? "check" : undefined}
        className={iconSave ? "media-details-save-icon" : undefined}
        label={headerSave ? "Save" : docked ? "Save details" : "Save"}
        pending={saving || feedback.review.saving}
        pendingAnnouncement="Saving media details."
        pendingLabel={headerSave ? "Saving…" : docked ? "Saving details…" : "Saving…"}
        title={!(dirty || feedback.reviewDirty) ? "No changes to save." : undefined}
        type="submit"
        variant={headerSave ? "ghost" : "primary"}
      />
    </div>
  ) : null;
  const previewActions = docked && (favoriteControl || replaceControl);
  const showSavedNotice = saved && !reviewOnlySaved;
  const footer = actionsTarget && canEdit && !error && !showSavedNotice && !previewActions && !showFramedCancel ? undefined : (
    <div className="media-image-inspector-footer" data-viewer-keys="off" data-pinned={pinFormActions || undefined}>
      {error ? (
        <InlineMessage tone="error" title="Media details were not saved">
          <span>{error}</span>
          {conflict ? <Button onClick={onReload}>Reload asset</Button> : null}
        </InlineMessage>
      ) : null}
      {showSavedNotice ? (
        <InlineMessage tone="success" title="Media details saved">
          The current version is {asset.version}.
        </InlineMessage>
      ) : null}
      {previewActions ? (
        <div className="media-image-inspector-preview-actions">{favoriteControl}{replaceControl}</div>
      ) : null}
      {maySave && !actionsTarget ? formActions : null}
      {showFramedCancel ? cancelAction : null}
      {!canEdit ? <InlineMessage title="Read-only media access">
        Your role can use this asset but cannot edit its shared details.
      </InlineMessage> : null}
    </div>
  );

  const inspectorLayout = docked
    ? { docked: true as const }
    : { onClose: onClose! };

  return (
    <>
    {actionsTarget && formActions ? createPortal(formActions, actionsTarget) : null}
    <Inspector
      {...inspectorLayout}
      className={`media-image-inspector${asset.kind === "audio" ? " media-audio-inspector" : ""}`}
      dirty={dirty || feedbackDirty}
      footer={footer}
      fitViewport
      heading={asset.name}
      label="Asset details"
      open
      storageKey="images"
    >
      <form className="media-image-inspector-form" id={formId} onSubmit={save}>
        {!docked ? (
          <InspectorSection id="preview" title="Preview">
            {asset.kind === "audio" ? <AudioPlayback asset={asset} getIdToken={getIdToken} /> : <a
              aria-describedby={descriptionId}
              className="media-image-inspector-preview"
              href={asset.url}
              onClick={onOpenFullSize ? (event) => {
                event.preventDefault();
                onOpenFullSize();
              } : undefined}
              rel={onOpenFullSize ? undefined : "noreferrer"}
              target={onOpenFullSize ? undefined : "_blank"}
            >
              <MediaPreview asset={asset} />
              {onOpenFullSize ? (
                <span>Open full size <Icon name="maximize" /></span>
              ) : (
                <span>Open original <Icon name="external-link" /></span>
              )}
            </a>}
            <p className="media-file-summary" id={descriptionId}>
              {asset.mimeType} · {formatMediaBytes(asset.sizeBytes)}
              {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ""}
            </p>
            {favoriteControl || replaceControl ? <div className="media-image-inspector-preview-actions">{favoriteControl}{replaceControl}</div> : null}
          </InspectorSection>
        ) : null}

        {asset.voiceover ? <InspectorSection id="voiceover" title="Voiceover">
          <ReadOnlyField label="Performer" value={asset.voiceover.performer_name} />
          <ReadOnlyField label="Style" value={asset.voiceover.style} />
          <ReadOnlyField label="Family" value={asset.voiceover.family} />
          <ReadOnlyField label="Take" value={String(asset.voiceover.take)} />
          <ReadOnlyField label="Duration" value={asset.voiceover.duration_seconds ? formatMediaDuration(asset.voiceover.duration_seconds) : "Not recorded"} />
          <ReadOnlyField label="Text" value={asset.voiceover.display_text ?? asset.voiceover.text} />
          <ReadOnlyField label="Flags" value={asset.voiceover.flags.join(", ")} />
        </InspectorSection> : null}

        <InspectorSection id="details" title="Details">
          {canEdit ? (
            <>
              <label className="media-inspector-field">
                Name
                <TextInput
                  disabled={fieldsLocked}
                  maxLength={180}
                  onChange={(event) => setName(event.target.value)}
                  required
                  value={name}
                />
              </label>
              {asset.source === "upload" ? (
                <div className="media-inspector-field">
                  <div className="editor-field-label-row">
                    <label htmlFor={`${descriptionId}-filename-input`}>Filename</label>
                    <InfoTooltip label="Filename" content="This changes library metadata only. The stored file and URL stay the same." />
                  </div>
                  <TextInput
                    aria-describedby={`${descriptionId}-filename`}
                    aria-label="Filename"
                    disabled={fieldsLocked}
                    id={`${descriptionId}-filename-input`}
                    maxLength={255}
                    onChange={(event) => setOriginalName(event.target.value)}
                    required
                    value={originalName}
                  />
                  <span className="media-inspector-field-help" id={`${descriptionId}-filename`}>
                    This changes library metadata only. The stored file and URL stay the same.
                  </span>
                </div>
              ) : null}
              <label className="media-inspector-field">
                Description
                <Textarea
                  disabled={fieldsLocked}
                  maxLength={2_000}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                  value={description}
                />
              </label>
              {asset.kind !== "audio" ? <div className="media-inspector-field">
                <div className="editor-field-label-row">
                  <label htmlFor={`${descriptionId}-alt-input`}>Alt-text suggestion</label>
                  <InfoTooltip label="Alt-text suggestion" content="Editors confirm alt text in context." />
                </div>
                <Textarea
                  aria-describedby={`${descriptionId}-alt`}
                  aria-label="Alt-text suggestion"
                  disabled={fieldsLocked}
                  id={`${descriptionId}-alt-input`}
                  maxLength={500}
                  onChange={(event) => setAltText(event.target.value)}
                  rows={3}
                  value={altText}
                />
                <span className="sr-only" id={`${descriptionId}-alt`}>Editors confirm alt text in context.</span>
              </div> : null}
            </>
          ) : (
            <>
              <ReadOnlyField label="Name" value={name} />
              {asset.source === "upload" ? <ReadOnlyField label="Filename" value={originalName} /> : null}
              <ReadOnlyField label="Description" value={description} />
              {asset.kind !== "audio" ? <ReadOnlyField label="Alt-text suggestion" value={altText} /> : null}
            </>
          )}
          {asset.metadataUpdateRequested ? <InlineMessage tone="info" title="Metadata update requested">Request recorded for the metadata pass.</InlineMessage> : null}
          {asset.altTextGenerated && altText === (asset.altText ?? "") ? (
            <InlineMessage tone="info" title="Generated alt text">
              The alt-text sweep wrote this text. Check it and edit it if needed.
            </InlineMessage>
          ) : null}
        </InspectorSection>

        <InspectorSection count={license.trim() || undefined} id="rights" title="Rights">
          {canEdit ? (
            <>
              <label className="media-inspector-field">
                License
                <TextInput disabled={fieldsLocked} maxLength={120} onChange={(event) => setLicense(event.target.value)} value={license} />
              </label>
              <label className="media-inspector-field">
                Credit
                <TextInput disabled={fieldsLocked} maxLength={300} onChange={(event) => setCredit(event.target.value)} value={credit} />
              </label>
            </>
          ) : (
            <>
              <ReadOnlyField label="License" value={license} />
              <ReadOnlyField label="Credit" value={credit} />
            </>
          )}
          {license.trim() ? null : (
            <InlineMessage tone="warning" title="No license entered">
              This file has no license. Add one so the rights are on record.
            </InlineMessage>
          )}
        </InspectorSection>

        <InspectorSection count={tags.length} id="tags" title="Tags">
          {canEdit ? (
            <TokenInput
              disabled={fieldsLocked}
              label="Tags"
              maxCount={20}
              maxLength={40}
              draft={tagDraft}
              onChange={setTags}
              onCommit={(values) => { committedTags.current.push(...values); }}
              onDraftChange={setTagDraft}
              placeholder="Add tag…"
              suggestions={tagSuggestions}
              suggestionsNote={SUGGESTIONS_NOTE}
              tokens={tags}
            />
          ) : <ReadOnlyField label="Tags" value={currentTags.join(", ")} />}
        </InspectorSection>

        <InspectorSection count={assignedCategories.length} id="categories" title="Categories">
          {canEdit ? (
            <fieldset aria-label="Category assignments" className="media-category-assignments">
              <legend>
                <span>Category assignments</span>
                <InfoTooltip label="Category assignments" content={CATEGORY_HELP} />
              </legend>
              <div>
                {categories
                  .filter((category) => category.active || assignedCategories.includes(category.id))
                  .map((category) => {
                    const primary = category.id === asset.category;
                    const checked = assignedCategories.includes(category.id);
                    return (
                      <label key={category.id}>
                        <input
                          aria-label={`${category.label}${primary ? " (primary)" : ""}${!category.active ? " (archived)" : ""}`}
                          aria-describedby={category.description ? `${descriptionId}-${category.id}-description` : undefined}
                          checked={checked}
                          disabled={fieldsLocked || primary || (!category.active && !checked)}
                          onChange={() => {
                            setAssignedCategories((current) => {
                              if (current.includes(category.id)) return current.filter((id) => id !== category.id);
                              if (current.length >= 8) {
                                setError("Choose no more than eight categories.");
                                return current;
                              }
                              setError(null);
                              return [...current, category.id];
                            });
                          }}
                          type="checkbox"
                        />
                        <span>
                          {category.label}
                          {primary ? " (primary)" : ""}
                          {!category.active ? " (archived)" : ""}
                          {category.description ? <small id={`${descriptionId}-${category.id}-description`}>{category.description}</small> : null}
                        </span>
                      </label>
                    );
                  })}
              </div>
            </fieldset>
          ) : (
            <div className="media-inspector-readonly-field">
              <div className="editor-field-label-row">
                <span>Category assignments</span>
                <InfoTooltip label="Category assignments" content={CATEGORY_HELP} />
              </div>
              <p>{categories
                .filter((category) => assignedCategories.includes(category.id))
                .map((category) => `${category.label}${category.id === asset.category ? " (primary)" : ""}${!category.active ? " (archived)" : ""}`)
                .join(", ")}</p>
            </div>
          )}
        </InspectorSection>

        <MediaFeedbackSections feedback={feedback} locked={locked || saving || deleting}
          onCommentDirtyChange={setCommentDirty} reviewSaveMode="combined" />

        <InspectorSection defaultOpen={false} id="file" title="File information">
          <dl className="media-image-inspector-facts">
            <div><dt>Type</dt><dd>{asset.mimeType}</dd></div>
            <div><dt>Origin</dt><dd>{mediaOriginLabel(asset.source)}</dd></div>
            <div><dt>Size</dt><dd>{formatMediaBytes(asset.sizeBytes)}</dd></div>
            <div><dt>Dimensions</dt><dd>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "Not recorded"}</dd></div>
            <div><dt>Version</dt><dd>{asset.version}</dd></div>
            <div><dt>Updated</dt><dd>{displayDate(asset.updatedAt)}</dd></div>
            <div>
              <dt>Categories</dt>
              <dd><MediaCategoryChips categoryIds={asset.categories} categories={categories} /></dd>
            </div>
            {asset.source !== "upload" ? <div><dt>Original filename</dt><dd>{asset.originalName}</dd></div> : null}
          </dl>
        </InspectorSection>

        {canEdit && asset.source === "upload" ? (
          <InspectorSection defaultOpen={false} id="delete" openRequest={confirmDeleteRequest} title="Delete from library">
            <p className="media-inspector-field-help">
              Only unused uploaded media can be deleted. The original file stays retained for audit and recovery, but staff cannot select it for new content.
            </p>
            {deleteError ? (
              <InlineMessage tone="error" title="Media was not deleted">
                <span>{deleteError}</span>
                {deleteConflict ? <Button onClick={onReload}>Reload asset</Button> : null}
              </InlineMessage>
            ) : null}
            {confirmingDelete ? (
              <div aria-label="Confirm media deletion" aria-live="polite" ref={deleteConfirmRef} role="group" tabIndex={-1}>
                <p>{`Delete ${asset.name} from the media library?`}</p>
                <div className="media-form-actions">
                  <AsyncActionButton
                    disabled={dirty || feedbackDirty || fieldsLocked}
                    label="Yes, delete from library"
                    onClick={() => void removeFromLibrary()}
                    pending={deleting}
                    pendingAnnouncement="Deleting media from the library."
                    pendingLabel="Deleting…"
                    variant="danger"
                  />
                  <Button
                    disabled={deleting}
                    onClick={() => {
                      returnDeleteFocus.current = true;
                      setConfirmingDelete(false);
                    }}
                    variant="ghost"
                  >
                    Keep media
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                disabled={dirty || feedbackDirty || fieldsLocked}
                onClick={() => {
                  returnDeleteFocus.current = false;
                  setConfirmingDelete(true);
                }}
                ref={deleteTriggerRef}
                variant="danger"
              >
                Delete from library
              </Button>
            )}
          </InspectorSection>
        ) : null}
      </form>
    </Inspector>
    </>
  );
}
