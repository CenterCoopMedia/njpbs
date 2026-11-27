import { useCoverageLabels } from "../context/CoverageLabelsContext";
import { RecordFormFields } from "./RecordFormFields";
import { postCoverageLabelId, resolveCoverageLabel } from "../../../packages/content-core/src/coverage-labels";
import type { ElectionSourceHost } from "../context/ElectionResultsSourceHost";
import { liveBlogPublicationIssue, type LiveBlogPublicationIssue } from "../lib/live-blog";
import type { ReportingEditorTransport } from "./DataHubReportingEditor";
import { parseDataHubReporting, type DataHubFigure } from "../../../packages/content-core/src/data-hub-reporting";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { usePublishedVocabulary, type VocabularyLoader } from "../lib/use-published-vocabulary";
import { EditorActionSlot, useEditorActionsAvailable } from "./EditorActions";
import { publicSiteOrigin } from "../lib/dev-origins";
import { renderPostBranding } from "../../../packages/content-core/src/post-branding";
import "../../../packages/content-core/src/post-branding.css";
import { parseHomeHero } from "../../../packages/content-core/src/home-hero";
import { PostTemplateActions } from "./PostTemplateActions";
import { parseLiveBlogDraft, type LiveBlogDraft } from "../../../packages/content-core/src/live-blog-draft";
import { Icon } from "./ui/Icon";
import { isAvailablePageSlug } from "../../../packages/content-core/src/public-pages";
import { isMintablePostSlug } from "../../../packages/content-core/src/post-slugs";
import { recordKindHasPublicRoute } from "../../../packages/content-core/src/public-record-kinds";
import { postPresentationTagError } from "../../../packages/content-core/src/post-formats";
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { hasConflictingLeadImageAlt } from "./PostLeadMediaEditor";
import { isPostLeadMedia, readPostLeadMedia } from "../../../packages/content-core/src/post-lead-media";
import { useSaveFlight } from "../hooks/useSaveFlight";
import { reconcileBlockId } from "../lib/block-editor-state";
import { editorSaveReceipt, type SavedEditorReceipt } from "../lib/editor-save-receipt";
import { defaultValueForField } from "../lib/field-defaults";
import type { ReadOnlyNotice } from "../lib/editor-save-decisions";
import { invalidEditorFields } from "../lib/field-validation";
import { recordsEqual } from "../lib/record-equality";
import { newLiveBlogVideoBlocks } from "../lib/publication-videos";
import { createReplayConflictRecordId, HttpError, isConflictError } from "../lib/functions";
import {
  contentSectionField,
  editorFieldGroupsFor,
  type EditorDocumentKind,
  type EditorField,
} from "../../../packages/content-core/src/editor-admin";
import {
  fieldPathKey,
  hasFieldValue,
  readFieldValue,
  removeFieldValue,
  writeFieldValue,
} from "../lib/field-path";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Toolbar,
} from "./ui/Primitives";
import { useWorkspaceActionsAvailable } from "./WorkspaceActions";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import type {
  BylineAuthorOption,
  MediaAssetSummary,
  MediaCategoryDefinition,
} from "../lib/functions";
import {
  defaultStoryCredits,
  resolveStoryCredits,
} from "../../../packages/content-core/src/story-credits";
import {
  hasExplicitPostTitle,
  normalizeBlankPostTitleOverrides,
} from "../lib/post-title-inheritance";
import type { BlockEditorHandle, EditorSaveOutcome, CapturedEditorSave } from "./BlockEditor";
import type { AdminBlock } from "../lib/block-factory";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";
import { SavePostTemplateDialog, type TemplateCaptureFields } from "./SavePostTemplateDialog";
import type { CapturePostTemplateRequest, PostTemplateReceipt } from "../lib/functions";

const RECORD_ASSET_ACCESSIBILITY = {
  post: {
    heroImage: {
      alt: "heroImageAlt",
      decorative: "heroImageDecorative",
    },
  },
  program: {
    keyArtAssetId: { alt: "keyArtAlt", decorative: "keyArtDecorative" },
  },
  event: { imageAssetId: { alt: "imageAlt", decorative: "imageDecorative" } },
  sponsor: {
    logoAssetId: {
      alt: "logoAlt",
      decorative: "logoDecorative",
    },
  },
} as const;

function accessibilityFieldsForAsset(
  kind: EditorDocumentKind,
  assetKey: string,
): { alt: string; decorative: string } | null {
  const byAsset =
    kind === "post"
      ? RECORD_ASSET_ACCESSIBILITY.post
      : kind === "program"
        ? RECORD_ASSET_ACCESSIBILITY.program
      : kind === "event"
        ? RECORD_ASSET_ACCESSIBILITY.event
      : kind === "sponsor"
        ? RECORD_ASSET_ACCESSIBILITY.sponsor
        : null;
  if (!byAsset || !(assetKey in byAsset)) return null;
  return byAsset[assetKey as keyof typeof byAsset];
}

function accessibilityFieldsForAlt(
  kind: EditorDocumentKind,
  altKey: string,
): { asset: string; decorative: string } | null {
  const entries =
    kind === "post"
      ? Object.entries(RECORD_ASSET_ACCESSIBILITY.post)
      : kind === "program"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.program)
      : kind === "event"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.event)
      : kind === "sponsor"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.sponsor)
        : [];
  const match = entries.find(([, fields]) => fields.alt === altKey);
  return match
    ? { asset: match[0], decorative: match[1].decorative }
    : null;
}

function isPostTitleOverrideField(
  kind: EditorDocumentKind,
  field: EditorField,
): boolean {
  return (
    kind === "post" &&
    field.key === "title" &&
    field.path?.length === 1 &&
    (field.path[0] === "seo" || field.path[0] === "social")
  );
}

function accessibilityFieldsForDecorative(
  kind: EditorDocumentKind,
  decorativeKey: string,
): { asset: string; alt: string } | null {
  const entries =
    kind === "post"
      ? Object.entries(RECORD_ASSET_ACCESSIBILITY.post)
      : kind === "program"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.program)
      : kind === "event"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.event)
      : kind === "sponsor"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.sponsor)
        : [];
  const match = entries.find(([, fields]) => fields.decorative === decorativeKey);
  return match ? { asset: match[0], alt: match[1].alt } : null;
}

function assetForAccessibilityField(
  kind: EditorDocumentKind,
  fieldKey: string,
): string | null {
  const entries =
    kind === "post"
      ? Object.entries(RECORD_ASSET_ACCESSIBILITY.post)
      : kind === "program"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.program)
      : kind === "event"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.event)
      : kind === "sponsor"
        ? Object.entries(RECORD_ASSET_ACCESSIBILITY.sponsor)
        : [];
  return (
    entries.find(
      ([, fields]) =>
        fields.alt === fieldKey || fields.decorative === fieldKey,
    )?.[0] ?? null
  );
}

// A save may be synchronous (a standalone form with no persist returns void) or asynchronous
// (a real persist returns a promise of the stored record). Detect the promise by its thenable
// shape rather than instanceof, so any promise-like return drives the async path. Mirrors the
// page editor's save contract (BlockEditor).
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export interface RecordSaveReceipt {
  savedTarget?: SavedEditorReceipt;
  warnings?: string[];
  kind: "record-save-receipt";
  document: Record<string, unknown>;
  mintedIds: Record<string, string>;
}

export function isRecordSaveReceipt(value: unknown): value is RecordSaveReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "record-save-receipt"
  );
}

function reconcileRecordBlockIds(
  record: Record<string, unknown>,
  mintedIds: Record<string, string>,
): Record<string, unknown> {
  if (!Array.isArray(record.blocks) || Object.keys(mintedIds).length === 0) {
    return record;
  }
  let changed = false;
  const blocks = record.blocks.map((block) => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      return block;
    }
    if (typeof (block as { id?: unknown }).id !== "string") return block;
    const reconciled = reconcileBlockId(block as AdminBlock, mintedIds);
    if (reconciled !== block) changed = true;
    return reconciled;
  });
  return changed ? { ...record, blocks } : record;
}

