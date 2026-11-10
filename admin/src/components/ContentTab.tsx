import { electionSourceApi } from "../lib/election-sources";
import type { ReportingEditorTransport, ReportingPreview } from "./DataHubReportingEditor";
import { parseReportingStory } from "../../../packages/content-core/src/data-hub-reporting-sources";
import { preparePrivatePreviewSession } from "../lib/staff-site";
import { homeLayoutsEnabled } from "../lib/home-layouts";
import {
  assertHomeV2WriterEnabled,
  pageBlocksSaveRequest,
  readVersion,
  readSaveBaseVersion,
  recordSaveRequest,
  storedPageContentFromDocument,
  type StoredPageContent,
} from "../lib/content-save-request";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type {
  LoadedRecord,
  PageContent,
  Surface,
} from "./EditorWorkspace";
import {
  ContentBrowseWorkspace,
  type BrowseSurface,
} from "./ContentBrowseWorkspace";
import type { RecordSaveReceipt } from "./RecordForm";
import type { RecordListPage } from "./RecordList";
import { useAuth } from "../context/AuthContext";
import { usageActionCollector } from "../lib/boardwalk-usage";
import {
  cmsBulkArchiveContent,
  cmsGetContent,
  cmsGetCoverageLabels,
  cmsGetRevision,
  cmsAssignContent,
  cmsListContent,
  cmsListPages,
  cmsPublishedVocabulary,
  postFunction,
  cmsListBylineAuthors,
  cmsListMedia,
  cmsListRevisions,
  cmsLoadPagePreviewStatus,
  cmsRequestSavedPreview,
  cmsPublish,
  cmsRequestPagePreview,
  cmsRestoreRevision,
  cmsTransitionContent,
  cmsSaveContent,
  cmsCapturePostTemplate,
  createReplayConflictRecordId,
  type CapturePostTemplateRequest,
  HttpError,
  type BulkArchiveItem,
  type GetContentResponse,
  type MediaListQuery,
  type UploadMediaMetadata,
  type PublicRuntimeReceipt,
} from "../lib/functions";
import { loadAssignableUsers as loadAssignmentStaff } from "../lib/assignments";
import { newLiveBlogVideoBlocks, saveContentWithPublicVideos, type PublicationVideoOptions } from "../lib/publication-videos";
import { parseScheduledPublishFailure } from "../../../packages/content-core/src/content-model";
import { db } from "../lib/firebase";
import { useContentSectionRegistry } from "../lib/use-content-sections";
import { useMediaCategories } from "../lib/use-media-categories";
import { normalizeEditorRecordDates } from "../lib/content-records";
import {
  DEFAULT_CONTENT_QUERY,
  encodeContentQuery,
  type ContentQuery,
} from "../lib/content-query";
import type { AdminBlock } from "../lib/block-factory";
import type {
  RecordKind,
  SectionId,
} from "../../../packages/content-core/src/editor-admin";
import { contentSectionForPublicPage } from "../../../packages/content-core/src/content-sections";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";
import type { ExitSaveOutcome } from "../lib/exit-save";
import {
  can,
  hasCapability,
  type Principal,
} from "../../../packages/content-core/src/rbac";
import type { PageDirectoryApi } from "./PagesDirectory";
import { pageCompositionSeed } from "../../../packages/content-core/src/page-composition-seeds";
import { homeCompositionDefaults } from "../../../packages/content-core/src/home-composition";
import {
  canSaveContent,
  canUploadMedia,
  canUseEditorLocks,
  canUseMediaLibrary,
} from "../lib/access";
import { defaultMediaUploadCategory, uploadMediaReusingDuplicates } from "../lib/media-upload";
import {
  pageMetadataFromDocument,
  pageMetadataSaveDocument,
} from "../lib/page-metadata";
import { editorLockClient } from "../lib/editor-lock-store";
import {
  loadContentLibraryViews,
  mutateContentLibraryViews,
} from "../lib/saved-content-view-store";
import type { SavedContentViewMutation } from "../lib/saved-content-views";
import { ContentStudioSkeleton } from "./EditorSkeleton";
import { SaveConflictReviewDialog } from "./SaveConflictReviewDialog";
import { editableBlocksForPublicPage } from "../lib/public-page-block-ownership";

const EditorWorkspace = lazy(async () => ({
  default: (await import("./EditorWorkspace")).EditorWorkspace,
}));
const EditorLayoutMode = lazy(async () => ({
  default: (await import("./EditorLayoutMode")).EditorLayoutMode,
}));

