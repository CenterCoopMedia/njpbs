import { revealInlineFocus } from "../lib/reveal-inline-focus";
import { WorkspaceBrowseToolbar } from "./WorkspaceActions";
import { BrowseRowActions } from "./BrowseRowActions";
import { buttonClassName } from "./ui/Primitives";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { ActionControl } from "./ui/ActionControl";
import { Tooltip } from "./ui/Tooltip";
import { useControlPresentation } from "../context/ControlPresentationContext";
import { InfoTooltip } from "./ui/InfoTooltip";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  PUBLIC_PAGES,
  type PublicPageId,
} from "../../../packages/content-core/src/public-pages";
import {
  POST_SLUG_MAX,
  POST_SLUG_SHAPE,
  slugifyPostTitle,
} from "../../../packages/content-core/src/post-slugs";
import { listRowNeedsPublicationWatch } from "../lib/content-status";
import { publicSiteOrigin, publicSiteUrl } from "../lib/dev-origins";
import { listOriginState, type ListOriginState } from "../lib/editor-back";
import { editPagePath } from "../lib/routes";
import { ContentQuickEdit } from "./ContentQuickEdit";
import { usePublicContentStatus } from "../context/PublicContentStatusContext";
import { PublishedVersionStatus } from "./PublishedVersionStatus";
import { ScheduledPublicationTime } from "./ScheduledPublicationTime";
import { ContentRowThumbnail } from "./ContentRowThumbnail";
import { Icon, type IconName } from "./ui/Icon";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Select,
  TableFrame,
  TextInput,
} from "./ui/Primitives";
import { SkeletonBlock } from "./ui/Skeleton";
import { WorkspaceActions } from "./WorkspaceActions";
import { RecycleBin, type RecycleBinPage } from "./RecycleBin";

export interface PageDirectoryEntry {
  id: string;
  title: string;
  path: string;
  section?: string;
  status?: string;
  publishAt?: string;
  published?: boolean;
  livePath?: string;
  liveTitle?: string;
  contentLinkDomain?: string;
  thumbnailUrl?: string;
  version?: number;
  contentVersion?: number;
  publishedContentVersion?: number;
  publishedSourceVersion?: number;
  liveSourceVersion?: number;
  publicUpdatePending?: boolean;
  publicBuildQueueId?: string | null;
  pendingSourceVersion?: number;
  pageReceipt?: { operationId: string; sourceVersion: number; visible: boolean };
  publicationTransport?: "page-no-build-v1";
}