interface RecordFormProps {
  electionSourceHost?: Omit<ElectionSourceHost, "documentId" | "version">;
  homeHeroTarget?: HTMLElement | null;
  dataHubReportingTarget?: HTMLElement | null;
  dataHubReportingFigure?: DataHubFigure | "featured";
  onReportingFigureReveal?: (figure: DataHubFigure | "featured") => void;
  reportingTransport?: ReportingEditorTransport;
  // When provided (including null while the host mount lands), Page title and
  // summary render in the main writing column instead of the metadata stack.
  writingTarget?: HTMLElement | null;
  onRevealField?: (key: string, fieldId: string) => void;
  capturePostTemplate?: (request: CapturePostTemplateRequest) => Promise<PostTemplateReceipt>;
  /** Whether the Post body may add or change custom HTML (content.publish). */
  canEditCustomHtml?: boolean;
  canManageSettings?: boolean;
  duplicatePost?: (sourceId: string, sourceVersion: number, editionLocale?: "es") => Promise<void>;
  canCreateSpanishEdition?: boolean;
  duplicateDisabledReason?: string;
  kind: EditorDocumentKind;
  pageId?: string;
  // A record to open the form on. Any field it omits falls back to the kind's default, so a
  // partial record still opens in a savable-shaped state.
  //
  // The workspace may pass either a restored draft or a stored record. The values have the same
  // shape, so initialIsClean below carries the distinction the form cannot safely infer.
  initial?: Record<string, unknown>;
  // A stored record is a clean seed; a restored in-memory draft is not. The values can have the
  // same shape, so the caller states which one it supplied instead of making the form guess from
  // the presence of an id or version.
  initialIsClean?: boolean;
  // When set, saving hands the validated record to onSave. A save that returns a promise drives
  // the async persist path: the button shows "Saving…", a rejection surfaces the server's
  // message, and a resolved record is adopted so the form takes the server-minted id — the next
  // save updates that record instead of creating a duplicate (#515 record-id adoption). A void
  // return keeps the synchronous "Saved." confirmation. Absent means a standalone form with no
  // persist wired (a bare test render).
  onSave?: (
    record: Record<string, unknown>,
    options?: { force?: boolean },
  ) => void | Promise<Record<string, unknown> | RecordSaveReceipt | void>;
  // The non-destructive exit from a version conflict: discard this form's local changes and ask
  // the host to read the addressed record again. Create forms have no stored record to reload.
  onReload?: () => void;
  // A replayed create can discover that its already-created record has advanced. The draft has
  // no adopted id, so the only safe recovery is an explicit handoff to that immutable record.
  // The host owns discarding the draft and create nonce before navigation.
  onOpenConflictRecord?: (id: string) => void;
  // A first page-metadata save uses a create-only claim. If another editor created the page,
  // this form never saw that document and cannot safely offer an overwrite; records and normal
  // versioned updates keep the explicit overwrite choice.
  allowConflictOverwrite?: boolean;
  // Raised after an async save lands with no newer local edit still in the form. This is later
  // than onSave's server response, so a create host can safely canonicalize the URL without
  // unmounting edits typed while the request was in flight.
  onSaved?: (record: Record<string, unknown>) => void;
  // A successful create can replace its temporary URL with the stored record URL. Keep the
  // confirmation through that one route change so the canonical screen confirms the save.
  preserveSuccessNoticeOnNextRoute?: boolean;
  // Whether the signed-in role may save this kind. When false the form still renders so an
  // editor can read it, but the save is disabled and says why (RBAC gate, issue #25).
  canSave: boolean;
  // Draft surfaces may save unfinished required fields while retaining all safety and shape
  // validation. Published-workflow surfaces keep the complete save boundary by default.
  allowIncomplete?: boolean;
  saveLabel?: string;
  // Optional host-level reason the save is unavailable. Capability copy remains the default;
  // isolated integrations can instead explain that persistence has not been connected.
  saveDisabledReason?: string;
  /** Why the form is inert, when it is. Defaults to the restore notice for older callers. */
  readOnlyNotice?: ReadOnlyNotice;
  // Raised true while an async save is in flight and false when it settles, so the workspace can
  // hold navigation until the save resolves. An unmount mid-save would orphan the request and
  // lose the record with no retry, so the workspace locks its rail on this signal — parity with
  // the page editor (#515).
  onSavingChange?: (saving: boolean) => void;
  // Raised with the live record every time it changes after the seed, so the host can keep the
  // work when this form unmounts (#579). The form is keyed on its kind, so switching content
  // type destroys it and every typed field with it; the host holds the draft and seeds the next
  // mount from it through `initial`.
  //
  // Raised with null when a save settles the record, which tells the host to drop the draft.
  // That half is load-bearing here in a way it is not for a page: a clean page is re-read, so a
  // page draft left behind only shows stale content, while a record is seeded from its draft and
  // nothing else. A saved record left stashed therefore comes back carrying its id, and the next
  // save updates that document instead of creating the new one the editor came back to write.
  onDraftChange?: (record: Record<string, unknown> | null) => void;
  // A revision restore replaces the complete editor-owned snapshot when it settles. Freeze the
  // live form for that short request so an edit cannot be accepted and then discarded by the
  // required reload. This is an interaction lock only; server authorization remains authoritative.
  readOnly?: boolean;
  showSaveAction?: boolean;
  // Existing Post workflow controls belong in the Publication bento panel, but they remain outside
  // the editor-only disabled fieldsets so an approved record can still return to draft, be published, or be
  // scheduled. The host supplies the controls because it owns permissions, versions, assignment,
  // and lifecycle requests.
  postInspector?: ReactNode;
  // Present only for staff who may publish live blog entries directly on this published
  // live blog. The host reloads the record after the publication lands.
  publishLiveBlogUpdate?: (liveBlog: LiveBlogDraft, baseVersion: number) => Promise<void | { warnings?: string[]; publicationRequested?: boolean }>;
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
  newId?: () => string;
  // The byline picker's feed (#1040). The host loads it once and hands it down;
  // the form neither fetches nor caches it.
  bylineAuthors?: readonly BylineAuthorOption[];
  bylineAuthorsUnavailable?: boolean;
  bylineAuthorsLoading?: boolean;
  canManageAuthorProfiles?: boolean;
  loadPublishedVocabulary?: VocabularyLoader;
  // The signed-in account's own author identity, or null when it has none or is
  // deactivated. A brand-new post defaults its byline to this one credit and to
  // nothing else: an account with no linked identity starts with an empty byline
  // rather than a guessed one, because a gap is visible and a wrong credit is not.
  selfAuthorId?: string | null;
  // The editorial desks a new record may be created into (#845), from the live section
  // registry. A record's desk is fixed by the write that creates it and decides who may
  // edit it afterwards, so the create form asks for it and a stored record only displays
  // it. Absent means the host wired no registry -- a bare test render or a design view --
  // and no section control is shown.
  sections?: readonly { id: string; label: string }[];
  /** Permitted new-Post defaults; null waits for the live registry. Labels use sections. */
  newPostSections?: readonly { id: string; label: string }[] | null;
}

const RECORD_SAVE_REFUSED: EditorSaveOutcome = { landed: false, clean: false };
const LIVE_BLOG_DIRECT_IGNORED_FIELDS = new Set(["liveBlog", "id", "version", "contentVersion", "status", "section",
  "unassignedDraft"]);

export interface RecordFormHandle {
  captureSave: () => CapturedEditorSave;
  validateForPublication: () => Promise<boolean>;
  save: (options?: { force?: boolean }) => Promise<EditorSaveOutcome>;
  // Adopt fields changed by a separate server mutation without remounting the editor. The
  // workspace uses this after assignment changes so the next content save carries the new
  // optimistic version while the assignment confirmation and keyboard focus stay in place.
  adoptServerFields: (fields: Record<string, unknown>) => void;
}

// The record the form edits, seeded from an existing record when given one. It starts from
// the whole `initial` record, not an empty object, so a save round-trips the fields the
// editor never sees -- the immutable id, and model keys like type, slug, status, and locale
// that are not editor descriptors. Then every descriptor field the record omits is filled
// with its default. Defaulting per kind (not with "") matters: a required rich-text field
// must start as a valid empty document, so an untouched form is already in a shape the save
// boundary can validate.
function seedRecord(
  kind: EditorDocumentKind,
  fields: readonly EditorField[],
  initial?: Record<string, unknown>,
  byline?: { selfAuthorId?: string | null },
  pageId?: string,
): Record<string, unknown> {
  let record: Record<string, unknown> = initial ? { ...initial } : {};
  if (kind === "post") {
    record = normalizeBlankPostTitleOverrides(record);
  }
  // The byline seed (#1040), before the generic per-kind defaults below, because
  // it is the one field whose starting value depends on the record and the person.
  // Three cases, in order:
  //   - the record already carries credits: open on them;
  //   - it carries only the pre-#1040 free-text `author`: convert that one string
  //     to one custom credit, deterministically, with no name matching;
  //   - it is a brand-new post: credit the signed-in author when they have an
  //     active identity, and otherwise start empty.
  if (
    fields.some((field) => field.kind === "storyCredits") &&
    !Array.isArray(record.credits)
  ) {
    const legacy = resolveStoryCredits(record);
    const creating = typeof record.id !== "string" || record.id.trim() === "";
    record = {
      ...record,
      credits:
        legacy.length > 0
          ? legacy
          : creating
            ? defaultStoryCredits(
                byline?.selfAuthorId
                  ? {
                      authorId: byline.selfAuthorId,
                      displayName: "",
                      active: true,
                    }
                  : null,
              )
            : [],
    };
  }
  for (const field of fields) {
    // Optional nested metadata is an override. Keep it absent until the editor actually
    // changes the control so “leave blank to use the visible title/summary” remains a true
    // fallback, not an explicitly stored empty value. Root fields retain the established form
    // seeding contract, and required nested fields would still receive a validation-ready value.
    if (field.key !== "coverageLabelId" && !hasFieldValue(record, field) && (!field.path || field.required)) {
      record = writeFieldValue(record, field, defaultValueForField(field));
    }
  }
  // An unselected default image is an explicit empty lead, never an incomplete image.
  if (kind === "post" && record.leadMedia === undefined && !readPostLeadMedia(record)) record.leadMedia = null;
  // Editor-only terms travel with the existing in-memory draft/leave guard.
  // pageMetadataSaveDocument's explicit allowlist keeps them out of every save.
  if (kind === "page" && pageId === "data-hub") record._dataHubReportingDrafts ??= {};
  if (kind === "event" && !record.registrationLabel) record.registrationLabel = "Register";
  return record;
}

