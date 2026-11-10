import { revealInlineFocus } from "../lib/reveal-inline-focus";
import { WorkspaceBrowseToolbar } from "./WorkspaceActions";
import { BrowseRowActions } from "./BrowseRowActions";
import { buttonClassName, Select, TextInput } from "./ui/Primitives";
import { Checkbox } from "./ui/Checkbox";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { ScheduledPublicationTime } from "./ScheduledPublicationTime";
import {
  Fragment,
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useDismissibleOverlay } from "../hooks/useDismissibleOverlay";
import {
  activeAdvancedFilterCount,
  DEFAULT_CONTENT_QUERY,
  contentQueriesEqual,
  encodeContentQuery,
  parseContentQuery,
  type ContentQuery,
  type SortField,
} from "../lib/content-query";
import { selectLibraryRecords, type LibrarySelection } from "../lib/content-library";
import {
  MAX_SAVED_CONTENT_VIEWS,
  MAX_SAVED_CONTENT_VIEW_NAME_LENGTH,
  SavedContentViewValidationError,
  createSavedContentView,
  parseSavedContentViews,
  type SavedContentViewMutation,
  type SavedContentView,
} from "../lib/saved-content-views";
import {
  CONTENT_STATUSES,
  RECORD_KINDS,
  isRecordKind,
  type ContentStatus,
} from "../lib/content-vocab";
import {
  RECORD_DESTINATIONS,
  contentKindLabel,
  recordDestination,
} from "../lib/content-nav";
import type { ContentRecordSummary } from "../lib/content-records";
import { isRetiredRecordKind } from "../../../packages/content-core/src/editor-admin";
import { listOriginState } from "../lib/editor-back";
import { createRecordPath, editRecordPath } from "../lib/routes";
import { contentStatusTone, displayContentStatus, listRowNeedsPublicationWatch } from "../lib/content-status";
import { useContentQuickEditGuard } from "../context/ContentQuickActionsContext";
import {
  HttpError,
  type BulkArchiveItem,
  type BulkArchiveOutcome,
  type BulkArchiveResponse,
} from "../lib/functions";
import {
  AsyncActionButton,
  Button,
  EmptyState,
  InlineMessage,
  StatusBadge,
  TableFrame,
} from "./ui/Primitives";
import { SkeletonBlock, SkeletonRegion, SkeletonText } from "./ui/Skeleton";
import { ContentLibraryTableShapes } from "./EditorSkeleton";
import { ActionControl } from "./ui/ActionControl";
import { PublishedVersionStatus } from "./PublishedVersionStatus";
import { ContentQuickEdit } from "./ContentQuickEdit";
import { ContentRowThumbnail } from "./ContentRowThumbnail";
import { Icon } from "./ui/Icon";
import { WorkspaceActions } from "./WorkspaceActions";
import { RecycleBin, type RecycleBinPage } from "./RecycleBin";
import { NewPostChoice } from "./NewPostChoice";
import { postTemplatesPath } from "../lib/routes";

interface ContentLibraryProps {
  postOnly?: boolean;
  persistentEditorDirty?: boolean;
  archiveRecords?: (items: BulkArchiveItem[]) => Promise<BulkArchiveResponse>;
  canArchive: boolean;
  canCreate: boolean;
  currentUserId?: string;
  loadSelection?: (query: ContentQuery) => Promise<LibrarySelection>;
  loadRecords?: () => Promise<ContentRecordSummary[]>;
  loadSavedViews?: () => Promise<SavedContentView[]>;
  mutateSavedViews?: (
    mutation: SavedContentViewMutation,
  ) => Promise<SavedContentView[]>;
  onMutatingChange?: (mutating: boolean) => void;
}

type LibraryState =
  | { status: "loading" }
  | {
      status: "ready";
      records: ContentRecordSummary[];
      serverSelection?: LibrarySelection;
      serverQueryKey?: string;
    }
  | { status: "error"; message: string };

type SavedViewsState =
  | { status: "loading" }
  | { status: "ready"; views: SavedContentView[] }
  | { status: "error"; message: string };

interface ArchiveResultRow extends BulkArchiveOutcome {
  title: string;
}

interface ArchiveRequestError {
  title: string;
  message: string;
}

const SORT_OPTIONS: readonly { value: SortField; label: string }[] = [
  { value: "updatedAt", label: "Last updated" },
  { value: "createdAt", label: "Created" },
  { value: "title", label: "Name" },
  { value: "status", label: "Status" },
  { value: "publishAt", label: "Publish date" },
];

function displayDate(value?: string): { date: string; time: string } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date),
    time: new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date),
  };
}

function hasArchivableVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function toggleValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function queryForStatus(query: ContentQuery, status: ContentStatus): ContentQuery {
  return { ...query, statuses: [status], page: 1 };
}

function archiveOutcomeCopy(outcome: BulkArchiveOutcome): string {
  switch (outcome.status) {
    case "archived":
      return "Moved to Recycle bin.";
    case "already_archived":
      return "Was already in Recycle bin; no change was needed.";
    case "conflict":
      return "Changed since this page loaded and was not moved to Recycle bin. Review the latest version before selecting it again.";
    case "missing":
      return "Is no longer available under All content and was not moved to Recycle bin.";
    case "failed":
      return outcome.message || "Could not be moved to Recycle bin. Reload before trying again.";
  }
}

function BulkArchiveFeedback({
  error,
  rows,
}: {
  error: ArchiveRequestError | null;
  rows: ArchiveResultRow[] | null;
}) {
  if (error) {
    return (
      <InlineMessage tone="error" title={error.title}>
        <span>{error.message}</span>
      </InlineMessage>
    );
  }
  if (!rows) return null;

  const incomplete = rows.some((row) =>
    ["conflict", "missing", "failed"].includes(row.status),
  );
  const removalFailed = rows.some((row) => row.publication?.status === "failed");
  return (
    <InlineMessage
      className="content-library-bulk-result"
      tone={incomplete || removalFailed ? "error" : "success"}
      title={incomplete ? "Some records were not moved to Recycle bin"
        : removalFailed ? "Moved to Recycle bin; public removal needs attention" : "Move to Recycle bin complete"}
    >
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <strong>{row.title}</strong> — {archiveOutcomeCopy(row)}
            {row.publication ? <span> {row.publication.status === "queued"
              ? "Public removal is queued. The current version can remain live until the build finishes."
              : "Public removal did not start. Open the record in Recycle bin and retry removal."}</span> : null}
            {row.publication?.warnings?.length ? <span> {row.publication.warnings.join(" ")}</span> : null}
          </li>
        ))}
      </ul>
    </InlineMessage>
  );
}