function isBrowseSurface(
  surface: Surface | undefined,
): surface is BrowseSurface {
  return (
    surface?.kind === "page-list" ||
    surface?.kind === "library" ||
    surface?.kind === "record-list"
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pagePublicationState(document: Record<string, unknown>) {
  const published = isPlainRecord(document.published)
    ? document.published
    : {};
  return {
    publishedElectionBlocks: Array.isArray(published.blocks) ? published.blocks.filter(block => isPlainRecord(block) && block.type === "election_results" && typeof block.id === "string") as unknown as AdminBlock[] : [],
    electionResultsApprovals: Array.isArray(document.electionResultsApprovals) ? document.electionResultsApprovals : undefined,
    contentVersion: readVersion(document.contentVersion ?? document.version),
    publiclyVisible:
      typeof document.publiclyVisible === "boolean"
        ? document.publiclyVisible
        : undefined,
    publicSourceVersion: readVersion(document.publicSourceVersion),
    publishedSourceVersion: readVersion(published.sourceVersion),
    publishBuildPending: document.publishBuildPending === true,
    publishBuildQueueId:
      typeof document.publishBuildQueueId === "string"
        ? document.publishBuildQueueId
        : null,
  };
}

// A composition seed supplies the current visible metadata until an editor saves an explicit
// value. Stored keys always win, including an intentional empty string. Merge the nested groups
// separately so saving one SEO override does not drop another seeded default on reopen.
function metadataDocumentWithSeed(
  pageId: PublicPageId,
  document: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = pageCompositionSeed(pageId)?.metadata ?? {};
  const merged = { ...defaults, ...document };
  for (const group of ["seo", "social"] as const) {
    const seededGroup = defaults[group];
    const storedGroup = document[group];
    if (isPlainRecord(seededGroup) || isPlainRecord(storedGroup)) {
      merged[group] = {
        ...(isPlainRecord(seededGroup) ? seededGroup : {}),
        ...(isPlainRecord(storedGroup) ? storedGroup : {}),
      };
    }
  }
  return merged;
}

// The Content tab is the editor workspace. It was a placeholder while the content model was
// gated on the block-catalog research brief; ADR 0013 fixed the catalog, so the editor now
// lands here on the decision core (issue #201).
//
// This layer owns the auth token and the authenticated function boundary, keeping
// EditorWorkspace free of
// both (so it stays a pure, directly-rendered component in tests). A page is a cmsPages
// document keyed by its canonical public page id; its section is a separate editor template:
//   - loadPage reads the page's stored blocks so the editor hydrates before it can save. A
//     save sends the whole block list, so editing must start from the stored composition, or
//     a save from a blank editor would overwrite the live page (#515 data-loss guard). The
//     cmsGetContent authorizes the read against the same capability model as the server-owned
//     write path. A never-created page has no doc, so it hydrates to an empty list and the first
//     save creates it.
//   - savePage sends the blocks and registry-derived editor template, so the server preserves
//     the page's other stored fields and returns the persisted blocks with their canonical ids
//     for the editor to adopt (#515). When loadPage had to use a legacy template singleton, it
//     also sends that source id and version; the server clones its protected metadata in the
//     same create transaction rather than trusting the browser to round-trip it.
//
// Both also carry the page's `version` (#530, wired here by #563). The load reads it from the
// same authenticated response the blocks come from, and the save echoes it back as
// `baseVersion` and returns
// the new one. That pairing is the point: the version has to describe the exact content the
// person is looking at, so reading it anywhere other than the document the editor was seeded
// from would make the claim a lie.
export function ContentTab({
  principal,
  enforcePublicPageOwnership = true,
  canArchiveLibrary = false,
  previewConfigured = import.meta.env.VITE_CMS_PREVIEW_ENABLED === "true",
  onSavingChange,
  surface,
  onNavigateSurface,
  onDirtyChange,
  unsavedProbeRef,
  saveRequestRef,
}: {
  principal: Principal;
  // Production keeps this on. Direct integration tests can turn it off when Home is only a
  // compact generic fixture for another ContentTab behavior; dedicated tests hold this policy.
  enforcePublicPageOwnership?: boolean;
  // Mirrors the content.delete backend boundary. An unpublish capability alone
  // cannot expose the archive control.
  canArchiveLibrary?: boolean;
  // The build-time operational flag is injectable at this boundary so callers, previews, and
  // tests can render an explicit deployment configuration. It never grants access by itself:
  // the content-read capability boundary below remains mandatory.
  previewConfigured?: boolean;
  // Forwarded from EditorWorkspace up to the shell so a page save in flight also holds the
  // primary tab nav, which lives above this boundary (#515). Threaded straight through; this
  // layer adds no save state of its own.
  onSavingChange?: (saving: boolean) => void;
  // The URL-derived surface and its navigation and dirty callbacks, threaded from the content
  // layout straight to the editor (#580). This layer owns the auth token and the Firestore
  // boundary only; routing state passes through it untouched. All optional, so the tab still
  // renders uncontrolled where no router drives it (the shipped shell before #580, and tests).
  surface?: Surface;
  onNavigateSurface?: (
    surface: Surface,
    options?: { replace?: boolean; committed?: boolean },
  ) => void;
  onDirtyChange?: (dirty: boolean) => void;
  unsavedProbeRef?: MutableRefObject<(() => boolean) | null>;
  saveRequestRef?: MutableRefObject<(() => Promise<ExitSaveOutcome>) | null>;
}) {
  const { getIdToken, state } = useAuth();
  const [conflictReview, setConflictReview] = useState<{
    title: string; version: number; document: Record<string, unknown>; proposed: Record<string, unknown>;
    kind: "page" | RecordKind; pageId: string; finish: (confirmed: boolean) => void;
  } | null>(null);
  const pendingConflictReview = useRef<((confirmed: boolean) => void) | null>(null);
  const conflictReviewInFlight = useRef(false);
  const reviewLifetime = useRef({ active: true });
  useEffect(() => {
    const lifetime = { active: true };
    reviewLifetime.current = lifetime;
    return () => { lifetime.active = false; pendingConflictReview.current?.(false); };
  }, []);
  const reviewCurrentSaveVersion = useCallback(async (collection: "cmsPages" | "cmsPosts", id: string,
    proposal: Record<string, unknown> | ((document: Record<string, unknown>) => Record<string, unknown>), loadedPage?: StoredPageContent) => {
    if (conflictReviewInFlight.current) throw new Error("Finish reviewing the other save before retrying. Your edits are still here.");
    conflictReviewInFlight.current = true;
    try {
      const lifetime = reviewLifetime.current;
      const assertActive = () => { if (!lifetime.active) throw new Error("The editor closed before this save was confirmed."); };
      const latest = await cmsGetContent(await getIdToken(), { collection, id });
      assertActive();
      if (!latest.found || !latest.document) throw new Error("This content is no longer available. Your edits are still here.");
      const document = latest.document;
      const publishedMetadata = isPlainRecord(document.published) && isPlainRecord(document.published.metadata) ? document.published.metadata : {};
      if ((collection === "cmsPosts" && (document.liveBlog !== undefined || publishedMetadata.liveBlog !== undefined)) ||
          (collection === "cmsPages" && (document.homeCompositionVersion !== undefined || document.serviceCompositionVersion !== loadedPage?.serviceCompositionVersion))) {
        throw new Error("This content needs to be reopened before saving. Your edits are still here and have not been saved. Keep a copy, then reload before saving.");
      }
      const proposed = typeof proposal === "function" ? proposal(document) : proposal;
      if (collection === "cmsPosts" && document.type !== proposed.type) throw new Error("This record changed. Your edits are still here.");
      const version = readSaveBaseVersion(document.version);
      if (version === undefined) throw new Error("The latest saved version could not be checked. Your edits are still here.");
      const confirmed = await new Promise<boolean>(resolve => {
        const finish = (accepted: boolean) => {
          pendingConflictReview.current = null;
          if (lifetime.active) setConflictReview(null);
          resolve(accepted);
        };
        pendingConflictReview.current = finish;
        setConflictReview({ title: String(document.title ?? document.name ?? "Untitled content"), version, document, proposed,
          kind: collection === "cmsPages" ? "page" : document.type as RecordKind, pageId: id, finish });
      });
      if (!confirmed) throw new Error("Your edits are still here and have not been saved.");
      assertActive();
      return { document, version, assertActive };
    } finally {
      conflictReviewInFlight.current = false;
    }
  }, [getIdToken]);
  // A direct browse address never needs the editor graph. The first editor address mounts the
  // lazy workspace immediately; after that, keep it mounted even while the URL points back to a
  // list or library so drafts and clean baselines survive that movement (#579/#595).
  const editorSurfaceSelected = !isBrowseSurface(surface);
  const [editorActivated, setEditorActivated] = useState(editorSurfaceSelected);
  useEffect(() => {
    if (editorSurfaceSelected) setEditorActivated(true);
  }, [editorSurfaceSelected]);
  const editorWorkspaceMounted = editorActivated || editorSurfaceSelected;

  // Before the editor has ever mounted, a browse surface cannot own a draft or an exit-save
  // callback. Pin those host seams to their clean state rather than leaving stale values in a
  // caller that reuses the same refs across content addresses.
  useEffect(() => {
    if (editorWorkspaceMounted) return;
    onDirtyChange?.(false);
    if (unsavedProbeRef) unsavedProbeRef.current = null;
    if (saveRequestRef) saveRequestRef.current = null;
  }, [
    editorWorkspaceMounted,
    onDirtyChange,
    saveRequestRef,
    unsavedProbeRef,
  ]);

  // One create surface exists per record kind (`record:<kind>:+`). Keep its nonce
  // beside that surface so a successful create in another draft cannot consume or
  // clear the retry identity of a failed request (#542).
  const pendingCreateNonces = useRef(new Map<RecordKind, string>());
  const pendingPostDuplicateNonces = useRef(new Map<string, string>());
  // Keep the complete authenticated snapshot and its trusted composition marker together.
  // Legacy Home shelf saves need the raw blocks to restore every ignored value byte-for-byte;
  // marked Home saves need the marker to admit the complete fixed composition. One entry per
  // page is enough because every successful response replaces it with the new server state.
  const storedPageBlocks = useRef(new Map<PublicPageId, StoredPageContent>());
  // A successful content read admits this editor. Preview keeps the same coarse
  // capabilities; the server checks stored ownership and area on each request.
  // Own-content readers retain preview access after submitting for review.
  const previewEnabled = previewConfigured &&
    (["content.create", "content.edit.any", "content.edit.own"] as const).some(
      capability => hasCapability(principal, capability),
    );
  // The desks a new record can be created into (#845). Same live registry the Staff access
  // grant picker reads, so a grant can never name a section the record form does not offer.
  const { sections: contentSections, ready: sectionsReady } = useContentSectionRegistry();
  // Reader identity owns private rows; registry labels do not change its authority.
  const loadDirectoryPages = useCallback(
    async () => (await cmsListPages(await getIdToken())).pages,
    [getIdToken, principal],
  );
  const pageDirectoryApi = useMemo<PageDirectoryApi>(() => {
    const sections = contentSections.filter(section => {
      const resource = { section: section.id, ownerId: principal.id };
      return can(principal, "content.create", resource) &&
        (can(principal, "content.edit.any", resource) || can(principal, "content.edit.own", resource));
    });
    return {
      sections, canCreate: sections.length > 0,
      canOpenBuiltIn: id => can(principal, "content.edit.any", { section: contentSectionForPublicPage(id) ?? undefined }),
      load: loadDirectoryPages,
      create: async ({ title, slug, section, idempotencyKey }) => {
        const response = await cmsSaveContent(await getIdToken(), {
          collection: "cmsPages", slug, section, idempotencyKey,
          document: { title, template: "genericPage", blocks: [] },
        });
        if (typeof response.document.id !== "string") throw new Error("The new page receipt is missing its ID.");
        return { id: response.document.id };
      },
    };
  }, [contentSections, principal, getIdToken, loadDirectoryPages]);
  const { state: mediaCategoryRegistry } = useMediaCategories(editorWorkspaceMounted);
  const editorLockActor = useMemo(() => {
    // Presence locks remain direct Firestore reads and writes. Resolve eligibility from the same
    // site-wide content-write principal as the rules boundary, while the authenticated state
    // supplies only the verified uid and display identity written into the lease.
    if (
      !state ||
      state.status !== "signed-in" ||
      !canUseEditorLocks(state.principal)
    ) {
      return undefined;
    }
    return {
      id: state.user.uid,
      name:
        state.userDoc?.displayName ??
        state.user.displayName ??
        state.user.email ??
        "Another editor",
    };
  }, [state]);

  const loadPage = useCallback(
    async (pageId: PublicPageId, section: SectionId): Promise<PageContent> => {
      const idToken = await getIdToken();
      let response: GetContentResponse;
      let inheritedLegacyDocument = false;
      let expectedAbsent = false;
      try {
        response = await cmsGetContent(idToken, {
          collection: "cmsPages",
          id: pageId,
        });
        expectedAbsent = !response.found;
        // The former route contract stored non-home work under one template singleton. An
        // operator who used those direct URLs may therefore have cmsPages/programLanding or
        // cmsPages/genericPage content even though the directory exposed only Home. Seed an
        // unmigrated real page from that legacy document rather than making the work disappear.
        // Its first save still targets pageId, creating an independent copy and leaving the
        // ambiguous shared source untouched for the other pages that may need it.
        if (!response.found && pageId !== section) {
          try {
            response = await cmsGetContent(idToken, {
              collection: "cmsPages",
              id: section,
            });
            inheritedLegacyDocument = response.found;
          } catch (error) {
            // The page-id read above is authoritative for access to this page. A contributor may
            // be allowed to create that absent canonical page while the optional shared legacy
            // singleton is either unreadable or soft-deleted. In either case, continue without a
            // legacy seed; the expected-absent claim still protects the first page-specific create.
            // Errors from the primary read, and statuses other than those two from this probe,
            // keep their existing honest error mappings in the outer catch below.
            if (!(
              error instanceof HttpError &&
              (error.status === 403 || error.status === 404)
            )) {
              throw error;
            }
          }
        }
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) {
          throw new Error("You do not have permission to edit this page.");
        }
        if (error instanceof HttpError && error.status === 404) {
          throw new Error("This page is no longer available.");
        }
        throw new Error("The page could not be loaded. Reload to try again.");
      }
      // A never-created page (neither a page-id doc nor a legacy template doc), or an unmarked
      // metadata-only page, opens empty; the first save creates it.
      if (!response.found || !response.document) {
        const seed = pageCompositionSeed(pageId);
        const seededBlocks = seed ? (seed.blocks as AdminBlock[]) : [];
        storedPageBlocks.current.set(pageId, { blocks: seededBlocks });
        return {
          blocks: enforcePublicPageOwnership
            ? editableBlocksForPublicPage(pageId, seededBlocks)
            : seededBlocks,
          metadata: pageMetadataFromDocument(pageId, seed?.metadata ?? {}),
          expectedAbsent,
        };
      }
      const data = response.document;
      // Ownership and lifecycle come from the same authorized server response as the page body.
      // They are part of the save claim for an existing canonical page: edit-own authority covers
      // only the trusted owner's draft, while edit-any authority may save any state. A legacy
      // singleton's ownership does not become the new page's ownership until the server creates
      // it, but its lifecycle does: cmsSaveContent clones that status and applies the corresponding
      // publish transition gate to the absent target, so the workspace must receive it too.
      const createdBy = inheritedLegacyDocument
        ? undefined
        : readNonEmptyString(data.createdBy);
      const status = readNonEmptyString(data.status);
      // Existing home documents predate per-page identity and carry no template. New saves do,
      // which lets a read refuse a page stored against the wrong palette rather than open blocks
      // under different placement rules. The public registry remains authoritative.
      if (data.template !== undefined && data.template !== section) {
        throw new Error(
          "This page's saved editor template does not match the live-page registry.",
        );
      }
      // A legacy version describes the shared template document, not the new page-id target.
      // Echoing it would make the first page-specific save conflict with a document that does not
      // exist. The separate expected-absent claim below guards that first page-specific create.
      const version = inheritedLegacyDocument
        ? undefined
        : readSaveBaseVersion(data.version);
      const scheduledPublishFailure = parseScheduledPublishFailure(
        data.scheduledPublishFailure,
      );
      const seedFromLegacyPage = inheritedLegacyDocument
        ? { id: section, version: readSaveBaseVersion(data.version) }
        : undefined;
      // Stored blocks are always server-validated on write, so a malformed value means drift or
      // corruption. Refuse to mount the editor on it — a bad shape would crash on render, and a
      // non-array would be treated as empty and let a save wipe the stored page. Route to the
      // load-error state instead (full document schema validation is tracked in #531).
      const storedPage = storedPageContentFromDocument(pageId, data);
      storedPageBlocks.current.set(pageId, storedPage);
      return {
        blocks: enforcePublicPageOwnership
          ? editableBlocksForPublicPage(
              pageId,
              storedPage.blocks,
              storedPage.homeCompositionVersion,
            )
          : storedPage.blocks,
        homeCompositionVersion: storedPage.homeCompositionVersion,
        metadata: pageMetadataFromDocument(
          pageId,
          metadataDocumentWithSeed(pageId, data),
        ),
        createdBy,
        editingSection: readNonEmptyString(data.section),
        status,
        version,
        scheduledPublishFailure,
        publishAt: typeof data.publishAt === "string" ? data.publishAt : undefined,
        ...pagePublicationState(data),
        expectedAbsent,
        seedFromLegacyPage,
      };
    },
    [enforcePublicPageOwnership, getIdToken],
  );

  const convertHome = useCallback(async (baseVersion: number, requestKey: string): Promise<PageContent> => {
    const idToken = await getIdToken();
    let saveError: unknown;
    try {
      await cmsSaveContent(idToken, {
        collection: "cmsPages", id: "home", baseVersion, convertHome: requestKey,
        document: { blocks: homeCompositionDefaults() },
      });
    } catch (error) {
      saveError = error;
    }
    // A lost response does not prove failure. Read the authorized canonical
    // record before allowing a retry, and adopt any already-converted draft.
    const current = await loadPage("home", "home");
    if (current.homeCompositionVersion === 1) return current;
    if (saveError) throw saveError;
    throw new Error("Home changed before its converted draft could be loaded. Reload to review its current version.");
  }, [getIdToken, loadPage]);

  const convertHomeV2 = useCallback(async (baseVersion: number, requestKey: string): Promise<PageContent> => {
    if (!homeLayoutsEnabled()) throw new Error("Editorial Home editing is not enabled. Its saved draft has been preserved.");
    if (!can(principal, "content.edit.any", { section: contentSectionForPublicPage("home") ?? undefined })) {
      throw new Error("Home requires edit access in the Station area.");
    }
    const idToken = await getIdToken();
    let saveError: unknown;
    try {
      await cmsSaveContent(idToken, {
        collection: "cmsPages", id: "home", baseVersion, convertHomeV2: requestKey, document: {},
      });
    } catch (error) {
      saveError = error;
    }
    // Read back after an uncertain response before retrying the same request key.
    const current = await loadPage("home", "home");
    if (current.homeCompositionVersion === 2) return current;
    if (saveError) throw saveError;
    throw new Error("Home changed before its editorial draft could be loaded. Reload to review its current version.");
  }, [getIdToken, loadPage, principal]);

  // `baseVersion` is the version the edit was composed against, echoed so the server can
  // refuse a save that would overwrite a change the editor never saw (#530). Every
  // existing Page needs this claim. Never-created Pages carry `createOnly` instead (#567).
  const savePage = useCallback(
    async (
      pageId: PublicPageId,
      section: SectionId,
      blocks: AdminBlock[],
      baseVersion?: number,
      createOnly?: boolean,
      seedFromLegacyPage?: { id: SectionId; version?: number },
      saveGroupId?: string,
    ): Promise<PageContent> => {
      let storedPage = storedPageBlocks.current.get(pageId);
      if (storedPage === undefined) {
        throw new Error("Reload this page before saving its content.");
      }
      assertHomeV2WriterEnabled(pageId, storedPage.homeCompositionVersion, baseVersion);
      if (storedPage.homeCompositionVersion === 2 && baseVersion === undefined) {
        throw new Error("Reload Home before saving its current version.");
      }
      let assertReviewActive: (() => void) | undefined;
      if (baseVersion === undefined && createOnly !== true) {
        const reviewed = await reviewCurrentSaveVersion("cmsPages", pageId, document => pageBlocksSaveRequest({
          pageId, section, blocks, enforcePublicPageOwnership,
          storedPage: storedPageContentFromDocument(pageId, document),
        }).document, storedPage);
        baseVersion = reviewed.version;
        storedPage = storedPageContentFromDocument(pageId, reviewed.document);
        assertReviewActive = reviewed.assertActive;
      }
      const request = pageBlocksSaveRequest({
        pageId, section, storedPage, blocks, enforcePublicPageOwnership,
        baseVersion, createOnly, seedFromLegacyPage, saveGroupId,
      });
      const idToken = await getIdToken();
      assertReviewActive?.();
      const response = await cmsSaveContent(idToken, request);
      const persistedPage = storedPageContentFromDocument(
        pageId,
        response.document,
      );
      storedPageBlocks.current.set(pageId, persistedPage);
      return {
        blocks: enforcePublicPageOwnership
          ? editableBlocksForPublicPage(
              pageId,
              persistedPage.blocks,
              persistedPage.homeCompositionVersion,
            )
          : persistedPage.blocks,
        homeCompositionVersion: persistedPage.homeCompositionVersion,
        mintedIds: response.mintedIds,
        warnings: response.warnings,
        metadata: pageMetadataFromDocument(pageId, response.document),
        createdBy: readNonEmptyString(response.document.createdBy),
        editingSection: readNonEmptyString(response.document.section),
        status: readNonEmptyString(response.document.status),
        version: readSaveBaseVersion(response.document.version),
        ...pagePublicationState(response.document),
      };
    },
    [enforcePublicPageOwnership, getIdToken, reviewCurrentSaveVersion],
  );

  const savePageMetadata = useCallback(
    async (
      pageId: PublicPageId,
      section: SectionId,
      metadata: Record<string, unknown>,
      baseVersion?: number,
      createOnly?: boolean,
      seedFromLegacyPage?: { id: SectionId; version?: number },
      saveGroupId?: string,
    ): Promise<PageContent> => {
      const storedPage = storedPageBlocks.current.get(pageId);
      assertHomeV2WriterEnabled(pageId, storedPage?.homeCompositionVersion, baseVersion);
      if (storedPage?.homeCompositionVersion === 2 && baseVersion === undefined) {
        throw new Error("Reload Home before saving its current version.");
      }
      let assertReviewActive: (() => void) | undefined;
      if (baseVersion === undefined && createOnly !== true) {
        const reviewed = await reviewCurrentSaveVersion("cmsPages", pageId, {
          ...pageMetadataSaveDocument(metadata),
          ...(pageId !== "home" && typeof metadata.slug === "string" ? { slug: metadata.slug } : {}),
        }, storedPage);
        baseVersion = reviewed.version;
        assertReviewActive = reviewed.assertActive;
      }
      const idToken = await getIdToken();
      assertReviewActive?.();
      const response = await cmsSaveContent(idToken, {
        collection: "cmsPages",
        id: pageId,
        slug: pageId !== "home" && typeof metadata.slug === "string" ? metadata.slug : undefined,
        document: {
          ...pageMetadataSaveDocument(metadata),
          template: section,
        },
        baseVersion,
        createOnly,
        seedFromLegacyPage,
        saveGroupId,
      });
      const persistedPage = storedPageContentFromDocument(
        pageId,
        response.document,
      );
      storedPageBlocks.current.set(pageId, persistedPage);
      return {
        blocks: enforcePublicPageOwnership
          ? editableBlocksForPublicPage(
              pageId,
              persistedPage.blocks,
              persistedPage.homeCompositionVersion,
            )
          : persistedPage.blocks,
        homeCompositionVersion: persistedPage.homeCompositionVersion,
        metadata: pageMetadataFromDocument(pageId, response.document),
        createdBy: readNonEmptyString(response.document.createdBy),
        editingSection: readNonEmptyString(response.document.section),
        status: readNonEmptyString(response.document.status),
        version: readSaveBaseVersion(response.document.version),
        ...pagePublicationState(response.document),
      };
    },
    [enforcePublicPageOwnership, getIdToken, reviewCurrentSaveVersion],
  );

  const requestSavedPreview = useCallback(
    async (target: import("../lib/saved-preview-operation").PreviewTarget) =>
      cmsRequestSavedPreview(await getIdToken(), target.collection, target.documentId, target.sourceVersion),
    [getIdToken],
  );

  const preparePreviewSession = useCallback(
    () => preparePrivatePreviewSession(getIdToken()),
    [getIdToken],
  );

  const requestPagePreview = useCallback(
    async (pageId: PublicPageId) => {
      const idToken = await getIdToken();
      return cmsRequestPagePreview(idToken, pageId);
    },
    [getIdToken],
  );

  const loadPagePreviewStatus = useCallback(
    async (queueId: string, options?: Parameters<typeof cmsLoadPagePreviewStatus>[2]) => {
      const idToken = await getIdToken();
      return cmsLoadPagePreviewStatus(idToken, queueId, options);
    },
    [getIdToken],
  );

  const loadRevisions = useCallback(
    async (
      collection: "cmsPages" | "cmsPosts",
      id: string,
      cursor?: string,
    ) => {
      const idToken = await getIdToken();
      return cmsListRevisions(idToken, {
        collection,
        id,
        ...(cursor ? { cursor } : {}),
      });
    },
    [getIdToken],
  );

  const loadRevision = useCallback(
    async (
      collection: "cmsPages" | "cmsPosts",
      id: string,
      revisionId: string,
    ) => {
      const idToken = await getIdToken();
      return cmsGetRevision(idToken, { collection, id, revisionId });
    },
    [getIdToken],
  );

  const restoreRevision = useCallback(
    async (
      collection: "cmsPages" | "cmsPosts",
      id: string,
      revisionId: string,
      baseVersion: number,
    ) => {
      const idToken = await getIdToken();
      return cmsRestoreRevision(idToken, {
        collection,
        id,
        revisionId,
        baseVersion,
      });
    },
    [getIdToken],
  );

  const transitionContent = useCallback(
    async (request: Parameters<typeof cmsTransitionContent>[1]) => {
      const idToken = await getIdToken();
      return cmsTransitionContent(idToken, request);
    },
    [getIdToken],
  );

  const publishContent = useCallback(
    async (
      collection: "cmsPages" | "cmsPosts",
      id: string,
      baseVersion: number,
      videos?: PublicationVideoOptions,
    ) => {
      if (collection === "cmsPages" && id === "home") {
        assertHomeV2WriterEnabled(id, storedPageBlocks.current.get("home")?.homeCompositionVersion, baseVersion);
      }
      usageActionCollector()("content.publish.request", collection === "cmsPages" ? "page" : "record", id);
      const idToken = await getIdToken();
      const saved = await saveContentWithPublicVideos(idToken, {
        collection,
        id,
        baseVersion,
        publish: true,
        document: {},
      }, videos);
      if (saved.publication) {
        return {
          document: saved.document,
          publicReceipt: null,
          buildQueued: saved.publication.transport !== "post-no-build-v1" && saved.publication.transport !== "page-no-build-v1" && saved.publication.transport !== "public-context-no-build-v1" && saved.publication.transport !== "release-pair-publication-v2",
          transport: saved.publication.transport,
        };
      }
      let publication;
      try {
        const sourceVersion = readVersion(saved.document.version);
        if (sourceVersion === undefined) {
          throw new Error("The published version receipt is missing.");
        }
        publication = await cmsPublish(
          idToken,
          [{ collection, id, sourceVersion }],
          { runtimeFirst: true },
        );
      } catch (error) {
        const message = `The version was saved as published, but its public update was not confirmed. ${error instanceof Error ? error.message : "The publication request failed."}`;
        if (error instanceof HttpError) {
          throw new HttpError(
            error.status,
            message,
            { ...error.data, publicationCommitted: true },
          );
        }
        throw Object.assign(new Error(message), {
          data: { publicationCommitted: true },
        });
      }
      return {
        document: saved.document,
        publicReceipt: publication.publicReceipt ?? null,
        buildQueued: publication.queueId !== null && publication.transport !== "post-no-build-v1" && publication.transport !== "page-no-build-v1" && publication.transport !== "public-context-no-build-v1" && publication.transport !== "release-pair-publication-v2",
        transport: publication.transport,
      } satisfies {
        document: Record<string, unknown>;
        publicReceipt: PublicRuntimeReceipt | null;
        buildQueued: boolean;
        transport: typeof publication.transport;
      };
    },
    [getIdToken],
  );

  // A direct live update publishes atomically on the fast path; the server
  // refuses it when that path is unavailable, so no cmsPublish follow-up exists.
  // Videos already in the public live blog keep their public copies. Request copies
  // only for new ones, because the copy endpoint needs Publish access.
  const publishLiveBlogUpdate = useCallback(
    async (id: string, baseVersion: number, liveBlog: unknown, publishedLiveBlog?: unknown) => {
      const idToken = await getIdToken();
      const saved = await saveContentWithPublicVideos(idToken, {
        collection: "cmsPosts",
        id,
        baseVersion,
        publish: true,
        liveBlogUpdate: true,
        document: { liveBlog },
      }, { blocks: newLiveBlogVideoBlocks(liveBlog, publishedLiveBlog) });
      return { warnings: saved.warnings, publicationRequested: Boolean(saved.publication) };
    },
    [getIdToken],
  );

  const scheduleContent = useCallback(
    async (
      collection: "cmsPages" | "cmsPosts",
      id: string,
      baseVersion: number,
      scheduleAt: string,
      videos?: PublicationVideoOptions,
    ) => {
      if (collection === "cmsPages" && id === "home") {
        assertHomeV2WriterEnabled(id, storedPageBlocks.current.get("home")?.homeCompositionVersion, baseVersion);
      }
      const idToken = await getIdToken();
      return saveContentWithPublicVideos(idToken, {
        collection,
        id,
        baseVersion,
        scheduleAt,
        document: {},
      }, videos);
    },
    [getIdToken],
  );

  // One bounded, server-authorized page of a typed record list (#1066). This is the same
  // paged query contract the combined library uses — the record type is a server-side filter,
  // the server owns the page size and the settled page, and the response carries only list
  // projections. Nothing here re-filters or accumulates pages on the client, so an editor
  // browsing Posts transfers and renders one page rather than the whole collection.
  const listRecords = useCallback(
    async (kind: RecordKind, page: number): Promise<RecordListPage> => {
      const idToken = await getIdToken();
      const selection = await cmsListContent(
        idToken,
        encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, types: [kind], page }),
      );
      return {
        records: selection.records,
        page: selection.page,
        pageCount: selection.pageCount,
        total: selection.total,
      };
    },
    [getIdToken],
  );

  const loadLibrarySelection = useCallback(
    async (query: ContentQuery) => {
      const idToken = await getIdToken();
      return cmsListContent(idToken, encodeContentQuery(query));
    },
    [getIdToken],
  );
  const archiveLibraryRecords = useCallback(
    async (items: BulkArchiveItem[]) => {
      const idToken = await getIdToken();
      return cmsBulkArchiveContent(idToken, items);
    },
    [getIdToken],
  );
  const loadAssignableUsers = useCallback(() => loadAssignmentStaff(db), []);
  const assignRecord = useCallback(
    async (request: {
      id: string;
      baseVersion: number;
      assignee: string | null;
    }) => {
      const idToken = await getIdToken();
      return (await cmsAssignContent(idToken, request)).document;
    },
    [getIdToken],
  );
  const loadSavedViews = useCallback(
    async () => (principal.id ? loadContentLibraryViews(principal.id) : []),
    [principal.id],
  );
  const mutateSavedViews = useCallback(
    async (mutation: SavedContentViewMutation) => {
      if (!principal.id)
        throw new Error("Sign in again before saving a view.");
      return mutateContentLibraryViews(principal.id, mutation);
    },
    [principal.id],
  );

  const loadRecord = useCallback(
    async (kind: RecordKind, id: string): Promise<LoadedRecord> => {
      const idToken = await getIdToken();
      let response: GetContentResponse;
      try {
        response = await cmsGetContent(idToken, {
          collection: "cmsPosts",
          id,
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) {
          throw new Error("You do not have permission to edit this record.");
        }
        if (error instanceof HttpError && error.status === 404) {
          return { status: "deleted" };
        }
        throw new Error("The record could not be loaded. Reload to try again.");
      }
      if (!response.found || !response.document) return { status: "missing" };
      const data = response.document;
      if (data.deleted === true) return { status: "deleted" };
      if (data.type !== kind) return { status: "invalid" };
      return {
        status: "ready",
        // As in the list, the addressed response owns identity even if an old document still
        // carries a conflicting `id` field. Normalize descriptor-backed date values at this
        // read boundary so a Firestore Timestamp never reaches the JSON save contract.
        record: normalizeEditorRecordDates(kind, { ...data, id }),
      };
    },
    [getIdToken],
  );

  // Persist a record to cmsPosts and return the stored record so the form adopts the
  // server-minted id. A record has no id on create, so the id is sent as the request key only
  // when the record already carries one (a reopened record or an update after create); on create
  // the server mints it. The id is addressed through the request key, never as a content field
  // — the server owns it, and sending it in the document would be stripped anyway. The kind is
  // stamped as the record's type discriminator so a mixed cmsPosts collection stays queryable
  // by type.
  const saveRecord = useCallback(
    async (
      kind: RecordKind,
      record: Record<string, unknown>,
      options?: { force?: boolean },
    ): Promise<RecordSaveReceipt> => {
      const creating = typeof record.id !== "string";
      let assertReviewActive: (() => void) | undefined;
      if (options?.force && !creating) {
        const proposal = recordSaveRequest(kind, record);
        const reviewed = await reviewCurrentSaveVersion("cmsPosts", record.id as string, {
          ...proposal.document, ...(proposal.slug === undefined ? {} : { slug: proposal.slug }),
        });
        record = { ...record, version: reviewed.document.version };
        assertReviewActive = reviewed.assertActive;
      }
      const idToken = await getIdToken();
      assertReviewActive?.();
      // One nonce per create surface, reused until that draft commits. A failed
      // Sponsor request can therefore survive a successful Post create and still
      // address its original server attempt when the editor returns to it.
      if (creating && !pendingCreateNonces.current.has(kind)) {
        pendingCreateNonces.current.set(kind, globalThis.crypto.randomUUID());
      }
      const response = await cmsSaveContent(idToken, recordSaveRequest(kind, record, {
        force: options?.force,
        idempotencyKey: pendingCreateNonces.current.get(kind),
      }));
      if (creating) pendingCreateNonces.current.delete(kind);
      return {
        kind: "record-save-receipt",
        document: response.document,
        mintedIds: response.mintedIds,
        warnings: response.warnings,
      };
    },
    [getIdToken, reviewCurrentSaveVersion],
  );

  const abandonRecordCreate = useCallback((kind: RecordKind) => {
    pendingCreateNonces.current.delete(kind);
  }, []);

  const capturePostTemplate = useCallback(async (request: CapturePostTemplateRequest) =>
    cmsCapturePostTemplate(await getIdToken(), request), [getIdToken]);

  const duplicatePost = useCallback(async (sourceId: string, sourceVersion: number) => {
    const sourceKey = `${sourceId}:${sourceVersion}`;
    let idempotencyKey = pendingPostDuplicateNonces.current.get(sourceKey);
    if (!idempotencyKey) {
      idempotencyKey = globalThis.crypto.randomUUID();
      pendingPostDuplicateNonces.current.set(sourceKey, idempotencyKey);
    }
    try {
      const response = await cmsSaveContent(await getIdToken(), {
        collection: "cmsPosts",
        document: { type: "post" },
        postSource: { id: sourceId, version: sourceVersion },
        idempotencyKey,
      });
      pendingPostDuplicateNonces.current.delete(sourceKey);
      return response.document;
    } catch (error) {
      if (createReplayConflictRecordId(error)) {
        pendingPostDuplicateNonces.current.delete(sourceKey);
        throw new Error(
          "The earlier duplicate was already created and later edited. Select Duplicate post again to make another copy.",
        );
      }
      throw error;
    }
  }, [getIdToken]);

  const loadMedia = useCallback(
    async (query: MediaListQuery, options?: { signal?: AbortSignal }) => {
      const idToken = await getIdToken();
      return cmsListMedia(idToken, query, options?.signal);
    },
    [getIdToken],
  );

  const uploadMedia = useCallback(
    async (file: File, metadata: UploadMediaMetadata, signal: AbortSignal) => {
      const idToken = await getIdToken();
      return uploadMediaReusingDuplicates(idToken, file, metadata, signal);
    },
    [getIdToken],
  );

  // The byline picker's feed (#1040). Open to every approved active account, so
  // it is not capability-gated here the way the media loaders above are.
  const loadBylineAuthors = useCallback(
    async (body?: { startAfter?: string | null }) => {
      const idToken = await getIdToken();
      return cmsListBylineAuthors(idToken, body ?? {});
    },
    [getIdToken],
  );

  const loadCoverageLabels = useCallback(
    async (signal: AbortSignal) => cmsGetCoverageLabels(await getIdToken(), signal),
    [getIdToken],
  );

  const loadPublishedVocabulary = useCallback(
    async () => cmsPublishedVocabulary(await getIdToken()),
    [getIdToken, principal],
  );

  const electionSources = useMemo(() => electionSourceApi(getIdToken), [getIdToken]);

  const reportingTransport = useMemo<ReportingEditorTransport>(() => ({
    preview: async (mapping,signal) => {
      const result = await postFunction<ReportingPreview>("cmsListContent",await getIdToken(),{view:"data-hub-reporting",action:"preview",mapping},{},{signal});
      if (!Array.isArray(result.stories) || result.stories.length > 85 || typeof result.failed !== "boolean" ||
          !Number.isFinite(Date.parse(result.cutoffAt))) throw new Error("Reporting preview is invalid.");
      return {...result,stories:result.stories.map(parseReportingStory)};
    },
    terms: async (taxonomy,search,signal) => (await postFunction<{terms:import("../../../packages/content-core/src/data-hub-reporting").ReportingTerm[]}>(
      "cmsListContent",await getIdToken(),{view:"data-hub-reporting",action:"terms",taxonomy,search},{},{signal})).terms,
    vocabulary:loadPublishedVocabulary,
  }),[getIdToken,loadPublishedVocabulary]);

  if (!editorWorkspaceMounted && isBrowseSurface(surface)) {
    return (
      <ContentBrowseWorkspace
        pageDirectoryApi={pageDirectoryApi}
        principal={principal}
        surface={surface}
        listRecords={listRecords}
        canArchiveLibrary={canArchiveLibrary}
        archiveLibraryRecords={archiveLibraryRecords}
        loadLibrarySelection={loadLibrarySelection}
        loadSavedViews={loadSavedViews}
        mutateSavedViews={mutateSavedViews}
        onSavingChange={onSavingChange}
      />
    );
  }

  return (
    <Suspense
      fallback={
        <ContentStudioSkeleton surface={surface ?? null} label="Opening the editor" withSelect={canArchiveLibrary} canCreate={canSaveContent(principal)} />
      }
    >
      <EditorLayoutMode />
      {conflictReview ?
        <SaveConflictReviewDialog {...conflictReview} onConfirm={() => conflictReview.finish(true)} onCancel={() => conflictReview.finish(false)} />
      : null}
      <EditorWorkspace
        electionSources={electionSources}
        pageDirectoryApi={pageDirectoryApi}
        principal={principal}
        enforcePublicPageOwnership={enforcePublicPageOwnership}
        savePage={savePage}
        savePageMetadata={savePageMetadata}
        convertHome={convertHome}
        convertHomeV2={convertHomeV2}
        saveRecord={saveRecord}
        capturePostTemplate={capturePostTemplate}
        duplicatePost={duplicatePost}
        abandonRecordCreate={abandonRecordCreate}
        canAssignRecords={canArchiveLibrary && hasCapability(principal, "users.manage")}
        loadAssignableUsers={loadAssignableUsers}
        assignRecord={assignRecord}
        listRecords={listRecords}
        canArchiveLibrary={canArchiveLibrary}
        archiveLibraryRecords={archiveLibraryRecords}
        loadLibrarySelection={loadLibrarySelection}
        loadSavedViews={loadSavedViews}
        mutateSavedViews={mutateSavedViews}
        loadRecord={loadRecord}
        loadPage={loadPage}
        loadBylineAuthors={loadBylineAuthors}
        loadCoverageLabels={loadCoverageLabels}
        loadPublishedVocabulary={loadPublishedVocabulary}
        reportingTransport={reportingTransport}
        loadMedia={canUseMediaLibrary(principal) ? loadMedia : undefined}
        uploadMedia={canUploadMedia(principal) ? uploadMedia : undefined}
        mediaCategories={
          mediaCategoryRegistry.status === "ready"
            ? mediaCategoryRegistry.categories
            : undefined
        }
        defaultUploadCategory={defaultMediaUploadCategory(principal)}
        canUploadCategory={(category) => canUploadMedia(principal, category)}
        mediaPickerUnavailable={!canUseMediaLibrary(principal)}
        autoSaveEnabled
        requestSavedPreview={previewEnabled ? requestSavedPreview : undefined}
        preparePreviewSession={previewEnabled ? preparePreviewSession : undefined}
        requestPagePreview={previewEnabled ? requestPagePreview : undefined}
        loadPagePreviewStatus={
          previewEnabled ? loadPagePreviewStatus : undefined
        }
        loadRevisions={loadRevisions}
        loadRevision={loadRevision}
        restoreRevision={restoreRevision}
        transitionContent={transitionContent}
        publishContent={publishContent}
        publishLiveBlogUpdate={publishLiveBlogUpdate}
        scheduleContent={scheduleContent}
        onSavingChange={onSavingChange}
        surface={surface}
        onNavigateSurface={onNavigateSurface}
        onDirtyChange={onDirtyChange}
        unsavedProbeRef={unsavedProbeRef}
        saveRequestRef={saveRequestRef}
        editorLockClient={editorLockClient}
        editorLockActor={editorLockActor}
        contentSections={contentSections}
        newPostSections={sectionsReady ? pageDirectoryApi.sections : null}
      />
    </Suspense>
  );
}
