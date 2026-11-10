import { WorkspaceBrowseToolbar } from "./WorkspaceActions";
import { BrowseRowActions } from "./BrowseRowActions";
import { buttonClassName } from "./ui/Primitives";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { listOriginState } from "../lib/editor-back";
import { createRecordPath, editRecordPath } from "../lib/routes";
import { contentStatusTone, displayContentStatus, listRowNeedsPublicationWatch } from "../lib/content-status";
import {
  DEFAULT_CONTENT_QUERY,
  encodeContentQuery,
  parseContentQuery,
} from "../lib/content-query";
import { ContentQuickEdit } from "./ContentQuickEdit";
import { PublishedVersionStatus } from "./PublishedVersionStatus";
import { Icon } from "./ui/Icon";
import { ActionControl } from "./ui/ActionControl";
import { Button, EmptyState, InlineMessage, StatusBadge, TableFrame } from "./ui/Primitives";
import { SkeletonTable } from "./ui/Skeleton";
import { EVENT_RECORD_LIST_COLUMNS, EVENT_RECORD_LIST_HEADINGS, RECORD_LIST_COLUMNS, RECORD_LIST_HEADINGS, RecordListCreateShape } from "./EditorSkeleton";
import type { RecordKind } from "../../../packages/content-core/src/editor-admin";

export interface RecordListItem {
  id: string;
  status: string;
  title: string;
  version?: number;
  contentVersion?: number;
  liveSourceVersion?: number;
  publishedSourceVersion?: number;
  publishedContentVersion?: number;
  publicUpdatePending?: boolean;
  publicBuildQueueId?: string | null;
  pendingSourceVersion?: number;
  updatedAt?: string;
  startsAt?: string;
}

// One server-authorized page of a typed record list: the rows for the addressed page plus the
// paging position the server settled on. The client never derives the position itself, so an
// address beyond the current result is corrected by the same response that answers it (#1066).
export interface RecordListPage {
  records: RecordListItem[];
  page: number;
  pageCount: number;
  total: number;
}

interface RecordListProps {
  canCreate: boolean;
  kind: RecordKind;
  label: string;
  loadRecords?: (kind: RecordKind, page: number) => Promise<RecordListPage>;
  persistentEditorDirty?: boolean;
}

type ListState =
  | { status: "loading" }
  // `requestedPage` is the address this selection answered. A response only describes the URL
  // it was asked for, so the canonicalization below can tell a settled page from one that is
  // simply out of date while the next request is still in flight.
  | { status: "ready"; requestedPage: number; selection: RecordListPage }
  | { status: "error"; message: string };

const EMPTY_SELECTION: RecordListPage = {
  records: [],
  page: 1,
  pageCount: 1,
  total: 0,
};

function pluralLabel(label: string): string {
  return label === "Staff member" ? "Staff members" : `${label}s`;
}