export interface PageDirectoryApi {
  // Keep stable for presentation changes; replace when read authority changes.
  load(): Promise<PageDirectoryEntry[]>;
  create(input: {
    title: string;
    slug: string;
    section: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  sections: readonly { id: string; label: string }[];
  canCreate: boolean;
  canOpenBuiltIn?: (id: string) => boolean;
}

const FAMILY_LABELS = {
  home: "Home page",
  service: "Service page",
  schedule: "Schedule page",
  article: "Article page",
  staff: "Staff directory",
  dataHub: "Data Hub",
} as const;

const FAMILY_ICONS: Record<keyof typeof FAMILY_LABELS, IconName> = {
  home: "home", service: "media", schedule: "activity", article: "file", staff: "users", dataHub: "activity",
};

const PAGE_ICONS: Record<string, IconName> = {
  watch: "play", live: "video", kids: "users", support: "heart", give: "heart", passport: "video",
};

const AREA_LABELS = {
  watch: "Watch",
  support: "Support",
  station: "Station",
  compliance: "Compliance",
} as const;

interface DirectoryPage {
  id: string;
  title: string;
  status?: string;
  publishAt?: string;
  path: string;
  livePath?: string;
  liveTitle?: string;
  contentLinkDomain?: string;
  published: boolean;
  family: keyof typeof FAMILY_LABELS;
  sectionLabel: string;
  editorTemplate: string;
  aliases?: readonly string[];
  thumbnailUrl?: string;
  version?: number;
  contentVersion?: number;
  publishedContentVersion?: number;
  publishedSourceVersion?: number;
  liveSourceVersion?: number;
  publicUpdatePending?: boolean;
  publicBuildQueueId?: string | null;
  pendingSourceVersion?: number;
  pageReceipt?: PageDirectoryEntry["pageReceipt"];
  publicationTransport?: "page-no-build-v1";
}

function publicationFields(entry?: PageDirectoryEntry) {
  if (!entry) return {};
  return {
    contentLinkDomain: entry.contentLinkDomain,
    version: entry.version,
    contentVersion: entry.contentVersion,
    publishedContentVersion: entry.publishedContentVersion,
    publishAt: entry.publishAt,
    publishedSourceVersion: entry.publishedSourceVersion,
    liveSourceVersion: entry.liveSourceVersion,
    publicUpdatePending: entry.publicUpdatePending,
    publicBuildQueueId: entry.publicBuildQueueId,
    pendingSourceVersion: entry.pendingSourceVersion,
    pageReceipt: entry.pageReceipt,
    publicationTransport: entry.publicationTransport,
  };
}

const EMPTY_ENTRIES: readonly PageDirectoryEntry[] = [];

function pageError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function mergeDirectoryPages(
  entries: readonly PageDirectoryEntry[],
  sections: PageDirectoryApi["sections"],
  canOpenBuiltIn?: PageDirectoryApi["canOpenBuiltIn"],
): DirectoryPage[] {
  const sectionLabels = new Map(sections.map((section) => [section.id, section.label]));
  const storedById = new Map(entries.map((entry) => [entry.id, entry]));
  const builtInIds = new Set<string>(PUBLIC_PAGES.map((page) => page.id));
  const builtIns = PUBLIC_PAGES.filter(page => storedById.has(page.id) || !canOpenBuiltIn || canOpenBuiltIn(page.id)).map((page): DirectoryPage => {
    const stored = storedById.get(page.id);
    const published = stored?.published ?? true;
    return {
      id: page.id,
      title: stored?.title ?? page.title,
      status: stored?.status,
      path: stored?.path ?? page.path,
      thumbnailUrl: stored?.thumbnailUrl,
      livePath: published ? stored?.livePath ?? page.path : undefined,
      published,
      family: page.family,
      sectionLabel: stored?.section
        ? sectionLabels.get(stored.section) ?? stored.section
        : AREA_LABELS[page.area],
      editorTemplate: page.editorTemplate,
      aliases: "aliases" in page ? page.aliases : undefined,
      ...publicationFields(stored),
    };
  });
  const custom = [...storedById.values()]
    .filter((entry) => !builtInIds.has(entry.id))
    .map((entry): DirectoryPage => ({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      path: entry.path,
      thumbnailUrl: entry.thumbnailUrl,
      livePath: entry.published ? entry.livePath ?? entry.path : undefined,
      published: entry.published === true,
      family: "article",
      sectionLabel: entry.section
        ? sectionLabels.get(entry.section) ?? entry.section
        : "No area",
      editorTemplate: "genericPage",
      ...publicationFields(entry),
    }));
  return [...builtIns, ...custom];
}

function openModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function PageCreateControl({
  api,
  origin,
  persistentEditorDirty,
}: {
  api: PageDirectoryApi;
  origin: ListOriginState;
  persistentEditorDirty: boolean;
}) {
  const navigate = useNavigate();
  const createTitleId = useId();
  const createDisabledId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const createInFlightRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugCustomized, setSlugCustomized] = useState(false);
  const [section, setSection] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function resetForm() {
    setTitle("");
    setSlug("");
    setSlugCustomized(false);
    setSection("");
    setCreateError(null);
    idempotencyKeyRef.current = null;
  }

  function openDialog() {
    resetForm();
    const dialog = dialogRef.current;
    if (!dialog) return;
    openModal(dialog);
    queueMicrotask(() => dialog.querySelector<HTMLInputElement>("input")?.focus());
  }

  function dismissDialog() {
    if (createInFlightRef.current) return;
    const dialog = dialogRef.current;
    if (dialog) closeModal(dialog);
    resetForm();
  }

  async function createPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createInFlightRef.current) return;
    const cleanTitle = title.trim();
    const cleanSlug = slug.trim();
    const cleanSection = section.trim();
    if (!cleanTitle || !cleanSlug || !cleanSection) {
      setCreateError("Enter a page title, URL slug, and area.");
      return;
    }

    createInFlightRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const idempotencyKey = idempotencyKeyRef.current ?? crypto.randomUUID();
      idempotencyKeyRef.current = idempotencyKey;
      const created = await api.create({
        title: cleanTitle,
        slug: cleanSlug,
        section: cleanSection,
        idempotencyKey,
      });
      idempotencyKeyRef.current = null;
      const dialog = dialogRef.current;
      if (dialog) closeModal(dialog);
      navigate(editPagePath(created.id as PublicPageId), { state: origin });
    } catch (error: unknown) {
      setCreateError(pageError(error, "The page could not be created."));
    } finally {
      createInFlightRef.current = false;
      setCreating(false);
    }
  }

  return (
    <>
      <WorkspaceActions>
        <div className="toolbar">
          <Button
            aria-describedby={persistentEditorDirty ? createDisabledId : undefined}
            aria-haspopup="dialog"
            disabled={persistentEditorDirty}
            onClick={openDialog}
            variant="primary"
          >
            <Icon name="plus" />
            <span className="button-compact-label">Add page</span>
          </Button>
          {persistentEditorDirty ? (
            <p className="editor-field-hint" id={createDisabledId}>
              Save or discard the open editor draft before adding a page.
            </p>
          ) : null}
        </div>
      </WorkspaceActions>

      <dialog
        aria-labelledby={createTitleId}
        className="report-problem-dialog"
        ref={dialogRef}
        onCancel={(event) => {
          if (creating) event.preventDefault();
        }}
        onClose={resetForm}
        onClick={(event) => {
          if (event.target === event.currentTarget && !creating) dismissDialog();
        }}
      >
        <div className="report-problem-dialog-panel">
          <div className="report-problem-dialog-head">
            <div>
              <h2 id={createTitleId}>Add page</h2>
              <p>Create a draft page for the public site.</p>
            </div>
            <Button
              aria-label="Close page form"
              disabled={creating}
              onClick={dismissDialog}
              variant="ghost"
            >
              <Icon name="close" />
            </Button>
          </div>
          <form className="report-problem-form" onSubmit={createPage}>
            <label>
              <span>Page title</span>
              <TextInput
                autoComplete="off"
                disabled={creating}
                onChange={(event) => {
                  const nextTitle = event.target.value;
                  setTitle(nextTitle);
                  if (!slugCustomized) setSlug(slugifyPostTitle(nextTitle));
                }}
                required
                value={title}
              />
            </label>
            <label>
              <span>URL slug</span>
              <TextInput
                autoCapitalize="none"
                autoComplete="off"
                disabled={creating}
                maxLength={POST_SLUG_MAX}
                onChange={(event) => {
                  setSlugCustomized(true);
                  setSlug(event.target.value);
                }}
                pattern={POST_SLUG_SHAPE.source}
                required
                spellCheck={false}
                value={slug}
              />
            </label>
            <p className="editor-field-hint">
              <code style={{ overflowWrap: "anywhere" }}>{`${publicSiteOrigin}/${slug || "<slug>"}/`}</code>
            </p>
            <div>
              <div className="editor-field-label-row"><label htmlFor="new-page-editing-group">Area</label><InfoTooltip label="Area" content="The area controls staff access. It does not add a public navigation link." /></div>
              <Select id="new-page-editing-group"
                disabled={creating}
                onChange={(event) => setSection(event.target.value)}
                required
                value={section}
              >
                <option value="">Choose an area</option>
                {api.sections.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </Select>
            </div>
            <p className="editor-field-hint">
              The new page is saved as a draft. It does not change the public site.
            </p>
            {createError ? (
              <InlineMessage tone="error" title="Page was not created">
                {createError}
              </InlineMessage>
            ) : null}
            <div className="button-row">
              <Button disabled={creating} onClick={dismissDialog}>
                Cancel
              </Button>
              <AsyncActionButton
                label="Create page"
                pending={creating}
                pendingAnnouncement="Creating the page draft."
                pendingLabel="Creating…"
                type="submit"
                variant="primary"
              />
            </div>
          </form>
        </div>
      </dialog>
    </>
  );
}

// The page directory deliberately reflects the public site rather than the CMS storage model.
// Built-in routes remain visible before an authorized CMS read completes. Stored entries then
// replace their mutable directory fields, while custom pages join the same list by immutable id.
export function PagesDirectory(props: Parameters<typeof PagesDirectoryContent>[0]) {
  return <ControlSizingProvider size="standard"><PagesDirectoryContent {...props} /></ControlSizingProvider>;
}