// The combined alpha library at /content/library. The URL is the only filter state: changing a
// control rewrites the shared domain codec, so refresh, back/forward, bookmarks, and copied links all
// reproduce the same result. Named views persist that same codec in the signed-in user's profile,
// so selecting one only changes the URL; the view never becomes a second source of filter state.
// Production resolves the query through one authenticated server boundary and receives only the
// addressed page plus its aggregate counts. The optional snapshot loader remains for the gallery
// and isolated tests, where a network boundary would make the specimen less useful.
export function ContentLibrary(props: ContentLibraryProps) {
  return <ControlSizingProvider size="standard"><ContentLibraryContent {...props} /></ControlSizingProvider>;
}

function ContentLibraryContent({
  postOnly = false,
  persistentEditorDirty = false,
  archiveRecords,
  canArchive,
  canCreate,
  currentUserId,
  loadSelection,
  loadRecords,
  loadSavedViews,
  mutateSavedViews,
  onMutatingChange,
}: ContentLibraryProps) {
  const contentLabel = postOnly ? "Posts" : "All content";
  const [searchParams, setSearchParams] = useSearchParams();
  // The filtered address this library is being read at, carried onto every editor it opens so
  // Back returns to the same filters, sort and page rather than an unfiltered list (#1037).
  const origin = listOriginState(useLocation());
  const createOptionsId = useId();
  const saveViewFormId = useId();
  const advancedFiltersId = useId();
  const bulkConfirmTitleId = useId();
  const detailsPrefix = useId();
  const [expandedPostIds, setExpandedPostIds] = useState<Set<string>>(() => new Set());
  const [openedPostIds, setOpenedPostIds] = useState<Set<string>>(() => new Set());
  const [createOptionsOpen, setCreateOptionsOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [saveViewFormOpen, setSaveViewFormOpen] = useState(false);
  const saveViewFormRef = useRef<HTMLFormElement>(null);
  const saveViewTriggerRef = useRef<HTMLButtonElement>(null);
  const advancedFiltersRef = useRef<HTMLDivElement>(null);
  const requestedPanelFocus = useRef<"filters" | "save-view" | null>(null);
  const returnSaveViewFocus = useRef(false);

  const [viewName, setViewName] = useState("");
  const [viewMutationError, setViewMutationError] = useState<string | null>(null);
  const [savingView, setSavingView] = useState(false);
  const savingViewRef = useRef(false);
  // Dataset modal state does not change the underlying content result set.
  const contentParams = new URLSearchParams(searchParams);
  contentParams.delete("panel"); contentParams.delete("dataset");
  const addressKey = contentParams.toString();
  const query = useMemo(() => {
    const parsed = parseContentQuery(addressKey);
    return postOnly ? { ...parsed, types: ["post" as const] } : parsed;
  }, [addressKey, postOnly]);
  const queryKey = postOnly ? encodeContentQuery(query) : addressKey;
  // Exclude deleted records before server paging so active pages stay full.
  const activeQuery = useMemo(() => {
    const statuses = query.statuses.filter((status) => status !== "archived");
    // Old saved views can contain only archived. They now use the separate bin.
    return { ...query, statuses: statuses.length ? statuses
      : CONTENT_STATUSES.filter((status) => status !== "archived") };
  }, [query]);
  const filterQuery = postOnly ? { ...query, types: [] } : query;
  // Open when the address already narrows the list, so a saved view or a shared link never
  // arrives with its constraints hidden behind a closed disclosure.
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(
    () => activeAdvancedFilterCount(filterQuery) > 0,
  );
  const activeFilterCount = activeAdvancedFilterCount(filterQuery);
  useEffect(() => {
    const requested = requestedPanelFocus.current;
    if (!requested || (requested === "filters" ? !advancedFiltersOpen : !saveViewFormOpen)) return;
    requestedPanelFocus.current = null;
    // The command bar remains visible after scrolling. Reveal its actual in-flow form,
    // without stealing route focus when a saved URL initially opens the filters.
    const frame = requestAnimationFrame(() => {
      const panel = requested === "filters" ? advancedFiltersRef.current : saveViewFormRef.current;
      const control = panel?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)");
      control?.focus();
      control?.scrollIntoView?.({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [advancedFiltersOpen, saveViewFormOpen]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LibraryState>({ status: "loading" });
  const [updating, setUpdating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [archiveConfirmationOpen, setArchiveConfirmationOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  useEffect(() => {
    if (!returnSaveViewFocus.current || saveViewFormOpen || savingView || archiving) return;
    returnSaveViewFocus.current = false;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === document.body || saveViewFormRef.current?.contains(active)) saveViewTriggerRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [saveViewFormOpen, savingView, archiving]);
  const [archiveResult, setArchiveResult] = useState<ArchiveResultRow[] | null>(null);
  const [archiveRequestError, setArchiveRequestError] =
    useState<ArchiveRequestError | null>(null);
  const {
    dirty: quickEditDirty,
    saving: quickEditSaving,
    hasUnsavedWork: quickEditHasUnsavedWork,
  } = useContentQuickEditGuard();
  const debounceQueryKey = useRef<string | null>(null);
  const preserveArchiveFeedbackQueryKey = useRef<string | null>(null);
  const archiveReloadAttempt = useRef<number | null>(null);
  const [savedViewsState, setSavedViewsState] = useState<SavedViewsState>(
    loadSavedViews ? { status: "loading" } : { status: "ready", views: [] },
  );

  // The create menu is a temporary panel: it covers the toolbar and holds nothing a person is
  // part-way through, so it closes on Escape and on pointer activation anywhere outside it, the
  // same dismissals the account menu already honors (#1036). Escape returns focus to the control
  // that opened it; a pointer has already chosen where attention goes, so it does not.
  const closeCreateOptions = useCallback(() => setCreateOptionsOpen(false), []);
  useDismissibleOverlay({
    open: createOptionsOpen,
    root: createMenuRef,
    trigger: createTriggerRef,
    onClose: closeCreateOptions,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setUpdating(true);
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    if (!loadSelection && !loadRecords) {
      setState({ status: "ready", records: [] });
      setUpdating(false);
      finishArchiveReload(attempt);
      return;
    }
    // Search writes each keystroke into the shareable URL. Briefly coalesce those URL changes so
    // a word produces one server request instead of one request per letter; other controls remain
    // immediate. Existing results stay mounted while the request is in flight, preserving focus.
    const delay = loadSelection && debounceQueryKey.current === queryKey ? 150 : 0;
    if (debounceQueryKey.current === queryKey) debounceQueryKey.current = null;
    timer = globalThis.setTimeout(() => {
      const request: Promise<{
        records: ContentRecordSummary[];
        serverSelection?: LibrarySelection;
        serverQueryKey?: string;
      }> = loadSelection
        ? loadSelection(activeQuery).then((selection) => ({
            records: selection.records,
            serverSelection: selection,
            serverQueryKey: queryKey,
          }))
        : loadRecords!().then((records) => ({ records }));
      request
        .then((next) => {
          if (!cancelled) {
            setState({ status: "ready", ...next });
            setUpdating(false);
            // This response is already the authoritative server selection, including its
            // canonical lower page when an archive collapses the last one. Release now so the
            // route blocker permits the URL-only normalization below; that normalized fetch is
            // redundant confirmation, not the refresh that makes interaction safe again.
            finishArchiveReload(attempt);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState({
              status: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "All content could not be loaded. Reload to try again.",
            });
            setUpdating(false);
            // The stale table is gone in the error state, so retry is the only next action and it
            // is safe to release the mutation hold even though the authoritative refresh failed.
            finishArchiveReload(attempt);
          }
        });
    }, delay);
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [attempt, loadRecords, loadSelection, loadSelection ? queryKey : ""]);

  useEffect(() => {
    let cancelled = false;
    if (!loadSavedViews) {
      setSavedViewsState({ status: "ready", views: [] });
      return;
    }
    setSavedViewsState({ status: "loading" });
    loadSavedViews()
      .then((views) => {
        if (!cancelled) {
          setSavedViewsState({ status: "ready", views: parseSavedContentViews(views) });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSavedViewsState({
            status: "error",
            message: "Your saved views could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadSavedViews]);

  // Selection belongs to the exact URL-addressed page the person can see. Back/forward and any
  // filter, sort, search, or page change discard it before the old rows can be acted on.
  useEffect(() => {
    const preserveArchiveFeedback =
      preserveArchiveFeedbackQueryKey.current === queryKey;
    preserveArchiveFeedbackQueryKey.current = null;
    setSelectedIds(new Set());
    setArchiveConfirmationOpen(false);
    setExpandedPostIds(new Set());
    setOpenedPostIds(new Set());
    if (!preserveArchiveFeedback) {
      setArchiveResult(null);
      setArchiveRequestError(null);
    }
  }, [queryKey]);

  useEffect(() => {
    if (quickEditDirty || quickEditSaving) setArchiveConfirmationOpen(false);
  }, [quickEditDirty, quickEditSaving]);

  const selection = useMemo(
    () => {
      if (state.status !== "ready") {
        return selectLibraryRecords([], activeQuery, currentUserId);
      }
      return (
        state.serverSelection ?? selectLibraryRecords(state.records, activeQuery, currentUserId)
      );
    },
    [currentUserId, activeQuery, state],
  );
  const loadDeletedPage = useCallback(async (page: number): Promise<RecycleBinPage> => {
    const deletedQuery: ContentQuery = { ...query, statuses: ["archived"], page };
    const deleted = loadSelection
      ? await loadSelection(deletedQuery)
      : selectLibraryRecords(state.status === "ready" ? state.records : [], deletedQuery, currentUserId);
    return {
      page: deleted.page,
      pageCount: deleted.pageCount,
      items: deleted.records.map((record) => ({
        id: `${record.kind}:${record.id}`,
        title: record.title,
        editorPath: isRetiredRecordKind(record.kind) ? undefined : editRecordPath(record.kind, record.id),
        target: isRecordKind(record.kind)
          ? { kind: record.kind, recordId: record.id }
          : undefined,
        restoreUnavailableReason: isRetiredRecordKind(record.kind)
          ? "This retired content type cannot be restored."
          : undefined,
      })),
    };
  }, [query, loadSelection, state, currentUserId]);
  const bulkArchiveAvailable = canArchive && archiveRecords !== undefined;
  const eligibleRecords = selection.records.filter(
    (record) => record.status !== "archived" && hasArchivableVersion(record.version),
  );
  const selectedRecords = eligibleRecords.filter((record) => selectedIds.has(record.id));
  const allEligibleSelected =
    eligibleRecords.length > 0 && selectedRecords.length === eligibleRecords.length;

  function finishArchiveReload(completedAttempt: number) {
    if (archiveReloadAttempt.current !== completedAttempt) return;
    archiveReloadAttempt.current = null;
    setArchiving(false);
    onMutatingChange?.(false);
  }

  function setQuery(
    next: ContentQuery,
    replace = false,
    debounce = false,
    preserveArchiveFeedback = false,
  ) {
    // The outcome belongs to the exact rows shown when the request began. A query change while
    // transactions are settling would unmount that context and can make a partial result look as
    // though it belongs to a different page. Controls are disabled below; keep this guard as the
    // invariant for keyboard submits and any future caller that forgets to expose disabled state.
    if (archiving) return;
    const nextKey = encodeContentQuery(postOnly ? { ...next, types: ["post"] } : next);
    debounceQueryKey.current = debounce ? nextKey : null;
    preserveArchiveFeedbackQueryKey.current = preserveArchiveFeedback ? nextKey : null;
    setSelectedIds(new Set());
    setArchiveConfirmationOpen(false);
    const nextParams = new URLSearchParams(nextKey);
    for (const name of ["panel", "dataset"]) {
      const value = searchParams.get(name);
      if (value !== null) nextParams.set(name, value);
    }
    setSearchParams(nextParams, { replace });
  }

  function updateQuery(
    patch: Partial<ContentQuery>,
    options: { replace?: boolean; keepPage?: boolean; debounce?: boolean } = {},
  ) {
    setQuery(
      { ...query, ...patch, page: options.keepPage ? patch.page ?? query.page : 1 },
      options.replace,
      options.debounce,
    );
  }

  // A copied link can name a page beyond the current result after records change. Canonicalize it
  // to the last real page instead of rendering an empty table with a misleading page number.
  useEffect(() => {
    if (
      state.status !== "ready" ||
      archiving ||
      (loadSelection && state.serverQueryKey !== queryKey) ||
      selection.page === query.page
    ) {
      return;
    }
    // This is a mechanical correction of the same result set, including after archive shrinks
    // the last page. Keep its per-record feedback; only an operator-initiated query change makes
    // that feedback stale.
    setQuery({ ...query, page: selection.page }, true, false, true);
  }, [archiving, loadSelection, query, queryKey, selection.page, state]);

  if (state.status === "loading") {
    return (
      <ContentLibrarySkeleton
        contentLabel={contentLabel}
        withSelect={bulkArchiveAvailable}
        postOnly={postOnly}
        canCreate={canCreate}
        canSaveViews={mutateSavedViews !== undefined}
      />
    );
  }

  if (state.status === "error") {
    return (
      <div className="content-library">
        <BulkArchiveFeedback error={archiveRequestError} rows={archiveResult} />
        <InlineMessage tone="error" title={`${contentLabel} could not be loaded`}>
          <span>{state.message} Reload to get the latest records.</span>
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Try loading {contentLabel} again
          </Button>
        </InlineMessage>
      </div>
    );
  }

  const defaultQuery: ContentQuery = { ...DEFAULT_CONTENT_QUERY, types: postOnly ? ["post"] : [] };
  const mineQuery: ContentQuery = { ...defaultQuery, ownerMode: "me" };
  const assignedQuery: ContentQuery = {
    ...defaultQuery,
    assignmentMode: "me",
  };
  const mineCount = selection.mineCount;
  const assignedCount = selection.assignedCount;
  const allActive = contentQueriesEqual(query, defaultQuery);
  const mineActive = currentUserId ? contentQueriesEqual(query, mineQuery) : false;
  const assignedActive = currentUserId
    ? contentQueriesEqual(query, assignedQuery)
    : false;
  const savedViews = savedViewsState.status === "ready" ? savedViewsState.views : [];
  const visibleSavedViews = postOnly ? savedViews.filter((view) => {
    const types = parseContentQuery(view.query).types;
    return types.length === 0 || (types.length === 1 && types[0] === "post");
  }) : savedViews;

  function togglePostDetails(id: string) {
    if (!expandedPostIds.has(id)) setOpenedPostIds((current) => new Set(current).add(id));
    setExpandedPostIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function persistSavedViewMutation(
    mutation: SavedContentViewMutation,
    afterSave?: () => void,
  ) {
    if (!mutateSavedViews || archiving || savingViewRef.current) return;
    savingViewRef.current = true;
    setSavingView(true);
    setViewMutationError(null);
    try {
      // The injected persistence boundary is still untrusted input. Production returns a
      // validated transaction result, but normalizing here keeps alternate hosts and tests from
      // putting malformed, paged, or non-canonical preferences into live component state.
      const next = parseSavedContentViews(await mutateSavedViews(mutation));
      setSavedViewsState({ status: "ready", views: next });
      afterSave?.();
    } catch (error) {
      const reason =
        error instanceof SavedContentViewValidationError
          ? error.message
          : "The saved view could not be stored.";
      setViewMutationError(`${reason} Your current filters are unchanged.`);
    } finally {
      savingViewRef.current = false;
      setSavingView(false);
    }
  }

  async function saveCurrentView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (archiving) return;
    let view: SavedContentView;
    try {
      view = createSavedContentView(globalThis.crypto.randomUUID(), viewName, query);
    } catch (error) {
      setViewMutationError(error instanceof Error ? error.message : "Enter a valid view name.");
      return;
    }
    if (savedViews.length >= MAX_SAVED_CONTENT_VIEWS) {
      setViewMutationError(`You can save up to ${MAX_SAVED_CONTENT_VIEWS} views.`);
      return;
    }
    const matchingName = savedViews.find(
      (candidate) => candidate.name.toLocaleLowerCase() === view.name.toLocaleLowerCase(),
    );
    if (matchingName) {
      setViewMutationError(`A saved view named “${matchingName.name}” already exists.`);
      return;
    }
    const matchingQuery = savedViews.find((candidate) =>
      contentQueriesEqual(parseContentQuery(candidate.query), query),
    );
    if (matchingQuery) {
      setViewMutationError(`These filters are already saved as “${matchingQuery.name}”.`);
      return;
    }
    await persistSavedViewMutation({ type: "add", view }, () => {
      const active = document.activeElement;
      returnSaveViewFocus.current = active === document.body || Boolean(saveViewFormRef.current?.contains(active));
      setViewName("");
      setSaveViewFormOpen(false);
    });
  }

  function toggleRecordSelection(id: string) {
    if (archiving) return;
    setArchiveConfirmationOpen(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function archiveSelectedRecords() {
    if (
      !archiveRecords ||
      selectedRecords.length === 0 ||
      archiving ||
      quickEditSaving ||
      quickEditHasUnsavedWork()
    ) {
      setArchiveConfirmationOpen(false);
      return;
    }
    const requestedRecords = [...selectedRecords];
    const items = requestedRecords.map((record) => ({
      id: record.id,
      baseVersion: record.version!,
    }));
    setArchiving(true);
    onMutatingChange?.(true);
    setArchiveRequestError(null);
    setArchiveResult(null);
    try {
      const response = await archiveRecords(items);
      const outcomes = new Map(response.outcomes.map((outcome) => [outcome.id, outcome]));
      setArchiveResult(
        requestedRecords.map((record) => ({
          ...(outcomes.get(record.id) ?? { id: record.id, status: "failed" as const }),
          title: record.title,
        })),
      );
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        // Auth and validation rejections happen before this endpoint opens its per-record loop.
        setArchiveRequestError({
          title: "Move to Recycle bin was rejected",
          message: `Request failed (${error.status}): ${error.message}. No records were changed.`,
        });
      } else {
        // A disconnected or failed response can arrive after some independent record
        // transactions committed. Do not claim that nothing changed; force a fresh read before
        // allowing another attempt.
        setArchiveRequestError({
          title: "The Move to Recycle bin result could not be confirmed",
          message:
            "Some records may have changed. All content is reloading; review the latest status and version before trying again.",
        });
      }
    } finally {
      setSelectedIds(new Set());
      setArchiveConfirmationOpen(false);
      // Keep both local controls and the route blocker held until the resulting authoritative
      // reload finishes. Releasing on the HTTP response would expose stale rows and versions in
      // the gap before this attempt settles.
      setAttempt((value) => {
        const reloadAttempt = value + 1;
        archiveReloadAttempt.current = reloadAttempt;
        return reloadAttempt;
      });
    }
  }

  return (
    <div className="content-library" aria-busy={updating || archiving || undefined}>
      {updating ? (
        <p className="sr-only" role="status">
          Updating {contentLabel}…
        </p>
      ) : null}
      <div className="content-library-actions">
        <div className="content-library-view-row content-library-views" onFocus={event => revealInlineFocus(event.currentTarget, event.target)} role="group" aria-label={`${contentLabel} quick views`}>
          <Button
            variant="ghost"
            aria-pressed={allActive}
            disabled={archiving}
            onClick={() => setQuery({ ...DEFAULT_CONTENT_QUERY })}
          >
            {postOnly ? "All posts" : <>All <span>{selection.allCount}</span></>}
          </Button>
          {currentUserId ? (
            <>
              <Button
                variant="ghost"
                aria-pressed={assignedActive}
                disabled={archiving}
                onClick={() => setQuery(assignedQuery)}
              >
                Assigned to me {!postOnly ? <span>{assignedCount}</span> : null}
              </Button>
              <Button
                variant="ghost"
                aria-pressed={mineActive}
                disabled={archiving}
                onClick={() => setQuery(mineQuery)}
              >
                My recent edits {!postOnly ? <span>{mineCount}</span> : null}
              </Button>
            </>
          ) : null}
          {CONTENT_STATUSES.filter((status) => status !== "archived").map((status) => {
            // Status quick views compose with the current search, type, owner, and sort state.
            // selection.statusCounts is intentionally calculated before the status constraint,
            // so each count says what this exact neighboring choice will reveal.
            const preset = queryForStatus(query, status);
            return (
              <Button
                key={status}
                variant="ghost"
                aria-pressed={contentQueriesEqual(query, preset)}
                disabled={archiving}
                onClick={() => setQuery(preset)}
              >
                {displayContentStatus(status)} <span>{selection.statusCounts[status]}</span>
              </Button>
            );
          })}
          {visibleSavedViews.map((view) => {
            const parsedSavedQuery = parseContentQuery(view.query);
            const savedQuery = postOnly
              ? { ...parsedSavedQuery, types: ["post" as const] }
              : parsedSavedQuery;
            return (
              <span className="content-library-saved-view" key={view.id}>
                <Button
                  variant="ghost"
                  aria-pressed={contentQueriesEqual(query, savedQuery)}
                  disabled={archiving}
                  onClick={() => {
                    setQuery(savedQuery);
                    // A saved view that narrows the list shows its constraints as it lands,
                    // the same way an address that arrives already narrowed does.
                    const visibleQuery = postOnly
                      ? { ...savedQuery, types: [] }
                      : savedQuery;
                    if (activeAdvancedFilterCount(visibleQuery) > 0) {
                      setAdvancedFiltersOpen(true);
                    }
                  }}
                >
                  {view.name}
                </Button>
                {mutateSavedViews ? (
                  <Button
                    className="content-library-delete-view"
                    size="compact"
                    variant="ghost"
                    aria-label={`Delete saved view ${view.name}`}
                    disabled={savingView || archiving}
                    onClick={() =>
                      void persistSavedViewMutation({ type: "delete", id: view.id })
                    }
                  >
                    ×
                  </Button>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>
      <WorkspaceBrowseToolbar>
      <div className="content-library-actions">
        <div className="content-library-view-row" role="search" aria-label={`${contentLabel} tools`}>
          <label className="content-library-search">
            <span>{postOnly ? "Search posts" : "Search content"}</span>
            <span className="content-browse-search-control">
              <Icon name="search" />
              <TextInput
                className="field-control"
                type="search"
                value={query.q}
                placeholder="Search by title or record ID"
                disabled={archiving}
                onChange={(event) =>
                  updateQuery(
                    { q: event.target.value },
                    { replace: true, debounce: true },
                  )
                }
              />
            </span>
          </label>
          <div className="content-library-sort">
            <label>
              <span>Sort by</span>
              <Select
                className="field-control"
                value={query.sortField}
                disabled={archiving}
                onChange={(event) =>
                  updateQuery({ sortField: event.target.value as SortField })
                }
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              className="content-library-direction"
              variant="secondary"
              aria-label={`Direction: ${query.sortDirection === "desc" ? "descending" : "ascending"}. Switch to ${query.sortDirection === "desc" ? "ascending" : "descending"}`}
              disabled={archiving}
              onClick={() => updateQuery({ sortDirection: query.sortDirection === "desc" ? "asc" : "desc" })}
            >
              <Icon name={query.sortDirection === "desc" ? "arrow-down" : "arrow-up"} />
              {query.sortDirection === "desc" ? "Descending" : "Ascending"}
            </Button>
          </div>
          <Button
            variant="secondary"
            aria-controls={advancedFiltersId}
            aria-expanded={advancedFiltersOpen}
            disabled={archiving}
            onClick={() => {
              if (!advancedFiltersOpen) requestedPanelFocus.current = "filters";
              setAdvancedFiltersOpen((open) => !open);
            }}
          >
            <Icon name="sliders" />
            <span className="button-compact-label">Filters</span>
            {activeFilterCount > 0 ? (
              <span className="content-library-filter-count">
                <span aria-hidden="true">{activeFilterCount}</span>
                <span className="sr-only">
                  {`, ${activeFilterCount} ${activeFilterCount === 1 ? "filter" : "filters"} active`}
                </span>
              </span>
            ) : null}
          </Button>
          {mutateSavedViews ? (
            <Button
              variant="secondary"
              aria-controls={saveViewFormId}
              aria-expanded={saveViewFormOpen}
              ref={saveViewTriggerRef}
              disabled={savedViewsState.status !== "ready" || savingView || archiving}
              onClick={() => {
                setViewMutationError(null);
                if (!saveViewFormOpen) requestedPanelFocus.current = "save-view";
                setSaveViewFormOpen((open) => !open);
              }}
            >
              Save current view
            </Button>
          ) : null}
        </div>
        <div className="content-library-primary-actions">
          {postOnly || !canCreate ? <Link className={buttonClassName("ghost", "standard")} to={postTemplatesPath()}>Post templates</Link> : null}
          {canCreate ? (
            <WorkspaceActions>
              {postOnly ? (
                archiving ? (
                  <span className={buttonClassName("primary", "standard")} aria-disabled="true">
                    New post
                  </span>
                ) : (
                  <NewPostChoice origin={origin} />
                )
              ) : (
                <div className="content-library-create" ref={createMenuRef}>
                  <Button
                    variant="primary"
                    aria-controls={createOptionsId}
                    aria-expanded={createOptionsOpen}
                    disabled={archiving}
                    onClick={() => setCreateOptionsOpen((open) => !open)}
                    ref={createTriggerRef}
                  >
                    New content
                  </Button>
                  <nav
                    id={createOptionsId}
                    className="content-library-create-options"
                    aria-label="Create a content record"
                    hidden={!createOptionsOpen}
                  >
                    <ul>
                      {RECORD_DESTINATIONS.filter(
                        (destination) =>
                          !isRetiredRecordKind(destination.record),
                      ).map((destination) => (
                        <li key={destination.record}>
                          {archiving ? (
                            <span
                              className={buttonClassName("ghost", "standard")}
                              aria-disabled="true"
                            >
                              New {destination.label.toLocaleLowerCase()}
                            </span>
                          ) : (
                            <Link
                              className={buttonClassName("ghost", "standard")}
                              to={createRecordPath(destination.record)}
                              state={origin}
                            >
                              New {destination.label.toLocaleLowerCase()}
                            </Link>
                          )}
                        </li>
                      ))}
                      <li><Link className={buttonClassName("ghost", "standard")} to={postTemplatesPath()}>Post from template</Link></li>
                    </ul>
                  </nav>
                </div>
              )}
            </WorkspaceActions>
          ) : null}
        </div>
      </div>
      </WorkspaceBrowseToolbar>

      {mutateSavedViews ? (
        <form
          id={saveViewFormId}
          className="content-library-save-view"
          ref={saveViewFormRef}
          hidden={!saveViewFormOpen}
          onSubmit={(event) => void saveCurrentView(event)}
        >
          <label>
            <span>View name</span>
            <TextInput
              className="field-control"
              value={viewName}
              maxLength={MAX_SAVED_CONTENT_VIEW_NAME_LENGTH}
              disabled={archiving}
              onChange={(event) => setViewName(event.target.value)}
            />
          </label>
          <AsyncActionButton
            disabled={archiving}
            label="Save view"
            pending={savingView}
            pendingAnnouncement="Saving view."
            pendingLabel="Saving view…"
            type="submit"
            variant="primary"
          />
          <Button
            variant="ghost"
            disabled={savingView || archiving}
            onClick={() => {
              setSaveViewFormOpen(false);
              setViewMutationError(null);
              saveViewTriggerRef.current?.focus();
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      {savedViewsState.status === "loading" ? (
        <p className="content-library-saved-view-status" role="status">
          Loading saved views…
        </p>
      ) : savedViewsState.status === "error" ? (
        <InlineMessage tone="error" title="Saved views are unavailable">
          <span>{savedViewsState.message} The filters still work normally.</span>
        </InlineMessage>
      ) : null}
      {viewMutationError ? (
        <InlineMessage tone="error" title="The saved view could not be stored">
          <span>{viewMutationError}</span>
        </InlineMessage>
      ) : null}
      <BulkArchiveFeedback error={archiveRequestError} rows={archiveResult} />

      <div id={advancedFiltersId} hidden={!advancedFiltersOpen} ref={advancedFiltersRef}>
        <div className="content-library-filters">
          {!postOnly ? <fieldset disabled={archiving}>
            <legend>Content type</legend>
            <div className="content-filter-options">
              {RECORD_KINDS.map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    aria-label={recordDestination(kind).navLabel}
                    checked={query.types.includes(kind)}
                    onChange={() => updateQuery({ types: toggleValue(query.types, kind) })}
                  />
                  <span>{recordDestination(kind).navLabel}</span>
                </label>
              ))}
            </div>
          </fieldset> : null}

          <fieldset disabled={archiving}>
            <legend>Status</legend>
            <div className="content-filter-options">
              {CONTENT_STATUSES.filter((status) => status !== "archived").map((status) => (
                <label key={status}>
                  <input
                    type="checkbox"
                    aria-label={displayContentStatus(status)}
                    checked={query.statuses.includes(status)}
                    onChange={() =>
                      updateQuery({ statuses: toggleValue(query.statuses, status) })
                    }
                  />
                  <span>{displayContentStatus(status)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="content-owner-filter">
            <input
              type="checkbox"
              checked={query.ownerMode === "me"}
              disabled={!currentUserId || archiving}
              onChange={(event) =>
                updateQuery({
                  ownerMode: event.target.checked ? "me" : "any",
                  ownerUid: null,
                })
              }
            />
            <span>Updated by me</span>
          </label>
          <label className="content-owner-filter">
            <input
              type="checkbox"
              checked={query.assignmentMode === "me"}
              disabled={!currentUserId || archiving}
              onChange={(event) =>
                updateQuery({
                  assignmentMode: event.target.checked ? "me" : "any",
                  assigneeUid: null,
                })
              }
            />
            <span>Assigned to me</span>
          </label>
          {query.ownerMode === "specific" ? (
            <InlineMessage tone="info">
              <span>Filtering by user {query.ownerUid}.</span>
              <Button
                disabled={archiving}
                onClick={() => updateQuery({ ownerMode: "any", ownerUid: null })}
              >
                Clear owner filter
              </Button>
            </InlineMessage>
          ) : null}
          {query.assignmentMode === "specific" ? (
            <InlineMessage tone="info">
              <span>Filtering by assignment to user {query.assigneeUid}.</span>
              <Button
                disabled={archiving}
                onClick={() =>
                  updateQuery({ assignmentMode: "any", assigneeUid: null })
                }
              >
                Clear assignment filter
              </Button>
            </InlineMessage>
          ) : null}

        </div>
      </div>

      <div className="content-library-result-bar">
        <p aria-live="polite">
          <strong>{selection.total}</strong> {selection.total === 1 ? "record" : "records"}
        </p>
        {!allActive ? (
          <Button
            variant="ghost"
            disabled={archiving}
            onClick={() => setQuery({ ...DEFAULT_CONTENT_QUERY })}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {bulkArchiveAvailable ? (
        <p className="sr-only" role="status" aria-label="Selected records">
          {selectedRecords.length} {selectedRecords.length === 1 ? "record" : "records"} selected
        </p>
      ) : null}

      {bulkArchiveAvailable && selectedRecords.length > 0 ? (
        <div className="content-library-bulk" role="group" aria-label="Bulk actions">
          <div className="content-library-bulk-toolbar">
            <span>
              <strong>
                {selectedRecords.length} {selectedRecords.length === 1 ? "record" : "records"} selected
              </strong>
              <span className="content-library-eligible-count">
                {` · ${eligibleRecords.length} eligible on this page`}
              </span>
            </span>
            <Button
              className="content-library-trash-action"
              variant="danger"
              disabled={
                selectedRecords.length === 0 ||
                updating ||
                archiving ||
                quickEditDirty ||
                quickEditSaving
              }
              onClick={() => {
                if (quickEditSaving || quickEditHasUnsavedWork()) {
                  setArchiveConfirmationOpen(false);
                  return;
                }
                setArchiveRequestError(null);
                setArchiveResult(null);
                setArchiveConfirmationOpen(true);
              }}
            >
              <Icon name="trash" />
              Move selected to recycle bin
            </Button>
          </div>
          {quickEditDirty || quickEditSaving ? (
            <p className="content-library-bulk-note" role="status">
              Save or discard the open quick edit before moving records to Recycle bin.
            </p>
          ) : null}
          {archiveConfirmationOpen ? (
            <section
              className="content-library-bulk-confirmation"
              aria-labelledby={bulkConfirmTitleId}
            >
              <h3 id={bulkConfirmTitleId}>Move the selected records to Recycle bin?</h3>
              <p>
                This moves {selectedRecords.length === 1 ? "it" : "them"} to Recycle bin.
                It does not publish or deploy the site. A record that changed since this page
                loaded will be left alone and reported separately.
              </p>
              <div>
                <AsyncActionButton
                  variant="danger"
                  label={`Move ${selectedRecords.length} ${selectedRecords.length === 1 ? "record" : "records"} to Recycle bin`}
                  disabled={quickEditDirty || quickEditSaving}
                  onClick={() => void archiveSelectedRecords()}
                  pending={archiving}
                  pendingAnnouncement="Moving selected records to Recycle bin."
                  pendingLabel="Moving…"
                />
                <Button
                  variant="ghost"
                  disabled={archiving}
                  onClick={() => setArchiveConfirmationOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {selection.total === 0 ? (
        <EmptyState
          title={selection.allCount === 0 ? "No content yet" : "No content matches these filters"}
          description={
            selection.allCount === 0
              ? "Create the first structured record when you are ready."
              : "Clear or change a filter to widen the results."
          }
          action={
            selection.allCount > 0 ? (
              <Button
                disabled={archiving}
                onClick={() => setQuery({ ...DEFAULT_CONTENT_QUERY })}
              >
                Clear filters
              </Button>
            ) : canCreate ? (
              archiving ? (
                <span className={buttonClassName("primary", "standard")} aria-disabled="true">
                  Create a post
                </span>
              ) : (
                <NewPostChoice origin={origin} label="Create a post" />
              )
            ) : undefined
          }
        />
      ) : (
        <>
          <TableFrame className="content-browse-frame" aria-label={`${contentLabel} table`}>
            <table className="data-table browse-table content-browse-table" aria-label={`${contentLabel} results`}>
              <thead>
                <tr>
                  {bulkArchiveAvailable ? <th scope="col" className="content-library-select-cell">
                    <Checkbox size="compact" className="content-library-select-all"
                        hideLabel label="Select all eligible records on this page"
                        checked={allEligibleSelected}
                        indeterminate={selectedRecords.length > 0 && !allEligibleSelected}
                        disabled={eligibleRecords.length === 0 || updating || archiving}
                        onChange={(event) => {
                          setArchiveConfirmationOpen(false);
                          setSelectedIds(event.target.checked
                            ? new Set(eligibleRecords.map((record) => record.id))
                            : new Set());
                        }}
                    />
                  </th> : null}
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Assignment</th>
                  <th scope="col" className="content-index-updated">Last updated</th>
                  <th scope="col" className="content-index-actions-cell"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {selection.records.map((record) => {
                  const hasVersion = hasArchivableVersion(record.version);
                  const recordEligible = record.status !== "archived" && hasVersion;
                  const detailsId = `${detailsPrefix}-${record.id}`;
                  const expanded = expandedPostIds.has(record.id);
                  const updatedAt = displayDate(record.updatedAt);
                  const thumbnailIcon = record.kind === "event"
                    ? "activity"
                    : record.kind === "program"
                      ? "media"
                      : "file";
                  const selectionLabel = record.status === "archived"
                    ? `${record.title} is already in Recycle bin`
                    : hasVersion
                      ? `Select ${record.title}`
                      : `${record.title} has no current version and cannot be moved to Recycle bin`;
                  return (
                    <Fragment key={`${record.kind}:${record.id}`}>
                    <tr
                      className="content-index-row"
                      data-selected={selectedIds.has(record.id) ? "true" : undefined}
                      data-expanded={expanded ? "true" : undefined}
                    >
                      {bulkArchiveAvailable ? (
                        <td data-label="Select" className="content-library-select-cell">
                          <Checkbox size="compact" hideLabel label={selectionLabel}
                            checked={recordEligible && selectedIds.has(record.id)}
                            disabled={!recordEligible || updating || archiving}
                            onChange={() => toggleRecordSelection(record.id)}
                          />
                        </td>
                      ) : null}
                      <td data-label="Name" className="content-title">
                        <div className="content-index-identity">
                          {archiving || isRetiredRecordKind(record.kind) ? (
                            <span className="content-index-title-static" aria-disabled="true">
                              <ContentRowThumbnail
                                src={record.thumbnailUrl}
                                icon={thumbnailIcon}
                              />
                              <span>{record.title}</span>
                            </span>
                          ) : (
                            <Link
                              className="content-index-title-link"
                              to={editRecordPath(record.kind, record.id)}
                              state={origin}
                            >
                              <ContentRowThumbnail
                                src={record.thumbnailUrl}
                                icon={thumbnailIcon}
                              />
                              <span>{record.title}</span>
                            </Link>
                          )}
                          {record.contentLinkDomain ? <small>Links to {record.contentLinkDomain}</small> : null}
                          <span className="content-index-date-inline">
                            Last updated: {updatedAt ? <time dateTime={record.updatedAt}>{updatedAt.date} · {updatedAt.time}</time> : "Not recorded"}
                          </span>
                          {record.kind === "post" ? <ScheduledPublicationTime status={record.status} publishAt={record.publishAt} className="content-index-secondary" /> : null}
                        </div>
                      </td>
                      <td data-label="Type">{contentKindLabel(record.kind)}</td>
                      <td data-label="Status">
                        {record.kind !== "post" ? <div>
                          <StatusBadge tone={contentStatusTone(record.status)}>
                            {displayContentStatus(record.status)}
                          </StatusBadge>
                        </div> : null}
                        <PublishedVersionStatus
                          collection="cmsPosts"
                          workingStatus={record.kind === "post" ? record.status : undefined}
                          recordTitle={record.title}
                          compact
                          documentId={record.id}
                          contentVersion={record.contentVersion}
                          publishedSourceVersion={record.publishedSourceVersion}
                          publishedContentVersion={record.publishedContentVersion}
                          liveSourceVersion={record.liveSourceVersion}
                          recordPublication={record.recordPublication}
                          publicBuildQueueId={record.publicBuildQueueId}
                          publicUpdatePending={record.publicUpdatePending}
                          pendingSourceVersion={record.pendingSourceVersion}
                          workingVersion={record.version}
                          loadPublicationMetadata={listRowNeedsPublicationWatch(record)}
                        />
                      </td>
                      <td data-label="Assignment">
                        {record.assignee === currentUserId
                          ? "You"
                          : record.assignee
                            ? "Another staff\u00a0member"
                            : "Unassigned"}
                      </td>
                      <td data-label="Last updated" className="content-index-date">
                        {updatedAt ? (
                          <time dateTime={record.updatedAt}>
                            <span>{updatedAt.date}</span>
                            <span className="content-index-date-time">{updatedAt.time}</span>
                          </time>
                        ) : (
                          "Not recorded"
                        )}
                      </td>
                      <td data-label="Actions" className="content-index-actions-cell">
                        {!archiving && !isRetiredRecordKind(record.kind) ? (
                          <BrowseRowActions
                            name={record.title}
                            primaryAction={
                              <Link
                                className={buttonClassName("secondary", "compact", "browse-row-edit")}
                                aria-label={`Edit ${record.title}`}
                                to={editRecordPath(record.kind, record.id)}
                                state={origin}
                              >
                                <Icon name="pencil" />
                                Edit
                              </Link>
                            }
                          >
                            {record.kind === "post" ? <Button
                              className="content-index-action-link"
                              variant="ghost"
                              type="button"
                              aria-controls={detailsId}
                              aria-expanded={expanded}
                              aria-label={`${expanded ? "Hide" : "Show"} details for ${record.title}`}
                              onClick={() => togglePostDetails(record.id)}
                            >{expanded ? "Hide details" : "Details"}</Button> : null}
                          </BrowseRowActions>
                        ) : null}
                      </td>
                    </tr>
                    {record.kind === "post" && openedPostIds.has(record.id) ? (
                      <tr className="content-index-detail-row" hidden={!expanded}>
                        <td colSpan={bulkArchiveAvailable ? 7 : 6}>
                          <section className="content-index-detail-panel" id={detailsId} aria-label={`${record.title} details`}>
                            <div className="content-index-detail-heading"><strong>{record.title}</strong><span>Post details</span></div>
                            <p className="field-hint">Record ID: <code>{record.id}</code>{record.version ? ` · Working version ${record.contentVersion ?? record.version}` : ""}</p>
                            <ContentQuickEdit
                              label={record.title}
                              persistentEditorDirty={persistentEditorDirty}
                              target={{ kind: "post", recordId: record.id }}
                              onDocumentChange={() => setAttempt((value) => value + 1)}
                            />
                            <Link className={buttonClassName("secondary", "standard")} to={editRecordPath("post", record.id)} state={origin}>Open full editor</Link>
                          </section>
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
          {selection.pageCount > 1 ? (
            <nav className="content-library-pagination" aria-label={`${contentLabel} pages`}>
              <ActionControl
                action="previous-page"
                label="Previous"
                disabled={selection.page === 1 || archiving}
                onClick={() =>
                  updateQuery(
                    { page: selection.page - 1 },
                    { keepPage: true },
                  )
                }
              />
              <span>
                Page {selection.page} of {selection.pageCount}
              </span>
              <ActionControl
                action="next-page"
                label="Next"
                disabled={selection.page === selection.pageCount || archiving}
                onClick={() =>
                  updateQuery(
                    { page: selection.page + 1 },
                    { keepPage: true },
                  )
                }
              />
            </nav>
          ) : null}
        </>
      )}
      <RecycleBin
        count={selection.statusCounts.archived}
        loadPage={loadDeletedPage}
        onRestore={() => setAttempt((value) => value + 1)}
        persistentEditorDirty={persistentEditorDirty}
        disabled={archiving || updating}
      />
    </div>
  );
}

// The loaded library's frame: quick views, the tools row, the result count and the table header,
// with skeleton rows where the records go. The rows keep the loaded roles and labels, which the
// layout CSS selects on. Control shapes take a minimum width rather than a fixed one, so the
// narrow layout's grid stretches them the way it stretches the real buttons.
function ContentLibrarySkeleton({
  contentLabel,
  withSelect,
  postOnly,
  canCreate,
  canSaveViews,
}: {
  contentLabel: string;
  withSelect: boolean;
  postOnly: boolean;
  canCreate: boolean;
  canSaveViews: boolean;
}) {
  return (
    <SkeletonRegion label={`Loading ${contentLabel}`} className="content-library">
      <div className="content-library-actions">
        <div className="content-library-view-row content-library-views" onFocus={event => revealInlineFocus(event.currentTarget, event.target)} role="group" aria-label={`${contentLabel} quick views`}>
          {/* The eight fixed views; saved views vary, so none is reserved. */}
          {[86, 176, 160, 90, 130, 135, 140, 135].map((width, index) => (
            <SkeletonBlock key={index} style={{ minWidth: width }} height="var(--cms-control-height)" radius="control" />
          ))}
        </div>
      </div>
      <div className="content-library-actions">
        <div className="content-library-view-row" role="search" aria-label={`${contentLabel} tools`}>
          <label className="content-library-search">
            <span>{contentLabel === "Posts" ? "Search posts" : "Search content"}</span>
            <SkeletonBlock style={{ minWidth: "12rem" }} height="var(--cms-control-height)" radius="control" />
          </label>
          <div className="content-library-sort">
            <label>
              <span>Sort by</span>
              <SkeletonBlock style={{ minWidth: 160 }} height="var(--cms-control-height)" radius="control" />
            </label>
            <SkeletonBlock style={{ minWidth: 132, alignSelf: "flex-end" }} height="var(--cms-control-height)" radius="control" />
          </div>
          <SkeletonBlock style={{ minWidth: 104, alignSelf: "flex-end" }} height="var(--cms-control-height)" radius="control" />
          {canSaveViews ? <SkeletonBlock style={{ minWidth: 162, alignSelf: "flex-end" }} height="var(--cms-control-height)" radius="control" /> : null}
        </div>
        <div className="content-library-primary-actions">
          {postOnly || !canCreate ? <SkeletonBlock style={{ minWidth: 124 }} height="var(--cms-control-height)" radius="control" /> : null}
          {canCreate ? (
            // The create control goes where the loaded one goes: into the browse heading when the
            // page has one. That target sits outside this region, so the shape hides itself.
            <WorkspaceActions>
              <div className={postOnly ? "post-start-choice" : "content-library-create"} aria-hidden="true" data-skeleton="">
                <SkeletonBlock style={{ minWidth: postOnly ? 118 : 130 }} height="var(--cms-control-height)" radius="control" />
                {postOnly ? (
                  <SkeletonBlock width="var(--cms-control-height)" height="var(--cms-control-height)" radius="control" />
                ) : null}
              </div>
            </WorkspaceActions>
          ) : null}
        </div>
      </div>
      <div className="content-library-result-bar">
        <p><SkeletonText width={72} /></p>
      </div>
      <ContentLibraryTableShapes withSelect={withSelect} postOnly={postOnly} />
    </SkeletonRegion>
  );
}