// The editor form for one record (an article, a staff member, a sponsor, ...). It renders
// the kind's descriptor list through the shared FieldRenderer, refuses a save that leaves
// a required field empty or a URL the renderer would strip by marking each one inline, and
// confirms a successful save.
export const RecordForm = forwardRef<RecordFormHandle, RecordFormProps>(function RecordForm({
  electionSourceHost,
  kind,
  initial,
  initialIsClean = false,
  onSave,
  capturePostTemplate,
  canEditCustomHtml = true,
  duplicatePost,
  canCreateSpanishEdition,
  duplicateDisabledReason,
  homeHeroTarget,
  dataHubReportingTarget,
  dataHubReportingFigure,
  onReportingFigureReveal,
  reportingTransport,
  writingTarget,
  onRevealField,
  onReload,
  pageId,
  onOpenConflictRecord,
  allowConflictOverwrite = true,
  onSaved,
  preserveSuccessNoticeOnNextRoute = false,
  canSave,
  canManageSettings = false,
  allowIncomplete = false,
  saveLabel = "Save",
  saveDisabledReason,
  readOnlyNotice,
  onSavingChange,
  onDraftChange,
  readOnly = false,
  showSaveAction = true,
  postInspector,
  publishLiveBlogUpdate,
  loadMedia,
  mediaPickerUnavailable = false,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  onMediaPickerDirtyChange,
  newId,
  bylineAuthors,
  bylineAuthorsUnavailable,
  bylineAuthorsLoading = false,
  canManageAuthorProfiles = false,
  loadPublishedVocabulary,
  selfAuthorId = null,
  sections,
  newPostSections,
}, ref) {
  const editorView = useEditorWorkspaceView();
  const coverage = useCoverageLabels(kind === "post");
  const coverageRegistryMissing = coverage.status === "ready" && !coverage.registry;
  const [termsRequested, setTermsRequested] = useState(false);
  const publishedTerms = usePublishedVocabulary(kind === "post" ? loadPublishedVocabulary : undefined, termsRequested);
  const successNotice = useSuccessNotice();
  const workspaceActionsAvailable = useWorkspaceActionsAvailable();
  const formId = useId();
  const [heroRevealRequest, setHeroRevealRequest] = useState(0);
  const [heroFocusId, setHeroFocusId] = useState<string>();
  const formRef = useRef<HTMLFormElement>(null);
  const postRevealRequest = useRef(0);
  const [postBentoReveal, setPostBentoReveal] = useState<{
    id: string;
    request: number;
    fieldId?: string;
  }>();
  const spanishEdition = kind === "post" && typeof initial?.editionOf === "string";
  const groups = useMemo(() => {
    const groupDefinitions = editorFieldGroupsFor(kind, pageId)
      .filter(group => group.id !== "schedule-copy" || initial?.scheduleCopy !== undefined);
    const source = spanishEdition ? groupDefinitions.map(group => ({
      ...group, fields: group.fields.filter(field => field.key !== "slug"),
    })) : groupDefinitions;
    if (kind === "page" && pageId === "data-hub") return source.filter(group => group.id !== "hero-image")
      .map(group => ({...group,fields:group.fields.filter(field => field.key !== "slug")}));
    if (kind !== "post" || !editorView?.kind) return source;
    const basic = source.find(group => group.id === "basics")!;
    const organization = source.find(group => group.id === "organization")!;
    const isIdentity = (field: EditorField) => !field.path && ["credits", "coverageLabelId", "spotlightNews", "showInHomeHero", "disableStoryCtas"].includes(field.key);
    const isSlug = (field: EditorField) => !field.path && field.key === "slug";
    return [
      { ...basic, label: "Post identity", help: "The people credited for this story.", fields: [...basic.fields.filter(field => !isSlug(field)), ...organization.fields.filter(isIdentity)] },
      { ...source.find(group => group.id === "hero-image")!, label: "Images", help: "The decorative heading background and lead image are separate from images in the story." },
      { ...organization, label: "Organization", help: "Public categories and tags.", fields: organization.fields.filter(field => !isIdentity(field) && !isSlug(field)) },
      ...source.filter(group => !["basics", "organization", "hero-image"].includes(group.id)),
      {
        id: "details",
        label: "Advanced",
        help: spanishEdition ? "Use Excerpt only when this Post has no summary." : "The independent public URL for this story.",
        fields: [...basic.fields, ...organization.fields].filter(isSlug),
      },
    ] as typeof source;
  }, [kind, pageId, editorView?.kind, initial?.scheduleCopy, spanishEdition]);
  const contentFields = useMemo(
    () => groups.flatMap((group) => group.fields),
    [groups],
  );
  const isPostWritingField = (field: EditorField): boolean =>
    kind === "post" &&
    field.path === undefined &&
    (field.key === "title" || field.key === "summary");

  function revealPostPanel(id: string, fieldId?: string) {
    postRevealRequest.current += 1;
    setPostBentoReveal({ id, request: postRevealRequest.current, fieldId });
  }
  // The create-time desk control (#845). Page metadata never carries one: a canonical
  // page's desk is its public area, recomputed server-side on every save, so offering a
  // choice would imply an editorial decision that does not exist.
  const sectionField = useMemo(
    () => (sections && kind !== "page" ? contentSectionField(sections) : null),
    [sections, kind],
  );
  // Seed a new post body to a valid empty composition. The post editor renders this field through
  // the block editor below, while stored records can supply their existing composition.
  const [record, setRecord] = useState<Record<string, unknown>>(() => {
    const seeded = seedRecord(
      kind,
      contentFields,
      kind === "post" ? { blocks: [], ...initial } : initial,
      { selfAuthorId },
      pageId,
    );
    const defaultOptions = newPostSections === undefined ? sectionField?.options
      : newPostSections?.map(section => ({ value: section.id }));
    const creating = typeof seeded.id !== "string" || seeded.id === "";
    if (kind === "post" && creating && (seeded.section == null || seeded.section === "") &&
        defaultOptions?.length === 1) {
      seeded.section = defaultOptions[0].value;
    }
    return seeded;
  });
  const postBrandingMarkup = kind === "post" ? renderPostBranding(record.spotlightNews, "headline",
    resolveCoverageLabel(postCoverageLabelId(record), coverage.registry), false) : "";
  const [savedLiveBlog, setSavedLiveBlog] = useState<LiveBlogDraft | undefined>(initialIsClean ? initial?.liveBlog as LiveBlogDraft | undefined : undefined);
  const [followUpBaselineKnown, setFollowUpBaselineKnown] = useState(initialIsClean || !initial?.id);
  const [liveBlogEntryKeys, setLiveBlogEntryKeys] = useState<Record<string, string>>({});
  const startLiveBlogRef = useRef<HTMLButtonElement>(null);
  const returnToLiveBlogStart = useRef(false);
  const focusNewLiveBlog = useRef(false);
  useLayoutEffect(() => {
    if (returnToLiveBlogStart.current && record.liveBlog == null) {
      returnToLiveBlogStart.current = false;
      startLiveBlogRef.current?.focus();
    }
  }, [record.liveBlog]);
  // A stored record's desk cannot move, so the control becomes a plain reading of where it
  // lives. The one exception is a Post draft the server deliberately saved without a desk:
  // its marker keeps the picker available until that first assignment lands.
  const recordExists = typeof record.id === "string" && record.id !== "";
  const unassignedPostDraft =
    kind === "post" &&
    record.status === "draft" &&
    record.unassignedDraft === true;
  const sectionIsEditable =
    sectionField !== null && (!recordExists || unassignedPostDraft);
  // Validation covers the desk only while it is a real choice. A legacy record stored
  // before the registry existed carries none, and demanding one here would block every
  // edit to it behind a field the save cannot accept anyway.
  const fields = useMemo(
    () =>
      sectionIsEditable && sectionField
        ? [...contentFields, sectionField]
        : contentFields,
    [contentFields, sectionField, sectionIsEditable],
  );
  const postBodyRef = useRef<BlockEditorHandle>(null);
  const [assetSuggestions, setAssetSuggestions] = useState<
    Record<string, string>
  >({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [liveBlogIssue, setLiveBlogIssue] = useState<LiveBlogPublicationIssue | null>(null);
  const publicationValidationError = useRef<string | null>(null);
  // The id every field control (or group) renders under, so the validation summary can point
  // at the exact control a message is about instead of asking the person to hunt for red.
  const fieldIdFor = (field: EditorField): string =>
    sectionField && field.key === sectionField.key && field.path === undefined
      ? `record-${kind}-section`
      : `record-${kind}-${fieldPathKey(field).replaceAll(".", "-")}`;
  const validationFieldIdFor = (field: EditorField): string =>
    kind === "post" && field.key === "heroImage" && hasConflictingLeadImageAlt(record)
      ? `${fieldIdFor(field)}-alt` : fieldIdFor(field);
  function postPanelIdForField(field: EditorField): string | null {
    if (kind !== "post") return null;
    if (
      sectionField &&
      field.key === sectionField.key &&
      field.path === undefined
    ) {
      return "post-title";
    }
    if (isPostWritingField(field)) return "post-title";
    const id = groups.find((group) => group.fields.includes(field))?.id;
    return editorView?.kind === "post" && id === "social" ? "search" : editorView?.kind === "post" && id === "excerpt" ? "details" : id ?? null;
  }

  // A validation or summary-link request can target a control inside a collapsed bento card.
  // Reveal its owner first, then focus after EditorBento applies the new layout state.
  const [reportingReveal, setReportingReveal] = useState(0);
  const [pendingFocusFieldId, setPendingFocusFieldId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingFocusFieldId) return;
    const focusTarget = () => {
      const target =
        document.getElementById(pendingFocusFieldId) ??
        formRef.current?.querySelector<HTMLElement>(
          `[aria-labelledby="${pendingFocusFieldId}-label"]`,
        ) ?? document.querySelector<HTMLElement>(`[aria-labelledby="${pendingFocusFieldId}-label"]`);
      if (target) for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      target?.focus();
      setPendingFocusFieldId(null);
    };
    if (kind !== "post") {
      focusTarget();
      return;
    }
    let focusFrame: number | null = null;
    const revealFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(focusTarget);
    });
    return () => {
      cancelAnimationFrame(revealFrame);
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    };
  }, [errors, kind, pendingFocusFieldId, postBentoReveal]);

  function jumpToField(field: EditorField) {
    const fieldId = validationFieldIdFor(field);
    if (homeHeroTarget && groups.some(group =>
      (group.id === "home-hero" || group.id === "hero-image") &&
      group.fields.some(candidate => fieldPathKey(candidate) === fieldPathKey(field)))) {
      setHeroFocusId(fieldId);
      setHeroRevealRequest(request => request + 1);
    }
    if (onRevealField) onRevealField(field.key, fieldId);
    else {
      const ownerId = postPanelIdForField(field);
      if (ownerId) revealPostPanel(ownerId, fieldId);
    }
    setPendingFocusFieldId(fieldId);
  }
  // Fields whose control is showing text the record does not hold (#850). A date-time control
  // keeps a half-typed value on screen rather than snapping back, so the record still holds the
  // previous instant and nothing in `record` says otherwise; without this the form would
  // validate the old value and report Saved against a date the editor never finished. Kept in a
  // ref because nothing renders from it until a save is attempted, which is also when it is
  // meant to be read: an error that appeared mid-keystroke would fire on every digit of a year.
  const draftErrorsRef = useRef<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  // A save is in flight (an async onSave that has not resolved). The Save button disables and
  // relabels while it holds, so a second click cannot fire a concurrent save.
  const [saving, setSaving] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [capturingTemplate, setCapturingTemplate] = useState(false);
  const captureInFlight = useRef(false);
  const [postSourceAction, setPostSourceAction] = useState<"duplicate" | "es" | null>(null);
  const duplicatingPost = postSourceAction !== null;
  const [publishingLiveBlog, setPublishingLiveBlog] = useState(false);
  // Set synchronously so a draft save started in the same tick sees the publication.
  const liveBlogPublishInFlight = useRef(false);
  const duplicateInFlight = useRef(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const interactionLocked = readOnly || duplicatingPost || publishingLiveBlog;
  const lastSaveReceipt = useRef<Record<string, unknown> | null>(null);
  // The server's reason for a rejected save, shown in the error banner. Cleared when the next
  // edit or save attempt starts, so a stale failure never lingers under a fresh save.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);
  // A 409 is not a retryable failure. The stored record moved while this copy was open, so the
  // person must explicitly choose whose work is discarded before another save can run.
  const [conflict, setConflict] = useState(false);
  const [advancedCreateRecordId, setAdvancedCreateRecordId] = useState<string | null>(null);
  // The latest record, updated every render. The async save reads this on resolve to tell
  // whether the editor changed while the save was in flight; a ref sidesteps the stale `record`
  // the awaited continuation would otherwise close over.
  const recordRef = useRef(record);
  recordRef.current = record;
  // Hand the live record to the host on every change after the seed, so switching content type
  // does not destroy a half-written record (#579). The seed is skipped: an opened-but-untouched
  // form has no work to keep, and reporting it would make the host stash an empty draft.
  //
  // The callback is held in a ref and kept out of the dep list deliberately. The host passes an
  // inline arrow, so depending on it would re-run this effect on every parent render -- a save
  // toggling `saving` would be enough -- and report a draft for a form nobody typed in. The host
  // reads the draft's existence as the signal that there is work to keep, so only a real record
  // change may report. Parity with the page editor (BlockEditor).
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  // Where the form last settled: the record as it stood, and whether that content is something
  // the editor could go back to and owe nothing for. `setField` replaces the object on every
  // edit, so an unequal identity is an edit and an equal one is not; a corrected typo is an edit
  // that leaves nothing different, and stashing it hands back the saved id -- the cost
  // `onDraftChange` describes.
  //
  // An identity, not a has-run flag, for the same reason as the page editor: React StrictMode
  // replays mount effects without resetting refs, and `main.tsx` mounts the admin inside it. A
  // flag would be consumed by the first run, and the replay would report an untouched form as
  // unsaved work. Comparing identity is idempotent, so the replay is harmless.
  //
  // Both facts live in one ref so a settle moves them together and `tsc` refuses a write that
  // states only one. A blank form's pristine seed is clean; a restored draft is not, because
  // `initial` is only ever unsaved work, and reading it as clean would drop that work the moment
  // an edit landed back on it.
  const settledRef = useRef<{ record: Record<string, unknown>; clean: boolean }>({
    record,
    clean: initialIsClean || !initial,
  });
  // The save now landing, when it is adopting a server-minted id, and the baseline that save
  // established: the snapshot that was sent, carrying the id the server minted for it. Adopting
  // replaces the record object, so the settle has to happen in the effect below rather than in the
  // save's own scope -- and the baseline has to travel here in the ref, because `sent` does not
  // survive that scope either.
  //
  // One ref rather than two, for the same reason as `settledRef`: "we are adopting" and "this is
  // what the server holds" are never separately true, so `tsc` refuses a write that states only one.
  const adoptingRef = useRef<{ saved: Record<string, unknown> } | null>(null);

  // Settle the draft once a save lands (#579), moving the clean point to what the server now holds.
  //
  // Two facts, not one. An edit composed while the save was in flight is still unsaved once the
  // save returns, so it keeps its draft -- but the clean point moves regardless, because the server
  // holds what was sent whether or not the editor has typed since. Conflating them is what let a
  // taken-back in-flight edit compare against the pre-save seed, stand as a draft holding content
  // identical to the server's, and carry the saved id into the record written next.
  //
  // Every successful save path calls this. Parity with the page editor, but the cost of missing
  // one is higher here. A clean page is re-read, so a stale page draft shows stale content; a
  // record has no read to repeat, so the host seeds the next mount from the draft itself. A saved
  // record left stashed therefore returns with its id, and the next save updates that document
  // rather than creating the one the editor came back to write.
  function settleDraft(saved: Record<string, unknown>, live: Record<string, unknown>) {
    setSavedLiveBlog(saved.liveBlog as LiveBlogDraft | undefined);
    setFollowUpBaselineKnown(true);
    settledRef.current = { record: saved, clean: true };
    // Content, not identity: adopting an id replaces the record object, so `live` is a new object
    // even when nothing was typed while the save was out.
    if (!recordsEqual(live, saved)) {
      onDraftChangeRef.current?.(live);
      return;
    }
    onDraftChangeRef.current?.(null);
  }

  function adoptServerFields(fields: Record<string, unknown>) {
    const live = { ...recordRef.current, ...fields };
    const baseline = { ...settledRef.current.record, ...fields };
    settledRef.current = {
      record: baseline,
      clean: settledRef.current.clean,
    };
    recordRef.current = live;
    setRecord(live);
    setConflict(false);
    setAdvancedCreateRecordId(null);
  }

  useEffect(() => {
    const adopting = adoptingRef.current;
    if (adopting) {
      adoptingRef.current = null;
      settleDraft(adopting.saved, record);
      return;
    }
    if (record === settledRef.current.record) return;
    // It changed and changed back, so there is no work to keep and the host drops the stash rather
    // than seeding the next mount from it. The content compare runs only after identity has already
    // found a change, so an untouched form never pays for it.
    if (settledRef.current.clean && recordsEqual(record, settledRef.current.record)) {
      onDraftChangeRef.current?.(null);
      return;
    }
    onDraftChangeRef.current?.(record);
  }, [record]);

  useEffect(() => {
    if (kind !== "post" || interactionLocked || newPostSections?.length !== 1) return;
    const previous = recordRef.current;
    if (previous.id || previous.section != null && previous.section !== "") return;
    const next = { ...previous, section: newPostSections[0].id };
    // The late default is part of the seed, just like the self byline below.
    if (settledRef.current.record === previous) {
      settledRef.current = { record: next, clean: settledRef.current.clean };
    }
    recordRef.current = next;
    setRecord(next);
  }, [kind, interactionLocked, newPostSections]);

  // The self byline default, applied late (#1040).
  //
  // `seedRecord` runs once, in the `useState` initializer, and the byline feed that
  // carries `selfAuthorId` is fetched over the network. On a brand-new post the
  // seed therefore almost always runs first, with `selfAuthorId` still null, and the
  // promised "credit the signed-in author" default never appears. Applying it when
  // the feed lands is what makes the rule real rather than aspirational.
  //
  // Guarded so it can only ever fill a gap. It runs on a record that is being
  // created, whose byline is still the empty list the seed left, and that nobody has
  // touched the byline control on -- and it runs at most once. An editor who removed
  // a credit in the seconds before the feed answered keeps their empty byline: a
  // missing byline is a visible gap they fill, while one that reappears after being
  // deleted is the editor's decision being overruled.
  const bylineTouchedRef = useRef(false);
  const selfCreditSettledRef = useRef(false);
  useEffect(() => {
    if (selfCreditSettledRef.current) return;
    if (!selfAuthorId) return;
    // One chance, taken or not: from here the byline is whatever the editor makes it.
    selfCreditSettledRef.current = true;
    if (interactionLocked || bylineTouchedRef.current) return;
    if (!fields.some((field) => field.kind === "storyCredits")) return;
    const prev = recordRef.current;
    const creating = typeof prev.id !== "string" || prev.id.trim() === "";
    if (!creating) return;
    if (!Array.isArray(prev.credits) || prev.credits.length > 0) return;
    const credits = defaultStoryCredits({
      authorId: selfAuthorId,
      displayName: "",
      active: true,
    });
    if (credits.length === 0) return;
    const next = { ...prev, credits };
    // The seed is not unsaved work, and neither is this: it is the same seed, late.
    // Moving the baseline with the record keeps an opened-but-untouched form from
    // reporting a draft the moment the feed answers.
    if (settledRef.current.record === prev) {
      settledRef.current = { record: next, clean: settledRef.current.clean };
    }
    recordRef.current = next;
    setRecord(next);
  }, [selfAuthorId, fields, interactionLocked]);

  // If this form unmounts, clear any saving signal it raised so the workspace does not stay
  // navigation-locked. Navigation is held while a save is in flight, so an unmount mid-save
  // should not happen; this is a backstop for an unmount from another cause.
  useEffect(() => {
    return () => onSavingChange?.(false);
  }, [onSavingChange]);

  function setField(
    field: EditorField,
    value: unknown,
    options?: { removeOptionalOverride?: boolean },
  ) {
    if (interactionLocked) return;
    // Once the editor has worked the byline control, the late self-default above
    // must not land on top of them -- including when they worked it back to empty.
    if (field.kind === "storyCredits") bylineTouchedRef.current = true;
    const key = field.key === "leadMedia" ? "heroImage" : fieldPathKey(field);
    setRecord((prev) => {
      const baseline = settledRef.current.record;
      const defaultValue = defaultValueForField(field);
      const clearsOptionalOverride =
        options?.removeOptionalOverride === true ||
        (field.path !== undefined && !field.required && Object.is(value, defaultValue));
      if (!clearsOptionalOverride) return writeFieldValue(prev, field, value);

      // "Use post title" is stronger than returning a generic optional widget to its default:
      // even a legacy stored blank is removed so this field has one unambiguous inherited
      // state after save and reload (#1399). The surrounding seo/social object remains when
      // the baseline had it, preserving sibling metadata and an authoritative partial clear.
      if (options?.removeOptionalOverride) {
        return removeFieldValue(prev, field, baseline);
      }

      // If the server already stored the widget's default, returning to it is a true revert.
      // Otherwise blank/off means “remove this override.” The baseline is passed to the remover
      // so a newly introduced metadata group can disappear (and compare clean again), while a
      // stored group may remain as `{}` to make a partial save authoritatively clear its field.
      if (
        hasFieldValue(baseline, field) &&
        Object.is(readFieldValue(baseline, field), defaultValue)
      ) {
        return writeFieldValue(prev, field, value);
      }
      return removeFieldValue(prev, field, baseline);
    });
    setSaved(false);
    setSaveError(null);
    setDuplicateError(null);
    // Clear a field's error the moment the editor edits it, so a corrected field stops
    // shouting before they try to save again.
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function selectAsset(field: EditorField, asset: MediaAssetSummary | null) {
    const accessibility = accessibilityFieldsForAsset(kind, field.key);
    const nextAssetId = asset?.id ?? "";
    const changed = readFieldValue(recordRef.current, field) !== nextAssetId;
    setField(field, nextAssetId);
    if (!accessibility) return;
    setAssetSuggestions((current) => {
      const next = { ...current };
      if (asset?.altText?.trim()) next[accessibility.alt] = asset.altText;
      else delete next[accessibility.alt];
      return next;
    });
    if (!changed) return;
    const altField = fields.find((candidate) => candidate.key === accessibility.alt);
    const decorativeField = fields.find(
      (candidate) => candidate.key === accessibility.decorative,
    );
    if (altField) setField(altField, "");
    if (decorativeField) setField(decorativeField, false);
    if (kind === "post" && field.key === "heroImage") {
      const captionField = fields.find((candidate) => candidate.key === "heroImageCaption");
      if (captionField) setField(captionField, "");
    }
  }

  // A control reporting that it holds an unfinished draft, or that it does not any more. The
  // withdrawal also drops the message if it is the one currently shown, so a finished date
  // stops shouting the moment it converts rather than waiting for the next save.
  function reportDraftError(field: EditorField, message: string | null) {
    const key = fieldPathKey(field);
    const previous = draftErrorsRef.current[key];
    if (message !== null) {
      draftErrorsRef.current = { ...draftErrorsRef.current, [key]: message };
      return;
    }
    if (previous === undefined) return;
    const { [key]: _removed, ...rest } = draftErrorsRef.current;
    draftErrorsRef.current = rest;
    setErrors((prev) => {
      if (prev[key] !== previous) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function changeField(field: EditorField, value: unknown) {
    if (
      isPostTitleOverrideField(kind, field) &&
      typeof value === "string" &&
      !hasExplicitPostTitle(value)
    ) {
      setField(field, "", { removeOptionalOverride: true });
      return;
    }
    setField(field, value);
    const accessibility = accessibilityFieldsForDecorative(kind, field.key);
    if (value !== true || !accessibility) return;
    const altField = fields.find((candidate) => candidate.key === accessibility.alt);
    if (altField) setField(altField, "");
  }

  function changePostBlocks(blocks: AdminBlock[] | null) {
    if (interactionLocked || blocks === null) return;
    setRecord((current) => ({ ...current, blocks }));
    setSaved(false);
    setSaveError(null);
    setDuplicateError(null);
  }

  function changeCoverageLabel(id?: string) {
    if (interactionLocked || !canSave || coverage.status !== "ready") return;
    setRecord(current => {
      const next = { ...current };
      next.coverageLabelId = id ?? null;
      if (current.liveBlog && typeof current.liveBlog === "object") {
        const liveBlog = { ...current.liveBlog as LiveBlogDraft };
        if (id === "nj-decides-2026") liveBlog.branding = "nj-decides-2026"; else delete liveBlog.branding;
        next.liveBlog = liveBlog;
      }
      return next;
    });
    setSaved(false); setSaveError(null); setDuplicateError(null);
    setErrors(current => { const next = { ...current }; delete next.coverageLabelId; return next; });
  }

  function changeLiveBlog(liveBlog: LiveBlogDraft | null) {
    if (interactionLocked || !canSave) return;
    setLiveBlogIssue(null);
    setRecord(current => {
      const createdBlog = liveBlog && current.liveBlog == null && postCoverageLabelId(current) === "nj-decides-2026"
        ? { ...liveBlog, branding: "nj-decides-2026" as const }
        : liveBlog;
      const next = { ...current, liveBlog: createdBlog };
      // A save already in flight can create the blog after this removal. Keep
      // the explicit deletion until that save settles and the next save clears it.
      if (liveBlog === null && !saving && settledRef.current.record.liveBlog === undefined) delete (next as Record<string, unknown>).liveBlog;
      return next;
    });
    setErrors(current => { const next = { ...current }; delete next.liveBlog; return next; });
    setSaved(false); setSaveError(null); setDuplicateError(null);
  }

  function revealLiveBlogIssue(issue: LiveBlogPublicationIssue | null) {
    setLiveBlogIssue(issue);
    revealPostPanel("post-live-blog", `${formId}-live-blog${issue ? `-entry-${liveBlogEntryKeys[issue.entryId] ?? issue.entryId}${issue.field === "headline" ? "-headline" : ""}` : ""}`);
  }

  function validateFields(complete: boolean): boolean {
    publicationValidationError.current = null;
    setSaveError(null);
    if (kind === "post" && presentationTagError) {
      setSaveError(presentationTagError);
      const reviewPresentation = () => {
        revealPostPanel("post-body");
        setPendingFocusFieldId(`${formId}-presentation`);
      };
      successNotice.show(presentationTagError, {
        tone: "error",
        action: { label: "Review presentation", onClick: reviewPresentation },
      });
      reviewPresentation();
      return false;
    }
    const validationFields = kind === "post" && record.leadMedia !== undefined
      ? fields.filter(field => !["heroImage", "heroImageAlt", "heroImageDecorative", "heroImageCaption"].includes(field.key)) : fields;
    const invalid = invalidEditorFields(validationFields, record, { allowIncomplete: !complete });
    if (!complete && pageId === "schedule") {
      invalid.push(...invalidEditorFields(fields.filter(field => field.path?.[0] === "scheduleCopy"), record));
    }
    const marked: Record<string, string> = {};
    let entryIssue: LiveBlogPublicationIssue | null = null;
    if (kind === "post" && record.liveBlog != null) {
      try { parseLiveBlogDraft(record.liveBlog, { complete }); }
      catch (cause) {
        entryIssue = complete ? liveBlogPublicationIssue(record.liveBlog) : null;
        marked.liveBlog = entryIssue?.message ?? (cause instanceof Error ? cause.message : "Check the live updates.");
      }
    }
    if (kind === "page" && pageId === "data-hub") {
      try { parseDataHubReporting(record.dataHubReporting); } catch { marked.dataHubReporting = "Check the reporting mapping."; }
    }
    if (kind === "post" && record.leadMedia !== null && record.leadMedia !== undefined && !isPostLeadMedia(record.leadMedia, complete)) {
      marked.heroImage = complete ? "Choose valid lead media. Images need alt text or a decorative mark; videos need a title or caption and a supported link or library video."
        : "Check the lead media selection and link. Use a supported video embed or an HTTPS video link.";
      const lead = record.leadMedia;
      if (typeof lead === "object" && !Array.isArray(lead) && "kind" in lead && lead.kind === "image") {
        const data = "data" in lead ? lead.data : null;
        marked.heroImage = data && typeof data === "object" && !Array.isArray(data)
          && "altDecorative" in data && data.altDecorative === true && "alt" in data && data.alt !== ""
          ? complete && typeof data.alt === "string" && !data.alt.trim()
            ? 'The alt text has only spaces. Clear it while "Mark lead image as decorative" is on.'
            : 'Clear the alt text or turn off "Mark lead image as decorative".'
          : "Check the lead image selection, alt text and caption. Choose a library image and add alt text or mark it decorative.";
      }
    }
    if (kind === "page" && pageId === "home") {
      try { parseHomeHero(record.homeHero); } catch (cause) { marked.homeHero = cause instanceof Error ? cause.message : "Home hero settings are invalid."; }
    }
    for (const { field, message } of invalid) {
      marked[kind === "post" && ["heroImageAlt", "heroImageDecorative", "heroImageCaption"].includes(field.key) ? "heroImage" : fieldPathKey(field)] = message;
    }
    if (kind === "program" && typeof record.watchUrl === "string" && record.watchUrl.trim()) {
      try {
        const url = new URL(record.watchUrl);
        if (url.protocol !== "https:" || url.hostname !== "watch.njpbs.org" || url.username || url.password || url.port) marked.watchUrl = "Use an HTTPS link on watch.njpbs.org.";
      } catch { marked.watchUrl = "Use an HTTPS link on watch.njpbs.org."; }
    }
    if (kind === "event") {
      for (const field of ["registrationUrl", "onlineUrl"]) {
        const value = record[field];
        if (typeof value === "string" && value.trim() && !/^https:\/\/[^\s]+$/i.test(value)) {
          marked[field] = "Use an HTTPS URL.";
        }
      }
      if (record.isFree === true && typeof record.priceText === "string" && record.priceText.trim()) {
        marked.priceText = "Leave the price blank for a free event.";
      }
    }
    if (kind === "sponsor" && typeof record.href === "string" && record.href.trim()) {
      try {
        const url = new URL(record.href);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
          /[\u0000-\u001f\u007f]/.test(record.href)) marked.href = "Website must use an absolute HTTP or HTTPS URL.";
      } catch { marked.href = "Website must use an absolute HTTP or HTTPS URL."; }
    }
    if (kind === "sponsor" && typeof record.activeFrom === "string" && typeof record.activeUntil === "string" &&
      record.activeFrom && record.activeUntil && record.activeUntil < record.activeFrom && !marked.activeUntil) {
      marked.activeUntil = "Active until must be on or after Active from.";
    }
    const slugField = fields.find(field => field.key === "slug" && !field.path);
    if (slugField && record.slug !== settledRef.current.record.slug) {
      const slug = record.slug;
      const validSlug = kind === "post" || kind === "event" || kind === "program"
        ? (!record.id && (slug === "" || slug === undefined)) || isMintablePostSlug(slug)
        : typeof pageId === "string" && isAvailablePageSlug(pageId, slug);
      if (!validSlug) marked.slug = "Enter an available URL slug with lowercase letters, numbers, and single hyphens (80 characters maximum).";
    }
    // A control still holding an unfinished draft blocks the save too. Reading `record` alone
    // cannot see this: the record holds the last value that converted, which is exactly why a
    // half-typed date used to save the old instant and report Saved (#850). A field the record
    // already fails on keeps that message; it is the more specific thing to say.
    for (const [key, message] of Object.entries(draftErrorsRef.current)) {
      if (marked[key] === undefined) marked[key] = message;
    }
    if (Object.keys(marked).length > 0) {
      setErrors(marked);
      setSaved(false);
      const firstField = fields.find(field => marked[fieldPathKey(field)] !== undefined);
      if (entryIssue) {
        publicationValidationError.current = entryIssue.message;
        revealLiveBlogIssue(entryIssue);
      }
      else if (firstField) jumpToField(firstField);
      else if (marked.liveBlog) {
        revealPostPanel("post-live-blog", `${formId}-live-blog`);
        setPendingFocusFieldId(`${formId}-live-blog`);
      }
      else if (marked.dataHubReporting) {
        setReportingReveal(value => value+1);
        onRevealField?.("dataHubReporting",`${formId}-reporting-control`);
      }
      else if (marked.homeHero) {
        setHeroFocusId(`${formId}-hero-selection`);
        setHeroRevealRequest(request => request + 1);
        if (onRevealField) onRevealField("homeHero", `${formId}-hero-selection`);
        else setPendingFocusFieldId(`${formId}-hero-selection`);
      }
      successNotice.show(entryIssue ? `Save stopped. ${entryIssue.message}` : firstField ? `Save stopped. ${firstField.label}: ${marked[fieldPathKey(firstField)]}` : "Save stopped. Check the highlighted fields.", {
        tone: "error",
        ...(firstField && !entryIssue ? { action: { label: "Review fields", onClick: () => jumpToField(firstField) } } : {}),
      });
      return false;
    }
    setErrors({});

    return true;
  }

  async function validateForPublication(): Promise<boolean> {
    if (!validateFields(true)) {
      if (publicationValidationError.current) throw new Error(publicationValidationError.current);
      return false;
    }
    if (kind !== "post") return true;
    const bodyIsValid = postBodyRef.current?.validateForPublication() === true;
    if (!bodyIsValid) revealPostPanel("post-body");
    return bodyIsValid;
  }

  const capturedSave = useRef<{
    record: Record<string, unknown>; token: object; valid: boolean; body?: CapturedEditorSave;
  } | null>(null);
  const submittedSave = useRef<{ record: Record<string, unknown>; token: object } | null>(null);
  const saveCaptured = useRef<(capture: NonNullable<typeof capturedSave.current>) => Promise<EditorSaveOutcome>>();
  const runSave = useSaveFlight<EditorSaveOutcome>();
  saveCaptured.current = capture => {
    if (interactionLocked || liveBlogPublishInFlight.current || !canSave || capturedSave.current !== capture || !capture.valid) {
      return Promise.resolve(RECORD_SAVE_REFUSED);
    }
    return runSave(() => persistRecord(undefined, capture));
  };
  function captureSave(): CapturedEditorSave {
    const capture = {
      record: recordRef.current,
      token: submittedSave.current?.record === recordRef.current ? submittedSave.current.token : {},
      valid: validateFields(!allowIncomplete),
      body: kind === "post" ? postBodyRef.current?.captureSave() : undefined,
    };
    capturedSave.current = capture;
    return { token: capture.token,
      save: () => saveCaptured.current!(capture),
      dispose: () => {
        capture.body?.dispose();
        if (capturedSave.current === capture) capturedSave.current = null;
      },
    };
  }
  function save(options?: { force?: boolean }): Promise<EditorSaveOutcome> {
    if (interactionLocked || liveBlogPublishInFlight.current || !canSave) return Promise.resolve(RECORD_SAVE_REFUSED);
    return runSave(() => persistRecord(options));
  }

  function persistRecord(options?: { force?: boolean }, capture?: NonNullable<typeof capturedSave.current>): EditorSaveOutcome | Promise<EditorSaveOutcome> {
    // Own the flight before awaiting Post body validation, not after the request starts.
    // Repeated callers await the same result without sending competing versions.
    if (conflict && !options?.force) return RECORD_SAVE_REFUSED;
    if (capture ? !capture.valid : !validateFields(!allowIncomplete)) return RECORD_SAVE_REFUSED;

    // The body editor has no persistence of its own in the Post form.
    if (kind === "post") return (async () => {
      const body = await (capture ? capture.body?.save() : postBodyRef.current?.save());
      if (capture ? body?.landed !== true : body?.clean !== true) {
        revealPostPanel("post-body");
        setSaved(false);
        return RECORD_SAVE_REFUSED;
      }
      return persistValidatedRecord(options, capture);
    })();
    return persistValidatedRecord(options, capture);
  }

  function persistValidatedRecord(options?: { force?: boolean }, capture?: NonNullable<typeof capturedSave.current>): EditorSaveOutcome | Promise<EditorSaveOutcome> {
    const sent = capture?.record ?? recordRef.current;
    const token = capture?.token ?? (capturedSave.current?.record === sent ? capturedSave.current.token : {});
    submittedSave.current = { record: sent, token };
    const outgoing = kind === "page" && pageId === "data-hub" ? {...sent} : sent;
    if (outgoing !== sent) delete outgoing._dataHubReportingDrafts;
    const outcome = options ? onSave?.(outgoing, options) : onSave?.(outgoing);
    if (isThenable(outcome)) return (async () => {
      // Async persist path: hold the saving state until the server answers, then either adopt
      // the server-minted id or surface the failure. A rejected save leaves the live record
      // untouched so the editor can retry from the same content.
      setSaving(true);
      onSavingChange?.(true);
      let cleanPersisted: Record<string, unknown> | undefined;
      let savedCurrent = false;
      let landed = false;
      let savedTarget: SavedEditorReceipt | undefined;
      try {
        const persistedResult = await outcome;
        const receipt = isRecordSaveReceipt(persistedResult)
          ? persistedResult
          : undefined;
        const persisted: Record<string, unknown> | void = receipt
          ? receipt.document
          : (persistedResult as Record<string, unknown> | void);
        const mintedIds = receipt?.mintedIds ?? {};
        const sentBlog = sent.liveBlog as LiveBlogDraft | undefined;
        const savedBlog = (persisted as { liveBlog?: LiveBlogDraft } | undefined)?.liveBlog;
        const liveBlogIds = new Map((sentBlog?.updates ?? []).flatMap((entry, index) => {
          const savedId = savedBlog?.updates[index]?.id;
          return savedId && entry.id !== savedId ? [[entry.id, savedId] as const] : [];
        }));
        const followUpIds = new Map((sentBlog?.updates ?? []).map((entry, index) => [entry.id,
          new Map((entry.followUps ?? []).flatMap((item, followIndex) => {
            const savedId = savedBlog?.updates[index]?.followUps?.[followIndex]?.id;
            return savedId && savedId !== item.id ? [[item.id, savedId] as const] : [];
          })),
        ]));
        if (liveBlogIds.size) setLiveBlogEntryKeys(current => ({ ...current,
          ...Object.fromEntries([...liveBlogIds].map(([before, after]) => [after, current[before] ?? before])),
        }));
        if ([...followUpIds.values()].some(ids => ids.size)) setLiveBlogEntryKeys(current => ({ ...current,
          ...Object.fromEntries([...followUpIds].flatMap(([parentId, ids]) => [...ids].map(([before, after]) => [
            `${liveBlogIds.get(parentId) ?? parentId}/${after}`, current[`${parentId}/${before}`] ?? before,
          ]))),
        }));
        // Reconcile through the sent identity, so additions/reordering and text
        // edits made during the request survive its canonical-id acknowledgment.
        const reconcileSavedRecord = (candidate: Record<string, unknown>) => {
          const next = reconcileRecordBlockIds(candidate, mintedIds);
          const blog = next.liveBlog as LiveBlogDraft | undefined;
          if (!blog) return next;
          return { ...next, liveBlog: { ...blog, updates: blog.updates.map(entry => {
            const id = liveBlogIds.get(entry.id);
            const nested = followUpIds.get(entry.id);
            return { ...entry, ...(id ? { id } : {}), ...(entry.followUps === undefined ? {} : {
              followUps: entry.followUps.map(item => ({ ...item, id: nested?.get(item.id) ?? item.id })),
            }) };
          }) } };
        };
        savedTarget = receipt?.savedTarget ?? (recordKindHasPublicRoute(kind) && persisted
          ? editorSaveReceipt("cmsPosts", persisted.id, persisted.version) : undefined);
        const sentPostBlocks = Array.isArray(sent.blocks)
          ? (sent.blocks as AdminBlock[])
          : [];
        // An edit composed while the save was in flight is still unsaved now that it has landed.
        const editedDuringSave = capture ? !recordsEqual(recordRef.current, sent) : recordRef.current !== sent;
        landed = true;
        setConflict(false);
        setAdvancedCreateRecordId(null);
        // Adopt the server's save envelope. The id turns a create into an update; the version
        // makes the next update claim the exact save that just landed; status and the unassigned
        // draft marker keep a newly saved Post eligible for its one later section choice. Merge
        // onto the live record so edits made while the save was in flight survive.
        const serverId = (persisted as { id?: unknown } | undefined)?.id;
        const serverVersion = (persisted as { version?: unknown } | undefined)?.version;
        const serverStatus = (persisted as { status?: unknown } | undefined)?.status;
        const serverSection = (persisted as { section?: unknown } | undefined)?.section;
        const serverUnassignedDraft = (
          persisted as { unassignedDraft?: unknown } | undefined
        )?.unassignedDraft;
        const serverFields: Record<string, unknown> = {};
        if (typeof serverId === "string") serverFields.id = serverId;
        if (
          typeof serverVersion === "number" &&
          Number.isInteger(serverVersion) &&
          serverVersion >= 1
        ) {
          serverFields.version = serverVersion;
          const revision = (persisted as { contentVersion?: unknown } | undefined)?.contentVersion;
          if (typeof revision === "number") serverFields.contentVersion = revision;
        }
        if (kind === "post" && typeof serverStatus === "string") serverFields.status = serverStatus;
        if (typeof serverSection === "string") serverFields.section = serverSection;
        if (serverUnassignedDraft === true) {
          serverFields.unassignedDraft = true;
        }
        // The meaningful-update request is a one-shot the server consumes and hands
        // back off (#1041). Adopting it alongside the other server fields is what makes it
        // one-shot on this side too: leaving the live toggle and the clean baseline on
        // would put the request back in the next ordinary save, and a typo fix would
        // re-stamp the story as meaningfully updated today.
        const serverMeaningfulUpdate = (
          persisted as { recordMeaningfulUpdate?: unknown } | undefined
        )?.recordMeaningfulUpdate;
        if (
          typeof serverMeaningfulUpdate === "boolean" &&
          sent.recordMeaningfulUpdate !== serverMeaningfulUpdate
        ) {
          serverFields.recordMeaningfulUpdate = serverMeaningfulUpdate;
        }
        // The first byline edit on a pre-#1040 post converts its free-text `author`
        // into one custom credit, and the server deletes the old field in that same
        // save. The live record and the clean baseline still carry it, so the next
        // ordinary save in this session would send a field the post contract no
        // longer has and be refused with "Unknown content field author" -- an error
        // about a field the editor never typed and cannot see. Adopting the removal
        // is the same move as adopting `recordMeaningfulUpdate` above, in the one
        // direction a spread merge cannot express.
        const droppedLegacyAuthor =
          !!persisted &&
          typeof persisted === "object" &&
          Object.prototype.hasOwnProperty.call(sent, "author") &&
          !Object.prototype.hasOwnProperty.call(persisted, "author");
        const droppedUnassignedDraft =
          !!persisted &&
          typeof persisted === "object" &&
          Object.prototype.hasOwnProperty.call(sent, "unassignedDraft") &&
          !Object.prototype.hasOwnProperty.call(persisted, "unassignedDraft");
        const droppedCoverageLabel = sent.coverageLabelId === null && !!persisted && !Object.prototype.hasOwnProperty.call(persisted, "coverageLabelId");
        const serverSlug = persisted?.slug;
        const serverPreviousSlugs = persisted?.previousSlugs;
        const adoptSavedRoute = (candidate: Record<string, unknown>) => {
          if (typeof serverSlug !== "string") return candidate;
          return {
            ...candidate,
            ...(candidate.slug === sent.slug ? { slug: serverSlug } : {}),
            ...(Array.isArray(serverPreviousSlugs) ? { previousSlugs: serverPreviousSlugs } : {}),
          };
        };
        const adoptServerRemovals = (
          candidate: Record<string, unknown>,
        ): Record<string, unknown> => {
          if (!droppedLegacyAuthor && !droppedUnassignedDraft && !droppedCoverageLabel) return candidate;
          const next = { ...candidate };
          let changed = false;
          if (droppedCoverageLabel && next.coverageLabelId === null) {
            delete next.coverageLabelId;
            changed = true;
          }
          if (droppedLegacyAuthor && Object.prototype.hasOwnProperty.call(next, "author")) {
            delete next.author;
            changed = true;
          }
          if (
            droppedUnassignedDraft &&
            Object.prototype.hasOwnProperty.call(next, "unassignedDraft")
          ) {
            delete next.unassignedDraft;
            changed = true;
          }
          return changed ? next : candidate;
        };
        const canonicalSent = adoptServerRemovals(
          adoptSavedRoute(reconcileSavedRecord(sent)),
        );
        const canonicalLive = adoptServerRemovals(
          adoptSavedRoute(reconcileSavedRecord(recordRef.current)),
        );
        if (capturedSave.current) {
          capturedSave.current.record = {
            ...adoptServerRemovals(adoptSavedRoute(reconcileSavedRecord(capturedSave.current.record))),
            ...serverFields,
          };
        }
        if (kind === "post") {
          postBodyRef.current?.adoptSavedIds(mintedIds, sentPostBlocks);
        }
        if (
          Object.keys(serverFields).length > 0 ||
          canonicalLive !== recordRef.current
        ) {
          // The merge replaces the record object, so the effect settles the draft against the
          // adopted server fields rather than this stale one. The baseline it settles to is what the
          // server holds: the snapshot that was sent, under the id just minted for it — never the
          // live record, which may already have moved on.
          adoptingRef.current = { saved: { ...canonicalSent, ...serverFields } };
          // A caller may request another save immediately after awaiting this one, before
          // React commits. Keep its base on this acknowledgment without dropping newer edits.
          recordRef.current = { ...canonicalLive, ...serverFields };
          setRecord((prev) => ({
            ...adoptServerRemovals(adoptSavedRoute(reconcileSavedRecord(prev))),
            ...serverFields,
          }));
        } else {
          // A save that mints no id leaves the record object untouched, so nothing reaches the
          // effect and this is the only place the draft can settle. The prop's contract allows
          // a void resolve, so this path is real rather than defensive.
          settleDraft(canonicalSent, canonicalLive);
        }
        // Confirm only when the live record is exactly what was sent; an edit made during the
        // save leaves unsaved changes, so it must not read as saved.
        if (!editedDuringSave) {
          setSaved(true);
          setSaveWarnings(receipt?.warnings ?? []);
          if (showSaveAction) {
            successNotice.show(receipt?.warnings?.length
              ? `Draft saved. ${receipt.warnings.join(" ")}`
              : "Draft saved.", {
              preserveOnNextRoute:
                preserveSuccessNoticeOnNextRoute &&
                typeof serverId === "string",
            });
          }
          savedCurrent = true;
          if (persisted && typeof persisted === "object") {
            cleanPersisted = persisted;
            lastSaveReceipt.current = persisted;
          }
        }
      } catch (err) {
        successNotice.show(isConflictError(err)
          ? "Your changes were not saved because this content changed elsewhere. Your draft is still here."
          : `Save failed. ${err instanceof Error ? err.message : "Try again. Your draft is still here."}`, { tone: "error" });
        const replayRecordId = createReplayConflictRecordId(err);
        if (replayRecordId) {
          setAdvancedCreateRecordId(replayRecordId);
          setConflict(true);
        } else if (isConflictError(err)) {
          setAdvancedCreateRecordId(null);
          setConflict(true);
        } else {
          setSaveError(err instanceof Error ? err.message : "The save could not be completed.");
        }
        setSaved(false);
      } finally {
        submittedSave.current = null;
        setSaving(false);
        onSavingChange?.(captureInFlight.current);
      }
      if (cleanPersisted) onSaved?.(cleanPersisted);
      return { landed, clean: savedCurrent, ...(landed ? { capture: token } : {}),
        ...(landed && savedTarget ? { receipt: savedTarget } : {}) };
    })();
    // A synchronous host can confirm a captured draft while later edits remain in the form.
    setConflict(false);
    const clean = capture ? recordsEqual(recordRef.current, sent) : recordRef.current === sent;
    setSaved(clean);
    if (showSaveAction && clean) successNotice.show("Draft saved.");
    settleDraft(sent, recordRef.current);
    submittedSave.current = null;
    return { landed: true, clean, capture: token };
  }

  useImperativeHandle(ref, () => ({ save, captureSave, adoptServerFields, validateForPublication }));

  // A direct live update sends only the live blog, so any other unsaved change would
  // be left behind. Ask for those to be saved or discarded first. A draft save and a
  // direct update never run together, so one host saving signal covers either flight.
  // Server envelope fields settle into the baseline only after the save effect runs,
  // so they are not editor changes here. The server checks the exact version.
  const withoutLiveBlog = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .filter(([field]) => !LIVE_BLOG_DIRECT_IGNORED_FIELDS.has(field)));
  const liveBlogDirectDisabledReason = readOnly || duplicatingPost || !canSave
    ? saveDisabledReason ?? "Live updates cannot be published from this editor right now."
    : saving ? "Wait for the current save to finish."
    : conflict ? "Reload this Post before publishing live updates."
    : !settledRef.current.clean || !recordsEqual(withoutLiveBlog(record), withoutLiveBlog(settledRef.current.record))
      ? "Save or discard your other Post changes first. Only live updates can be published directly."
    // The video copy reads the saved Post, so a newly chosen video must be saved first.
    : newLiveBlogVideoBlocks(record.liveBlog, settledRef.current.record.liveBlog).length > 0
      ? "Save a draft first. A newly added video is copied to the public site from the saved Post."
      : undefined;
  async function publishLiveBlogDirectly() {
    if (!publishLiveBlogUpdate || liveBlogPublishInFlight.current || submittedSave.current || captureInFlight.current || duplicateInFlight.current) return;
    const liveBlog = recordRef.current.liveBlog as LiveBlogDraft;
    const baseVersion = recordRef.current.version;
    if (typeof baseVersion !== "number") throw new Error("Save this Post before publishing live updates.");
    try { parseLiveBlogDraft(liveBlog, { complete: true }); }
    catch (cause) {
      const issue = liveBlogPublicationIssue(liveBlog);
      const message = issue?.message ?? (cause instanceof Error ? cause.message : "Check the live updates.");
      setErrors(current => ({ ...current, liveBlog: message }));
      revealLiveBlogIssue(issue);
      throw new Error(message);
    }
    // Hold navigation and other Post actions in the host while the request runs.
    liveBlogPublishInFlight.current = true;
    setPublishingLiveBlog(true);
    onSavingChange?.(true);
    try {
      const receipt = await publishLiveBlogUpdate(liveBlog, baseVersion);
      setSaveWarnings(receipt?.warnings ?? []);
      // The server accepted a queued publication; the public site confirms it later.
      successNotice.show(receipt?.publicationRequested === false
        ? (receipt.warnings ?? []).join(" ")
        : ["Publication requested. The public site has not confirmed these live updates yet.", ...(receipt?.warnings ?? [])].join(" "));
    } catch (err) {
      // A stale version opens the same reload or discard recovery as a draft save.
      // Other 409 refusals, such as changes outside live updates, stay in Live updates.
      if (isConflictError(err) && err instanceof HttpError && err.data.versionConflict === true) {
        setAdvancedCreateRecordId(null);
        setConflict(true);
      }
      throw err;
    } finally {
      liveBlogPublishInFlight.current = false;
      setPublishingLiveBlog(false);
      onSavingChange?.(captureInFlight.current);
    }
  }

  const templateNeedsSave = !settledRef.current.clean ||
    !recordsEqual(record, settledRef.current.record) || Object.keys(draftErrorsRef.current).length > 0;
  async function captureTemplate(fields: TemplateCaptureFields): Promise<PostTemplateReceipt> {
    if (!capturePostTemplate || captureInFlight.current || duplicateInFlight.current || liveBlogPublishInFlight.current) throw new Error("Another Post action is already in progress.");
    captureInFlight.current = true;
    setCapturingTemplate(true);
    onSavingChange?.(true);
    try {
      let source = recordRef.current;
      if (templateNeedsSave) {
        lastSaveReceipt.current = null;
        const outcome = await save();
        if (!outcome.clean || !lastSaveReceipt.current) throw new Error("The Post save did not finish. Cancel and check the editor before capturing a template.");
        source = lastSaveReceipt.current;
      }
      if (typeof source.id !== "string" || typeof source.version !== "number") throw new Error("Save this Post before making a template.");
      return await capturePostTemplate({ ...fields, sourceId: source.id, sourceVersion: source.version });
    } finally {
      captureInFlight.current = false;
      setCapturingTemplate(false);
      onSavingChange?.(false);
    }
  }

  async function duplicateSavedPost(editionLocale?: "es") {
    if (!duplicatePost || duplicateInFlight.current || captureInFlight.current || liveBlogPublishInFlight.current) return;
    const source = recordRef.current;
    if (templateNeedsSave || typeof source.id !== "string" || typeof source.version !== "number") return;
    duplicateInFlight.current = true;
    setPostSourceAction(editionLocale ?? "duplicate");
    setSaveError(null);
    setDuplicateError(null);
    onSavingChange?.(true);
    try {
      if (editionLocale === undefined) await duplicatePost(source.id, source.version);
      else await duplicatePost(source.id, source.version, editionLocale);
    } catch (error) {
      setDuplicateError(error instanceof Error ? error.message : "Try again. The saved Post was not changed.");
    } finally {
      duplicateInFlight.current = false;
      setPostSourceAction(null);
      onSavingChange?.(captureInFlight.current);
    }
  }

  const routedSnapshot = record.published as { metadata?: { slug?: unknown } } | undefined;
  const publishedRecordSlug = typeof routedSnapshot?.metadata?.slug === "string"
    ? routedSnapshot.metadata.slug
    : settledRef.current.record.slug;
  const hasErrors = Object.keys(errors).length > 0;
  // The marked fields in descriptor order, paired with what the save said about each. Only
  // fields this form renders are listed; a stale key for a control that is no longer shown
  // (a conditional alt-text field after its image was cleared) has nothing to jump to.
  const invalidFields = fields.filter(
    (field) => errors[fieldPathKey(field)] !== undefined,
  ).map((field) => ({ field }));
  const postTags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const presentationTagError = kind === "post" ? postPresentationTagError(postTags) : null;
  function removeLiveBlog() {
    returnToLiveBlogStart.current = true;
    changeLiveBlog(null);
  }
  function startLiveBlog() {
    focusNewLiveBlog.current = true;
    changeLiveBlog({ schemaVersion: 1, coverageState: "ongoing", updates: [] });
  }
  function changeReportingDrafts(drafts: Record<string, string>) {
    setSaved(false);
    setSaveError(null);
    setRecord(current => ({ ...current, _dataHubReportingDrafts: drafts }));
  }
  function submitPortalledForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    void save();
  }

  const feedback = (
    <>
      {conflict ? (
        <InlineMessage
          className="record-form-conflict"
          tone="warning"
          role="alert"
          title={
            advancedCreateRecordId
              ? "This created record changed before the retry finished"
              : kind === "page"
                ? "Someone else saved this page while you were editing its metadata"
                : "Someone else saved this record while you were editing it"
          }
        >
          <span>
            {advancedCreateRecordId
              ? "Your draft is still here. Open the saved record to continue from its current version; this discards the draft."
              : "Your changes are still here and have not been saved. Saving now would overwrite their work."}
          </span>
          <Toolbar>
            {advancedCreateRecordId && onOpenConflictRecord ? (
              <Button
                onClick={() => onOpenConflictRecord(advancedCreateRecordId)}
                disabled={saving}
              >
                Open saved record, discarding this draft
              </Button>
            ) : onReload ? (
              <Button onClick={onReload} disabled={saving}>
                {kind === "page"
                  ? "Reload page, discarding all page changes"
                  : "Reload record, discarding your changes"}
              </Button>
            ) : null}
            {!advancedCreateRecordId && allowConflictOverwrite && record.liveBlog === undefined ? (
              <Button
                disabled={!canSave || saving}
                onClick={() => void save({ force: true })}
              >
                Save anyway, overwriting their changes
              </Button>
            ) : null}
          </Toolbar>
        </InlineMessage>
      ) : null}
      {saveWarnings.length ? <InlineMessage tone="warning" title="Content notice">
        {saveWarnings.map(warning => <p key={warning}>{warning}</p>)}
      </InlineMessage> : null}
      {saveError ? (
        <InlineMessage tone="error" title="Save failed">
          <span className="error-text">{saveError}</span>
        </InlineMessage>
      ) : duplicateError ? (
        <InlineMessage tone="error" role="alert" title="Post was not duplicated">
          <span className="error-text">{duplicateError}</span>
        </InlineMessage>
      ) : hasErrors ? (
        <InlineMessage
          tone="error"
          title="Fix the highlighted fields before saving."
        >
          {/* One link per problem, named for the field and described by the message that
              already sits beside the control. Following it opens whatever panel holds the
              control and puts focus on it, so the fix is one click away instead of a scroll
              through every group looking for red. */}
          <ul className="record-form-error-list">
            {invalidFields.map(({ field }) => (
              <li key={fieldPathKey(field)}>
                <button
                  aria-controls={validationFieldIdFor(field)}
                  aria-describedby={`${fieldIdFor(field)}-error`}
                  className="record-form-error-link"
                  onClick={() => jumpToField(field)}
                  type="button"
                >
                  {field.label}
                </button>
              </li>
            ))}
          </ul>
        </InlineMessage>
      ) : null}
    </>
  );

  const editorActionsAvailable = useEditorActionsAvailable();
  const PostActions = editorActionsAvailable ? EditorPostActions : PostTemplateActions;
  const postSourceActionDisabled = saving || capturingTemplate || publishingLiveBlog || duplicatingPost ||
    templateNeedsSave || duplicateDisabledReason !== undefined || typeof record.id !== "string" || typeof record.version !== "number";
  const saveActions = showSaveAction ? (
    <EditorActionSlot group="save">
      <Toolbar className="record-form-actions">
        <AsyncActionButton
          type="submit"
          form={formId}
          variant={kind === "post" ? "secondary" : "primary"}
          icon={kind === "post" ? "save" : undefined}
          disabled={readOnly || !canSave || conflict || capturingTemplate || duplicatingPost}
          label={saveLabel}
          pending={saving}
          pendingAnnouncement={
            kind === "page" ? "Saving page metadata." : "Saving record."
          }
          pendingLabel="Saving…"
        />
        {kind === "post" && (capturePostTemplate || duplicatePost) ? <PostActions>
            {duplicatePost ? <AsyncActionButton
              label="Duplicate post"
              variant="menu"
              icon="stack"
              pending={postSourceAction === "duplicate"}
              pendingLabel="Duplicating…"
              pendingAnnouncement="Duplicating the saved Post as a new draft."
              disabled={postSourceActionDisabled}
              onClick={() => void duplicateSavedPost()}
            /> : null}
            {duplicatePost && canCreateSpanishEdition ? <AsyncActionButton
              label="Create or open Spanish draft"
              variant="menu"
              icon="file"
              pending={postSourceAction === "es"}
              pendingLabel="Opening Spanish draft…"
              pendingAnnouncement="Opening the linked Spanish draft."
              disabled={postSourceActionDisabled}
              onClick={() => void duplicateSavedPost("es")}
            /> : null}
            {capturePostTemplate ? <Button variant="menu" aria-haspopup="dialog" onClick={() => setTemplateOpen(true)} disabled={saving || capturingTemplate || duplicatingPost || publishingLiveBlog || typeof record.id !== "string" || typeof record.version !== "number"}><Icon name="file" /><span>Save as template</span></Button> : null}
            {typeof record.id !== "string" ? <p className="muted">Save this Post first.</p> : null}
            {duplicatePost && typeof record.id === "string" && templateNeedsSave ? <p className="muted">Save or revert your changes before duplicating this Post.</p> : null}
            {duplicatePost && !templateNeedsSave && duplicateDisabledReason && !duplicatingPost ? <p className="muted">{duplicateDisabledReason}</p> : null}
        </PostActions> : null}
        {canSave ? null : (
          <span className="muted">
            {saveDisabledReason ?? (kind === "page"
              ? "Your role cannot save this page's metadata."
              : "Your role cannot save this record.")}
          </span>
        )}
        {saved && !successNotice.available ? (
          <span className="success-text" role="status">
            Saved.
          </span>
        ) : null}
      </Toolbar>
      {templateOpen && typeof record.version === "number" ? <SavePostTemplateDialog
        sourceVersion={record.version}
        needsSave={templateNeedsSave}
        canSave={canSave && !readOnly && !conflict && !publishingLiveBlog}
        onCapture={captureTemplate}
        onClose={() => setTemplateOpen(false)}
      /> : null}
    </EditorActionSlot>
  ) : null;

  return (
    <form
      ref={formRef}
      id={formId}
      className="record-form"
      data-record-kind={kind}
      aria-busy={readOnly || duplicatingPost}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {workspaceActionsAvailable ? saveActions : null}
      {kind === "program" && typeof record.keyArt === "string" && record.keyArt.trim() ? (
        <p className="muted" role="status">The old Media Manager ID is no longer used. Choose art from the media library.</p>
      ) : null}
      {kind === "program" && typeof record.slug === "string" && record.slug ? (
        <p className="muted">Public URL: {publicSiteOrigin}/programs/{record.slug}/ {record.status === "published" ? <> · <a href={`${publicSiteOrigin}/programs/${publishedRecordSlug}/`} target="_blank" rel="noopener noreferrer">View live</a></> : null}</p>
      ) : null}
      {readOnly ? (
        <InlineMessage
          tone="info"
          role="status"
          title={readOnlyNotice?.title ?? "Restoring this version"}
        >
          {readOnlyNotice?.message ??
            "Editing will resume after the current document reloads."}
        </InlineMessage>
      ) : null}
      <RecordFormFields
        accessibilityFieldsForAlt={accessibilityFieldsForAlt}
        allowIncomplete={allowIncomplete}
        assetForAccessibilityField={assetForAccessibilityField}
        assetSuggestions={assetSuggestions}
        bylineAuthors={bylineAuthors}
        bylineAuthorsLoading={bylineAuthorsLoading}
        bylineAuthorsUnavailable={bylineAuthorsUnavailable}
        canEditCustomHtml={canEditCustomHtml}
        canManageAuthorProfiles={canManageAuthorProfiles}
        canManageSettings={canManageSettings}
        canSave={canSave}
        canUploadCategory={canUploadCategory}
        changeCoverageLabel={changeCoverageLabel}
        changeField={changeField}
        changeLiveBlog={changeLiveBlog}
        changePostBlocks={changePostBlocks}
        changeReportingDrafts={changeReportingDrafts}
        coverage={coverage}
        coverageRegistryMissing={coverageRegistryMissing}
        dataHubReportingFigure={dataHubReportingFigure}
        dataHubReportingTarget={dataHubReportingTarget}
        defaultUploadCategory={defaultUploadCategory}
        editorView={editorView}
        electionSourceHost={electionSourceHost}
        errors={errors}
        feedback={feedback}
        fields={fields}
        focusNewLiveBlog={focusNewLiveBlog.current}
        followUpBaselineKnown={followUpBaselineKnown}
        formId={formId}
        groups={groups}
        hasInitialLeadMedia={initial?.leadMedia !== undefined}
        heroFocusId={heroFocusId}
        heroRevealRequest={heroRevealRequest}
        homeHeroTarget={homeHeroTarget}
        interactionLocked={interactionLocked}
        isPostTitleOverrideField={isPostTitleOverrideField}
        isPostWritingField={isPostWritingField}
        jumpToField={jumpToField}
        kind={kind}
        liveBlogDirectDisabledReason={liveBlogDirectDisabledReason}
        liveBlogEntryKeys={liveBlogEntryKeys}
        liveBlogIssue={liveBlogIssue}
        loadMedia={loadMedia}
        loadPublishedVocabulary={loadPublishedVocabulary}
        mediaCategories={mediaCategories}
        mediaPickerUnavailable={mediaPickerUnavailable}
        newId={newId}
        onMediaPickerDirtyChange={onMediaPickerDirtyChange}
        onReportingFigureReveal={onReportingFigureReveal}
        pageId={pageId}
        postBentoReveal={postBentoReveal}
        postBodyRef={postBodyRef}
        postBrandingMarkup={postBrandingMarkup}
        postInspector={postInspector}
        postTags={postTags}
        presentationTagError={presentationTagError}
        publishedRecordSlug={publishedRecordSlug}
        publishedTerms={publishedTerms}
        publishLiveBlogDirectly={publishLiveBlogUpdate ? publishLiveBlogDirectly : undefined}
        record={record}
        removeLiveBlog={removeLiveBlog}
        reportDraftError={reportDraftError}
        reportingReveal={reportingReveal}
        reportingTransport={reportingTransport}
        requestVocabulary={() => setTermsRequested(true)}
        revealPostPanel={revealPostPanel}
        saveDisabledReason={saveDisabledReason}
        savedLiveBlog={savedLiveBlog}
        sectionField={sectionField}
        sectionIsEditable={sectionIsEditable}
        selectAsset={selectAsset}
        selfAuthorId={selfAuthorId}
        setField={setField}
        startLiveBlog={startLiveBlog}
        startLiveBlogRef={startLiveBlogRef}
        submitPortalledForm={submitPortalledForm}
        uploadMedia={uploadMedia}
        writingTarget={writingTarget}
      />
      {!workspaceActionsAvailable ? saveActions : null}
    </form>
  );
});

function EditorPostActions({ children }: { children: React.ReactNode }) {
  return <EditorActionSlot group="routine">{children}</EditorActionSlot>;
}
