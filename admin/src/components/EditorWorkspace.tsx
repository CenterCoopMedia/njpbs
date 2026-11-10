import { CoverageLabelsProvider, type CoverageLabelsLoader } from "../context/CoverageLabelsContext";
import { ElectionResultsSourceHost, type ElectionSourceHost } from "../context/ElectionResultsSourceHost";
import type { ElectionSourceApi } from "../lib/election-sources";
import { homeLayoutsEnabled } from "../lib/home-layouts";
import { seedDataHubPageBlocks } from "../lib/data-hub-page-seed";
import type { DataHubFigure } from "../../../packages/content-core/src/data-hub-reporting";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { EditorActionsProvider, EditorActionSlot } from "./EditorActions";
import { HOME_HERO_CONTENT } from "../../../packages/content-core/src/home-section-render";
import { postPresentationError } from "../../../packages/content-core/src/post-formats";
import { ContentShelfSources } from "./ContentShelfPicker";
import { HttpError, type CapturePostTemplateRequest, type PublishBuildResponse, type PostTemplateReceipt } from "../lib/functions";
import { ScheduledPublicationTime } from "./ScheduledPublicationTime";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Link, useInRouterContext, useLocation } from "react-router";
import {
  RecordForm,
  isRecordSaveReceipt,
  type RecordFormHandle,
  type RecordSaveReceipt,
} from "./RecordForm";
import { AssignmentPanel } from "./AssignmentPanel";
import { ElectionResultsHistory } from "./ElectionResultsHistory";
import { RecordList, type RecordListPage } from "./RecordList";
import { ContentLibrary } from "./ContentLibrary";
import { PagesDirectory, type PageDirectoryApi } from "./PagesDirectory";
import { BlockEditor, type BlockEditorHandle, type CapturedEditorSave } from "./BlockEditor";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { SavedPreview, type SavedPreviewProps } from "./SavedPreview";
import { useSaveFlight } from "../hooks/useSaveFlight";
import { editorSaveReceipt, type SavedEditorReceipt } from "../lib/editor-save-receipt";
import { useDraftAutosave } from "../hooks/useDraftAutosave";
import { PagePreview } from "./PagePreview";
import { RevisionHistory } from "./RevisionHistory";
import { PublishedVersionStatus } from "./PublishedVersionStatus";
import { LivePostAction } from "./LivePostAction";
import { LifecycleActionsPanel } from "./LifecycleActionsPanel";
import { EditorBento, type BentoPanel } from "./EditorBento";
import { Icon } from "./ui/Icon";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";
import {
  AsyncActionButton,
  Button,
  EmptyState,
  InlineMessage,
  Panel,
  StatusLabel,
  Toolbar,
} from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import { EditorFormSkeleton } from "./EditorSkeleton";
import {
  WorkspaceActions,
  WorkspaceFeedback,
  WorkspaceStatus,
  WorkspaceTitle,
  useWorkspaceActionsAvailable,
} from "./WorkspaceActions";
import { canManageAuthorProfiles, canManageSettings, canSaveContent } from "../lib/access";
import {
  adminPerf,
  registerAdminPerfEditorLeaseRelease,
} from "../lib/perf-receipts";
import type { ExitSaveOutcome } from "../lib/exit-save";
import { editorBackDestination, readListOrigin } from "../lib/editor-back";
import {
  readOnlyNotice,
  pageLifecycleResource,
  pageSaveDecision,
  recordLifecycleResource,
  recordSaveDecision,
} from "../lib/editor-save-decisions";
import {
  contentPagesPath,
  createRecordPath,
  recordListPath,
} from "../lib/routes";
import { blocksEqual } from "../lib/block-equality";
import { normalizeLoadedEditorBlocks } from "../lib/block-editor-state";
import { editorSectionCount } from "../lib/content-outline";
import { normalizeEditorRecordDates } from "../lib/content-records";
import { recordsEqual } from "../lib/record-equality";
import { useEditorLock } from "../hooks/useEditorLock";
import type {
  EditorLock,
  EditorLockActor,
  EditorLockClient,
} from "../lib/editor-locks";
import {
  browserEditorWorkStorage,
  clearRecoveredWork,
  readRecoveredWork,
  writeRecoveredWork,
  type RecoveredEditorWork,
} from "../lib/editor-work-recovery";
import {
  PAGE_DESTINATIONS,
  RECORD_DESTINATIONS,
  pageDestination,
  recordDestination,
} from "../lib/content-nav";
import {
  type RecordKind,
  type SectionId,
} from "../../../packages/content-core/src/editor-admin";
import { HOME_EDITABLE_BLOCK_TYPES } from "../lib/public-page-block-ownership";
import {
  publicPage,
  publicPagePath,
  type PublicPageId,
} from "../../../packages/content-core/src/public-pages";
import { pageCompositionFixedRegions } from "../../../packages/content-core/src/page-composition-seeds";
import type { AdminBlock } from "../lib/block-factory";
import type { ContentQuery } from "../lib/content-query";
import type { LibrarySelection } from "../lib/content-library";
import type {
  AssignContentRequest,
  BulkArchiveItem,
  BylineAuthorOption,
  BylineAuthorsResponse,
  BulkArchiveResponse,
  MediaCategoryDefinition,
  PreviewRequestResponse,
  PreviewStatusResponse,
  GetRevisionResponse,
  ListRevisionsResponse,
  RestoreRevisionResponse,
  SaveCollection,
  TransitionContentRequest,
  TransitionContentResponse,
  PublicRuntimeReceipt,
} from "../lib/functions";
import { videosForPublication, type PublicationVideoOptions } from "../lib/publication-videos";
import type { AssignableUser } from "../lib/assignments";
import { can, type Principal } from "../../../packages/content-core/src/rbac";
import { recordKindHasPublicRoute } from "../../../packages/content-core/src/public-record-kinds";
import {
  parseBlocks,
  isAssignableContentStatus,
  parseScheduledPublishFailure,
  type ScheduledPublishFailure,
} from "../../../packages/content-core/src/content-model";
import type {
  SavedContentView,
  SavedContentViewMutation,
} from "../lib/saved-content-views";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import {
  contentStatusTone,
  displayContentStatus,
  livePublishedSourceVersion,
} from "../lib/content-status";

const ACTIVE_DRAFT_RECONCILE_MS = 250;

type SavingSource =
  | `election-source:${string}`
  | "assignment"
  | "record-form"
  | "page-metadata"
  | "page-blocks"
  | "page-update"
  | "home-conversion"
  | "revision-restore"
  | "lifecycle-transition"
  | "library-mutation";

// A record surface carries the addressed id: `null` is the create route and a string is an
// edit-by-id route. Structurally identical to routes.ts EditorSurface so the content layout hands
// its parsed surface straight in. The id is what keeps a create draft and an edit-by-id visit for
// the same kind on separate surfaces, and what lets the editor tell "compose a new record" from
// "open the record this URL addresses".
export type Surface =
  | { kind: "page-list" }
  | { kind: "library" }
  | { kind: "record-list"; record: RecordKind }
  | { kind: "record"; record: RecordKind; id: string | null }
  | { kind: "page"; pageId: PublicPageId; section: SectionId };

// A page's blocks together with the stored version they were read from, which a save echoes
// back as `baseVersion` so the server can refuse an edit composed against content the editor
// can no longer see (#530). Load and save share the shape because a save returns the new
// version, which becomes the base for the next save in the same session -- without that, a
// second save would echo a version the first one had already superseded and conflict with
// itself.
//
// `version` is optional because a document can genuinely have none to claim: a page that has
// never been created, and one stored before `version` existed, both read as undefined. A
// never-created page carries `expectedAbsent` instead, so its first save is still guarded
// against another editor creating the page in the meantime (#567).
const LockedElectionSourceControls = lazy(() => import("./ElectionResultsEditor").then(module => ({ default: module.ElectionResultsSourceControls })));
const noSourceChange = () => {};
const noSourceConnections = new Map<string, boolean>();

export interface PageContent {
  electionResultsApprovals?: import("../../../packages/content-core/src/election-results").ElectionRaceApproval[];
  blocks: AdminBlock[];
  warnings?: string[];
  homeCompositionVersion?: 1 | 2;
  // Present on a save response. Each entry maps the id sent for one block to the canonical id
  // minted by the server. Loads have no identity receipt, so this stays optional on the shared
  // load/save shape.
  mintedIds?: Record<string, string>;
  // Optional for isolated/test integrations written before page metadata was editable. The
  // production boundary always supplies it, and the workspace falls back to the public-page
  // registry when an older integration does not.
  metadata?: Record<string, unknown>;
  // Trusted ownership and lifecycle from cmsGetContent/cmsSaveContent. Existing pages need both
  // to mirror the server's edit-own decision; their absence denies edit-own rather than widening
  // the caller into edit-any authority.
  createdBy?: string;
  editingSection?: string;
  status?: string;
  publishAt?: string;
  version?: number;
  // The last scheduled-publish failure the server recorded on an approved page,
  // validated at the ContentTab boundary before it reaches the lifecycle panel.
  scheduledPublishFailure?: ScheduledPublishFailure;
  contentVersion?: number;
  publiclyVisible?: boolean;
  publicSourceVersion?: number;
  publishedSourceVersion?: number;
  publishedElectionBlocks?: AdminBlock[];
  publishBuildPending?: boolean;
  publishBuildQueueId?: string | null;
  expectedAbsent?: boolean;
  // An old editor route stored several real pages in one template-keyed singleton. When a
  // page-id document is absent, ContentTab can hydrate from that source and asks the server to
  // copy its non-block metadata atomically on first save. The source version travels with the
  // blocks so a changed legacy document is refused rather than partly migrated from two states.
  seedFromLegacyPage?: { id: SectionId; version?: number };
}

// The hydration state for the selected page. A page save sends its whole block list, so the
// editor must be seeded with the page's stored blocks before it can save — otherwise a save
// from a blank editor would overwrite the live composition (#515 data-loss guard). Loading
// and error therefore render in place of the editor: while loading there is nothing to save
// yet, and on a failed read editing stays disabled so a blank editor can never overwrite the
// stored page. `idle` is the non-page (record) surface, where no hydration runs.
type PageLoad =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      electionResultsApprovals?: import("../../../packages/content-core/src/election-results").ElectionRaceApproval[];
      blocks: AdminBlock[];
      homeCompositionVersion?: 1 | 2;
      metadata: Record<string, unknown>;
      createdBy?: string;
      editingSection?: string;
      pageStatus?: string;
      publishAt?: string;
      scheduledPublishFailure?: ScheduledPublishFailure;
      contentVersion?: number;
      publiclyVisible?: boolean;
      publicSourceVersion?: number;
      publishedSourceVersion?: number;
      publishedElectionBlocks?: AdminBlock[];
      publishBuildPending?: boolean;
      publishBuildQueueId?: string | null;
      expectedAbsent: boolean;
    }
  | { status: "error"; message: string };

export type LoadedRecord =
  | { status: "ready"; record: Record<string, unknown> }
  | { status: "missing" }
  | { status: "deleted" }
  | { status: "invalid" };

type RecordLoad =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      record: Record<string, unknown>;
      initialIsClean: boolean;
    }
  | { status: "missing" }
  | { status: "deleted" }
  | { status: "invalid" }
  | { status: "error"; message: string };

function labelForSurface(surface: Surface): string {
  if (surface.kind === "page-list") return "Site pages";
  if (surface.kind === "library") return "All content";
  return surface.kind === "record" || surface.kind === "record-list"
    ? recordDestination(surface.record).label
    : pageDestination(surface.pageId).label;
}

function isSameSurface(surface: Surface, value: Surface): boolean {
  if (surface.kind !== value.kind) return false;
  if (surface.kind === "page-list" || surface.kind === "library") return true;
  if (surface.kind === "record-list") {
    return (
      surface.record ===
      (value as Extract<Surface, { kind: "record-list" }>).record
    );
  }
  if (surface.kind === "record") {
    const other = value as Extract<Surface, { kind: "record" }>;
    return surface.record === other.record && surface.id === other.id;
  }
  return (
    surface.pageId === (value as Extract<Surface, { kind: "page" }>).pageId
  );
}

// A stable key for one surface, so drafts can be held per surface rather than per mount. A record
// key includes the addressed id so the create surface (id null, keyed with the "+" create marker)
// and an edit-by-id surface for the same kind never collide in the draft map. A parsed id can
// never be "+" (parseContentPath rejects it), so the marker cannot alias a real record.
function surfaceKey(surface: Surface): string {
  return surface.kind === "page-list"
    ? "page-list"
    : surface.kind === "library"
      ? "library"
      : surface.kind === "record-list"
        ? `record-list:${surface.record}`
        : surface.kind === "record"
          ? `record:${surface.record}:${surface.id ?? "+"}`
          : `page:${surface.pageId}`;
}

// Courtesy locks name persisted Firestore documents, not routes. A create form has no document id
// yet, and list or library surfaces never mutate one record, so those surfaces need no lock.
export function editorLockSurfaceKey(surface: Surface): string | null {
  return surface.kind === "page"
    ? `cmsPages:${surface.pageId}`
    : surface.kind === "record" && surface.id !== null
      ? `cmsPosts:${surface.id}`
      : null;
}

function lockStartLabel(lock: EditorLock): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(lock.acquiredAtMs));
}

// Work in progress on a surface nobody is looking at right now. Both editors are keyed on the
// surface, so leaving one unmounts it and takes its state with it; the workspace holds the
// draft here and seeds the next mount from it (#579).
//
// A page draft carries the version its blocks were composed against, because the two are one
// claim and must travel together: restoring blocks while re-reading the version would echo a
// base the person never saw and defeat the conflict guard (#530).
type Draft =
  | { kind: "record"; record: Record<string, unknown> }
  | {
      kind: "page";
      blocks: AdminBlock[];
      homeCompositionVersion?: 1 | 2;
      createdBy?: string;
      editingSection?: string;
      pageStatus?: string;
      version?: number;
      contentVersion?: number;
      publiclyVisible?: boolean;
      publicSourceVersion?: number;
      publishedSourceVersion?: number;
      publishedElectionBlocks?: AdminBlock[];
      publishBuildPending?: boolean;
      publishBuildQueueId?: string | null;
      expectedAbsent?: boolean;
      seedFromLegacyPage?: { id: SectionId; version?: number };
    };

type PageMetadataDraft = {
  metadata: Record<string, unknown>;
  homeCompositionVersion?: 1 | 2;
  createdBy?: string;
  editingSection?: string;
  pageStatus?: string;
  version?: number;
  contentVersion?: number;
  publiclyVisible?: boolean;
  publicSourceVersion?: number;
  publishedSourceVersion?: number;
  publishedElectionBlocks?: AdminBlock[];
  publishBuildPending?: boolean;
  publishBuildQueueId?: string | null;
  expectedAbsent?: boolean;
  seedFromLegacyPage?: { id: SectionId; version?: number };
};

interface EditorWorkspaceProps {
  electionSources?: ElectionSourceApi;
  pageDirectoryApi?: PageDirectoryApi;
  principal: Principal;
  // ContentTab enables the public-route ownership policy. Direct test and design-gallery renders
  // remain generic block-workspace specimens unless they opt into the production adapter.
  enforcePublicPageOwnership?: boolean;
  // Persist a page's blocks through cmsSaveContent and resolve to the server's canonical
  // blocks for the editor to adopt (#515), plus the version that write produced (#530).
  // Injected from ContentTab, which owns the auth token, so the workspace stays free of the
  // auth context and is rendered in tests with a fake. Absent (as in a bare test render)
  // leaves the page editor with no save affordance.
  //
  // `baseVersion` is the version the blocks were composed against. A missing claim
  // on an existing Page asks ContentTab to read and confirm the current saved version;
  // the server never accepts an unclaimed update.
  savePage?: (
    pageId: PublicPageId,
    section: SectionId,
    blocks: AdminBlock[],
    baseVersion?: number,
    createOnly?: boolean,
    seedFromLegacyPage?: { id: SectionId; version?: number },
    saveGroupId?: string,
  ) => Promise<PageContent>;
  // A metadata save is deliberately separate from a block save. Both are partial-document
  // writes through the same server transaction. Their version claims advance together after a
  // save that proved the stored version current, but stay separate after a save that proved
  // nothing -- an explicit force-overwrite (#563), or a save from a page that was loaded with no
  // version to send (#670) -- so stale work in the sibling editor cannot silently replace a
  // remote change.
  savePageMetadata?: (
    pageId: PublicPageId,
    section: SectionId,
    metadata: Record<string, unknown>,
    baseVersion?: number,
    createOnly?: boolean,
    seedFromLegacyPage?: { id: SectionId; version?: number },
    saveGroupId?: string,
  ) => Promise<PageContent>;
  // Persist a record through cmsSaveContent and resolve to the stored record so the form can
  // adopt the server-minted id (#515). Injected from ContentTab alongside savePage; the kind is
  // supplied here so ContentTab can stamp it as the record's type discriminator. Absent (a bare
  // test render) leaves the record form with no persist wired.
  saveRecord?: (
    kind: RecordKind,
    record: Record<string, unknown>,
    options?: { force?: boolean },
  ) => Promise<Record<string, unknown> | RecordSaveReceipt>;
  capturePostTemplate?: (request: CapturePostTemplateRequest) => Promise<PostTemplateReceipt>;
  duplicatePost?: (sourceId: string, sourceVersion: number) => Promise<Record<string, unknown>>;
  // Clear host state that belongs to an abandoned create after the server identifies the
  // already-created record. This is separate from an ordinary failed save: only the person's
  // explicit decision to discard the draft may release its idempotency nonce.
  abandonRecordCreate?: (kind: RecordKind) => void;
  // Record assignment is a separate admin-only workflow mutation. The dedicated callback keeps
  // assignee out of the editable save payload and its staff loader keeps this component free of
  // Firestore/auth dependencies.
  canAssignRecords?: boolean;
  loadAssignableUsers?: () => Promise<AssignableUser[]>;
  assignRecord?: (
    request: AssignContentRequest,
  ) => Promise<Record<string, unknown>>;
  // Browse and hydrate records through the Firestore boundary owned by ContentTab. The per-kind
  // list supports quick type-specific browsing, one bounded page at a time (#1066); the combined
  // loader feeds the URL-filtered library.
  // loadRecord returns explicit absence and integrity states so an unsafe blank form is never
  // substituted for a failed read.
  listRecords?: (kind: RecordKind, page: number) => Promise<RecordListPage>;
  canArchiveLibrary?: boolean;
  archiveLibraryRecords?: (
    items: BulkArchiveItem[],
  ) => Promise<BulkArchiveResponse>;
  loadLibrarySelection?: (query: ContentQuery) => Promise<LibrarySelection>;
  loadSavedViews?: () => Promise<SavedContentView[]>;
  mutateSavedViews?: (
    mutation: SavedContentViewMutation,
  ) => Promise<SavedContentView[]>;
  loadRecord?: (kind: RecordKind, id: string) => Promise<LoadedRecord>;
  // Read a page's stored blocks so the editor hydrates before it can save (#515 data-loss
  // guard), and the version they were read at so a save can claim it (#530). Injected from
  // ContentTab alongside savePage; production always provides it. When absent (a bare test
  // render) the page editor starts empty, does not hydrate, and has no version to echo.
  loadPage?: (pageId: PublicPageId, section: SectionId) => Promise<PageContent>;
  convertHome?: (baseVersion: number, requestKey: string) => Promise<PageContent>;
  convertHomeV2?: (baseVersion: number, requestKey: string) => Promise<PageContent>;
  reportingTransport?: import("./DataHubReportingEditor").ReportingEditorTransport;
  loadHomeSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  // ContentTab supplies the authenticated station-image browser. Keeping it injectable
  // preserves this workspace as a direct test and design-gallery surface.
  loadMedia?: MediaPickerLoader;
  // The byline picker's feed (#1040). Read once per mounted workspace and shared by
  // every record form it renders, so opening five posts is one request, not five.
  // Paged: called again with the previous page's cursor until the feed is exhausted.
  // Absent in a bare test render: the byline control then offers custom credits only.
  loadBylineAuthors?: (
    body?: { startAfter?: string | null },
  ) => Promise<BylineAuthorsResponse>;
  loadCoverageLabels?: CoverageLabelsLoader;
  loadPublishedVocabulary?: import("../lib/use-published-vocabulary").VocabularyLoader;
  uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
  // ContentTab sets this when the principal can edit content but cannot use the
  // private media library. The editor then preserves saved ids without exposing
  // the old raw-id control or offering a request the server will refuse.
  mediaPickerUnavailable?: boolean;
  autoSaveEnabled?: boolean;
  requestSavedPreview?: SavedPreviewProps["requestPreview"];
  preparePreviewSession?: SavedPreviewProps["prepareSession"];
  requestPagePreview?: (
    pageId: PublicPageId,
  ) => Promise<PreviewRequestResponse>;
  loadPagePreviewStatus?: SavedPreviewProps["loadPreviewStatus"];
  // Revision summaries and full rows stay behind the same authenticated
  // record-aware boundary as content hydration. The workspace supplies only
  // the addressed collection and id, so this component remains auth-free.
  loadRevisions?: (
    collection: SaveCollection,
    id: string,
    cursor?: string,
  ) => Promise<ListRevisionsResponse>;
  loadRevision?: (
    collection: SaveCollection,
    id: string,
    revisionId: string,
  ) => Promise<GetRevisionResponse>;
  restoreRevision?: (
    collection: SaveCollection,
    id: string,
    revisionId: string,
    baseVersion: number,
  ) => Promise<RestoreRevisionResponse>;
  transitionContent?: (
    request: TransitionContentRequest,
  ) => Promise<TransitionContentResponse>;
  publishContent?: (
    collection: SaveCollection,
    id: string,
    baseVersion: number,
    videos?: PublicationVideoOptions,
  ) => Promise<{
    document: Record<string, unknown>;
    publicReceipt?: PublicRuntimeReceipt | null;
    buildQueued?: boolean;
    transport?: PublishBuildResponse["transport"];
  }>;
  // Publish only live blog entries and coverage state on a published live blog Post.
  publishLiveBlogUpdate?: (
    id: string,
    baseVersion: number,
    liveBlog: unknown,
    publishedLiveBlog?: unknown,
  ) => Promise<{ warnings?: string[]; publicationRequested?: boolean }>;
  scheduleContent?: (
    collection: SaveCollection,
    id: string,
    baseVersion: number,
    scheduleAt: string,
    videos?: PublicationVideoOptions,
  ) => Promise<{ document: Record<string, unknown> }>;
  // A block id generator forwarded to the page editor, injected in tests for deterministic
  // ids. Production leaves it unset and the editor uses crypto.randomUUID.
  newId?: () => string;
  // Raised whenever a page save starts or settles, so an ancestor that owns other navigation
  // (the shell's primary hierarchy) can hold it too. The workspace already blocks its isolated
  // surface picker while saving; a top-level route change would unmount the editor and orphan the
  // save one level above this component's reach, so the shell needs the same signal (#515).
  onSavingChange?: (saving: boolean) => void;
  // The surface to show, when the content layout drives it from the URL (#580). Optional so a
  // bare test render, and any caller that does not route, stays uncontrolled and keeps its own
  // surface state. When provided, the URL is the single source of truth for which surface is
  // open, so routed transitions report through onNavigateSurface rather than moving state
  // here. Structurally identical to routes.ts EditorSurface, so the layout hands its parsed
  // surface straight in.
  surface?: Surface;
  // A routed selection, when the surface is URL-controlled. The layout turns it into a navigation;
  // the resulting surface flows back through the `surface` prop. Absent means uncontrolled: the
  // isolated surface picker moves internal state directly.
  onNavigateSurface?: (
    surface: Surface,
    options?: { replace?: boolean; committed?: boolean },
  ) => void;
  // Raised when the set of surfaces holding unsaved work becomes non-empty or empties again, so
  // the content layout's navigation guard can prompt before a dirty leave (#580). Draft existence
  // arms this cheaply and immediately; after input idles, the active surface is reconciled against
  // its clean baseline so a fully reverted edit disarms the signal and releases its courtesy lease.
  // It never says clean while work is outstanding, so it is safe as the arming signal.
  onDirtyChange?: (dirty: boolean) => void;
  // Filled in with a probe that answers, by value, whether any draft still differs from its clean
  // point. The guard calls it at the moment it would prompt, which turns the conservative flag
  // above into an exact synchronous answer without putting the comparison on the typing path
  // (#595). A host that does not pass one still gets the debounced exact active-surface signal.
  unsavedProbeRef?: MutableRefObject<(() => boolean) | null>;
  // Filled in with the active surface's own save, so a host holding an exit can commit the work
  // and wait for the server's answer before it lets the exit through (#1032). It resolves true
  // only when every unsaved panel of that surface landed and nothing was left behind; a refusal,
  // a failure, a conflict, or an edit made while the save was in flight all resolve false.
  saveRequestRef?: MutableRefObject<(() => Promise<ExitSaveOutcome>) | null>;
  // Firestore presence is injected beside the content boundary so this workspace remains a pure,
  // directly renderable component in tests and the development gallery.
  editorLockClient?: EditorLockClient;
  editorLockActor?: EditorLockActor;
  // The live content section registry (#845), injected for the same reason every other
  // Firestore-backed input here is: this component stays a direct test and design-gallery
  // surface. The record create form turns it into the required desk picker; absent (a bare
  // test render) leaves the create form with no section control, which is what a host that
  // never wired the registry can honestly offer.
  contentSections?: readonly { id: string; label: string }[];
  newPostSections?: readonly { id: string; label: string }[] | null;
}