function PagesDirectoryContent({
  api,
  persistentEditorDirty = false,
}: {
  api?: PageDirectoryApi;
  persistentEditorDirty?: boolean;
}) {
  // Carried onto every page editor this directory opens, so the editor's Back action names the
  // list the person actually came from (#1037).
  const controlPresentation = useControlPresentation();
  const location = useLocation();
  const origin = listOriginState(location);
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("page_q") ?? "";
  // Keep input edits synchronous while navigation is pending. A new location ends
  // the draft, so Back cannot restore a draft from an earlier visit.
  const [searchDraft, setSearchDraft] = useState({ locationKey: location.key, value: search });
  if (searchDraft.locationKey !== location.key) {
    setSearchDraft({ locationKey: location.key, value: search });
  }
  const searchValue = searchDraft.locationKey === location.key ? searchDraft.value : search;
  const section = searchParams.get("page_section") ?? "";
  const detailsPrefix = useId();
  const [loaded, setLoaded] = useState<{
    reader: PageDirectoryApi["load"];
    entries: PageDirectoryEntry[];
  } | null>(null);
  const publicStatus = usePublicContentStatus();
  const publicStatusUnavailable = !publicStatus || publicStatus.state === "unavailable";
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Start in the loading state when a read will run, so the first paint does not mount the
  // public-site cells (and their status poll) only to swap them for skeleton chips.
  const [loading, setLoading] = useState(() => Boolean(api?.load));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedPageIds, setExpandedPageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openedPageIds, setOpenedPageIds] = useState<Set<string>>(
    () => new Set(),
  );

  const reader = api?.load;
  useEffect(() => {
    if (!reader) {
      setLoaded(null);
      setLoading(false);
      setLoadError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    void reader()
      .then((entries) => {
        if (active) setLoaded({ reader, entries });
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(pageError(error, "The saved pages could not be loaded."));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reader, loadAttempt]);

  const entries = loaded && loaded.reader === reader ? loaded.entries : EMPTY_ENTRIES;
  const allPages = useMemo(
    () => mergeDirectoryPages(entries, api?.sections ?? [], api?.canOpenBuiltIn),
    [api?.sections, api?.canOpenBuiltIn, entries],
  );
  const pages = allPages.filter((page) => page.status !== "archived");
  const deletedPages = useMemo(() => allPages.filter((page) =>
    page.status === "archived" &&
    (!section || page.sectionLabel === section) &&
    [page.title, page.id, page.path, page.sectionLabel, ...(page.aliases ?? [])]
      .join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  ), [allPages, section, search]);
  const loadDeletedPage = useCallback(async (): Promise<RecycleBinPage> => ({
    page: 1,
    pageCount: 1,
    items: deletedPages.map((page) => ({
      id: page.id,
      title: page.title,
      editorPath: editPagePath(page.id as PublicPageId),
      target: { kind: "page", pageId: page.id as PublicPageId },
    })),
  }), [deletedPages]);
  const sections = [...new Set(pages.map((page) => page.sectionLabel))].sort();
  const matchingIds = new Set(pages.filter((page) =>
    (!section || page.sectionLabel === section) &&
    [page.title, page.id, page.path, page.sectionLabel, ...(page.aliases ?? [])]
      .join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  ).map((page) => page.id));

  function filterPages(name: "page_q" | "page_section", value: string) {
    if (name === "page_q") setSearchDraft({ locationKey: location.key, value });
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    }, { replace: name === "page_q" });
  }

  function toggleDetails(pageId: string) {
    if (!expandedPageIds.has(pageId)) {
      setOpenedPageIds((current) => new Set(current).add(pageId));
    }
    setExpandedPageIds((current) => {
      const next = new Set(current);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }

  return (
    <div className="pages-directory content-index">
      <div className="content-library-actions">
        <div
          className="content-library-view-row content-library-views pages-directory-section-views"
          onFocus={event => revealInlineFocus(event.currentTarget, event.target)}
          role="group"
          aria-label="Page areas"
        >
          <Button
            variant="ghost"
            aria-pressed={section === ""}
            onClick={() => filterPages("page_section", "")}
          >
            All areas <span>{pages.length}</span>
          </Button>
          {sections.map((name) => (
            <Button
              key={name}
              variant="ghost"
              aria-pressed={section === name}
              onClick={() => filterPages("page_section", name)}
            >
              {name} <span>{pages.filter((page) => page.sectionLabel === name).length}</span>
            </Button>
          ))}
        </div>
      </div>
      {publicStatusUnavailable ? (
        <InlineMessage className="pages-directory-public-notice" tone="warning">
          <Icon name="info" />
          <div>
            <strong>Public-site status is unavailable</strong>
            <p>Open a live page to check what’s currently visible.</p>
          </div>
        </InlineMessage>
      ) : null}

      {loading ? (
        <span className="sr-only" role="status">Loading saved pages</span>
      ) : null}
      {loadError ? (
        <InlineMessage tone="error" title="Pages could not be loaded">
          <p>{loadError}</p>
          <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            Retry
          </Button>
        </InlineMessage>
      ) : null}

      <div className="pages-directory-list">
        <WorkspaceBrowseToolbar>
        <div className="content-browse-toolbar pages-directory-toolbar">
          <div className="content-browse-search" role="search" aria-label="Find site pages">
            <label>
              <span>Search pages</span>
              <span className="content-browse-search-control">
                <Icon name="search" />
                <TextInput
                  type="search"
                  value={searchValue}
                  onChange={(event) => filterPages("page_q", event.target.value)}
                  placeholder="Search by title, URL, or alias"
                />
              </span>
            </label>
          </div>
          <p className="pages-directory-count" role="status">
            {search || section ? `${matchingIds.size} of ${pages.length} pages shown` : `${pages.length} pages`}
          </p>
          {search || section ? <Button variant="ghost" onClick={() => {
            setSearchDraft({ locationKey: location.key, value: "" });
            setSearchParams((current) => {
              const next = new URLSearchParams(current);
              next.delete("page_q"); next.delete("page_section");
              return next;
            });
          }}>Clear page filters</Button> : null}
          {api?.canCreate ? (
            <PageCreateControl api={api} origin={origin} persistentEditorDirty={persistentEditorDirty} />
          ) : null}
        </div>
        </WorkspaceBrowseToolbar>
      <TableFrame
        className="content-browse-frame"
        aria-label="Site pages table"
        aria-busy={loading || undefined}
        data-skeleton={loading ? "" : undefined}
      >
        <table className="data-table browse-table pages-directory-table content-browse-table" aria-label="Live site pages">
          <caption className="sr-only">
            Canonical site pages with draft, live, and expandable detail actions
          </caption>
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Area</th>
              <th scope="col">Status</th>
              <th scope="col" className="content-index-actions-cell"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => {
              const editorPath = editPagePath(page.id as PublicPageId);
              const liveUrl = page.published && page.livePath
                ? publicSiteUrl(page.livePath)
                : null;
              const expanded = expandedPageIds.has(page.id);
              const detailsId = `${detailsPrefix}-${page.id}`;
              return (
                <Fragment key={page.id}>
                  <tr
                    className="content-index-row"
                    data-expanded={expanded ? "true" : "false"}
                    hidden={!matchingIds.has(page.id)}
                  >
                    <td data-label="Page" className="content-title">
                      <div className="pages-directory-identity content-index-identity">
                        <Link
                          className="pages-directory-title-link content-index-title-link"
                          aria-label={`Edit page draft: ${page.title}`}
                          to={editorPath}
                          state={origin}
                        >
                          <ContentRowThumbnail
                            src={page.thumbnailUrl}
                            icon={PAGE_ICONS[page.id] ?? FAMILY_ICONS[page.family]}
                          />
                          <span>{page.title}</span>
                        </Link>
                        {page.contentLinkDomain ? <small>Links to {page.contentLinkDomain}</small> : null}
                        <div className="pages-directory-address content-index-address">
                          {liveUrl && page.livePath === page.path ? (
                            <a href={liveUrl} target="_blank" rel="noreferrer">
                              {page.path}
                              <span className="sr-only"> (opens in a new tab)</span>
                            </a>
                          ) : (
                            <span>{page.path}</span>
                          )}
                          {page.aliases?.length ? (
                            <span className="page-aliases">
                              Also served at {page.aliases.join(", ")}
                            </span>
                          ) : null}
                        </div>
                        <ScheduledPublicationTime status={page.status} publishAt={page.publishAt} className="content-index-secondary" />
                      </div>
                    </td>
                    <td data-label="Area">
                      <span className="content-index-section">{page.sectionLabel}</span>
                      <span className="content-index-secondary">{FAMILY_LABELS[page.family]}</span>
                    </td>
                    <td data-label="Status">
                      {/* The registry rows are known before the saved pages load; only their
                          public-site state waits, so that cell holds a chip-sized shape. */}
                      {loading ? (
                        <SkeletonBlock width={88} height={22} radius="round" />
                      ) : (
                        <PublishedVersionStatus
                          collection="cmsPages"
                          documentId={page.id}
                          compact
                          unknownLabel="Unknown"
                          workingStatus={page.status}
                          recordTitle={page.title}
                          contentVersion={page.contentVersion}
                          publishedContentVersion={page.publishedContentVersion}
                          workingVersion={page.version}
                          publishedSourceVersion={page.publishedSourceVersion}
                          liveSourceVersion={page.liveSourceVersion}
                          publicBuildQueueId={page.publicBuildQueueId}
                          publicUpdatePending={page.publicUpdatePending}
                          pendingSourceVersion={page.pendingSourceVersion}
                          pageReceipt={page.pageReceipt}
                          publicationTransport={page.publicationTransport}
                          loadPublicationMetadata={listRowNeedsPublicationWatch(page)}
                        />
                      )}
                    </td>
                    <td data-label="Actions" className="content-index-actions-cell">
                      <BrowseRowActions
                        name={page.title}
                        primaryAction={
                          <Link className={buttonClassName("secondary", "compact", "browse-row-edit")} to={editorPath} state={origin}>
                            Edit draft
                          </Link>
                        }
                      >
                        {liveUrl ? (
                          <Tooltip content={`View live: ${page.title} (opens in a new tab)`}>
                            <a
                              className={buttonClassName("ghost", "compact")}
                              href={liveUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`View live: ${page.title} (opens in a new tab)`}
                            >
                              {controlPresentation === "text" ? "View live" : <Icon name="external-link" />}
                            </a>
                          </Tooltip>
                        ) : null}
                        <ActionControl
                          action={expanded ? "collapse" : "expand"}
                          label="Details"
                          accessibleName={`${expanded ? "Hide" : "Show"} details for ${page.title}`}
                          className="content-index-action-link"
                          variant="ghost"
                          type="button"
                          aria-controls={detailsId}
                          aria-expanded={expanded}
                          onClick={() => toggleDetails(page.id)}
                        />
                      </BrowseRowActions>
                    </td>
                  </tr>
                  {openedPageIds.has(page.id) ? (
                    <tr
                      className="content-index-detail-row"
                      hidden={!expanded || !matchingIds.has(page.id)}
                    >
                      <td colSpan={4}>
                        <section
                          className="content-index-detail-panel"
                          id={detailsId}
                          aria-label={`${page.title} details`}
                        >
                          <div className="content-index-detail-heading">
                            <div>
                              <span className="content-index-detail-kicker">Page details</span>
                              <strong>{page.title}</strong>
                            </div>
                            <span>{page.sectionLabel}</span>
                          </div>
                          <dl className="content-index-facts">
                            <div>
                              <dt>Canonical path</dt>
                              <dd>
                                <code>{page.path}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>Page ID</dt>
                              <dd>
                                <code>{page.id}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>Page type</dt>
                              <dd>{FAMILY_LABELS[page.family]}</dd>
                            </div>
                            <div>
                              <dt>Editor template</dt>
                              <dd>
                                <code>{page.editorTemplate}</code>
                              </dd>
                            </div>
                          </dl>
                          <details className="pages-directory-quick-edit">
                            <summary>Quick edit and lifecycle</summary>
                            <ContentQuickEdit
                              label={page.title}
                              persistentEditorDirty={persistentEditorDirty}
                              target={{ kind: "page", pageId: page.id as PublicPageId }}
                              onDocumentChange={() => setLoadAttempt((attempt) => attempt + 1)}
                            />
                          </details>
                        </section>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {matchingIds.size === 0 ? <tr><td colSpan={4}>No pages match these filters.</td></tr> : null}
          </tbody>
        </table>
      </TableFrame>
      </div>
      <RecycleBin
        count={deletedPages.length}
        loadPage={loadDeletedPage}
        onRestore={() => setLoadAttempt((attempt) => attempt + 1)}
        persistentEditorDirty={persistentEditorDirty}
        disabled={loading}
      />
    </div>
  );
}