function displayUpdatedAt(value?: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function displayEventStart(value?: string): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(date)} ET`;
}

// The paged address for this list. Only the page position is addressable here — the record type
// is the route itself, and this surface offers no search, status, owner or sort control — so the
// same codec the library uses is read for its validation and written back canonically rather
// than a second, hand-rolled page grammar being introduced (#1066).
function pageAddress(page: number): string {
  return encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, page });
}

// The deliberately small, per-kind browse surface for #540/#566. It remains the fastest direct
// route into one record type, while /content/library owns combined search, filters, counts,
// saved views, and current-page bulk archive.
//
// Browsing is bounded: the list asks the server for one page at a time on the same authorized
// query contract the library uses, instead of pulling every record of the kind and rendering
// the ones that happen to fit (#1066). The page position lives in the URL, so a refresh, a
// shared link, Back, and an editor's Back action all return to the page the person was reading.
export function RecordList(props: RecordListProps) {
  return <ControlSizingProvider size="standard"><RecordListContent {...props} /></ControlSizingProvider>;
}

function RecordListContent({
  canCreate,
  kind,
  label,
  loadRecords,
  persistentEditorDirty = false,
}: RecordListProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ListState>({ status: "loading" });
  // A page request is in flight over rows that are still readable. It disables the paging
  // controls so a second click cannot outrun the first, and marks the table busy for assistive
  // technology.
  const [updating, setUpdating] = useState(false);
  const [expandedPostIds, setExpandedPostIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openedPostIds, setOpenedPostIds] = useState<Set<string>>(
    () => new Set(),
  );
  const detailsPrefix = useId();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const plural = pluralLabel(label);
  const lowerPlural = plural.toLowerCase();
  const queryKey = searchParams.toString();
  // Untrusted URL input: an unusable `page` falls back to the first page rather than reaching a
  // request.
  const requestedPage = useMemo(() => parseContentQuery(queryKey).page, [queryKey]);

  useEffect(() => {
    let cancelled = false;
    setUpdating(true);
    // The first read has nothing to show yet. A page change does: keep those rows on screen
    // while the next page is in flight, so paging reads as the table changing rather than the
    // surface collapsing to a loading line and back.
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    if (!loadRecords) {
      setState({ status: "ready", requestedPage, selection: EMPTY_SELECTION });
      setUpdating(false);
      return;
    }
    loadRecords(kind, requestedPage)
      .then((selection) => {
        if (!cancelled) {
          setState({ status: "ready", requestedPage, selection });
          setUpdating(false);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "The record list could not be loaded. Reload to try again.",
          });
          setUpdating(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, kind, loadRecords, requestedPage]);

  const selection = state.status === "ready" ? state.selection : EMPTY_SELECTION;

  useEffect(() => {
    setExpandedPostIds(new Set());
    setOpenedPostIds(new Set());
  }, [kind, selection.page]);

  // The address this list is being read at, carried onto every editor it opens so the editor's
  // Back action can return to this exact view — this page included — rather than to a rebuilt
  // default (#1037). While the next page is in flight the URL has already moved but the rows on
  // screen have not, so the origin names the page those rows are actually on: opening a retained
  // row and coming back must land on the list that contains it, not on the page being fetched.
  const origin = useMemo(() => {
    if (state.status === "ready" && state.requestedPage !== requestedPage) {
      return { from: `${location.pathname}?${pageAddress(state.requestedPage)}` };
    }
    return listOriginState(location);
  }, [location, requestedPage, state]);

  // A shared or bookmarked link can name a page past the end of a list that has since shrunk.
  // The server answered with the last real page; make the address say so rather than leaving a
  // page number in the URL that no longer describes what is on screen.
  useEffect(() => {
    if (
      state.status !== "ready" ||
      // A selection loaded for an earlier address says nothing about this one; correcting the
      // URL from it would undo the page the person just asked for.
      state.requestedPage !== requestedPage ||
      selection.page === requestedPage
    ) {
      return;
    }
    setSearchParams(pageAddress(selection.page), { replace: true });
  }, [requestedPage, selection.page, setSearchParams, state]);

  function goToPage(page: number) {
    setSearchParams(pageAddress(page));
  }

  function togglePostDetails(recordId: string) {
    if (!expandedPostIds.has(recordId)) {
      setOpenedPostIds((current) => new Set(current).add(recordId));
    }
    setExpandedPostIds((current) => {
      const next = new Set(current);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  }

  if (state.status === "loading") {
    return (
      <div className={kind === "post" ? "record-list record-list-post content-index" : "record-list content-index"}>
        {canCreate ? <RecordListCreateShape /> : null}
        <TableFrame tabIndex={-1}>
          <SkeletonTable
            label={`Loading ${lowerPlural}`}
            tableClassName={kind === "post" ? "browse-table record-list-post-table" : "browse-table"}
            rowClassName="content-index-row"
            headings={kind === "post" ? ["Post", "Status", "Last updated", "Actions"] : kind === "event" ? EVENT_RECORD_LIST_HEADINGS : RECORD_LIST_HEADINGS}
            columns={
              kind === "post"
                ? [{ kind: "text", width: "72%", lines: 2 }, { kind: "chip" }, { kind: "text", width: "60%" }, RECORD_LIST_COLUMNS[3]!]
                : kind === "event" ? EVENT_RECORD_LIST_COLUMNS : RECORD_LIST_COLUMNS
            }
            rows={8}
          />
        </TableFrame>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <InlineMessage tone="error" title={`The ${label.toLowerCase()} list could not be loaded`}>
        <span>{state.message} No records were changed.</span>
        <Button onClick={() => setAttempt((value) => value + 1)}>
          Try loading {lowerPlural} again
        </Button>
      </InlineMessage>
    );
  }

  if (selection.records.length === 0) {
    return (
      <EmptyState
        title={`No ${lowerPlural} yet`}
        description={`Create the first ${label.toLowerCase()} when you are ready.`}
        action={
          canCreate ? (
            <Link
              className={buttonClassName("primary", "standard")}
              to={createRecordPath(kind)}
              state={origin}
            >
              Create {label.toLowerCase()}
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div
      className={
        kind === "post"
          ? "record-list record-list-post content-index"
          : "record-list content-index"
      }
      aria-busy={updating}
    >
      {canCreate ? (
        <WorkspaceBrowseToolbar><div className="record-list-actions">
          <Link
            className={buttonClassName("primary", "standard")}
            to={createRecordPath(kind)}
            state={origin}
          >
            New {label.toLowerCase()}
          </Link>
        </div></WorkspaceBrowseToolbar>
      ) : null}
      <TableFrame>
        <table className={kind === "post" ? "data-table browse-table record-list-post-table" : "data-table browse-table"}>
          <thead>
            <tr>
              <th scope="col">{kind === "post" ? "Post" : "Name"}</th>
              <th scope="col">Status</th>
              {kind === "event" ? <th scope="col">Starts</th> : null}
              <th scope="col">Last updated</th>
              <th scope="col" className="content-index-actions-cell"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {/* Public publication status is a Post list feature; other kinds below show workflow status. */}
            {kind === "post"
              ? selection.records.map((record) => {
                  const expanded = expandedPostIds.has(record.id);
                  const detailsId = `${detailsPrefix}-${record.id}`;
                  const editorPath = editRecordPath(kind, record.id);
                  return (
                    <Fragment key={record.id}>
                      <tr
                        className="content-index-row"
                        data-expanded={expanded ? "true" : "false"}
                      >
                        <td data-label="Post" className="content-title">
                          <div className="content-index-identity">
                            <Link
                              className="content-index-title-link"
                              to={editorPath}
                              state={origin}
                            >
                              <Icon name="file" />
                              <span>{record.title}</span>
                            </Link>

                          </div>
                        </td>
                        <td data-label="Status">
                          <PublishedVersionStatus
                            compact
                            collection="cmsPosts"
                            workingStatus={record.status}
                            recordTitle={record.title}
                            documentId={record.id}
                            contentVersion={record.contentVersion}
                            publishedSourceVersion={record.publishedSourceVersion}
                            publishedContentVersion={record.publishedContentVersion}
                            liveSourceVersion={record.liveSourceVersion}
                            publicBuildQueueId={record.publicBuildQueueId}
                            publicUpdatePending={record.publicUpdatePending}
                            pendingSourceVersion={record.pendingSourceVersion}
                            workingVersion={record.version}
                            loadPublicationMetadata={listRowNeedsPublicationWatch(record)}
                          />
                        </td>
                        <td data-label="Last updated" className="content-index-date">
                          {displayUpdatedAt(record.updatedAt)}
                        </td>
                        <td data-label="Actions" className="content-index-actions-cell">
                          <BrowseRowActions
                            name={record.title}
                            primaryAction={
                              <Link
                                className={buttonClassName("secondary", "compact", "browse-row-edit")}
                                aria-label={`Edit ${record.title}`}
                                to={editorPath}
                                state={origin}
                              >
                                Edit
                              </Link>
                            }
                          >
                            <Button
                              className="content-index-action-link"
                              variant="ghost"
                              type="button"
                              aria-controls={detailsId}
                              aria-expanded={expanded}
                              aria-label={`${expanded ? "Hide" : "Show"} details for ${record.title}`}
                              onClick={() => togglePostDetails(record.id)}
                            >
                              {expanded ? "Hide details" : "Details"}
                            </Button>
                          </BrowseRowActions>
                        </td>
                      </tr>
                      {openedPostIds.has(record.id) ? (
                        <tr
                          className="content-index-detail-row"
                          hidden={!expanded}
                        >
                          <td colSpan={4}>
                            <section
                              className="content-index-detail-panel"
                              id={detailsId}
                              aria-label={`${record.title} details`}
                            >
                              <div className="content-index-detail-heading">
                                <div>
                                  <span className="content-index-detail-kicker">Post details</span>
                                  <strong>{record.title}</strong>
                                </div>
                              </div>
                              <dl className="content-index-facts">
                                <div>
                                  <dt>Record ID</dt>
                                  <dd>
                                    <code>{record.id}</code>
                                  </dd>
                                </div>
                                <div>
                                  <dt>Working revision</dt>
                                  <dd>
                                    {record.version ? `Version ${record.contentVersion ?? record.version}` : "Not recorded"}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Status</dt>
                                  <dd>
                                    <PublishedVersionStatus
                                      collection="cmsPosts"
                                      workingStatus={record.status}
                                      recordTitle={record.title}
                                      publishedSourceVersion={record.publishedSourceVersion}
                                      publishedContentVersion={record.publishedContentVersion}
                                      documentId={record.id}
                                      contentVersion={record.contentVersion}
                                      liveSourceVersion={record.liveSourceVersion}
                                      publicBuildQueueId={record.publicBuildQueueId}
                                      publicUpdatePending={record.publicUpdatePending}
                                      pendingSourceVersion={record.pendingSourceVersion}
                                      workingVersion={record.version}
                                    />
                                  </dd>
                                </div>
                                <div>
                                  <dt>Last updated</dt>
                                  <dd>{displayUpdatedAt(record.updatedAt)}</dd>
                                </div>
                              </dl>
                              <ContentQuickEdit
                                label={record.title}
                                persistentEditorDirty={persistentEditorDirty}
                                target={{ kind: "post", recordId: record.id }}
                                onDocumentChange={() =>
                                  setAttempt((value) => value + 1)
                                }
                              />
                              <p className="content-index-detail-note">
                                Open the full editor to review the body, media, assignment, dates,
                                search, social sharing, and publishing controls.
                              </p>
                              <div className="content-index-detail-actions">
                                <Link
                                  className={buttonClassName("secondary", "standard")}
                                  to={editorPath}
                                  state={origin}
                                >
                                  Open full editor
                                </Link>
                              </div>
                            </section>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              : selection.records.map((record) => {
                  const editorPath = editRecordPath(kind, record.id);
                  return (
                    <tr className="content-index-row" key={record.id}>
                      <td data-label="Name" className="content-title">
                        <div className="content-index-identity">
                          <Link
                            className="content-index-title-link"
                            to={editorPath}
                            state={origin}
                          >
                            {record.title}
                          </Link>

                        </div>
                      </td>
                      <td data-label="Status">
                        <StatusBadge tone={contentStatusTone(record.status)}>
                          {displayContentStatus(record.status)}
                        </StatusBadge>
                      </td>
                      {kind === "event" ? <td data-label="Starts">{displayEventStart(record.startsAt)}</td> : null}
                      <td data-label="Last updated">
                        {displayUpdatedAt(record.updatedAt)}
                      </td>
                      <td data-label="Actions" className="content-index-actions-cell">
                        <BrowseRowActions
                          name={record.title}
                          primaryAction={
                            <Link
                              className={buttonClassName("secondary", "compact", "browse-row-edit")}
                              aria-label={`Edit ${record.title}`}
                              to={editorPath}
                              state={origin}
                            >
                              Edit
                            </Link>
                          }
                        >
                        </BrowseRowActions>
                      </td>
                      </tr>
                  );
                })}
          </tbody>
        </table>
      </TableFrame>
      {selection.pageCount > 1 ? (
        <nav
          className="record-list-pagination"
          aria-label={`${plural} pages`}
        >
          <ActionControl
            action="previous-page"
            label="Previous"
            disabled={selection.page === 1 || updating}
            onClick={() => goToPage(selection.page - 1)}
          />
          <span>
            Page {selection.page} of {selection.pageCount}
          </span>
          <ActionControl
            action="next-page"
            label="Next"
            disabled={selection.page === selection.pageCount || updating}
            onClick={() => goToPage(selection.page + 1)}
          />
        </nav>
      ) : null}
      {selection.pageCount > 1 && selection.page === selection.pageCount ? (
        <p className="record-list-end" role="status">
          You have reached the end of the {label.toLowerCase()} list.
        </p>
      ) : null}
    </div>
  );
}