// The content editor: pick a record or a page, edit it, and save. Both surfaces persist
// through cmsSaveContent: a page save (the injected savePage) sends the whole block list and
// adopts the server's canonical block ids, and a record save (the injected saveRecord) sends
// the record's fields and adopts the server-minted id so the next save updates it (#515). A
// page also hydrates from its stored blocks (the injected loadPage) before it can save, so an
// edit composes over the live page rather than overwriting it from a blank editor. Save is
// gated on the principal's capability; publishing is a higher capability surfaced here but not
// yet a separate lifecycle action.
export function EditorWorkspace(props: EditorWorkspaceProps) {
  return <ContentShelfSources.Provider value={{ loadLibrarySelection: props.loadLibrarySelection, loadRecord: props.loadRecord, loadPages: props.pageDirectoryApi?.load }}>
    <CoverageLabelsProvider load={props.loadCoverageLabels}><EditorWorkspaceContent {...props} /></CoverageLabelsProvider>
  </ContentShelfSources.Provider>;
}

function EditorWorkspaceContent({
  electionSources,
  pageDirectoryApi,
  principal,
  enforcePublicPageOwnership = false,
  savePage,
  savePageMetadata,
  saveRecord,
  capturePostTemplate,
  duplicatePost,
  abandonRecordCreate,
  canAssignRecords = false,
  loadAssignableUsers,
  assignRecord,
  listRecords,
  canArchiveLibrary = false,
  archiveLibraryRecords,
  loadLibrarySelection,
  loadSavedViews,
  mutateSavedViews,
  loadRecord,
  loadPage,
  convertHome,
  convertHomeV2,
  loadHomeSources,
  reportingTransport,
  loadMedia,
  loadBylineAuthors,
  loadPublishedVocabulary,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  mediaPickerUnavailable = false,
  autoSaveEnabled = false,
  requestSavedPreview,
  preparePreviewSession,
  requestPagePreview,
  loadPagePreviewStatus,
  loadRevisions,
  loadRevision,
  restoreRevision,
  transitionContent,
  publishContent,
  publishLiveBlogUpdate,
  scheduleContent,
  newId,
  onSavingChange,
  surface: controlledSurface,
  onNavigateSurface,
  onDirtyChange,
  unsavedProbeRef,
  saveRequestRef,
  editorLockClient,
  editorLockActor,
  contentSections,
  newPostSections,
}: EditorWorkspaceProps) {
  const editorView = useEditorWorkspaceView();
  // The home page, so page composition is what a person arrives at. This opened on the
  // article record form until the editor shipped and nobody could find it: a record form
  // and an unbuilt page editor look alike from the outside, so the block editor read as
  // missing rather than one rail click away. The cost is that the hydration effect below
  // now runs on mount, which makes a page read part of opening the studio -- the read has
  // to happen before any page can be edited (#515), so this pays it up front instead of on
  // the first rail click. A read that fails still fails safe: editing stays disabled and
  // the retry stands (#574).
  // The surface is either driven by the URL (controlledSurface, passed by the content layout) or
  // held here when no router is above (a bare test render). Falling back to internal state keeps
  // the component usable in isolation while letting the URL be the source of truth in the app.
  const [internalSurface, setInternalSurface] = useState<Surface>({
    kind: "page",
    pageId: "home",
    section: "home",
  });
  const surface = controlledSurface ?? internalSurface;
  const workspaceActionsAvailable = useWorkspaceActionsAvailable();
  const successNotice = useSuccessNotice();
  const [pageLoad, setPageLoad] = useState<PageLoad>({ status: "idle" });
  const [recordLoad, setRecordLoad] = useState<RecordLoad>({ status: "idle" });
  // The deferred editor graph has resolved and mounted. Timed as its own boundary
  // so a slow session separates route download from editor render (#1064).
  // Categories only; no page, record, or account identity.
  useEffect(() => {
    adminPerf.phase("editorMounted");
  }, []);
  // The first usable editing surface of the session, for the performance receipt (#1064). It
  // is marked from the committed ready state rather than from the content request resolving:
  // a response only becomes an editing surface once this component has adopted it and
  // rendered, and a stale response the hydration boundary discards must not be able to
  // consume the once-only mark. Categories only; no page, record, or account identity.
  useEffect(() => {
    if (pageLoad.status === "ready" || recordLoad.status === "ready") {
      adminPerf.phase("editorReady");
    }
  }, [pageLoad.status, recordLoad.status]);
  // Every independently mounted save control contributes its own lifecycle. A boolean cannot
  // represent two concurrent page saves: if metadata settled before composition, its `false`
  // used to unlock navigation while the composition request was still writing (#669). A set
  // also makes each source idempotent, which matters because editor cleanup reports `false`
  // after the request's own `finally` has already done so.
  const [savingSources, setSavingSources] = useState<ReadonlySet<SavingSource>>(
    () => new Set(),
  );
  const saving = savingSources.size > 0;
  const restoring = savingSources.has("revision-restore");
  const changingLifecycle = savingSources.has("lifecycle-transition");
  const changingElectionSources = [...savingSources].some(source => source.startsWith("election-source:"));
  const onElectionSourceBusyChange = useCallback((blockId: string, active: boolean) => {
    setSavingSources(current => {
      const source: SavingSource = `election-source:${blockId}`;
      if (current.has(source) === active) return current;
      const next = new Set(current); if (active) next.add(source); else next.delete(source); return next;
    });
  }, []);
  const setSavingSource = useCallback(
    (source: SavingSource, active: boolean) => {
      setSavingSources((current) => {
        if (current.has(source) === active) return current;
        const next = new Set(current);
        if (active) next.add(source);
        else next.delete(source);
        return next;
      });
    },
    [],
  );
  // Stable callbacks keep each child's cleanup effect tied to its actual mount. An inline
  // callback would change identity on every parent render and could report a false settle while
  // that child still owns an in-flight request.
  const onAssignmentSavingChange = useCallback(
    (active: boolean) => setSavingSource("assignment", active),
    [setSavingSource],
  );
  const onRecordSavingChange = useCallback(
    (active: boolean) => setSavingSource("record-form", active),
    [setSavingSource],
  );
  const onPageMetadataSavingChange = useCallback(
    (active: boolean) => setSavingSource("page-metadata", active),
    [setSavingSource],
  );
  const onPageBlocksSavingChange = useCallback(
    (active: boolean) => setSavingSource("page-blocks", active),
    [setSavingSource],
  );
  const onRevisionRestoringChange = useCallback(
    (active: boolean) => setSavingSource("revision-restore", active),
    [setSavingSource],
  );
  const onLifecycleChanging = useCallback(
    (active: boolean) => setSavingSource("lifecycle-transition", active),
    [setSavingSource],
  );
  const onLibraryMutatingChange = useCallback(
    (active: boolean) => setSavingSource("library-mutation", active),
    [setSavingSource],
  );
  // Advances only after a page save succeeds. The exact-draft preview uses it
  // to retire any artifact built from the previous saved version without
  // coupling the panel to the editor's concurrency refs.
  const [pageSaveRevision, setPageSaveRevision] = useState(0);
  const homeConversionAttempt = useRef<{ version: number; key: string } | null>(null);
  const homeConversionBusy = useRef(false);
  const [homeConversionError, setHomeConversionError] = useState<string>();
  const [homeV2Confirmation, setHomeV2Confirmation] = useState(false);
  const homeV2Trigger = useRef<HTMLButtonElement>(null);
  const homeV2Cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (homeV2Confirmation) homeV2Cancel.current?.focus();
  }, [homeV2Confirmation]);
  useEffect(() => { setHomeV2Confirmation(false); }, [surface.kind, surface.kind === "page" ? surface.pageId : null]);
  const homeEditorTarget = useRef<HTMLDivElement>(null);
  const [homeHeroTarget, setHomeHeroTarget] = useState<HTMLDivElement | null>(null);
  const [reportingSelection, setReportingSelection] = useState<{target: HTMLElement; figure: DataHubFigure | "featured"} | null>(null);
  const reportingValidationRevealed = useRef(false);
  const [pageWritingTarget, setPageWritingTarget] = useState<HTMLDivElement | null>(null);
  const focusConvertedHome = useRef(false);
  useLayoutEffect(() => {
    if (!focusConvertedHome.current) return;
    if (surface.kind !== "page" || surface.pageId !== "home") {
      focusConvertedHome.current = false;
      return;
    }
    if (pageLoad.status !== "ready" || pageLoad.homeCompositionVersion === undefined) return;
    // Conversion replaces the confirmation and mounts the retained editor
    // hosts. Focus after those layout effects have placed the real controls.
    const frame = requestAnimationFrame(() => {
      const target = homeEditorTarget.current;
      (target?.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']") ?? target)?.focus();
      focusConvertedHome.current = false;
      successNotice.show("Home sections loaded. This action did not publish the page.");
    });
    return () => cancelAnimationFrame(frame);
  }, [pageLoad, surface, successNotice]);
  const [pageUpdateState, setPageUpdateState] = useState<{
    key: string;
    status: "idle" | "saving" | "saved" | "error";
    message?: string;
  }>({ key: "", status: "idle" });
  const [previewAfterReload, setPreviewAfterReload] =
    useState<PublicPageId | null>(null);
  const activePageId = surface.kind === "page" ? surface.pageId : null;
  useEffect(() => {
    if (previewAfterReload !== null && previewAfterReload !== activePageId) {
      setPreviewAfterReload(null);
    }
  }, [activePageId, previewAfterReload]);
  const revealRequest = useRef(0);
  const [bentoReveal, setBentoReveal] = useState<{
    id: string;
    request: number;
    fieldId?: string;
  }>();

  function revealBentoPanel(id: string, fieldId?: string) {
    revealRequest.current += 1;
    setBentoReveal({ id, request: revealRequest.current, fieldId });
  }
  // Whether any surface currently holds unsaved work. Mirrored from the draft map's non-empty
  // status and raised to the content layout through onDirtyChange (#580), which uses it to guard
  // a dirty leave. Kept as state (not read from the ref) so a change re-renders and the effect
  // below fires; a boolean bails out of re-render unless it actually flips, so writing it on
  // every keystroke is cheap.
  const [dirty, setDirty] = useState(false);
  // Upload metadata lives inside the media picker, outside the page/record draft maps. Mirror it
  // separately so the shared route, sign-out, and unload guard remains armed while that transient
  // form is open, without pretending the document itself has become saveable.
  const [mediaPickerDirty, setMediaPickerDirty] = useState(false);
  const mediaPickerDirtyRef = useRef(false);
  const onMediaPickerDirtyChange = useCallback((nextDirty: boolean) => {
    mediaPickerDirtyRef.current = nextDirty;
    setMediaPickerDirty(nextDirty);
  }, []);
  // Locks follow the active document only. Drafts kept for another surface remain protected by
  // the leave guard, but they do not keep that document reserved after navigation.
  const [activeSurfaceDirty, setActiveSurfaceDirty] = useState(false);
  // Bumped to re-read the current page (the conflict banner's "Reload the page"). The surface
  // does not move, so the hydration effect has nothing else to notice; this is the change it
  // watches. It also sends the effect back through `loading`, which unmounts the editor and is
  // what actually discards the person's unsaved blocks.
  const [reloadCount, setReloadCount] = useState(0);
  const [recordReloadCount, setRecordReloadCount] = useState(0);
  // A successful assignment advances the same record version the form must echo on its next
  // content save. Most record forms remount on the returned server document. A Post adopts the
  // server-controlled fields through its form handle instead because its assignment panel now
  // lives inside the form and must keep its confirmation and keyboard focus.
  const [recordMutationRevision, setRecordMutationRevision] = useState(0);
  const [recordHistoryRevision, setRecordHistoryRevision] = useState(0);
  // The version the mounted editor's blocks were composed against, echoed on save so the
  // server can refuse an edit that never saw someone else's change (#530). A ref, not state:
  // nothing renders it, and the save closure has to read the value current at the moment it
  // fires rather than the one captured when it was created. The hydration boundary owns writing
  // it, whether content comes from a store read or an in-memory restore, so it always describes
  // the blocks actually on screen.
  const blockBaseVersion = useRef<number | undefined>(undefined);
  // Metadata and blocks start from the same page snapshot, but keep separate version claims.
  // A save that actually proved the stored version current can advance both. A save that proved
  // nothing about the page advances only the form it wrote, leaving the other stale or unclaimed
  // so it cannot silently replace remote work: a forced save that dropped a stale claim to
  // overwrite (#563), and a save from a page loaded without a usable version at all (#670).
  const metadataBaseVersion = useRef<number | undefined>(undefined);
  // One Update saves composition and then metadata: two requests against the same document,
  // seconds apart. The version the first write returned describes exactly the document this
  // sequence just produced, so it is a claim the second request has earned even when the page
  // itself was loaded with no version to send. Without it that second request would claim
  // nothing, the server would have nothing to check, and a write that landed in the gap would
  // be overwritten in silence. It is deliberately scoped to the sequence -- set when one starts,
  // cleared when it ends -- so an independent later save by the sibling form still has to prove
  // its own currency, which is what #670 is about.
  const pageSaveSequence = useRef<{ version?: number; id: string; blocks: boolean; metadata: boolean } | undefined>(undefined);
  // Existing-page save authority is resolved from the same trusted snapshot as the visible
  // content. Keep it beside the version and create claim so restoring a draft cannot accidentally
  // authorize against a different page or against lifecycle data fetched later.
  const pageCreatedBy = useRef<string | undefined>(undefined);
  const pageEditingSection = useRef<string | undefined>(undefined);
  const pageStatus = useRef<string | undefined>(undefined);
  const homeCompositionVersion = useRef<1 | 2 | undefined>(undefined);
  const pagePublication = useRef<{
    contentVersion?: number;
    publiclyVisible?: boolean;
    publicSourceVersion?: number;
    publishedSourceVersion?: number;
    publishedElectionBlocks?: AdminBlock[];
    publishBuildPending?: boolean;
    publishBuildQueueId?: string | null;
  }>({});
  // The page-id document was absent when these blocks were loaded. This is kept beside the
  // version because it is the create-side concurrency claim: the save is valid only while the
  // page remains absent (#567). Unlike a stale-version conflict, this claim can never be
  // force-dropped: the editor has not seen the newly created page, so reload is its only safe
  // conflict resolution.
  const expectedAbsent = useRef(false);
  // The template-keyed document these blocks came from, when this page is being split out of
  // the old singleton storage contract. It is part of the same hydration claim as the blocks,
  // version, and expected-absence flag, so drafts preserve it and a successful save clears it.
  const seedFromLegacyPage = useRef<
    { id: SectionId; version?: number } | undefined
  >(undefined);
  // Work in progress on surfaces that are not mounted, keyed by surface (#579). Written from
  // each editor's onDraftChange and read when a surface is selected. A ref, not state: nothing
  // renders it, and the hydration effect has to read the value current when it runs rather than
  // one captured at render.
  const drafts = useRef(new Map<string, Draft>());
  // The clean point held beside each surface's draft (#595): the content that was last loaded or
  // saved. An editor's own clean point does not survive the unmount a surface switch causes, so the
  // host keeps it here, where it does. A draft whose content matches this baseline is not unsaved
  // work -- the content changed and changed back -- so it is dropped at the surface-switch boundary
  // rather than restored stale. Kept in refs for the same reason as `drafts`: nothing renders them,
  // and the compare runs when a surface is selected, not on render.
  const pageBaselines = useRef(new Map<string, AdminBlock[]>());
  // Clean panels lose their drafts after saving, but keep their own claims while a sibling
  // is still dirty. Store those claims by page so navigation cannot borrow the sibling's.
  const pageBaseVersions = useRef(new Map<string, { blocks?: number; metadata?: number }>());
  const recordBaselines = useRef(new Map<string, Record<string, unknown>>());
  // Only addressed reads and server acknowledgments establish an exact preview
  // target. Restored browser drafts and later React props cannot mint receipts.
  const previewReceipts = useRef(new Map<string, SavedEditorReceipt>());
  function rememberPreviewReceipt(value: Surface, version: unknown) {
    const target = value.kind === "page"
      ? editorSaveReceipt("cmsPages", value.pageId, version)
      : value.kind === "record" && recordKindHasPublicRoute(value.record) && value.id
        ? editorSaveReceipt("cmsPosts", value.id, version) : undefined;
    if (target) previewReceipts.current.set(surfaceKey(value), target);
    else previewReceipts.current.delete(surfaceKey(value));
  }
  // Page metadata has its own form and therefore its own draft lifecycle. Keeping it in a
  // parallel map prevents a metadata edit from replacing a block draft (or vice versa) while
  // both still contribute to the one dirty-leave guard.
  const pageMetadataDrafts = useRef(new Map<string, PageMetadataDraft>());
  const [, refreshCanvasMetadata] = useState(0);
  const [, refreshPageSectionCount] = useState(0);
  const pageMetadataBaselines = useRef(
    new Map<string, Record<string, unknown>>(),
  );
  // A readable name per draft key, recorded when the draft is, so an exit can say which work is
  // still unsaved without reverse-engineering a surface out of its key.
  const draftLabels = useRef(new Map<string, string>());
  const pageBlocksEditorRef = useRef<BlockEditorHandle>(null);
  const pageMetadataEditorRef = useRef<RecordFormHandle>(null);
  const recordEditorRef = useRef<RecordFormHandle>(null);
  // Draft existence gives typing an immediate, constant-time dirty signal. Once input pauses,
  // reconcile the active draft against its clean baseline so an edit reverted in place releases
  // its courtesy lease without putting a full rich-text structural walk on every keystroke.
  const activeDraftCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const activeSurfaceRef = useRef(surface);
  activeSurfaceRef.current = surface;
  // The byline picker's feed (#1040), read once for this workspace. A failure is
  // recorded rather than thrown: an editor who cannot see the staff list can still
  // write the story and add custom credits, and the control says why the list is
  // empty instead of looking as though nobody works here.
  const [bylineAuthors, setBylineAuthors] = useState<BylineAuthorOption[]>([]);
  const [bylineSelfAuthorId, setBylineSelfAuthorId] = useState<string | null>(null);
  const [bylineAuthorsUnavailable, setBylineAuthorsUnavailable] = useState(false);
  const [bylineAuthorsLoading, setBylineAuthorsLoading] = useState(Boolean(loadBylineAuthors));
  useEffect(() => {
    if (!loadBylineAuthors) { setBylineAuthorsLoading(false); return; }
    setBylineAuthorsLoading(true);
    let live = true;
    void (async () => {
      // Follow the cursor to the end. The feed pages at 200 rows, and stopping at
      // the first page would silently make everyone past it uncreditable -- the
      // control would show a complete-looking list with people missing from it,
      // which is worse than an error. Newsrooms this size fit in a page or two, so
      // the loop is bounded rather than paged into the control.
      const collected: BylineAuthorOption[] = [];
      let cursor: string | null = null;
      let selfAuthorId: string | null = null;
      // A cursor that never resolves to null is a server fault, not a bigger
      // newsroom. Cap the walk so a bad feed cannot spin here forever.
      for (let page = 0; page < 25; page += 1) {
        const response = await loadBylineAuthors(
          cursor === null ? undefined : { startAfter: cursor },
        );
        if (!live) return;
        collected.push(...response.authors);
        if (page === 0) selfAuthorId = response.selfAuthorId;
        cursor = response.nextCursor;
        if (cursor === null) break;
      }
      // Sorted across pages, not within one: each page arrives sorted by display
      // name, but the cursor walks the staff document id, so concatenating them
      // interleaves the alphabets.
      collected.sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      );
      setBylineAuthors(collected);
      setBylineSelfAuthorId(selfAuthorId);
      setBylineAuthorsUnavailable(false);
    })().catch(() => {
      if (!live) return;
      setBylineAuthorsUnavailable(true);
    }).finally(() => {
      if (live) setBylineAuthorsLoading(false);
    });
    return () => {
      live = false;
    };
  }, [loadBylineAuthors]);
  const canSave = canSaveContent(principal);

  function pageMetadataKey(
    pageSurface: Extract<Surface, { kind: "page" }>,
  ): string {
    return `${surfaceKey(pageSurface)}:metadata`;
  }

  function surfaceHasDraft(value: Surface): boolean {
    const key = surfaceKey(value);
    return (
      drafts.current.has(key) ||
      (value.kind === "page" &&
        pageMetadataDrafts.current.has(pageMetadataKey(value)))
    );
  }

  function refreshDirty() {
    const activeHasDraft = surfaceHasDraft(surface);
    setDirty(drafts.current.size > 0 || pageMetadataDrafts.current.size > 0);
    setActiveSurfaceDirty(activeHasDraft);
    // Every draft write and delete passes through here, and both dirty flags stop changing after
    // the first one. While a displaced snapshot is being kept current, the recovery effects need
    // to hear about each subsequent change, so this signal is raised only in that state rather
    // than adding a render to every keystroke of ordinary editing.
    if (displacementCaptured.current !== null) {
      setDisplacedDraftRevision((revision) => revision + 1);
    }
    if (activeDraftCheckTimer.current !== null) {
      globalThis.clearTimeout(activeDraftCheckTimer.current);
      activeDraftCheckTimer.current = null;
    }
    if (!activeHasDraft) return;

    const checkedSurface = surface;
    activeDraftCheckTimer.current = globalThis.setTimeout(() => {
      activeDraftCheckTimer.current = null;
      if (!isSameSurface(activeSurfaceRef.current, checkedSurface)) return;
      if (checkedSurface.kind === "page") {
        pageDraftFor(checkedSurface);
        pageMetadataDraftFor(checkedSurface);
      } else if (checkedSurface.kind === "record") {
        recordDraftFor(checkedSurface);
      }
      setDirty(drafts.current.size > 0 || pageMetadataDrafts.current.size > 0);
      setActiveSurfaceDirty(surfaceHasDraft(checkedSurface));
    }, ACTIVE_DRAFT_RECONCILE_MS);
  }

  // The surface changes two ways: a rail click in uncontrolled mode (setInternalSurface), or a
  // URL change in controlled mode — including browser back/forward, which never runs
  // selectSurface. Both must move a page's hydration to loading before paint, so the new page's
  // editor is never shown for a frame seeded with the previous page's blocks. Comparing the
  // surface key against the last one rendered catches both paths here (React's supported "adjust
  // state while rendering" pattern), so the click handler no longer resets it. A page this
  // session already edited restores from its draft instead of reading, so it skips loading to
  // avoid flashing a spinner over work that never left memory (#579).
  const activeSurfaceKey = surfaceKey(surface);
  // Document modes follow canonical identity; pane preferences and editor hosts stay mounted.
  const setDocumentIdentity = editorView?.setDocumentIdentity;
  useLayoutEffect(() => { setDocumentIdentity?.(activeSurfaceKey); }, [activeSurfaceKey, setDocumentIdentity]);
  const [renderedSurfaceKey, setRenderedSurfaceKey] =
    useState(activeSurfaceKey);
  if (activeSurfaceKey !== renderedSurfaceKey) {
    if (activeDraftCheckTimer.current !== null) {
      globalThis.clearTimeout(activeDraftCheckTimer.current);
      activeDraftCheckTimer.current = null;
    }
    setRenderedSurfaceKey(activeSurfaceKey);
    setPageUpdateState({ key: "", status: "idle" });
    // These lookups normalize drafts that match their clean baselines by deleting them. Compute
    // dirty state only after that normalization; otherwise a returned-to-clean page claims and
    // heartbeats a courtesy lease merely because the pre-normalized map still had an entry.
    const restoredPageLoad = restoredPageLoadFor(surface);
    const restoringRecord = recordDraftFor(surface) !== undefined;
    setDirty(drafts.current.size > 0 || pageMetadataDrafts.current.size > 0);
    setActiveSurfaceDirty(surfaceHasDraft(surface));
    setPageLoad(
      restoredPageLoad ??
        (surface.kind === "page" && loadPage
          ? { status: "loading" }
          : { status: "idle" }),
    );
    setRecordLoad(
      surface.kind === "record" &&
        surface.id !== null &&
        loadRecord &&
        !restoringRecord
        ? { status: "loading" }
        : { status: "idle" },
    );
  }

  useEffect(() => {
    return () => {
      if (activeDraftCheckTimer.current !== null) {
        globalThis.clearTimeout(activeDraftCheckTimer.current);
      }
    };
  }, []);

  // Page routes already carry their authorization section. A record's route carries only its
  // type, so its section must come from the addressed document after hydration; treating
  // `article` or `program` as an RBAC section would incorrectly deny a news-scoped editor.
  const lockSection =
    surface.kind === "page"
      ? surface.section
      : surface.kind === "record" &&
          recordLoad.status === "ready" &&
          typeof recordLoad.record.section === "string"
        ? recordLoad.record.section
        : undefined;
  const activeEditorLockSurfaceKey = editorLockSurfaceKey(surface);
  // Courtesy presence exists to coordinate writers. A read-only principal can still inspect and
  // locally interact with form controls, but must never reserve content they cannot save.
  const activeEditorLockActor = canSave ? editorLockActor : undefined;
  // `canSave` is only the site-wide floor. The loaded document has its own answer -- a frozen
  // status, someone else's record, a contributor's already-submitted piece -- and reserving a
  // record this person cannot change would hold it against an editor who can (#1047). An
  // automatic claim therefore waits for the read to resolve into a permitted mutation; an
  // explicit takeover is a deliberate act and is not gated here.
  const activeSurfaceMayMutate =
    canSave &&
    (surface.kind === "page"
      ? !loadPage ||
        (pageLoad.status === "ready" &&
          pageSaveDecision(principal, surface.pageId, pageLoad).allowed)
      : surface.kind === "record"
        ? surface.id === null ||
          (recordLoad.status === "ready" &&
            recordSaveDecision(principal, recordLoad.record).allowed)
        : false);
  const editorLock = useEditorLock({
    actor: activeEditorLockActor,
    // With no stored section, can() still authorizes an intentionally unscoped admin grant while
    // denying a section-scoped editor because the resource section cannot be confirmed.
    canTakeOver: can(
      principal,
      "content.edit.any",
      lockSection === undefined ? undefined : { section: lockSection },
    ),
    client: editorLockClient,
    mutable: activeSurfaceMayMutate,
    surfaceKey: activeEditorLockSurfaceKey,
  });
  useEffect(() => {
    if (!editorLock.ownsLock) return;
    return registerAdminPerfEditorLeaseRelease(editorLock.yieldEditor);
  }, [editorLock.ownsLock, editorLock.yieldEditor]);
  // A persisted editor can write only after this tab owns its lease. That closes the frame between
  // the first edit and the effect that starts the claim as well as the transaction's pending
  // window. A failed presence service still fails open after naming the outage; optimistic version
  // checks remain the correctness boundary on every save.
  const editorLockEnabled = Boolean(
    activeEditorLockSurfaceKey && activeEditorLockActor && editorLockClient,
  );
  // An untouched persisted editor normally claims on its first draft. Keep an explicit save
  // available while presence is ready and unblocked too: an absent page seeded from a legacy
  // document (or an intentionally empty new page) has a meaningful create-only save without a
  // local edit. Its save wrapper reserves the lease before it calls the persistence boundary.
  // A tab that handed the record over is deliberately out of the running until the person takes
  // it back, so it must not present a save, lifecycle, history or assignment action that would
  // reclaim the record from whoever was just given it.
  const canClaimEditorOnSave = Boolean(
    editorLockEnabled &&
    !activeSurfaceDirty &&
    editorLock.ready &&
    !editorLock.claiming &&
    !editorLock.yielded &&
    !editorLock.blockingLock,
  );
  const canSaveInActiveEditor =
    canSave &&
    (!editorLockEnabled ||
      editorLock.lockUnavailable ||
      editorLock.ownsLock ||
      canClaimEditorOnSave);
  const editorLockSaveDisabledReason =
    canSave &&
    editorLockEnabled &&
    !editorLock.lockUnavailable &&
    !editorLock.ownsLock
      ? editorLock.yielded
        ? "You handed this record over. Take it back before saving."
        : "Save is disabled until this tab reserves the editor."
      : undefined;
  // A clean tab may claim the lease inside a lifecycle action. Keep the action
  // available long enough to reach reserveEditorForSave; a real blocking lock,
  // an active claim, or an unavailable presence state still supplies the reason.
  const editorLockLifecycleDisabledReason = canClaimEditorOnSave
    ? undefined
    : editorLockSaveDisabledReason;

  async function reserveEditorForSave() {
    if (!editorLockEnabled || editorLock.lockUnavailable || editorLock.ownsLock)
      return;
    if (await editorLock.reserveForSave()) return;
    throw new Error(
      "Another editing session reserved this content before the save began.",
    );
  }

  async function restoreFromHistory(
    collection: SaveCollection,
    id: string,
    revisionId: string,
    baseVersion: number,
  ): Promise<RestoreRevisionResponse> {
    if (!restoreRevision) {
      throw new Error("Revision restore is not connected in this workspace.");
    }
    await reserveEditorForSave();
    return restoreRevision(collection, id, revisionId, baseVersion);
  }
  // Losing the lease to a forced takeover must not cost the displaced person their unsaved work.
  // The draft already survives in this workspace's map for the rest of the visit; this writes the
  // same snapshot to the browser so it also survives a reload, a closed tab, or a crash while the
  // person is deciding what to do (#1047).
  const recoveryStorage = browserEditorWorkStorage();
  const [recoveredWork, setRecoveredWork] = useState<RecoveredEditorWork | null>(null);
  const displacementCaptured = useRef<string | null>(null);
  const workspaceTitleRef = useRef("");
  // Bumped whenever a draft for the active surface is written. `activeSurfaceDirty` is a boolean
  // and stops changing after the first keystroke, so it cannot on its own tell the recovery
  // snapshot that there is newer work to keep.
  const [displacedDraftRevision, setDisplacedDraftRevision] = useState(0);
  const sawDirtySinceMount = useRef(false);

  // The displaced editor stays mounted and its forms stay interactive on purpose: the point of
  // the state is that the person keeps their work and can read it, copy from it, and carry on
  // until they take the record back. Making it genuinely read-only would mean disabling the very
  // draft the banner promises is still there. So the snapshot has to track the draft rather than
  // freeze at the instant of displacement, or a reload would restore a stale copy and lose
  // everything typed afterwards.
  useEffect(() => {
    const actorId = activeEditorLockActor?.id;
    if (
      !recoveryStorage ||
      actorId === undefined ||
      !activeEditorLockSurfaceKey ||
      !editorLock.displacedBy
    ) {
      return;
    }
    const active = activeSurfaceRef.current;
    const draft = drafts.current.get(surfaceKey(active));
    const metadataDraft =
      active.kind === "page"
        ? pageMetadataDrafts.current.get(pageMetadataKey(active))
        : undefined;
    if (!draft && !metadataDraft) return;
    displacementCaptured.current = activeEditorLockSurfaceKey;
    writeRecoveredWork(recoveryStorage, {
      actorId,
      surfaceKey: activeEditorLockSurfaceKey,
      label: workspaceTitleRef.current,
      displacedBy: editorLock.displacedBy,
      savedAtMs: Date.now(),
      // The clean baselines travel with the draft. A page's blocks and its metadata are two
      // drafts over one document, so a snapshot of only one of them would otherwise restore into
      // a mount that has no loaded content behind it and show the page as empty.
      payload: {
        draft,
        metadataDraft,
        blockBaseline:
          active.kind === "page"
            ? pageBaselines.current.get(surfaceKey(active))
            : undefined,
        metadataBaseline:
          active.kind === "page"
            ? pageMetadataBaselines.current.get(pageMetadataKey(active))
            : undefined,
      },
    });
  }, [
    activeEditorLockActor?.id,
    activeEditorLockSurfaceKey,
    activeSurfaceDirty,
    displacedDraftRevision,
    editorLock.displacedBy,
    recoveryStorage,
  ]);

  // Reinstall a displaced snapshot before the hydration effect reads the draft map, so recovered
  // work travels the ordinary draft-restore path rather than a second, divergent one.
  useLayoutEffect(() => {
    const actorId = activeEditorLockActor?.id;
    setRecoveredWork(null);
    displacementCaptured.current = null;
    sawDirtySinceMount.current = false;
    if (!recoveryStorage || actorId === undefined || !activeEditorLockSurfaceKey) return;
    const stored = readRecoveredWork(recoveryStorage, actorId, activeEditorLockSurfaceKey);
    if (!stored) return;
    const payload = stored.payload as {
      draft?: Draft;
      metadataDraft?: PageMetadataDraft;
      blockBaseline?: AdminBlock[];
      metadataBaseline?: Record<string, unknown>;
    } | null;
    const active = activeSurfaceRef.current;
    const key = surfaceKey(active);
    // A live draft for this surface is newer than anything on disk; never overwrite it.
    if (payload?.draft && !drafts.current.has(key)) {
      drafts.current.set(key, payload.draft);
    }
    if (active.kind === "page") {
      const metadataKeyValue = pageMetadataKey(active);
      if (payload?.metadataDraft && !pageMetadataDrafts.current.has(metadataKeyValue)) {
        pageMetadataDrafts.current.set(metadataKeyValue, payload.metadataDraft);
      }
      // Restore the baselines the drafts were written against, so recovering one of the two
      // page drafts does not present the other half of the document as empty.
      if (payload?.blockBaseline && !pageBaselines.current.has(key)) {
        pageBaselines.current.set(key, payload.blockBaseline);
      }
      if (
        payload?.metadataBaseline &&
        !pageMetadataBaselines.current.has(metadataKeyValue)
      ) {
        pageMetadataBaselines.current.set(metadataKeyValue, payload.metadataBaseline);
      }
    }
    // Recovered work is unsaved work. Saying so keeps the editor mounted and the draft visible
    // even while somebody else still holds the record, instead of hiding it behind the
    // read-only message the person is trying to get out from under.
    refreshDirty();
    setRecoveredWork(stored);
  }, [activeEditorLockActor?.id, activeEditorLockSurfaceKey, recoveryStorage]);

  // The snapshot stops being work to recover once the surface has no unsaved draft left. That
  // happens two ways: this tab holds the record and is clean, or a save that was already in
  // flight when somebody took over landed and cleared the draft underneath. Ownership cannot be
  // the only condition, or the second case would leave an obsolete snapshot to be offered later
  // as unsaved work when it is in fact the saved content.
  useEffect(() => {
    const actorId = activeEditorLockActor?.id;
    if (!recoveryStorage || actorId === undefined || !activeEditorLockSurfaceKey) return;
    if (activeSurfaceDirty) {
      sawDirtySinceMount.current = true;
      return;
    }
    // A restored snapshot marks the surface dirty from a layout effect, one commit after this
    // effect first runs. Requiring an observed dirty-to-clean transition keeps that restore from
    // clearing the very snapshot it just reinstated.
    if (!editorLock.ownsLock && !sawDirtySinceMount.current) return;
    clearRecoveredWork(recoveryStorage, actorId, activeEditorLockSurfaceKey);
    displacementCaptured.current = null;
    sawDirtySinceMount.current = false;
    setRecoveredWork(null);
  }, [
    activeEditorLockActor?.id,
    activeEditorLockSurfaceKey,
    activeSurfaceDirty,
    displacedDraftRevision,
    editorLock.ownsLock,
    recoveryStorage,
  ]);

  function discardRecoveredWork() {
    const actorId = activeEditorLockActor?.id;
    if (recoveryStorage && actorId !== undefined && activeEditorLockSurfaceKey) {
      clearRecoveredWork(recoveryStorage, actorId, activeEditorLockSurfaceKey);
    }
    setRecoveredWork(null);
  }

  // A stale lock document must not hide a terminal read result. Lock UI becomes authoritative
  // only after the addressed page or record has loaded into an editable state.
  const editorLockCanGateActiveEditor =
    activeEditorLockSurfaceKey !== null &&
    (surface.kind === "page"
      ? !loadPage || pageLoad.status === "ready"
      : surface.kind === "record" &&
        surface.id !== null &&
        recordLoad.status === "ready");

  // The half-written record held for a surface, if this session has edited one. Seeds the form on
  // mount through `initial`, which already fills any field a partial record omits, so a draft
  // restores into a savable-shaped form the same way a stored record would (#579).
  function recordDraftFor(value: Surface): Record<string, unknown> | undefined {
    if (value.kind !== "record") return undefined;
    const key = surfaceKey(value);
    const draft = drafts.current.get(key);
    if (draft?.kind !== "record") return undefined;
    // A draft that matches the saved or loaded baseline is a taken-back edit, not unsaved work.
    // Drop it so an edit surface re-reads current storage and a create surface opens blank.
    const baseline = recordBaselines.current.get(key);
    if (baseline && recordsEqual(draft.record, baseline)) {
      // Delete the matched draft rather than leaving it clean-but-present, mirroring the page path.
      // The record baseline only advances through a save, which always overwrites the draft first,
      // so a stale draft cannot outlive its baseline here the way a page draft can (#595) -- but
      // keeping the two paths identical forecloses that class of bug and leaves no lingering
      // snapshot behind.
      drafts.current.delete(key);
      return undefined;
    }
    return draft.record;
  }

  // The page draft held for a surface, if this session has edited it (#579). Two places ask this
  // same question and have to agree, so they ask it here rather than each testing the map: the
  // surface-change render restores the draft without a loading frame, and the hydration effect
  // skips the store read. If those two ever disagree the symptom is a spinner flashing over work
  // that never left memory, or a read replacing that work.
  function pageDraftFor(
    surface: Surface,
  ): Extract<Draft, { kind: "page" }> | undefined {
    const key = surfaceKey(surface);
    const draft = drafts.current.get(key);
    if (draft?.kind !== "page") return undefined;
    // A draft whose blocks match the clean baseline is a reverted edit, not unsaved work (a block
    // added and undone, a word typed and deleted). Re-read instead of restoring the stale snapshot,
    // so a change someone else saved meanwhile becomes visible rather than staying hidden until a
    // save is refused (#595). The compare runs here, at the surface-switch boundary, not per
    // keystroke. Without a baseline (never loaded) the draft stands, matching the prior behavior.
    const baseline = pageBaselines.current.get(key);
    if (baseline && blocksEqual(draft.blocks, baseline)) {
      // Delete the matched draft, not just report it clean. The re-read this triggers can return
      // newer server content, which advances the baseline. A surviving draft would then no longer
      // match that newer baseline, so the next visit would restore this stale snapshot as unsaved
      // work -- hiding the current page and setting up an overwrite. Dropping it makes the clean
      // match final and the next visit read again (#595).
      drafts.current.delete(key);
      return undefined;
    }
    return draft;
  }

  function pageMetadataDraftFor(value: Surface): PageMetadataDraft | undefined {
    if (value.kind !== "page") return undefined;
    const key = pageMetadataKey(value);
    const draft = pageMetadataDrafts.current.get(key);
    if (!draft) return undefined;
    const baseline = pageMetadataBaselines.current.get(key);
    if (baseline && recordsEqual(draft.metadata, baseline)) {
      pageMetadataDrafts.current.delete(key);
      return undefined;
    }
    return draft;
  }

  // Project a page's in-memory block and metadata drafts into the same ready state a store read
  // produces. The surface-change render and the hydration effect both use this boundary: the
  // render must mount the restored editor immediately so `idle` cannot flash the loading fallback
  // before the passive effect runs (#601), while the effect remains the owner of re-reading pages
  // that have no draft. Restore the concurrency claim at the same time as the visible content so
  // even an interaction before the effect runs cannot save with a previous page's version.
  function restoredPageLoadFor(
    value: Surface,
  ): Extract<PageLoad, { status: "ready" }> | undefined {
    if (value.kind !== "page") return undefined;
    const blockDraft = pageDraftFor(value);
    const metadataDraft = pageMetadataDraftFor(value);
    if (!blockDraft && !metadataDraft) return undefined;

    // A draft keeps its own claim, including an absent version. A clean panel keeps the claim
    // recorded at its last read or save. Only recovery without an in-memory claim falls back
    // to the sibling's snapshot; an absent recorded version must not borrow a newer claim.
    const baseVersions = pageBaseVersions.current.get(surfaceKey(value));
    blockBaseVersion.current = blockDraft
      ? blockDraft.version
      : baseVersions ? baseVersions.blocks : metadataDraft?.version;
    metadataBaseVersion.current = metadataDraft
      ? metadataDraft.version
      : baseVersions ? baseVersions.metadata : blockDraft?.version;
    const claim = blockDraft ?? metadataDraft;
    pageCreatedBy.current = claim?.createdBy;
    pageEditingSection.current = claim?.editingSection;
    pageStatus.current = claim?.pageStatus;
    homeCompositionVersion.current = claim?.homeCompositionVersion;
    pagePublication.current = {
      publishedElectionBlocks: claim?.publishedElectionBlocks,
      contentVersion: claim?.contentVersion,
      publiclyVisible: claim?.publiclyVisible,
      publicSourceVersion: claim?.publicSourceVersion,
      publishedSourceVersion: claim?.publishedSourceVersion,
      publishBuildPending: claim?.publishBuildPending,
      publishBuildQueueId: claim?.publishBuildQueueId,
    };
    expectedAbsent.current = claim?.expectedAbsent === true;
    seedFromLegacyPage.current = claim?.seedFromLegacyPage;

    return {
      status: "ready",
      blocks:
        blockDraft?.blocks ??
        pageBaselines.current.get(surfaceKey(value)) ??
        [],
      metadata: metadataDraft?.metadata ??
        pageMetadataBaselines.current.get(pageMetadataKey(value)) ?? {
          title: publicPage(value.pageId)?.title ?? value.pageId,
        },
      createdBy: claim?.createdBy,
      editingSection: claim?.editingSection,
      homeCompositionVersion: claim?.homeCompositionVersion,
      pageStatus: claim?.pageStatus,
      ...pagePublication.current,
      expectedAbsent: claim?.expectedAbsent === true,
    };
  }

  // Take a page editor's report of what it holds. Blocks mean unsaved work to keep; `null`
  // means a save landed with nothing in flight, so the page is clean and the draft has to go --
  // otherwise the next visit would restore this snapshot instead of reading, and quietly hide
  // a change someone else made after the save (#579).
  function trackPageDraft(
    pageSurface: Extract<Surface, { kind: "page" }>,
    blocks: AdminBlock[] | null,
  ) {
    const key = surfaceKey(pageSurface);
    const previousDraft = drafts.current.get(key);
    const savedBlocks = pageBaselines.current.get(key) ?? [];
    const previousBlocks = previousDraft?.kind === "page" ? previousDraft.blocks : savedBlocks;
    if (blocks === null) {
      drafts.current.delete(key);
      draftLabels.current.delete(key);
    } else {
      draftLabels.current.set(key, labelForSurface(pageSurface));
      setPageUpdateState((current) =>
        current.key === key && current.status === "idle"
          ? current
          : { key, status: "idle" },
      );
      drafts.current.set(key, {
        kind: "page",
        blocks,
        homeCompositionVersion: homeCompositionVersion.current,
        createdBy: pageCreatedBy.current,
        editingSection: pageEditingSection.current,
        pageStatus: pageStatus.current,
        ...pagePublication.current,
        version: blockBaseVersion.current,
        expectedAbsent: expectedAbsent.current,
        seedFromLegacyPage: seedFromLegacyPage.current,
      });
    }
    refreshDirty();
    // Drafts live in refs. Refresh the summary only when membership changes;
    // typing within a section must not rerender the workspace on each keystroke.
    if (editorSectionCount(previousBlocks, pageSurface.pageId) !== editorSectionCount(blocks ?? savedBlocks, pageSurface.pageId)) {
      refreshPageSectionCount(value => value + 1);
    }
  }

  function trackPageMetadataDraft(
    pageSurface: Extract<Surface, { kind: "page" }>,
    metadata: Record<string, unknown> | null,
  ) {
    const key = pageMetadataKey(pageSurface);
    const previousMetadata = pageMetadataDrafts.current.get(key)?.metadata;
    // Render the canonical draft map, not a second copy that could survive reload.
    if (metadata === null || metadata.title !== previousMetadata?.title || metadata.description !== previousMetadata?.description) {
      refreshCanvasMetadata(value => value + 1);
    }
    if (metadata === null) {
      pageMetadataDrafts.current.delete(key);
      draftLabels.current.delete(key);
    } else {
      draftLabels.current.set(key, labelForSurface(pageSurface));
      const pageKey = surfaceKey(pageSurface);
      setPageUpdateState((current) =>
        current.key === pageKey && current.status === "idle"
          ? current
          : { key: pageKey, status: "idle" },
      );
      pageMetadataDrafts.current.set(key, {
        metadata,
        homeCompositionVersion: homeCompositionVersion.current,
        createdBy: pageCreatedBy.current,
        editingSection: pageEditingSection.current,
        pageStatus: pageStatus.current,
        ...pagePublication.current,
        version: metadataBaseVersion.current,
        expectedAbsent: expectedAbsent.current,
        seedFromLegacyPage: seedFromLegacyPage.current,
      });
    }
    refreshDirty();
  }

  function advancePageAfterSave(
    pageSurface: Extract<Surface, { kind: "page" }>,
    saved: PageContent,
    savedEditor: "blocks" | "metadata",
    forced: boolean,
  ) {
    const { version } = saved;
    rememberPreviewReceipt(pageSurface, version);
    // The ordinary editor's claim before it adopts the returned version. Legacy
    // documents explicitly claim zero. A reviewed recovery instead claims the fresh
    // version read by ContentTab, so its old local claim cannot prove sibling currency.
    const claimedVersion =
      savedEditor === "blocks"
        ? blockBaseVersion.current
        : metadataBaseVersion.current;
    const provenCreate = expectedAbsent.current;
    // An ordinary save proves currency for a sibling with the same exact claim,
    // including zero: the server refused unless that claim matched stored content.
    // Reviewed recovery does not prove a stale sibling's draft was current, so it
    // never advances that sibling. A create proves absence through createOnly.
    const siblingVersion = savedEditor === "blocks"
      ? metadataBaseVersion.current : blockBaseVersion.current;
    const provedPageCurrency = !forced && (provenCreate ||
      (claimedVersion !== undefined && claimedVersion === siblingVersion));

    if (savedEditor === "blocks") blockBaseVersion.current = version;
    else metadataBaseVersion.current = version;
    // A sequence may share a receipt when its panels started with the same claim (including
    // an initial legacy load). Starting a later sequence must not clear an already-unclaimed
    // sibling's conflict merely because the first panel saved again.
    if (pageSaveSequence.current &&
        (claimedVersion === siblingVersion || pageSaveSequence.current.version !== undefined)) {
      pageSaveSequence.current.version = version;
    }

    if (provedPageCurrency) {
      blockBaseVersion.current = version;
      metadataBaseVersion.current = version;
    }
    pageBaseVersions.current.set(surfaceKey(pageSurface), {
      blocks: blockBaseVersion.current,
      metadata: metadataBaseVersion.current,
    });
    pageCreatedBy.current = saved.createdBy;
    pageEditingSection.current = saved.editingSection;
    pageStatus.current = saved.status;
    homeCompositionVersion.current = saved.homeCompositionVersion;
    pagePublication.current = {
      publishedElectionBlocks: saved.publishedElectionBlocks ?? pagePublication.current.publishedElectionBlocks,
      contentVersion: saved.contentVersion ?? pagePublication.current.contentVersion,
      publiclyVisible:
        saved.publiclyVisible ?? pagePublication.current.publiclyVisible,
      publicSourceVersion:
        saved.publicSourceVersion ?? pagePublication.current.publicSourceVersion,
      publishedSourceVersion:
        saved.publishedSourceVersion ??
        pagePublication.current.publishedSourceVersion,
      publishBuildPending:
        saved.publishBuildPending ?? pagePublication.current.publishBuildPending,
      publishBuildQueueId:
        saved.publishBuildQueueId !== undefined
          ? saved.publishBuildQueueId
          : pagePublication.current.publishBuildQueueId,
    };
    expectedAbsent.current = false;
    seedFromLegacyPage.current = undefined;

    // A create changes the authorization question from content.create to edit-own/edit-any. Adopt
    // the server's returned owner and lifecycle immediately so a second save in this session is
    // gated against the newly stored page rather than the page's former absence.
    setPageLoad((current) =>
      current.status === "ready"
        ? {
            ...current,
            // Save only advances the fields this editor wrote. A sibling block
            // save must not replace metadata with a stale or omitted value.
            ...(savedEditor === "metadata" && saved.metadata
              ? { metadata: saved.metadata }
              : {}),
            createdBy: saved.createdBy,
            editingSection: saved.editingSection,
            homeCompositionVersion: saved.homeCompositionVersion,
            pageStatus: saved.status,
            ...pagePublication.current,
            expectedAbsent: false,
          }
        : current,
    );

    const blockKey = surfaceKey(pageSurface);
    const blockDraft = drafts.current.get(blockKey);
    if (blockDraft?.kind === "page") {
      drafts.current.set(blockKey, {
        ...blockDraft,
        homeCompositionVersion: saved.homeCompositionVersion,
        ...(savedEditor === "blocks" || provedPageCurrency
          ? { version }
          : {}),
        createdBy: saved.createdBy,
        editingSection: saved.editingSection,
        pageStatus: saved.status,
        ...pagePublication.current,
        expectedAbsent: false,
        seedFromLegacyPage: undefined,
      });
    }
    const metadataKey = pageMetadataKey(pageSurface);
    const metadataDraft = pageMetadataDrafts.current.get(metadataKey);
    if (metadataDraft) {
      pageMetadataDrafts.current.set(metadataKey, {
        ...metadataDraft,
        homeCompositionVersion: saved.homeCompositionVersion,
        ...(savedEditor === "metadata" || provedPageCurrency
          ? { version }
          : {}),
        createdBy: saved.createdBy,
        editingSection: saved.editingSection,
        pageStatus: saved.status,
        ...pagePublication.current,
        expectedAbsent: false,
        seedFromLegacyPage: undefined,
      });
    }
    setPageSaveRevision((revision) => revision + 1);
  }

  function pageSaveBaseVersion(editor: "blocks" | "metadata", forced: boolean) {
    if (forced) return undefined;
    const ownVersion = editor === "blocks" ? blockBaseVersion.current : metadataBaseVersion.current;
    const siblingVersion = editor === "blocks" ? metadataBaseVersion.current : blockBaseVersion.current;
    const version = ownVersion ?? pageSaveSequence.current?.version;
    // Once the other panel has saved, an unclaimed independent draft needs the same
    // explicit review choice as a stale versioned draft; it cannot borrow the sibling's claim.
    if (version === undefined && siblingVersion !== undefined) {
      throw new HttpError(409, "Reload this page before saving changes composed without a version.");
    }
    return version;
  }

  // The same for a record form. `null` means a save settled it, so the draft has to go: a record
  // is seeded straight from its draft, so keeping a saved one would hand the next mount a record
  // that already has an id, and the save after that would update that document instead of
  // creating the new one (#579).
  function trackRecordDraft(
    value: Extract<Surface, { kind: "record" }>,
    next: Record<string, unknown> | null,
  ) {
    const key = surfaceKey(value);
    if (next === null) {
      drafts.current.delete(key);
      draftLabels.current.delete(key);
    } else {
      draftLabels.current.set(key, labelForSurface(value));
      drafts.current.set(key, { kind: "record", record: next });
    }
    refreshDirty();
  }

  // Whether any held draft still differs from its clean point, answered by value.
  //
  // `dirty` above is the cheap half: a draft exists. The block reducer hands back a new array for
  // every op, so an edit typed and then undone initially leaves a draft behind. The short idle
  // reconciliation above removes that clean draft for lease accuracy without putting a structural
  // walk on every keystroke; this boundary probe remains the synchronous answer for navigation.
  //
  // This is that boundary answer. The host calls it when a navigation is about to be held or the
  // document is about to unload -- once, at a moment where a structural walk costs nothing anyone
  // can feel -- so the guard asks about work that is actually still there. A page with no baseline
  // has not been read yet and a record with none has never been saved; neither has a clean point to
  // have returned to, so a draft against no baseline is genuinely unsaved work.
  function hasUnsavedWork(): boolean {
    return mediaPickerDirtyRef.current || unsavedDraftKeys().length > 0;
  }

  function hasElectionSourceUnsavedWork(): boolean {
    const target = activeSurfaceRef.current;
    const keys = new Set([surfaceKey(target), ...(target.kind === "page" ? [pageMetadataKey(target)] : [])]);
    return mediaPickerDirtyRef.current || unsavedDraftKeys().some(key => keys.has(key));
  }

  // The same walk, reporting which drafts are outstanding rather than only whether any is. An
  // exit that offers to save needs the list: only the mounted surface can be committed, so the
  // rest have to be named rather than silently dropped (#1032).
  function unsavedDraftKeys(): string[] {
    const keys: string[] = [];
    for (const [key, draft] of drafts.current) {
      if (draft.kind === "page") {
        const baseline = pageBaselines.current.get(key);
        if (!baseline || !blocksEqual(draft.blocks, baseline)) keys.push(key);
      } else {
        const baseline = recordBaselines.current.get(key);
        if (!baseline || !recordsEqual(draft.record, baseline)) keys.push(key);
      }
    }
    for (const [key, draft] of pageMetadataDrafts.current) {
      const baseline = pageMetadataBaselines.current.get(key);
      if (!baseline || !recordsEqual(draft.metadata, baseline)) keys.push(key);
    }
    return keys;
  }

  // The readable names behind those keys, minus the surface named by `except` (the one the exit
  // just saved) and minus duplicates, since a page holds a block draft and a metadata draft under
  // two keys but is one thing to a person. A key with no recorded label is skipped rather than
  // shown raw: the sentence stays true either way, and its fallback wording covers the case.
  function unsavedItemLabels(except?: Surface): string[] {
    const excluded = new Set(
      except
        ? [
            surfaceKey(except),
            ...(except.kind === "page" ? [pageMetadataKey(except)] : []),
          ]
        : [],
    );
    const labels: string[] = [];
    for (const key of unsavedDraftKeys()) {
      if (excluded.has(key)) continue;
      const label = draftLabels.current.get(key);
      if (label && !labels.includes(label)) labels.push(label);
    }
    return labels;
  }

  // Save every unsaved panel of one page surface, and answer both questions its callers ask.
  // The Save draft control, an exit that chose to save first (#1032), and the preview gate (#1042)
  // all come through here, so the page's definition of a completed save is written once:
  // composition, then metadata.
  //
  // `landed` is whether the stored page now holds this work. `allCurrent` is the stricter answer
  // — whether nothing is left dirty afterward — and an edit made while the save was in flight
  // separates the two: the request succeeded, so the stored revision advanced, but the editor is
  // unsaved again. An exit needs the strict answer, because leaving would lose that later edit.
  // The preview needs the other one: it builds the stored revision, never the editor's live
  // state, so a save that reached the store is exactly what it was waiting for.
  type PageSaveCapture = { token: object; blocks?: CapturedEditorSave; metadata?: CapturedEditorSave };
  const previewPageCapture = useRef<PageSaveCapture>();
  const runPageSave = useSaveFlight<{
    landed: boolean; allCurrent: boolean; receipt?: SavedEditorReceipt; capture?: object;
  }>(surfaceKey(surface));
  function savePageSurface(pageSurface: Extract<Surface, { kind: "page" }>, capture?: PageSaveCapture): Promise<{
    landed: boolean; allCurrent: boolean; receipt?: SavedEditorReceipt; capture?: object;
  }> {
    // Stale callbacks cannot join another document's operation.
    if (surfaceKey(activeSurfaceRef.current) !== surfaceKey(pageSurface)) {
      return Promise.resolve({ landed: false, allCurrent: false });
    }
    return runPageSave(() => persistPageSurface(pageSurface, capture));
  }

  async function persistPageSurface(
    pageSurface: Extract<Surface, { kind: "page" }>,
    capture?: PageSaveCapture,
  ): Promise<{ landed: boolean; allCurrent: boolean; receipt?: SavedEditorReceipt; capture?: object }> {
    const pageKey = surfaceKey(pageSurface);
    const blockDraft = drafts.current.get(pageKey);
    const blocksDirty = capture ? !!capture.blocks : blockDraft?.kind === "page";
    const metadataDirty = capture ? !!capture.metadata : pageMetadataDrafts.current.has(
      pageMetadataKey(pageSurface),
    );
    // Repeated calls already joined the page flight. Keep the unrelated-operation gate
    // below; a lifecycle/assignment/restore operation is not an equivalent content save.
    if (!blocksDirty && !metadataDirty)
      return { landed: true, allCurrent: true };
    const firstPanelSource = blocksDirty ? "page-blocks" : "page-metadata";
    const joinsFirstPanel = capture && [...savingSources].every(source => source === firstPanelSource);
    if (saving && !joinsFirstPanel) return { landed: false, allCurrent: false };

    setPageUpdateState({ key: pageKey, status: "saving" });
    reportingValidationRevealed.current = false;
    setSavingSource("page-update", true);
    pageSaveSequence.current = { id: crypto.randomUUID(), blocks: blocksDirty, metadata: metadataDirty };
    // The save transaction: from the moment the editor starts committing this page until
    // every panel it owns has landed. Wider than one request on purpose -- composition and
    // metadata are separate authorized writes -- so the receipt can separate save time from
    // the transport time of each call inside it (#1064). Category only; no page identity.
    const saveTransaction = adminPerf.begin("save", {
      route: "content",
      operation: "content-write",
    });
    // Each panel answers both questions (#1042). A write that reached the store lets the sequence
    // continue and lets the preview build, even when typing during the save has already made the
    // editor dirty again; only a refused or failed write stops it and names the panel to fix.
    let landedAll = true;
    let receipt: SavedEditorReceipt | undefined;
    let cleanAll = true;
    let blockToken: object | undefined;
    let metadataToken: object | undefined;
    let failedPanel: "content" | "metadata" | undefined;
    try {
      if (blocksDirty) {
        const outcome = await (capture ? capture.blocks?.save() : pageBlocksEditorRef.current?.save());
        blockToken = outcome?.capture;
        landedAll = outcome?.landed === true;
        cleanAll = outcome?.clean === true;
        receipt = outcome?.receipt;
        if (!landedAll) failedPanel = "content";
      }
      if (landedAll && metadataDirty) {
        const outcome = await (capture ? capture.metadata?.save() : pageMetadataEditorRef.current?.save());
        metadataToken = outcome?.capture;
        landedAll = outcome?.landed === true;
        cleanAll = cleanAll && outcome?.clean === true;
        // Metadata is the last write in this sequence; an earlier block receipt does
        // not describe the complete acknowledged page if this write has no receipt.
        receipt = outcome?.receipt;
        if (!landedAll) failedPanel = "metadata";
      }
      const blocksRemainDirty = drafts.current.get(pageKey)?.kind === "page";
      const metadataRemainsDirty = pageMetadataDrafts.current.has(
        pageMetadataKey(pageSurface),
      );
      const allCurrent =
        landedAll && cleanAll && !blocksRemainDirty && !metadataRemainsDirty;
      if (failedPanel && !reportingValidationRevealed.current) {
        revealBentoPanel(failedPanel);
      }
      setPageUpdateState({
        key: pageKey,
        status: failedPanel ? "error" : allCurrent ? "saved" : "idle",
        message:
          failedPanel === "content"
            ? "Save did not finish. Review Page content."
            : failedPanel === "metadata"
              ? "Save did not finish. Review Page metadata."
              : undefined,
      });
      if (allCurrent) successNotice.show("Draft saved.");
      saveTransaction.end({ outcome: landedAll ? "ok" : "error" });
      const target = capture ?? previewPageCapture.current;
      const capturedAll = target && (!target.blocks || blockToken === target.blocks.token) &&
        (!target.metadata || metadataToken === target.metadata.token);
      return { landed: landedAll, allCurrent,
        ...(capturedAll ? { capture: target.token } : {}),
        ...(landedAll && receipt ? { receipt } : {}) };
    } finally {
      pageSaveSequence.current = undefined;
      // A save that threw still closes its own measure, so a failure is timed rather than
      // silently dropped from the receipt.
      saveTransaction.end({ outcome: "error" });
      setSavingSource("page-update", false);
    }
  }

  const previewPageSaver = useRef((active: Extract<Surface, { kind: "page" }>, capture: PageSaveCapture) =>
    savePageSurface(active, capture));
  previewPageSaver.current = (active, capture) => savePageSurface(active, capture);
  const previewCanSave = useRef(canSaveInActiveEditor);
  previewCanSave.current = canSaveInActiveEditor;

  async function preparePreview(signal: AbortSignal): Promise<SavedEditorReceipt> {
    const active = activeSurfaceRef.current;
    const key = surfaceKey(active);
    const stillHere = () => {
      if (signal.aborted || surfaceKey(activeSurfaceRef.current) !== key) throw new Error("Preview was canceled");
      if (mediaPickerDirtyRef.current) throw new Error("Media changes are still being edited");
    };
    stillHere();
    const dirtyKeys = unsavedDraftKeys();
    const needsSave = dirtyKeys.includes(key) || (active.kind === "page" && dirtyKeys.includes(pageMetadataKey(active)));
    let receipt = previewReceipts.current.get(key);
    if (!needsSave) {
      if (!receipt) throw new Error("The editor has no trusted preview target");
      return receipt;
    }
    if (!previewCanSave.current) throw new Error("Saving is not available");
    // Capture before the first await. Each existing save owner retains this draft
    // and adopts only server version/ID fields while an older save finishes.
    const pageCapture: PageSaveCapture | undefined = active.kind === "page" ? {
      token: {},
      // Include panels an older sequence will write even if they were reverted
      // to their baseline before this click. That sequence can still save them.
      blocks: dirtyKeys.includes(key) || pageSaveSequence.current?.blocks
        ? pageBlocksEditorRef.current?.captureSave() : undefined,
      metadata: dirtyKeys.includes(pageMetadataKey(active)) || pageSaveSequence.current?.metadata
        ? pageMetadataEditorRef.current?.captureSave() : undefined,
    } : undefined;
    const recordCapture = active.kind === "record" && recordKindHasPublicRoute(active.record)
      ? recordEditorRef.current?.captureSave() : undefined;
    if (pageCapture) previewPageCapture.current = pageCapture;
    const token = pageCapture?.token ?? recordCapture?.token;
    try {
      for (let pass = 0; pass < 2; pass++) {
        stillHere();
        if (!previewCanSave.current) throw new Error("Saving is not available");
        const outcome = active.kind === "page" && pageCapture
          ? await previewPageSaver.current(active, pageCapture)
          : await recordCapture?.save();
        stillHere();
        if (!outcome?.landed || !outcome.receipt) throw new Error("No acknowledged preview target");
        receipt = outcome.receipt;
        if (token && outcome.capture === token) return receipt;
        // The first call can join an older save. The second submits the captured
        // draft, never the live content typed after Preview was selected.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      throw new Error("The captured preview draft was not saved");
    } finally {
      if (previewPageCapture.current === pageCapture) previewPageCapture.current = undefined;
      pageCapture?.blocks?.dispose();
      pageCapture?.metadata?.dispose();
      recordCapture?.dispose();
    }
  }

  // The save an exit asks for: commit whatever the surface the person is on still holds, then
  // report honestly on everything else.
  //
  // Only the mounted surface has an editor, and an editor is where the save boundary lives --
  // structure, required fields, and the block-model parse all run inside it. A retained draft for
  // a surface that is not mounted therefore cannot be committed from here without sending
  // unvalidated content past that boundary, which is a worse failure than the one being fixed. So
  // the exit saves what it can and refuses to call the result "saved" while other work from this
  // session is still only in the browser; the dialog names what is left (#1032).
  async function saveActiveSurface(): Promise<ExitSaveOutcome> {
    // The picker queue must be finished or explicitly discarded inside its own flow. A document
    // save cannot commit upload metadata, so never report a host-level "Save and leave" as safe
    // while that transient work remains.
    if (mediaPickerDirtyRef.current) return { status: "failed" };
    const active = activeSurfaceRef.current;
    let landed: boolean;
    if (active.kind === "page") {
      landed = (await savePageSurface(active)).allCurrent;
    } else if (active.kind === "record") {
      landed =
        (await recordEditorRef.current?.save())?.clean === true &&
        !drafts.current.has(surfaceKey(active));
    } else {
      // A list or library surface mounts no editor, so there is nothing here to commit.
      landed = true;
    }
    if (!landed) return { status: "failed" };

    const elsewhere = unsavedItemLabels(active);
    if (hasUnsavedWork() && (elsewhere.length > 0 || unsavedDraftKeys().length > 0)) {
      return { status: "unsaved-elsewhere", items: elsewhere };
    }
    return { status: "saved" };
  }

  const autosaveDraft = surface.kind === "page"
    ? pageLoad.status === "ready" && (pageLoad.expectedAbsent || pageLoad.pageStatus === "draft")
    : surface.kind === "record" && surface.record === "post" &&
      (surface.id === null || (recordLoad.status === "ready" && recordLoad.record.status === "draft"));
  const autosave = useDraftAutosave({
    identity: surfaceKey(surface),
    enabled: autoSaveEnabled && autosaveDraft && canSaveInActiveEditor && !restoring && !changingLifecycle,
    savedVersion: surface.kind === "page"
      ? Math.max(blockBaseVersion.current ?? 0, metadataBaseVersion.current ?? 0)
      : recordLoad.status === "ready" && typeof recordLoad.record.version === "number"
        ? recordLoad.record.version : undefined,
    saving,
    draftKey: () => {
      if (mediaPickerDirtyRef.current) return null;
      const active = activeSurfaceRef.current;
      const key = surfaceKey(active);
      const metadataKey = active.kind === "page" ? pageMetadataKey(active) : null;
      if (!unsavedDraftKeys().some(item => item === key || item === metadataKey)) return null;
      return JSON.stringify([drafts.current.get(key), metadataKey ? pageMetadataDrafts.current.get(metadataKey) : null]);
    },
    save: async () => {
      const active = activeSurfaceRef.current;
      if (active.kind === "page") return (await savePageSurface(active)).landed;
      return (await recordEditorRef.current?.save())?.landed === true;
    },
  });

  // Published beside the probe below, and for the same reason: the host calls it at the exact
  // moment it is holding an exit. Cleared on unmount, so a workspace that is gone never reports
  // a save for work nobody is doing.
  useEffect(() => {
    if (!saveRequestRef) return;
    saveRequestRef.current = saveActiveSurface;
    return () => {
      saveRequestRef.current = null;
    };
  });

  // Published to the host as a ref rather than a prop callback so the host can ask the question at
  // the instant it needs it. The probe closes over the draft and baseline maps, which are refs, so
  // one assignment stays current for the editor's whole life. Cleared on unmount: an editor that is
  // gone holds no work, and a stale probe would answer for a page nobody is editing.
  useEffect(() => {
    if (!unsavedProbeRef) return;
    unsavedProbeRef.current = hasUnsavedWork;
    return () => {
      unsavedProbeRef.current = null;
    };
  });

  // Isolated component renders (tests and the development gallery) have no router-owned surface,
  // so they retain a compact picker. The shipped ContentLayout always supplies controlledSurface;
  // its destinations live exclusively in the shell's primary hierarchy.
  function selectIsolatedSurface(nextSurface: Surface) {
    if (saving || isSameSurface(surface, nextSurface)) return;
    setInternalSurface(nextSurface);
  }

  // Read the current page again. Two callers ask for this and they must not drift apart: the
  // conflict banner's reload, and the retry offered when a read failed (#574).
  //
  // Loading is set here rather than left to the effect, for the same reason selectSurface does
  // it: the effect is passive, so the render in between would still show whatever was on
  // screen -- a ready editor, or a stale failure the person just asked to clear.
  //
  // Dropping the draft first is what makes this a reload at all (#579). Both callers are asking
  // to go back to the store: the conflict banner's button says "discarding your changes" in so
  // many words, and the retry has nothing worth keeping. Leave the draft in place and the
  // hydration effect restores it instead of reading, so the discard button would quietly do
  // nothing -- the one thing a person who just chose to lose their work must be able to trust.
  function reloadPage() {
    drafts.current.delete(surfaceKey(surface));
    if (surface.kind === "page") {
      pageMetadataDrafts.current.delete(pageMetadataKey(surface));
    }
    refreshDirty();
    setPageLoad({ status: "loading" });
    setReloadCount((count) => count + 1);
  }

  function reloadPageForPreview() {
    if (surface.kind !== "page") return;
    setPreviewAfterReload(surface.pageId);
    reloadPage();
  }

  // Discard the addressed record's local draft and re-read that exact immutable id. Used by
  // both a failed-read retry and the non-destructive side of the version-conflict choice.
  function reloadRecord() {
    if (surface.kind !== "record" || surface.id === null) return;
    drafts.current.delete(surfaceKey(surface));
    refreshDirty();
    setRecordLoad({ status: "loading" });
    setRecordReloadCount((count) => count + 1);
  }

  // Hydrate the selected page from its stored blocks, or restore the draft if this session has
  // already edited it. Runs on every page selection and on an explicit reload. A save changes
  // neither, so it never re-runs mid-edit. A stale resolution from a page the user already
  // switched away from is dropped.
  //
  // This is also the only place the echoed version is written, which is deliberate: it is a
  // claim about what the person can see, so it has to be set from the same read that seeds the
  // editor. Clearing it before the read means a load that fails or resolves late can never
  // leave a version from the previous page attached to this one's blocks.
  useEffect(() => {
    if (surface.kind !== "page" || !loadPage) return;
    let cancelled = false;
    const { pageId, section } = surface;
    // A page this session has already edited comes back from the draft rather than the store
    // (#579). Re-reading would replace the person's unsaved blocks with the stored ones, which
    // is the same loss the read is meant to prevent, only through the front door. The draft
    // carries the version it was composed against, so the restored blocks still echo the base
    // the person actually saw and the conflict guard still holds (#530). An untouched page has
    // no draft and reads normally, so someone else's change is still visible on return.
    const restoredPageLoad = restoredPageLoadFor(surface);
    if (restoredPageLoad) {
      setPageLoad(restoredPageLoad);
      return;
    }
    previewReceipts.current.delete(surfaceKey(surface));
    blockBaseVersion.current = undefined;
    metadataBaseVersion.current = undefined;
    pageCreatedBy.current = undefined;
    pageEditingSection.current = undefined;
    pageStatus.current = undefined;
    homeCompositionVersion.current = undefined;
    pagePublication.current = {};
    expectedAbsent.current = false;
    seedFromLegacyPage.current = undefined;
    setPageLoad({ status: "loading" });
    loadPage(pageId, section)
      .then(
        ({
          blocks,
          homeCompositionVersion: loadedHomeCompositionVersion,
          publishedElectionBlocks: loadedPublishedElectionBlocks,
          electionResultsApprovals: loadedElectionResultsApprovals,
          metadata: loadedMetadata,
          createdBy: loadedCreatedBy,
          editingSection: loadedEditingSection,
          status: loadedStatus,
          publishAt: loadedPublishAt,
          version,
          scheduledPublishFailure: loadedScheduledPublishFailure,
          contentVersion: loadedContentVersion,
          publiclyVisible: loadedPubliclyVisible,
          publicSourceVersion: loadedPublicSourceVersion,
          publishedSourceVersion: loadedPublishedSourceVersion,
          publishBuildPending: loadedPublishBuildPending,
          publishBuildQueueId: loadedPublishBuildQueueId,
          expectedAbsent: loadedExpectedAbsent,
          seedFromLegacyPage: loadedLegacySeed,
        }) => {
          if (!cancelled) {
            blockBaseVersion.current = version;
            metadataBaseVersion.current = version;
            pageCreatedBy.current = loadedCreatedBy;
            pageEditingSection.current = loadedEditingSection;
            pageStatus.current = loadedStatus;
            homeCompositionVersion.current = loadedHomeCompositionVersion;
            pagePublication.current = {
              publishedElectionBlocks: loadedPublishedElectionBlocks,
              contentVersion: loadedContentVersion ?? version,
              publiclyVisible: loadedPubliclyVisible,
              publicSourceVersion: loadedPublicSourceVersion,
              publishedSourceVersion: loadedPublishedSourceVersion,
              publishBuildPending: loadedPublishBuildPending,
              publishBuildQueueId: loadedPublishBuildQueueId,
            };
            expectedAbsent.current = loadedExpectedAbsent === true;
            seedFromLegacyPage.current = loadedLegacySeed;
            // The store read is a clean point: record it so a later reverted edit compares against
            // what was loaded and is recognized as clean (#595).
            const addressedSurface: Extract<Surface, { kind: "page" }> = {
              kind: "page",
              pageId,
              section,
            };
            rememberPreviewReceipt(addressedSurface, loadedExpectedAbsent ? undefined : version);
            pageBaseVersions.current.set(surfaceKey(addressedSurface), {
              blocks: version,
              metadata: version,
            });
            const metadata = loadedMetadata ?? {
              title: publicPage(pageId)?.title ?? pageId,
            };
            // Store and mount the same canonical seed. The block editor normalizes finite
            // headline levels to the shared renderer's displayed value, so keeping the raw
            // stored list here would make a later fully reverted edit compare permanently
            // dirty and restore a stale draft instead of re-reading (#525/#595).
            const editorBlocks = normalizeLoadedEditorBlocks(pageId === "data-hub" &&
              loadedMetadata?.dataHubCompositionVersion !== 1
              ? seedDataHubPageBlocks(blocks) : blocks);
            pageBaselines.current.set(
              surfaceKey(addressedSurface),
              editorBlocks,
            );
            pageMetadataBaselines.current.set(
              pageMetadataKey(addressedSurface),
              metadata,
            );
            setPageLoad({
              status: "ready",
              publishedElectionBlocks: loadedPublishedElectionBlocks,
              electionResultsApprovals: loadedElectionResultsApprovals,
              blocks: editorBlocks,
              homeCompositionVersion: loadedHomeCompositionVersion,
              metadata:
                pageMetadataDraftFor(addressedSurface)?.metadata ?? metadata,
              createdBy: loadedCreatedBy,
              editingSection: loadedEditingSection,
              pageStatus: loadedStatus,
              scheduledPublishFailure: loadedScheduledPublishFailure,
              publishAt: loadedPublishAt,
              contentVersion: loadedContentVersion ?? version,
              publiclyVisible: loadedPubliclyVisible,
              publicSourceVersion: loadedPublicSourceVersion,
              publishedSourceVersion: loadedPublishedSourceVersion,
              publishBuildPending: loadedPublishBuildPending,
              publishBuildQueueId: loadedPublishBuildQueueId,
              expectedAbsent: loadedExpectedAbsent === true,
            });
          }
        },
      )
      .catch((error: unknown) => {
        if (!cancelled) {
          setPageLoad({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "The page could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [surface, loadPage, reloadCount]);

  // Hydrate an addressed record before mounting its form. Absence, soft deletion, a mismatched
  // type discriminator, and read failure are distinct terminal states; none falls through to a
  // blank form, because saving that form would mint or overwrite the wrong document (#566).
  useEffect(() => {
    if (surface.kind !== "record" || surface.id === null || !loadRecord) return;
    let cancelled = false;
    const addressedSurface = surface;
    const draft = recordDraftFor(addressedSurface);
    if (draft) {
      setRecordLoad({ status: "ready", record: draft, initialIsClean: false });
      return;
    }
    previewReceipts.current.delete(surfaceKey(addressedSurface));
    setRecordLoad({ status: "loading" });
    loadRecord(surface.record, surface.id)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "ready") {
          rememberPreviewReceipt(addressedSurface, result.record.version);
          recordBaselines.current.set(
            surfaceKey(addressedSurface),
            result.record,
          );
          setRecordLoad({
            status: "ready",
            record: result.record,
            initialIsClean: true,
          });
        } else {
          setRecordLoad(result);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRecordLoad({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "The record could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [surface, loadRecord, recordReloadCount]);

  // Raise the aggregate in-flight save signal to the shell so it can hold primary navigation too.
  // The same aggregate blocks this component's isolated picker; routed destinations live in an
  // ancestor that would otherwise unmount the editor on a click mid-save and orphan the request.
  // onSavingChange from the shell is a stable setter, so this only fires when `saving` flips.
  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);

  // Raise the dirty signal to the content layout so its navigation guard can prompt before a
  // dirty leave (#580). `dirty` is a boolean, so this only fires when the editor crosses between
  // holding unsaved work and being clean, and onDirtyChange from the layout is a stable setter.
  useEffect(() => {
    onDirtyChange?.(dirty || mediaPickerDirty);
  }, [dirty, mediaPickerDirty, onDirtyChange]);

  function recordFormFor(
    recordSurface: Extract<Surface, { kind: "record" }>,
    initial?: Record<string, unknown>,
    initialIsClean = false,
  ) {
    const key = surfaceKey(recordSurface);
    const saveDecision =
      recordSurface.id === null || initial === undefined
        ? ({ allowed: true } as const)
        : recordSaveDecision(principal, initial);
    const canSaveRecord = canSaveInActiveEditor && saveDecision.allowed;
    const recordSaveDisabledReason = saveDecision.allowed
      ? editorLockSaveDisabledReason
      : saveDecision.reason;
    const persistedRecordId =
      recordSurface.id !== null && typeof initial?.id === "string"
        ? initial.id
        : recordSurface.id;
    const recordVersion =
      typeof initial?.version === "number" &&
      Number.isSafeInteger(initial.version) &&
      initial.version >= 1
        ? initial.version
        : undefined;
    const currentAssignee =
      typeof initial?.assignee === "string" && initial.assignee.length > 0
        ? initial.assignee
        : null;
    const recordStatus = initial?.status;
    const displayedRecordStatus =
      typeof recordStatus === "string"
        ? recordStatus
        : recordSurface.id === null
          ? "draft"
          : undefined;
    const recordScheduledPublishFailure = parseScheduledPublishFailure(
      initial?.scheduledPublishFailure,
    );
    const recordLiveSourceVersion = livePublishedSourceVersion(initial ?? {});
    const recordPublished =
      typeof initial?.published === "object" &&
      initial.published !== null &&
      !Array.isArray(initial.published)
        ? (initial.published as Record<string, unknown>)
        : undefined;
    const recordPendingSourceVersion =
      typeof recordPublished?.sourceVersion === "number" &&
      Number.isSafeInteger(recordPublished.sourceVersion) &&
      recordPublished.sourceVersion >= 1
        ? recordPublished.sourceVersion
        : undefined;
    const assignmentStatusDisabledReason =
      recordStatus === "published"
        ? "Unpublish this record before changing its assignment."
        : recordStatus === "archived"
          ? "Restore this record before changing its assignment."
          : isAssignableContentStatus(recordStatus)
            ? undefined
            : "This record's workflow status does not allow assignment.";
    const assignmentDisabledReason =
      assignmentStatusDisabledReason ??
      (activeSurfaceDirty
        ? "Save or revert your content edits before changing assignment."
        : saving
          ? "Wait for the current content change to finish before changing assignment."
          : editorLockSaveDisabledReason);
    const historyRestoreDisabledReason = recordStatus === "published"
      ? "Save your edits as a draft before restoring a saved version."
      : !saveDecision.allowed
      ? saveDecision.reason
      : activeSurfaceDirty
        ? "Save or revert your unsaved work before restoring a version."
        : saving
          ? "Wait for the current content change to finish before restoring a version."
          : canSaveInActiveEditor
            ? undefined
            : editorLockSaveDisabledReason;
    const recordLifecycleResourceValue = recordLifecycleResource(initial ?? {});
    // Editor access may publish live blog entries and coverage state directly on a
    // public live blog. The server enforces the same rule and refuses other changes.
    const recordPublishedLiveBlog = (recordPublished?.metadata as { liveBlog?: unknown } | undefined)?.liveBlog;
    const liveBlogUpdateTarget =
      recordSurface.record === "post" && typeof persistedRecordId === "string" && publishLiveBlogUpdate &&
      initial?.liveBlog !== undefined && recordPublishedLiveBlog !== undefined &&
      (initial?.publiclyVisible === true || (initial?.publiclyVisible === undefined && recordStatus === "published")) &&
      (recordStatus === "published" || recordStatus === "draft") &&
      can(principal, "content.edit.any", recordLifecycleResourceValue)
        ? { id: persistedRecordId, publish: publishLiveBlogUpdate }
        : null;
    const duplicateResource = {
      ...recordLifecycleResourceValue,
      ownerId: principal.id,
    };
    const canDuplicatePost =
      recordSurface.record === "post" &&
      recordSurface.id !== null &&
      duplicatePost !== undefined &&
      can(principal, "content.create", duplicateResource) &&
      (can(principal, "content.edit.any", duplicateResource) ||
        can(principal, "content.edit.own", duplicateResource));
    const lifecycleDisabledReason = activeSurfaceDirty
      ? "Save or revert your content edits before changing lifecycle."
      : saving && !changingLifecycle
        ? "Wait for the current content change to finish before changing lifecycle."
        : editorLockLifecycleDisabledReason;
    function assertRecordPresentation() {
      if (recordSurface.record !== "post" || !initial) return;
      const parsed = parseBlocks(initial.blocks);
      if (!parsed.ok) throw new Error(parsed.error);
      if (!Array.isArray(initial.tags) || initial.tags.some(tag => typeof tag !== "string")) {
        throw new Error("Post tags must be a list of topics.");
      }
      const error = postPresentationError({ tags: initial.tags, blocks: parsed.blocks, heroImage: initial.heroImage, leadMedia: initial.leadMedia });
      if (error) throw new Error(error);
    }
    async function validateRecordForPublication() {
      if (!(await recordEditorRef.current?.validateForPublication())) {
        throw new Error("Check the highlighted fields and content before publishing.");
      }
      assertRecordPresentation();
    }
    const lifecyclePanel =
      recordSurface.id !== null && persistedRecordId ? (
        <LifecycleActionsPanel
          unifiedStatus={recordSurface.record === "post"}
          recordTitle={typeof initial?.title === "string" ? initial.title : undefined}
          baseVersion={recordVersion}
          contentVersion={typeof initial?.contentVersion === "number" ? initial.contentVersion : recordVersion}
          canArchive={can(
            principal,
            "content.delete",
            recordLifecycleResourceValue,
          )}
          canApprove={can(
            principal,
            "content.edit.any",
            recordLifecycleResourceValue,
          )}
          canEdit={
            can(principal, "content.edit.any", recordLifecycleResourceValue) ||
            can(principal, "content.edit.own", recordLifecycleResourceValue)
          }
          canPublish={can(principal, "content.publish", recordLifecycleResourceValue)}
          // Publication is offered for exactly the kinds whose server action can
          // complete. That is the shared routed-kind contract's answer (#923),
          // not a list restated here: Program joined Post when its public route
          // landed. Sponsor and Newsletter publish cards through approval and
          // retain their own feedback without a routed Publish or Schedule.
          canSchedule={recordKindHasPublicRoute(recordSurface.record)}
          publicationSupported={recordKindHasPublicRoute(recordSurface.record)}
          cardPublication={["sponsor", "newsletter"].includes(recordSurface.record)}
          canRestore={can(
            principal,
            "content.delete",
            recordLifecycleResourceValue,
          )}
          canUnpublish={can(
            principal,
            "content.unpublish",
            recordLifecycleResourceValue,
          )}
          collection="cmsPosts"
          disabledReason={lifecycleDisabledReason}
          documentId={persistedRecordId}
          headless={recordSurface.record === "post" || recordSurface.record === "program"}
          liveSourceVersion={recordLiveSourceVersion}
          publicUpdatePending={initial?.publishBuildPending === true}
          publicBuildQueueId={
            typeof initial?.publishBuildQueueId === "string"
              ? initial.publishBuildQueueId
              : null
          }
          pendingSourceVersion={recordPendingSourceVersion}
          onChanged={reloadRecord}
          videos={videosForPublication(initial?.blocks, initial?.leadMedia, recordSurface.record === "post" ? initial?.liveBlog : undefined)}
          onPublish={
            publishContent
              ? async (baseVersion, onProgress) => {
                  await validateRecordForPublication();
                  await reserveEditorForSave();
                  return publishContent(
                    "cmsPosts",
                    persistedRecordId,
                    baseVersion,
                    { blocks: initial?.blocks, leadMedia: initial?.leadMedia, liveBlog: recordSurface.record === "post" ? initial?.liveBlog : undefined, onProgress },
                  );
                }
              : undefined
          }
          onSchedule={
            scheduleContent
              ? async (baseVersion, scheduleAt, onProgress) => {
                  await validateRecordForPublication();
                  await reserveEditorForSave();
                  return scheduleContent(
                    "cmsPosts",
                    persistedRecordId,
                    baseVersion,
                    scheduleAt,
                    { blocks: initial?.blocks, leadMedia: initial?.leadMedia, liveBlog: recordSurface.record === "post" ? initial?.liveBlog : undefined, onProgress },
                  );
                }
              : undefined
          }
          onReload={reloadRecord}
          onSubmittingChange={onLifecycleChanging}
          onTransition={
            transitionContent
              ? async (request, options) => {
                  if (!options?.retryAcceptedCard && (request.action === "submit" || request.action === "approve")) await validateRecordForPublication();
                  await reserveEditorForSave();
                  return transitionContent(request);
                }
              : undefined
          }
          scheduledPublishFailure={recordScheduledPublishFailure}
          scheduledAt={typeof initial?.publishAt === "string" ? initial.publishAt : undefined}
          status={typeof recordStatus === "string" ? recordStatus : undefined}
          workspaceActions={workspaceActionsAvailable}
        />
      ) : null;
    const assignmentPanel =
      canAssignRecords && recordSurface.id !== null && persistedRecordId ? (
        <AssignmentPanel
          assignee={currentAssignee}
          baseVersion={recordVersion}
          canAssign={canSaveInActiveEditor}
          disabledReason={assignmentDisabledReason}
          loadAssignableUsers={loadAssignableUsers}
          onAssign={
            assignRecord
              ? async (request) => {
                  await reserveEditorForSave();
                  return assignRecord(request);
                }
              : undefined
          }
          onAssigned={(saved) => {
            // Callable responses carry Firestore Timestamps as JSON
            // {_seconds,_nanoseconds} maps. Normalize the addressed record kind before this
            // response becomes either the clean baseline or a fresh uncontrolled form seed.
            const normalizedSaved = normalizeEditorRecordDates(
              recordSurface.record,
              saved,
            );
            rememberPreviewReceipt(recordSurface, normalizedSaved.version);
            recordBaselines.current.set(key, normalizedSaved);
            drafts.current.delete(key);
            setRecordLoad({
              status: "ready",
              record: normalizedSaved,
              initialIsClean: true,
            });
            if (recordSurface.record === "post") {
              const serverFields: Record<string, unknown> = {};
              for (const field of [
                "id",
                "version",
                "assignee",
                "updatedAt",
                "updatedBy",
              ]) {
                if (field in normalizedSaved) {
                  serverFields[field] = normalizedSaved[field];
                }
              }
              recordEditorRef.current?.adoptServerFields(serverFields);
            } else {
              setRecordMutationRevision((revision) => revision + 1);
            }
            setRecordHistoryRevision((revision) => revision + 1);
            refreshDirty();
          }}
          onReload={reloadRecord}
          onSubmittingChange={onAssignmentSavingChange}
          recordId={persistedRecordId}
        />
      ) : null;
    const recordPreview = requestSavedPreview && loadPagePreviewStatus && persistedRecordId &&
      recordKindHasPublicRoute(recordSurface.record) && recordStatus !== "archived" ? (
        <SavedPreview
          key={persistedRecordId}
          collection="cmsPosts"
          documentId={persistedRecordId}
          enabled={!mediaPickerDirty && (!activeSurfaceDirty || canSaveRecord) &&
            (!!previewReceipts.current.get(key) || activeSurfaceDirty)}
          disabledReason={mediaPickerDirty ? "Finish or cancel the media changes before previewing."
            : activeSurfaceDirty && !canSaveRecord ? "Your access does not allow saving these changes for preview."
              : "Wait for a saved record to load before previewing."}
          preparePreview={preparePreview}
          requestPreview={requestSavedPreview}
          prepareSession={preparePreviewSession}
          loadPreviewStatus={loadPagePreviewStatus}
        />
      ) : null;
    return (
      <div className="record-editor">
        {workspaceActionsAvailable ? (
          <WorkspaceStatus>
            {recordSurface.record === "post" ? (
              <span className="status-label" aria-live="polite">
                {!editorView?.kind ? <span className="status-label-key">Status:</span> : null}
                {" "}
                <PublishedVersionStatus collection="cmsPosts" documentId={persistedRecordId ?? undefined}
                  documentBar={editorView?.kind ? { kind: "post", draftState: saving ? "saving" : activeSurfaceDirty ? "dirty" : persistedRecordId ? "saved" : "new" } : undefined}
                  recordTitle={typeof initial?.title === "string" ? initial.title : undefined}
                  workingStatus={displayedRecordStatus ?? "draft"} workingVersion={recordVersion}
                  contentVersion={typeof initial?.contentVersion === "number" ? initial.contentVersion : undefined}
                  liveSourceVersion={recordLiveSourceVersion} pendingSourceVersion={recordPendingSourceVersion}
                  publicUpdatePending={initial?.publishBuildPending === true} statusOnly />
              </span>
            ) : (
              <StatusLabel tone={contentStatusTone(displayedRecordStatus)}>
                {displayContentStatus(displayedRecordStatus)}
              </StatusLabel>
            )}
            {recordSurface.record === "post" ? <ScheduledPublicationTime status={displayedRecordStatus} publishAt={typeof initial?.publishAt === "string" ? initial.publishAt : undefined} /> : null}
          </WorkspaceStatus>
        ) : null}
        <EditorBackLink
          surface={{ kind: "record", record: recordSurface.record }}
          listLabel={labelForSurface(recordSurface)}
        />
        {recordSurface.record === "program" ? (
          <details className="editor-metadata" open={Boolean(recordScheduledPublishFailure)}>
            <summary role="button">Workflow and assignment</summary>
            {recordPreview}
            {lifecyclePanel}
            {assignmentPanel}
          </details>
        ) : recordSurface.record === "post" ? null : <>{lifecyclePanel}{assignmentPanel}</>}
        <RecordForm
          ref={recordEditorRef}
          key={`${key}:${recordMutationRevision}`}
          kind={recordSurface.record}
          capturePostTemplate={recordSurface.record === "post" ? capturePostTemplate : undefined}
          electionSourceHost={electionSources && recordSurface.record === "post" ? { api: electionSources, collection: "cmsPosts", canPublish: can(principal, "content.publish", recordLifecycleResourceValue), locked: saving || !canSaveInActiveEditor, pauseLocked: saving, hasUnsavedWork: hasElectionSourceUnsavedWork, onBusyChange: onElectionSourceBusyChange } : undefined}
          canEditCustomHtml={can(principal, "content.publish", recordLifecycleResourceValue)}
          duplicatePost={canDuplicatePost ? async (sourceId, sourceVersion) => {
            const duplicated = await duplicatePost(sourceId, sourceVersion);
            if (typeof duplicated.id !== "string") {
              throw new Error("The duplicate receipt is missing its record ID.");
            }
            successNotice.show("Post duplicated as a draft.");
            const nextSurface: Surface = {
              kind: "record",
              record: "post",
              id: duplicated.id,
            };
            if (onNavigateSurface) {
              onNavigateSurface(nextSurface, { committed: true });
            } else {
              selectIsolatedSurface(nextSurface);
            }
          } : undefined}
          duplicateDisabledReason={mediaPickerDirty
            ? "Finish or cancel the media changes before duplicating this Post."
            : saving
              ? "Wait for the current content change to finish before duplicating this Post."
              : undefined}
          initial={initial}
          initialIsClean={initialIsClean}
          canSave={canSaveRecord}
          allowIncomplete={recordSurface.record === "post" && autosaveDraft}
          bylineAuthors={bylineAuthors}
          loadPublishedVocabulary={loadPublishedVocabulary}
          bylineAuthorsUnavailable={bylineAuthorsUnavailable}
          bylineAuthorsLoading={bylineAuthorsLoading}
          canManageAuthorProfiles={canManageAuthorProfiles(principal)}
          selfAuthorId={bylineSelfAuthorId}
          loadMedia={loadMedia}
          mediaPickerUnavailable={mediaPickerUnavailable}
          uploadMedia={
            recordSurface.record === "post" ? uploadMedia : undefined
          }
          mediaCategories={mediaCategories}
          defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory}
          onMediaPickerDirtyChange={onMediaPickerDirtyChange}
          newId={newId}
          sections={contentSections}
          newPostSections={newPostSections}
          postInspector={
            recordSurface.record === "post" &&
            (assignmentPanel || lifecyclePanel || requestSavedPreview) ? (
              <>
                {recordPreview}
                {assignmentPanel}
                {lifecyclePanel}
                <ElectionResultsHistory approvals={Array.isArray(initial?.electionResultsApprovals) ? initial.electionResultsApprovals : undefined} />
              </>
            ) : undefined
          }
          saveDisabledReason={recordSaveDisabledReason}
          publishLiveBlogUpdate={liveBlogUpdateTarget
            ? async (liveBlog, baseVersion) => {
                await reserveEditorForSave();
                const receipt = await liveBlogUpdateTarget.publish(liveBlogUpdateTarget.id, baseVersion, liveBlog, recordPublishedLiveBlog);
                reloadRecord();
                return receipt;
              }
            : undefined}
          onSave={
            saveRecord
              ? async (record, options) => {
                  await reserveEditorForSave();
                  const saved = await saveRecord(
                    recordSurface.record,
                    record,
                    options,
                  );
                  const receipt = isRecordSaveReceipt(saved)
                    ? saved
                    : undefined;
                  const savedDocument: Record<string, unknown> = receipt
                    ? receipt.document
                    : (saved as Record<string, unknown>);
                  rememberPreviewReceipt(recordSurface, savedDocument.version);
                  // RecordForm adopts server identity/version fields and reconciles canonical
                  // block ids. Keep the workspace clean point in that same form shape rather
                  // than replacing editor-owned fields with the full server echo.
                  const identity: Record<string, unknown> = {};
                  if (typeof savedDocument.id === "string") {
                    identity.id = savedDocument.id;
                  }
                  if (
                    typeof savedDocument.version === "number" &&
                    Number.isInteger(savedDocument.version) &&
                    savedDocument.version >= 1
                  ) {
                    identity.version = savedDocument.version;
                    identity.contentVersion = savedDocument.contentVersion;
                  }
                  if (typeof savedDocument.slug === "string") identity.slug = savedDocument.slug;
                  if (Array.isArray(savedDocument.previousSlugs)) identity.previousSlugs = savedDocument.previousSlugs;
                  recordBaselines.current.set(key, {
                    ...record,
                    ...(receipt && Array.isArray(savedDocument.blocks)
                      ? { blocks: savedDocument.blocks }
                      : {}),
                    ...identity,
                  });
                  if (recordSurface.id !== null) {
                    // Assignment and content saves share one optimistic record version. Keep the
                    // addressed server snapshot current even when RecordForm stays mounted, so a
                    // clean save followed by an assignment echoes the version that just landed
                    // instead of forcing a false conflict and reload.
                    setRecordLoad({
                      status: "ready",
                      record: { ...record, ...savedDocument },
                      initialIsClean: true,
                    });
                    setRecordHistoryRevision((revision) => revision + 1);
                  }
                  return saved;
                }
              : undefined
          }
          onReload={recordSurface.id === null ? undefined : reloadRecord}
          onOpenConflictRecord={
            recordSurface.id === null
              ? (id) => {
                  drafts.current.delete(key);
                  recordBaselines.current.delete(key);
                  refreshDirty();
                  abandonRecordCreate?.(recordSurface.record);
                  const nextSurface: Surface = {
                    kind: "record",
                    record: recordSurface.record,
                    id,
                  };
                  if (onNavigateSurface) {
                    onNavigateSurface(nextSurface, {
                      replace: true,
                      committed: true,
                    });
                  } else {
                    selectIsolatedSurface(nextSurface);
                  }
                }
              : undefined
          }
          onSaved={(saved) => {
            // RecordForm raises this only when the committed snapshot is still the live form —
            // never when the person typed during the request. Clear the create draft explicitly
            // because canonicalizing the URL unmounts that form before its settle effect can.
            if (
              recordSurface.id === null &&
              typeof saved.id === "string" &&
              onNavigateSurface
            ) {
              drafts.current.delete(key);
              refreshDirty();
              onNavigateSurface(
                { kind: "record", record: recordSurface.record, id: saved.id },
                { replace: true, committed: true },
              );
            }
          }}
          preserveSuccessNoticeOnNextRoute={
            recordSurface.id === null && !!onNavigateSurface
          }
          onSavingChange={onRecordSavingChange}
          onDraftChange={(record) => trackRecordDraft(recordSurface, record)}
          readOnly={
            restoring ||
            changingElectionSources ||
            changingLifecycle ||
            recordStatus === "in_review" ||
            recordStatus === "approved" ||
            recordStatus === "scheduled"
          }
          readOnlyNotice={
            changingElectionSources ? { title: "Updating the election source connection", message: "Manual editing resumes when the connection change finishes." } : readOnlyNotice({
              status: recordStatus,
              restoring,
              changingLifecycle,
              noun: recordSurface.record === "post" ? "post" : "record",
            }) ?? undefined
          }
          saveLabel="Save draft"
          showSaveAction={
            recordSurface.record !== "post" ||
            !["in_review", "approved", "scheduled"].includes(String(recordStatus))
          }
        />
        {recordSurface.record === "post" && persistedRecordId ? (
          <LivePostAction documentId={persistedRecordId} />
        ) : null}
        {recordSurface.record === "event" ? recordPreview : null}
        {recordSurface.id !== null && loadRevisions && loadRevision ? (
          <RevisionHistory
            collection="cmsPosts"
            currentVersion={recordVersion}
            documentId={recordSurface.id}
            loadRevisions={loadRevisions}
            loadRevision={loadRevision}
            onRestored={reloadRecord}
            onRestoringChange={onRevisionRestoringChange}
            refreshKey={recordHistoryRevision}
            restoreDisabledReason={historyRestoreDisabledReason}
            restoreRevision={restoreRevision ? restoreFromHistory : undefined}
          />
        ) : null}
      </div>
    );
  }

  function loadedRecordFormFor(
    recordSurface: Extract<Surface, { kind: "record" }>,
    content: Extract<RecordLoad, { status: "ready" }>,
  ) {
    const draft = recordDraftFor(recordSurface);
    return recordFormFor(
      recordSurface,
      draft ?? content.record,
      draft ? false : content.initialIsClean,
    );
  }

  function pageEditorsFor(
    pageSurface: Extract<Surface, { kind: "page" }>,
    content: Extract<PageLoad, { status: "ready" }>,
  ) {
    const blockDraft = pageDraftFor(pageSurface);
    const savedPageBlocks = pageBaselines.current.get(surfaceKey(pageSurface)) ?? content.blocks;
    const metadataDraft = pageMetadataDraftFor(pageSurface);
    const saveDecision = pageSaveDecision(principal, pageSurface.pageId, content);
    const canSavePage = canSaveInActiveEditor && saveDecision.allowed;
    const pageSaveDisabledReason = saveDecision.allowed
      ? editorLockSaveDisabledReason
      : saveDecision.reason;
    const pageCurrentVersion =
      Math.max(
        blockBaseVersion.current ?? 0,
        metadataBaseVersion.current ?? 0,
      ) || undefined;
    const historyRestoreDisabledReason = content.pageStatus === "published"
      ? "Save your edits as a draft before restoring a saved version."
      : !saveDecision.allowed
      ? saveDecision.reason
      : activeSurfaceDirty
        ? "Save or revert your unsaved work before restoring a version."
        : saving
          ? "Wait for the current content change to finish before restoring a version."
          : canSaveInActiveEditor
            ? undefined
            : editorLockSaveDisabledReason;
    const pageLifecycleResourceValue = pageLifecycleResource(
      pageSurface.pageId,
      content,
    );
    const lifecycleDisabledReason = activeSurfaceDirty
      ? "Save or revert your content edits before changing lifecycle."
      : saving && !changingLifecycle
        ? "Wait for the current content change to finish before changing lifecycle."
        : editorLockLifecycleDisabledReason;
    const initialMetadata: Record<string, unknown> = {
      ...(pageSurface.pageId === "home" ? {
        homeHeroTitle: HOME_HERO_CONTENT.title,
        homeHeroSubtitle: HOME_HERO_CONTENT.subtitle,
      } : {}),
      ...(metadataDraft?.metadata ?? content.metadata),
    };
    const registryPage = publicPage(pageSurface.pageId);
    const homeCanvas = pageSurface.pageId === "home" && content.homeCompositionVersion !== undefined;
    const homeShelfOnly =
      enforcePublicPageOwnership && pageSurface.pageId === "home" && !homeCanvas;
    const fixedRegions = homeCanvas
      ? []
      : pageCompositionFixedRegions(pageSurface.pageId, {
          homeCompositionVersion: content.homeCompositionVersion,
        });
    const pageTitle = typeof initialMetadata.title === "string" && initialMetadata.title.trim() ? initialMetadata.title : registryPage?.title ?? labelForSurface(pageSurface);
    const pagePath = publicPagePath(pageSurface.pageId, initialMetadata) ?? registryPage?.path;
    const blockEditorTargetId = `page-block-editor-${pageSurface.pageId}`;
    const pageKey = surfaceKey(pageSurface);
    const combinedPageActions =
      workspaceActionsAvailable &&
      savePage !== undefined &&
      savePageMetadata !== undefined;
    const pageUpdateSaving =
      pageUpdateState.key === pageKey && pageUpdateState.status === "saving";
    const pageUpdateSaved =
      pageUpdateState.key === pageKey && pageUpdateState.status === "saved";
    const pageUpdateError =
      pageUpdateState.key === pageKey && pageUpdateState.status === "error"
        ? pageUpdateState.message
        : undefined;
    const pageUpdateDisabledReason = !canSavePage
      ? (pageSaveDisabledReason ?? "Saving is not available.")
      : saving && !pageUpdateSaving
        ? "Wait for the current save to finish."
        : !activeSurfaceDirty
          ? "There are no changes to save."
          : undefined;
    const pageUpdateDisabled =
      !canSavePage || (saving && !pageUpdateSaving) || !activeSurfaceDirty;
    const pageUpdateReasonId = `${blockEditorTargetId}-update-reason`;
    async function validatePageForPublication() {
      if (!homeShelfOnly && !pageBlocksEditorRef.current?.validateForPublication()) {
        revealBentoPanel("content");
        throw new Error("Check the highlighted page content before publishing.");
      }
      if (!(await pageMetadataEditorRef.current?.validateForPublication())) {
        throw new Error("Check the highlighted page settings before publishing.");
      }
    }
    const pageLiveSourceVersion = livePublishedSourceVersion({
      status: content.pageStatus,
      publiclyVisible: content.publiclyVisible,
      publicSourceVersion: content.publicSourceVersion,
      publishBuildPending: content.publishBuildPending,
      published: { sourceVersion: content.publishedSourceVersion },
    });
    const convertingHome = savingSources.has("home-conversion");
    const conversionDisabledReason = !canSavePage
      ? pageSaveDisabledReason ?? "Editing is not available."
      : content.pageStatus !== "draft" || content.expectedAbsent || !pageCurrentVersion
        ? "Open a saved Home draft before enabling editing."
        : content.publishBuildPending
          ? "Wait for the current publication to finish."
          : activeSurfaceDirty || mediaPickerDirty
            ? "Save or revert your changes before enabling Home editing."
            : saving ? "Wait for the current change to finish." : undefined;

    const canConvertHomeV2 = pageSurface.pageId === "home" && content.homeCompositionVersion === 1 &&
      homeLayoutsEnabled() && can(principal, "content.edit.any", pageLifecycleResourceValue);
    const editorialConversionDisabledReason = !canSavePage
      ? pageSaveDisabledReason ?? "Editing is not available."
      : !["draft", "published"].includes(content.pageStatus ?? "") || content.expectedAbsent || !pageCurrentVersion
      ? "Open a saved Home draft or published Home before changing its layout."
      : content.publishBuildPending || content.pageStatus !== "published" && content.publishAt
        ? "Wait for scheduled or pending publication to finish before changing the layout."
        : activeSurfaceDirty || mediaPickerDirty
          ? "Save or revert your changes before changing the Home layout."
          : saving ? "Wait for the current change to finish." : undefined;
    function cancelEditorialConversion() {
      setHomeV2Confirmation(false);
      homeV2Trigger.current?.focus();
    }
    async function useEditorialHome() {
      if (!convertHomeV2 || !canConvertHomeV2 || editorialConversionDisabledReason || !pageCurrentVersion || homeConversionBusy.current) return;
      homeConversionBusy.current = true;
      setHomeConversionError(undefined);
      setSavingSource("home-conversion", true);
      try {
        await reserveEditorForSave();
        if (!isSameSurface(activeSurfaceRef.current, pageSurface) || mediaPickerDirtyRef.current ||
            unsavedDraftKeys().some(key => key === pageKey || key === pageMetadataKey(pageSurface))) {
          throw new Error("Save or revert your Home changes before changing its layout.");
        }
        if (homeConversionAttempt.current?.version !== pageCurrentVersion) {
          homeConversionAttempt.current = { version: pageCurrentVersion, key: crypto.randomUUID() };
        }
        const saved = await convertHomeV2(pageCurrentVersion, homeConversionAttempt.current.key);
        if (saved.homeCompositionVersion !== 2) throw new Error("The editorial draft could not be confirmed. Reload Home.");
        if (!isSameSurface(activeSurfaceRef.current, pageSurface)) return;
        advancePageAfterSave(pageSurface, saved, "blocks", false);
        homeConversionAttempt.current = null;
        setHomeV2Confirmation(false);
        focusConvertedHome.current = true;
        reloadPage();
      } catch (error) {
        setHomeConversionError(error instanceof Error ? error.message : "The editorial draft could not be loaded. Reload Home before trying again.");
      } finally {
        homeConversionBusy.current = false;
        setSavingSource("home-conversion", false);
      }
    }

    async function enableHomeEditing() {
      if (!convertHome || !homeShelfOnly || conversionDisabledReason || !pageCurrentVersion || homeConversionBusy.current) return;
      homeConversionBusy.current = true;
      setHomeConversionError(undefined);
      setSavingSource("home-conversion", true);
      try {
        await reserveEditorForSave();
        if (!isSameSurface(activeSurfaceRef.current, pageSurface) || mediaPickerDirtyRef.current ||
          unsavedDraftKeys().some(key => key === pageKey || key === pageMetadataKey(pageSurface))) {
          throw new Error("Save or revert your Home changes before enabling editing.");
        }
        if (homeConversionAttempt.current?.version !== pageCurrentVersion) {
          homeConversionAttempt.current = { version: pageCurrentVersion, key: crypto.randomUUID() };
        }
        const saved = await convertHome(pageCurrentVersion, homeConversionAttempt.current.key);
        if (saved.homeCompositionVersion !== 1) throw new Error("Home editing could not be confirmed. Reload its current draft.");
        if (!isSameSurface(activeSurfaceRef.current, pageSurface)) return;
        advancePageAfterSave(pageSurface, saved, "blocks", false);
        homeConversionAttempt.current = null;
        focusConvertedHome.current = true;
        reloadPage();
      } catch (error) {
        setHomeConversionError(error instanceof Error ? error.message : "Home editing could not be enabled. Reload to check its current draft.");
      } finally {
        homeConversionBusy.current = false;
        setSavingSource("home-conversion", false);
      }
    }

    // The Save draft control and an exit that chose to save first run the same sequence, so the two
    // can never hold different definitions of "this page is saved".
    async function updatePage() {
      await savePageSurface(pageSurface);
    }
    // Title and summary sit in the main writing column like Posts. Page content stays in
    // main; metadata, preview, and lifecycle sit in the side column unless the editor moves them.
    const writingPanel: BentoPanel = {
      id: "page-title",
      title: "Title and summary",
      outlineLabel: "Title and summary",
      defaultZone: editorView?.kind ? "side" : "main",
      allowedZones: editorView?.kind ? ["main", "side"] : ["main"],
      body: <div ref={setPageWritingTarget} className="page-title-editor" />,
    };
    const contentPanel: BentoPanel = {
      id: "content",
      title: "Page content",
      presentation: editorView?.kind ? "canvas" : undefined,
      outlineLabel: "Page content",
      subtitle: editorView?.kind ? `${editorSectionCount(blockDraft?.blocks ?? savedPageBlocks, pageSurface.pageId)} sections · Select to inspect, pencil to edit` : pageSurface.pageId === "staff"
        ? "Edit authored blocks. The published roster stays generated and locked."
        : "Edit page blocks.",
      defaultZone: "main",
      allowedZones: ["main"],
      body: (
        <div className="page-content-editor">
          {pageSurface.pageId === "home" ? <div ref={setHomeHeroTarget} /> : null}
          {fixedRegions.length > 0 ? (
            <section
              className="page-fixed-context"
              role="region"
              aria-label={`Fixed ${pageTitle} page context`}
            >
              <details className="page-fixed-context-details">
                <summary>
                  <span className="page-fixed-context-label">
                    <Icon name="lock" />
                    Locked content
                  </span>
                  <span className="page-fixed-context-count">
                    {fixedRegions.length} {fixedRegions.length === 1 ? "region" : "regions"}
                    <Icon name="chevron-down" />
                  </span>
                </summary>
                <ul>
                  {fixedRegions.map((region) => (
                    <li key={region.label}>
                      <strong>{region.label}</strong>
                      <span>{region.detail}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          ) : null}
          {pageSurface.pageId === "home" && content.homeCompositionVersion === 1 && !canConvertHomeV2 && homeConversionError ? (
            <InlineMessage tone="error">{homeConversionError}</InlineMessage>
          ) : null}
          {canConvertHomeV2 && convertHomeV2 ? (
            <InlineMessage tone="info" title="Editorial Home layout">
              <div>
                <p>Start with news first, then arrange and edit your Home sections.</p>
                <Button ref={homeV2Trigger} aria-expanded={homeV2Confirmation} disabled={Boolean(editorialConversionDisabledReason)}
                  onClick={() => { setHomeConversionError(undefined); setHomeV2Confirmation(true); }}>Use the editorial layout</Button>
                {editorialConversionDisabledReason ? <p>{editorialConversionDisabledReason}</p> : null}
                {homeV2Confirmation ? <div role="group" aria-labelledby="home-v2-confirmation-title" aria-describedby="home-v2-confirmation-description"
                  className="lifecycle-actions-confirmation" onKeyDown={event => {
                    if (event.key === "Escape" && !convertingHome) { event.preventDefault(); cancelEditorialConversion(); }
                  }}>
                  <strong id="home-v2-confirmation-title">Use the editorial layout?</strong>
                  <p id="home-v2-confirmation-description">This saves an editorial draft in the starting section order. The live homepage does not change until you press Publish.</p>
                  <div className="button-row">
                    <Button ref={homeV2Cancel} disabled={convertingHome} onClick={cancelEditorialConversion}>Cancel</Button>
                    <AsyncActionButton variant="primary" label="Use the editorial layout" pending={convertingHome}
                      pendingLabel="Preparing editorial draft…" pendingAnnouncement="Preparing the editorial Home draft."
                      disabled={Boolean(editorialConversionDisabledReason)} onClick={() => void useEditorialHome()} />
                  </div>
                </div> : null}
                {homeConversionError ? <div role="alert"><p>{homeConversionError}</p>
                  <Button disabled={saving || activeSurfaceDirty || mediaPickerDirty} onClick={() => { setHomeConversionError(undefined); setHomeV2Confirmation(false); reloadPage(); }}>Reload Home</Button>
                </div> : null}
              </div>
            </InlineMessage>
          ) : null}
          {homeShelfOnly ? (
            <InlineMessage
              className="page-home-ownership-notice"
              tone="info"
              title="Edit the Home sections"
            >
              <p>Edit the text, images and shelf settings shown below. Your current content stays in version
                history. This does not publish the page.</p>
              {convertHome ? <>
                <AsyncActionButton variant="primary" label="Enable Home editing"
                  disabled={Boolean(conversionDisabledReason)} pending={convertingHome}
                  pendingLabel="Enabling editing…" pendingAnnouncement="Preparing the Home draft."
                  onClick={() => void enableHomeEditing()} />
                {conversionDisabledReason ? <p>{conversionDisabledReason}</p> : null}
              </> : null}
              {homeConversionError ? <div role="alert">
                <p>{homeConversionError}</p>
                <Button disabled={saving || activeSurfaceDirty || mediaPickerDirty} onClick={() => { setHomeConversionError(undefined); reloadPage(); }}>Reload Home</Button>
              </div> : null}
            </InlineMessage>
          ) : null}
          <div
            ref={homeEditorTarget}
            id={blockEditorTargetId}
            className="page-layout-editor-target"
            tabIndex={-1}
          >
            <BlockEditor
              ref={pageBlocksEditorRef}
              electionResultsApprovals={content.electionResultsApprovals}
              electionSourceHost={electionSources ? { api: electionSources, collection: "cmsPages", documentId: pageSurface.pageId, version: pageCurrentVersion, publicBlocks: content.publishedElectionBlocks, canPublish: can(principal, "content.publish", pageLifecycleResourceValue), locked: saving || !canSaveInActiveEditor, pauseLocked: saving, hasUnsavedWork: hasElectionSourceUnsavedWork, onBusyChange: onElectionSourceBusyChange } : undefined}
              key={pageSurface.pageId}
              pageId={pageSurface.pageId}
              onReportingSelectionChange={pageSurface.pageId === "data-hub" ? setReportingSelection : undefined}
              pageTitle={typeof initialMetadata?.title === "string" ? initialMetadata.title : undefined}
              pageDescription={typeof initialMetadata?.description === "string" ? initialMetadata.description : undefined}
              homeCompositionVersion={content.homeCompositionVersion}
              loadHomeSources={loadHomeSources}
              section={pageSurface.section}
              allowedBlockTypes={
                homeShelfOnly ? HOME_EDITABLE_BLOCK_TYPES : undefined
              }
              canEditCustomHtml={can(principal, "content.publish", pageLifecycleResourceValue)}
              initialBlocks={blockDraft?.blocks ?? content.blocks}
              canSave={canSavePage}
              allowIncomplete={autosaveDraft}
              saveDisabledReason={pageSaveDisabledReason}
              newId={newId}
              loadMedia={loadMedia}
              mediaPickerUnavailable={mediaPickerUnavailable}
              uploadMedia={uploadMedia}
              mediaCategories={mediaCategories}
              defaultUploadCategory={defaultUploadCategory}
              canUploadCategory={canUploadCategory}
              onMediaPickerDirtyChange={onMediaPickerDirtyChange}
              onSave={
                savePage
                  ? async (blocks, options) => {
                      if (homeCanvas && options?.force) throw new Error("Reload Home before applying edits to its latest version.");
                      await reserveEditorForSave();
                      const forced = options?.force === true;
                      // "Save anyway" asks the adapter to read and explicitly confirm the
                      // latest saved version. A create-only claim is never dropped: this
                      // editor has not seen the new document, so BlockEditor offers reload as
                      // its only safe conflict resolution.
                      const saved = await savePage(
                        pageSurface.pageId,
                        pageSurface.section,
                        blocks,
                        pageSaveBaseVersion("blocks", forced),
                        expectedAbsent.current ? true : undefined,
                        seedFromLegacyPage.current,
                        pageSaveSequence.current?.id,
                      );
                      // The write that just landed is the new base. Without this a second
                      // save in the same session would echo the version the first one had
                      // already superseded, and the editor would conflict with itself.
                      advancePageAfterSave(
                        pageSurface,
                        saved,
                        "blocks",
                        forced,
                      );
                      pageBaselines.current.set(
                        surfaceKey(pageSurface),
                        saved.blocks,
                      );
                      return {
                        blocks: saved.blocks,
                        mintedIds: saved.mintedIds ?? {},
                        warnings: saved.warnings ?? [],
                        savedTarget: editorSaveReceipt("cmsPages", pageSurface.pageId, saved.version),
                      };
                    }
                  : undefined
              }
              onReload={reloadPage}
              allowConflictOverwrite={!expectedAbsent.current && !homeCanvas}
              onSavingChange={onPageBlocksSavingChange}
              onDraftChange={(blocks) => trackPageDraft(pageSurface, blocks)}
              readOnly={
                convertingHome ||
                changingElectionSources ||
                restoring ||
                changingLifecycle ||
                (content.pageStatus === "in_review" &&
                  !content.expectedAbsent) ||
                content.pageStatus === "approved" ||
                content.pageStatus === "scheduled"
              }
              readOnlyNotice={
                changingElectionSources ? { title: "Updating the election source connection", message: "Manual editing resumes when the connection change finishes." } : readOnlyNotice({
                  status: content.pageStatus,
                  restoring,
                  changingLifecycle,
                  noun: "page",
                }) ?? undefined
              }
              showSaveAction={!combinedPageActions}
            />
          </div>
        </div>
      ),
    };

    const metadataPanel: BentoPanel = {
      id: "metadata",
      title: "Page metadata",
      subtitle: pageSurface.pageId === "staff"
        ? "Edit the Staff hero background, crop, search, and social settings."
        : "Edit page labels and link previews.",
      aside: registryPage ? (
        <p className="page-public-path">
          <span>Path</span> <code>{pagePath}</code>
        </p>
      ) : undefined,
      defaultZone: "side",
      body: (
        <RecordForm
          ref={pageMetadataEditorRef}
          key={pageMetadataKey(pageSurface)}
          homeHeroTarget={pageSurface.pageId === "home" ? homeHeroTarget : undefined}
          dataHubReportingTarget={pageSurface.pageId === "data-hub" ? reportingSelection?.target : undefined}
          dataHubReportingFigure={pageSurface.pageId === "data-hub" ? reportingSelection?.figure : undefined}
          onReportingFigureReveal={figure => {
            if (!pageBlocksEditorRef.current?.revealDataHubFigure(figure)) {
              setReportingSelection(null);
              if (editorView?.kind) editorView.openPane("details", "document");
              else revealBentoPanel("metadata");
            }
          }}
          reportingTransport={reportingTransport}
          writingTarget={pageWritingTarget}
          onRevealField={(key, fieldId) => {
            if (key === "dataHubReporting") {
              reportingValidationRevealed.current = true;
              if (editorView?.kind) editorView.openPane("details", reportingSelection ? "selection" : "document");
              else revealBentoPanel("metadata");
              return;
            }
            revealBentoPanel(
            key === "title" || key === "description" ? "page-title"
              : pageSurface.pageId === "home" &&
                (key === "homeHero" || key.startsWith("homeHero") || key.startsWith("heroBackground"))
                ? "content"
                : "metadata",
            fieldId,
          ); }}
          kind="page"
          pageId={pageSurface.pageId}
          initial={initialMetadata}
          initialIsClean={!metadataDraft}
          canManageSettings={canManageSettings(principal)}
          canSave={canSavePage && savePageMetadata !== undefined}
          allowIncomplete={autosaveDraft}
          loadMedia={loadMedia}
          mediaPickerUnavailable={mediaPickerUnavailable}
          uploadMedia={uploadMedia}
          mediaCategories={mediaCategories}
          defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory}
          onMediaPickerDirtyChange={onMediaPickerDirtyChange}
          saveDisabledReason={
            !saveDecision.allowed
              ? saveDecision.reason
              : canSave && savePageMetadata === undefined
                ? "Metadata saving is not connected in this workspace."
                : pageSaveDisabledReason
          }
          onSave={
            savePageMetadata
              ? async (metadata, options) => {
                  if (homeCanvas && options?.force) throw new Error("Reload Home before applying edits to its latest version.");
                  await reserveEditorForSave();
                  const forced = options?.force === true;
                  // A form with no claim of its own -- a page loaded without a usable version
                  // (#670) -- still claims what an Update sequence's earlier write returned:
                  // that version describes the document this same sequence just wrote, so an
                  // interleaved write by someone else is refused instead of overwritten.
                  const saved = await savePageMetadata(
                    pageSurface.pageId,
                    pageSurface.section,
                    metadata,
                    pageSaveBaseVersion("metadata", forced),
                    expectedAbsent.current ? true : undefined,
                    seedFromLegacyPage.current,
                    pageSaveSequence.current?.id,
                  );
                  const persisted = saved.metadata ?? metadata;
                  advancePageAfterSave(pageSurface, { ...saved, metadata: persisted }, "metadata", forced);
                  pageMetadataBaselines.current.set(
                    pageMetadataKey(pageSurface),
                    persisted,
                  );
                  return {
                    kind: "record-save-receipt" as const,
                    document: persisted,
                    mintedIds: {},
                    savedTarget: editorSaveReceipt("cmsPages", pageSurface.pageId, saved.version),
                  };
                }
              : undefined
          }
          onReload={reloadPage}
          allowConflictOverwrite={!expectedAbsent.current && !homeCanvas}
          onSavingChange={onPageMetadataSavingChange}
          onDraftChange={(metadata) =>
            trackPageMetadataDraft(pageSurface, metadata)
          }
          readOnly={
            convertingHome ||
            restoring ||
            changingLifecycle ||
            (content.pageStatus === "in_review" && !content.expectedAbsent) ||
            content.pageStatus === "approved" ||
            content.pageStatus === "scheduled"
          }
          readOnlyNotice={
            readOnlyNotice({
              status: content.pageStatus,
              restoring,
              changingLifecycle,
              noun: "page",
            }) ?? undefined
          }
          saveLabel="Save metadata"
          showSaveAction={!combinedPageActions}
        />
      ),
    };

    const panels: BentoPanel[] = [writingPanel, contentPanel, metadataPanel];
    if (registryPage && content.pageStatus !== "archived") {
      panels.push({
        id: "preview",
        title: "Preview",
        toggleLabel: workspaceActionsAvailable ? "Preview panel" : undefined,
        subtitle: "Preview the saved page on desktop and mobile.",
        defaultZone: "side",
        defaultCollapsed: true,
        body: requestSavedPreview && loadPagePreviewStatus ? (
          <SavedPreview
            key={pageSurface.pageId}
            collection="cmsPages"
            documentId={pageSurface.pageId}
            enabled={!mediaPickerDirty && (!activeSurfaceDirty || canSavePage) &&
              (!!previewReceipts.current.get(surfaceKey(pageSurface)) || activeSurfaceDirty)}
            disabledReason={mediaPickerDirty ? "Finish or cancel the media changes before previewing."
              : activeSurfaceDirty && !canSavePage ? "Your access does not allow saving these changes for preview."
                : "Wait for a saved page to load before previewing."}
            preparePreview={preparePreview}
            requestPreview={requestSavedPreview}
            prepareSession={preparePreviewSession}
            loadPreviewStatus={loadPagePreviewStatus}
          />
        ) : (
          <PagePreview
            key={pageSurface.pageId}
            pageId={pageSurface.pageId}
            pagePath={pagePath ?? registryPage.path}
            dirty={activeSurfaceDirty}
            saving={saving}
            savedVersion={pageCurrentVersion ?? 0}
            requestPreview={requestPagePreview}
            loadPreviewStatus={loadPagePreviewStatus}
            // The gate's two ways out of unsaved work are this workspace's own: the same page-save
            // sequence the Save draft control and the exit guard run (#1032), and the same
            // discard-and-re-read the conflict banner offers. The preview never gets a private
            // definition of saved, and never builds from work that is only in the browser (#1042).
            saveChanges={
              canSavePage
                ? async () => (await savePageSurface(pageSurface)).landed
                : undefined
            }
            discardChanges={reloadPageForPreview}
            startOnMount={previewAfterReload === pageSurface.pageId}
            onStartOnMountHandled={() => setPreviewAfterReload(null)}
            headless
            workspaceAction={workspaceActionsAvailable}
            onReveal={() => revealBentoPanel("preview")}
          />
        ),
      });
    }
    if (!content.expectedAbsent) {
      panels.push({
        id: "lifecycle",
        title: "Lifecycle",
        subtitle: "Save, review, and publish this version.",
        defaultZone: "side",
        body: (
          <>
          {content.homeCompositionVersion === 2 && savedPageBlocks.some(block => block.section === "home-newsletter" && block.visible &&
            Array.isArray(block.data.newsletterIds) && block.data.newsletterIds.length === 0) ? (
            <InlineMessage tone="info"><p>Publishing shows the standard newsletter band until a newsletter is chosen.</p></InlineMessage>
          ) : null}
          <LifecycleActionsPanel
            recordTitle={pageTitle}
            baseVersion={pageCurrentVersion}
            contentVersion={content.contentVersion ?? pageCurrentVersion}
            canArchive={can(
              principal,
              "content.delete",
              pageLifecycleResourceValue,
            )}
            canApprove={can(
              principal,
              "content.edit.any",
              pageLifecycleResourceValue,
            )}
            canEdit={
              can(principal, "content.edit.any", pageLifecycleResourceValue) ||
              can(principal, "content.edit.own", pageLifecycleResourceValue)
            }
            canPublish={can(principal, "content.publish", pageLifecycleResourceValue)}
            publicationSupported
            publicationDisabledReason={pageSurface.pageId === "home" && content.homeCompositionVersion === 2 && !homeLayoutsEnabled()
              ? "Version 2 Home editing is not enabled. Its saved draft has been preserved."
              : undefined}
            canRestore={can(
              principal,
              "content.delete",
              pageLifecycleResourceValue,
            )}
            canUnpublish={can(
              principal,
              "content.unpublish",
              pageLifecycleResourceValue,
            )}
            collection="cmsPages"
            disabledReason={lifecycleDisabledReason}
            documentId={pageSurface.pageId}
            headless
            liveSourceVersion={pageLiveSourceVersion}
            publicBuildQueueId={content.publishBuildQueueId ?? null}
            publicUpdatePending={content.publishBuildPending === true}
            pendingSourceVersion={content.publishedSourceVersion}
            onChanged={reloadPage}
            videos={videosForPublication(content.blocks)}
            onPublish={
              publishContent
                ? async (baseVersion, onProgress) => {
                    await validatePageForPublication();
                    await reserveEditorForSave();
                    return publishContent(
                      "cmsPages",
                      pageSurface.pageId,
                      baseVersion,
                      { blocks: content.blocks, onProgress },
                    );
                  }
                : undefined
            }
            onSchedule={
              scheduleContent
                ? async (baseVersion, scheduleAt, onProgress) => {
                    await validatePageForPublication();
                    await reserveEditorForSave();
                    return scheduleContent(
                      "cmsPages",
                      pageSurface.pageId,
                      baseVersion,
                      scheduleAt,
                      { blocks: content.blocks, onProgress },
                    );
                  }
                : undefined
            }
            onReload={reloadPage}
            onSubmittingChange={onLifecycleChanging}
            onTransition={
              transitionContent
                ? async (request) => {
                    if (request.action === "submit" || request.action === "approve") await validatePageForPublication();
                    await reserveEditorForSave();
                    return transitionContent(request);
                  }
                : undefined
            }
            scheduledPublishFailure={content.scheduledPublishFailure}
            scheduledAt={content.publishAt}
            status={content.pageStatus}
            workspaceActions={workspaceActionsAvailable}
            onReveal={() => revealBentoPanel("lifecycle")}
          />
          <ElectionResultsHistory approvals={content.electionResultsApprovals} />
          </>
        ),
      });
    }
    if (!content.expectedAbsent && loadRevisions && loadRevision) {
      panels.push({
        id: "revisions",
        presentation: editorView?.kind ? "history" : undefined,
        title: "Revision history",
        subtitle: "Review saved versions and changes.",
        defaultZone: "side",
        defaultCollapsed: true,
        body: (
          <RevisionHistory
            collection="cmsPages"
            currentVersion={pageCurrentVersion}
            documentId={pageSurface.pageId}
            loadRevisions={loadRevisions}
            loadRevision={loadRevision}
            onRestored={reloadPage}
            onRestoringChange={onRevisionRestoringChange}
            refreshKey={pageSaveRevision}
            restoreDisabledReason={historyRestoreDisabledReason}
            restoreRevision={restoreRevision ? restoreFromHistory : undefined}
            headless
          />
        ),
      });
    }
    return (
      <>
        {workspaceActionsAvailable ? (
          <WorkspaceStatus>
            <span className="status-label" aria-live="polite">
              {!editorView?.kind ? <span className="status-label-key">Status:</span> : null}
              {" "}
              <PublishedVersionStatus collection="cmsPages" documentId={pageSurface.pageId}
                documentBar={editorView?.kind ? { kind: "page", draftState: saving ? "saving" : activeSurfaceDirty ? "dirty" : pageCurrentVersion ? "saved" : "new" } : undefined}
                recordTitle={pageTitle}
                workingStatus={content.pageStatus ?? "draft"} workingVersion={pageCurrentVersion}
                contentVersion={content.contentVersion} liveSourceVersion={pageLiveSourceVersion}
                pendingSourceVersion={content.publishedSourceVersion}
                publicUpdatePending={content.publishBuildPending === true} statusOnly />
            </span>
            <ScheduledPublicationTime status={content.pageStatus} publishAt={content.publishAt} />
          </WorkspaceStatus>
        ) : null}
        <EditorBackLink surface={{ kind: "page" }} />
        {combinedPageActions ? (
          <EditorActionSlot group="save">
            <Toolbar className="page-update-actions" aria-label="Save page">
              <span
                className="disabled-action-shell"
                role={pageUpdateDisabledReason ? "group" : undefined}
                aria-label={
                  pageUpdateDisabledReason
                    ? `Save draft unavailable: ${pageUpdateDisabledReason}`
                    : undefined
                }
                title={pageUpdateDisabledReason}
                tabIndex={pageUpdateDisabledReason ? 0 : undefined}
              >
                <AsyncActionButton
                  variant="secondary"
                  icon="save"
                  aria-describedby={
                    pageUpdateDisabledReason ? pageUpdateReasonId : undefined
                  }
                  disabled={pageUpdateDisabled}
                  label="Save draft"
                  onClick={() => void updatePage()}
                  pending={pageUpdateSaving}
                  pendingAnnouncement="Saving draft."
                  pendingLabel="Saving…"
                />
              </span>
              {pageUpdateDisabledReason ? (
                <span className="sr-only" id={pageUpdateReasonId}>
                  {pageUpdateDisabledReason}
                </span>
              ) : null}
              {pageUpdateSaved && !successNotice.available ? (
                <span className="success-text" role="status">
                  Saved.
                </span>
              ) : null}
              {pageUpdateError ? (
                <span className="error-text" role="alert">
                  {pageUpdateError}
                </span>
              ) : null}
            </Toolbar>
          </EditorActionSlot>
        ) : null}
        <EditorBento
          storageKey="page"
          ariaLabel="Page editor sections"
          documentOutline={{
            heading: "Document",
            settingsLabel: "Page settings",
          }}
          panels={panels}
          revealPanel={bentoReveal}
        />
      </>
    );
  }

  function lockedElectionSources() {
    if (!electionSources) return null;
    let target: Pick<ElectionSourceHost, "collection" | "documentId" | "version" | "canPublish"> | null = null;
    let blocks: readonly AdminBlock[] = [];
    if (surface.kind === "page" && pageLoad.status === "ready") {
      target = { collection: "cmsPages", documentId: surface.pageId, version: Math.max(blockBaseVersion.current ?? 0, metadataBaseVersion.current ?? 0) || undefined,
        canPublish: can(principal, "content.publish", pageLifecycleResource(surface.pageId, pageLoad)) };
      blocks = [...pageLoad.blocks, ...(pageLoad.publishedElectionBlocks ?? [])];
    } else if (surface.kind === "record" && surface.record === "post" && surface.id && recordLoad.status === "ready") {
      const record = recordLoad.record;
      target = { collection: "cmsPosts", documentId: surface.id, version: typeof record.version === "number" ? record.version : undefined,
        canPublish: can(principal, "content.publish", recordLifecycleResource(record)) };
      blocks = [...(Array.isArray(record.blocks) ? record.blocks as AdminBlock[] : []),
        ...((record.published as { blocks?: AdminBlock[] } | undefined)?.blocks ?? [])];
    }
    if (!target?.canPublish) return null;
    const results = [...new Map(blocks.filter(block => block.type === "election_results").map(block => [block.id, block])).values()];
    if (!results.length) return null;
    // Inspect only the shared source controls. The locked content editor remains
    // unmounted, and pause never claims or changes the colleague's lease.
    return <ElectionResultsSourceHost.Provider value={{ ...target, api: electionSources, locked: true, pauseLocked: saving,
      hasUnsavedWork: () => false, onBusyChange: onElectionSourceBusyChange, connectionStates: noSourceConnections, onConnectedChange: noSourceChange }}>
      <Suspense fallback={null}>{results.map(block => <LockedElectionSourceControls key={block.id} block={block} readOnly onChange={noSourceChange} />)}</Suspense>
    </ElectionResultsSourceHost.Provider>;
  }

  // The five presence states a person has to be able to tell apart: read-only because somebody
  // else holds the record, a takeover this tab has asked for, a takeover that displaced this tab,
  // an expired session, and a save conflict (which stays with the version guard, not here).
  function lockedSurfaceMessage(
    lock: EditorLock,
    options?: { preserveEditor?: boolean; saving?: boolean },
  ) {
    const samePerson = lock.ownerId === editorLockActor?.id;
    // "Somebody else has this" and "somebody took this from me" are different things to be told,
    // whether or not there was unsaved work in the tab at the time.
    const displaced = editorLock.displacedBy !== null;
    const keptWork = options?.preserveEditor === true;
    const asked = editorLock.outgoingRequestPending;
    // One ask fits on a lease. Somebody already waiting is not a queue this person can join.
    const waitingElse = editorLock.requestedByOther;
    const title = displaced
      ? `${lock.ownerName} took over this record`
      : samePerson
        ? "You are editing this in another tab or window"
        : asked
          ? `Waiting for ${lock.ownerName} to hand this over`
          : `${lock.ownerName} is editing this right now`;
    const backPath =
      surface.kind === "record"
        ? recordListPath(surface.record)
        : contentPagesPath();
    return (
      <InlineMessage
        tone={displaced ? "warning" : asked ? "info" : "warning"}
        title={title}
        className={
          displaced
            ? "editor-lock-message editor-lock-message-displaced"
            : asked
              ? "editor-lock-message editor-lock-message-requested"
              : "editor-lock-message editor-lock-message-readonly"
        }
      >
        <p>
          {options?.saving
            ? "Another session took over while this tab’s save is finishing. Wait for its result before deciding whether to take over."
            : keptWork
              ? "Your unsaved changes are still here and are kept in this browser, so you can come back to them. Saving is off until you hold the record again."
              : displaced
                ? `${lock.ownerName} now holds the record and this tab is read-only. Nothing you had already saved was affected.`
                  : asked
                  ? `Your request was sent. ${lock.ownerName} can hand the record over, and this page updates on its own when it becomes free.`
                  : `${samePerson ? "That session" : "The editing session"} began ${lockStartLabel(lock)}. This tab is read-only and has not changed the content.`}
        </p>
        <div className="button-row">
          {editorLock.canTakeOver ? (
            <Button
              variant="primary"
              disabled={editorLock.claiming || options?.saving}
              onClick={() => void editorLock.takeOver()}
            >
              {editorLock.claiming
                ? "Taking over…"
                : displaced
                  ? "Take the record back"
                  : "Take over editing"}
            </Button>
          ) : null}
          {!samePerson && !asked && !waitingElse && !options?.saving ? (
            <Button
              variant={editorLock.canTakeOver ? "secondary" : "primary"}
              onClick={() => void editorLock.requestTakeover()}
            >
              Ask to edit
            </Button>
          ) : null}
          {options?.saving ? null : (
            <Link className="button button-secondary" to={backPath}>
              Back out
            </Link>
          )}
        </div>
        {waitingElse ? (
          <p>
            {`${waitingElse.byName} already asked for this record, so there is nobody to ask ahead of them. This page updates on its own when it becomes free.`}
          </p>
        ) : null}
        {!editorLock.canTakeOver && !waitingElse ? (
          <p>
            Your role cannot take another editor’s active session, so asking is the
            way in.
          </p>
        ) : null}
      </InlineMessage>
    );
  }

  // Shown to the holder. An ask never moves the record on its own: this is the person who
  // decides.
  function takeoverRequestMessage() {
    const request = editorLock.incomingRequest;
    if (!request) return null;
    return (
      <InlineMessage
        tone="info"
        title={`${request.byName} is asking to edit this`}
        className="editor-lock-message editor-lock-message-incoming"
      >
        <p>
          You still hold the record. Hand it over when you are at a good stopping
          point, or keep going and answer later.
        </p>
        <div className="button-row">
          <Button
            variant="primary"
            disabled={activeSurfaceDirty || saving}
            onClick={() => void editorLock.yieldEditor()}
          >
            Hand over editing
          </Button>
          <Button variant="secondary" onClick={() => void editorLock.dismissRequest()}>
            Keep editing
          </Button>
        </div>
        {activeSurfaceDirty ? (
          <p>Save or discard your changes first, then hand it over.</p>
        ) : null}
      </InlineMessage>
    );
  }

  function yieldedMessage() {
    return (
      <InlineMessage
        tone="info"
        title="You handed this record over"
        className="editor-lock-message editor-lock-message-yielded"
      >
        <p>
          This tab is read-only until you ask for the record back. Nothing you saved
          was lost.
        </p>
        <div className="button-row">
          <Button variant="primary" onClick={() => void editorLock.reclaim()}>
            Take the record back
          </Button>
        </div>
      </InlineMessage>
    );
  }

  function recoveredWorkMessage() {
    if (!recoveredWork) return null;
    return (
      <InlineMessage
        tone="info"
        title="Recovered your unsaved changes"
        className="editor-lock-message editor-lock-message-recovered"
      >
        <p>
          {`These are the changes you had open when ${recoveredWork.displacedBy} took over on ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(recoveredWork.savedAtMs))}. Review them before saving, because the record may have changed since.`}
        </p>
        <div className="button-row">
          <Button variant="secondary" onClick={discardRecoveredWork}>
            Dismiss this notice
          </Button>
        </div>
      </InlineMessage>
    );
  }

  function unavailableRecord(
    recordSurface: Extract<Surface, { kind: "record" }>,
    title: string,
    description: string,
    allowCreate = true,
  ) {
    const label = labelForSurface(recordSurface).toLowerCase();
    return (
      <EmptyState
        title={title}
        description={description}
        action={
          <div className="button-row">
            <Link
              className="button button-secondary"
              to={recordListPath(recordSurface.record)}
            >
              Back to {label} list
            </Link>
            {allowCreate && canSave ? (
              <Link
                className="button button-primary"
                to={createRecordPath(recordSurface.record)}
              >
                Create a new {label}
              </Link>
            ) : null}
          </div>
        }
      />
    );
  }

  const loadedRecordTitle =
    surface.kind === "record" && recordLoad.status === "ready"
      ? ["title", "headline", "name"]
          .map((key) => recordLoad.record[key])
          .find(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
      : undefined;
  const workspaceDocumentTitle =
    surface.kind === "record-list" && surface.record === "post"
      ? "Posts"
      : surface.kind === "record" && surface.id === null
      ? `New ${recordDestination(surface.record).label.toLowerCase()}`
      : surface.kind === "page" && pageLoad.status === "ready" && typeof pageLoad.metadata.title === "string"
        ? pageLoad.metadata.title : loadedRecordTitle ?? labelForSurface(surface);
  // Read by the displacement snapshot, which fires from an effect and needs the title the person
  // was actually looking at rather than one captured when the callback was created.
  workspaceTitleRef.current = workspaceDocumentTitle;

  return (
    <EditorActionsProvider label={workspaceActionsAvailable
      ? surface.kind === "page" ? "Page"
        : surface.kind === "record" && recordKindHasPublicRoute(surface.record)
          ? recordDestination(surface.record).label : null
      : null}>
    <section className="content-studio" aria-label="Content studio">
      {autoSaveEnabled && autosave !== "idle" && !(autosave === "saved" && activeSurfaceDirty) ? (
        <WorkspaceFeedback>
          <p role="status">{autosave === "saving" ? "Saving draft…" : autosave === "saved" ? "Draft autosaved." : "Autosave did not finish. Check the editor and save again."}</p>
        </WorkspaceFeedback>
      ) : null}
      <div className="content-studio-layout">
        {!controlledSurface ? (
          <div
            className="content-surface-picker"
            aria-label="Component surface picker"
          >
            {RECORD_DESTINATIONS.map((choice) => (
              <Button
                aria-label={choice.label}
                aria-current={
                  surface.kind === "record" && surface.record === choice.record
                    ? "page"
                    : undefined
                }
                disabled={saving}
                key={choice.record}
                onClick={() =>
                  selectIsolatedSurface({
                    kind: "record",
                    record: choice.record,
                    id: null,
                  })
                }
                variant="ghost"
              >
                <Icon name="file" />
                <span>{choice.label}</span>
              </Button>
            ))}
            {PAGE_DESTINATIONS.map((choice) => {
              const value: Surface = {
                kind: "page",
                pageId: choice.pageId,
                section: choice.section,
              };
              return (
                <Button
                  aria-label={choice.label}
                  aria-current={
                    isSameSurface(surface, value) ? "page" : undefined
                  }
                  disabled={saving}
                  key={choice.pageId}
                  onClick={() => selectIsolatedSurface(value)}
                  variant="ghost"
                >
                  <Icon name="content" />
                  <span>{choice.label}</span>
                </Button>
              );
            })}
          </div>
        ) : null}
        <WorkspaceTitle>
          <h1 id="page-title" className="programmatic-focus-target">
            {editorView?.kind === "post" && surface.kind === "record" && surface.id !== null ? "Edit post" : workspaceDocumentTitle}
          </h1>
        </WorkspaceTitle>
        <Panel
          className={surface.kind === "page-list" || surface.kind === "record-list" || surface.kind === "library" ? "editor-canvas content-browse-panel" : "editor-canvas"}
          aria-labelledby="page-title"
        >
          <div
            className={
              surface.kind === "page-list" || surface.kind === "record-list" || surface.kind === "library"
                ? "editor-form-region editor-form-region-wide content-browse-region"
                : "editor-form-region editor-form-region-wide"
            }
          >
            {editorLockCanGateActiveEditor && editorLock.checking ? (
              <div className="editor-loading">
                <LoadingIndicator
                  label="Checking whether someone else is editing"
                  stages={[
                    "Reading the editor lease for this surface",
                    "Comparing it with your session",
                  ]}
                />
              </div>
            ) : editorLockCanGateActiveEditor &&
              editorLock.blockingLock &&
              (!saving || changingElectionSources) &&
              !activeSurfaceDirty ? (
              <>{lockedSurfaceMessage(editorLock.blockingLock)}{lockedElectionSources()}</>
            ) : (
              <>
                {editorLockCanGateActiveEditor && editorLock.blockingLock ? (
                  lockedSurfaceMessage(editorLock.blockingLock, {
                    preserveEditor: true,
                    saving,
                  })
                ) : editorLockCanGateActiveEditor &&
                  editorLock.lockUnavailable ? (
                  <InlineMessage
                    tone="warning"
                    title="Editing presence is unavailable"
                  >
                    The courtesy lock could not be checked. Version conflict
                    protection still guards every save.
                  </InlineMessage>
                ) : editorLockCanGateActiveEditor && editorLock.yielded ? (
                  yieldedMessage()
                ) : editorLockCanGateActiveEditor && editorLock.staleLock ? (
                  <InlineMessage
                    tone="info"
                    title="The previous editing session expired"
                  >
                    Nobody has renewed that session, so this tab is reserving the
                    record now. The existing version check still protects content
                    saved from another session.
                  </InlineMessage>
                ) : editorLockCanGateActiveEditor && editorLock.claiming ? (
                  <div className="editor-lock-status">
                    <LoadingIndicator
                      label="Reserving this editor"
                      stages={[
                        "Claiming the editor lease for your session",
                        "Confirming no one else holds it",
                      ]}
                    />
                  </div>
                ) : null}
                {editorLockCanGateActiveEditor ? takeoverRequestMessage() : null}
                {recoveredWorkMessage()}
                {surface.kind === "page-list" ? (
                  <PagesDirectory api={pageDirectoryApi} persistentEditorDirty={dirty} />
                ) : surface.kind === "library" || (surface.kind === "record-list" && surface.record === "post") ? (
                  <ContentLibrary
                    key={surface.kind === "library" ? "library" : "posts"}
                    postOnly={surface.kind === "record-list"}
                    persistentEditorDirty={dirty}
                    archiveRecords={archiveLibraryRecords}
                    canArchive={canArchiveLibrary}
                    canCreate={canSave}
                    currentUserId={principal.id}
                    loadSelection={loadLibrarySelection}
                    loadSavedViews={loadSavedViews}
                    mutateSavedViews={mutateSavedViews}
                    onMutatingChange={onLibraryMutatingChange}
                  />
                ) : surface.kind === "record-list" ? (
                  <RecordList
                    key={surface.record}
                    canCreate={canSave}
                    kind={surface.record}
                    label={labelForSurface(surface)}
                    loadRecords={listRecords}
                    persistentEditorDirty={dirty}
                  />
                ) : surface.kind === "record" ? (
                  surface.id === null ? (
                    recordFormFor(surface, recordDraftFor(surface))
                  ) : !loadRecord ? (
                    unavailableRecord(
                      surface,
                      "Record editing unavailable",
                      "This editor has no record data source, so it cannot safely open the addressed record.",
                      false,
                    )
                  ) : recordLoad.status === "ready" ? (
                    loadedRecordFormFor(surface, recordLoad)
                  ) : recordLoad.status === "missing" ? (
                    unavailableRecord(
                      surface,
                      `This ${labelForSurface(surface).toLowerCase()} could not be found`,
                      "It may have been removed, or the link may be out of date.",
                    )
                  ) : recordLoad.status === "deleted" ? (
                    unavailableRecord(
                      surface,
                      `This ${labelForSurface(surface).toLowerCase()} was deleted`,
                      "Deleted records cannot be edited here.",
                      false,
                    )
                  ) : recordLoad.status === "invalid" ? (
                    unavailableRecord(
                      surface,
                      "This record cannot be opened",
                      "Its stored type does not match this address, so editing is disabled.",
                      false,
                    )
                  ) : recordLoad.status === "error" ? (
                    <InlineMessage
                      tone="error"
                      title="Record editing unavailable"
                    >
                      <span className="error-text">
                        {recordLoad.message} Editing is disabled so a save
                        cannot overwrite the stored record.
                      </span>
                      <Button onClick={reloadRecord}>
                        Try loading the record again
                      </Button>
                    </InlineMessage>
                  ) : (
                    <EditorFormSkeleton label="Loading the record" />
                  )
                ) : !loadPage ? (
                  // Bare render (tests) with no hydration source: the editor starts empty, every
                  // time. Production always injects loadPage, so this path is a test-only
                  // affordance, and #579's keep-the-draft guarantee is scoped to the hydrated path
                  // rather than reimplemented here for a branch nothing ships. Nothing read the
                  // page, so there is no version to claim and no read to repeat: the save echoes
                  // nothing and there is no reload to offer, which means a conflict cannot arise
                  // here to need one.
                  <BlockEditor
                    key={surface.pageId}
                    section={surface.section}
                    canSave={canSaveInActiveEditor}
                    saveDisabledReason={editorLockSaveDisabledReason}
                    newId={newId}
                    loadMedia={loadMedia}
                    mediaPickerUnavailable={mediaPickerUnavailable}
                    uploadMedia={uploadMedia}
                    mediaCategories={mediaCategories}
                    defaultUploadCategory={defaultUploadCategory}
                    canUploadCategory={canUploadCategory}
                    onMediaPickerDirtyChange={onMediaPickerDirtyChange}
                    onSave={
                      savePage
                        ? async (blocks) => {
                            await reserveEditorForSave();
                            const saved = await savePage(
                              surface.pageId,
                              surface.section,
                              blocks,
                            );
                            return {
                              blocks: saved.blocks,
                              mintedIds: saved.mintedIds ?? {},
                              warnings: saved.warnings ?? [],
                            };
                          }
                        : undefined
                    }
                    onSavingChange={onPageBlocksSavingChange}
                    onDraftChange={(blocks) => trackPageDraft(surface, blocks)}
                  />
                ) : pageLoad.status === "error" ? (
                  // The read is the only way back to a page, so a failure here has to stay
                  // askable. It is reached two ways -- selecting a page, and reloading after a
                  // conflict -- and the second is why the retry is not a convenience (#574): that
                  // reload has already discarded the person's blocks, by their own instruction and
                  // by unmounting the editor. Without a retry they are left holding neither their
                  // work nor the page they traded it for, and "Save anyway" is foreclosed too
                  // because it needed those blocks. The retry does not give the blocks back. It
                  // finishes the trade.
                  <InlineMessage
                    className="page-load-error"
                    tone="error"
                    title="Page editing unavailable"
                  >
                    <span className="error-text">
                      {pageLoad.message} Editing is disabled so a save cannot
                      overwrite the stored page.
                    </span>
                    <Button variant="primary" onClick={reloadPage}>
                      Try loading the page again
                    </Button>
                  </InlineMessage>
                ) : pageLoad.status === "ready" ? (
                  // Both forms are hydrated from the same page snapshot and persist partial document
                  // overlays. Saving metadata never replaces blocks, and saving blocks never drops
                  // metadata; the shared version claim still catches an intervening page write.
                  pageEditorsFor(surface, pageLoad)
                ) : (
                  <EditorFormSkeleton label="Loading the page" />
                )}
              </>
            )}
          </div>
        </Panel>
      </div>
    </section>
    </EditorActionsProvider>
  );
}

/*
  The one visible way out of an open editor (#1037). It is a router Link, not a history step, so
  it rides the same navigation guard as every other exit: a leave that would drop unsaved work is
  held and confirmed by the content layout's blocker, while a move that keeps the editor mounted
  goes through with the draft intact. Where it points is decided by editorBackDestination from the
  list the editor was opened from, so a filtered library comes back filtered while a direct link,
  or a reload that carried no origin, falls back to the editor's own list.
*/
interface EditorBackLinkProps {
  surface: { kind: "record"; record: RecordKind } | { kind: "page" };
  listLabel?: string;
}

// The isolated specimen gallery renders editor surfaces outside a router to check their geometry.
// There is nowhere to navigate there, so the action is simply absent rather than throwing on a
// router hook. Every routed surface — every surface a person actually edits in — renders it.
function EditorBackLink(props: EditorBackLinkProps) {
  const view = useEditorWorkspaceView();
  const inRouter = useInRouterContext();
  if (view?.kind) return null;
  return inRouter ? <RoutedEditorBackLink {...props} /> : null;
}

function RoutedEditorBackLink({ surface, listLabel }: EditorBackLinkProps) {
  const location = useLocation();
  const destination = editorBackDestination({
    surface,
    listLabel,
    origin: readListOrigin(location.state),
  });
  return (
    <Link className="editor-back" to={destination.to}>
      <Icon name="arrow-left" />
      {destination.label}
    </Link>
  );
}
