import { type ReactNode, useEffect, useState } from "react";
import { Icon } from "./ui/Icon";
import { Link, useLocation } from "react-router";
import {
  DEFAULT_NEWSROOM_BANNER_HEADING,
  DEFAULT_NEWSROOM_MILESTONE_NUMBER,
} from "../../../packages/content-core/src/cms-settings";
import { isRetiredRecordKind } from "../../../packages/content-core/src/editor-admin";
import type { ContentRecordSummary } from "../lib/content-records";
import type { LibrarySelection } from "../lib/content-library";
import { DEFAULT_CONTENT_QUERY } from "../lib/content-query";
import type { PublishActivitySummary } from "../lib/publish-activity";
import { fetchAdminStatus, type AdminStatusManifest } from "../lib/admin-status";
import { contentKindLabel } from "../lib/content-nav";
import { listOriginState } from "../lib/editor-back";
import { contentStatusTone, displayContentStatus, listRowNeedsPublicationWatch } from "../lib/content-status";
import {
  accountProfilePath,
  activityPath,
  createRecordPath,
  contentLibraryPath,
  contentPagesPath,
  editPagePath,
  editRecordPath,
  mediaLibraryPath,
  publishQueuePath,
} from "../lib/routes";
import {
  ActivityIndicator,
  Button,
  EmptyState,
  InlineMessage,
  Panel,
  StatusBadge,
} from "./ui/Primitives";
import { SkeletonBlock, SkeletonRegion, SkeletonText } from "./ui/Skeleton";
import { ScheduledPublicationTime } from "./ScheduledPublicationTime";
import {
  BuildStatus,
  MilestoneStatus,
  useAdminStatus,
} from "./BuildMilestoneStatus";
import { PublishedVersionStatus } from "./PublishedVersionStatus";
import { ContentRowThumbnail } from "./ContentRowThumbnail";
import "./NewsroomHome.css";

export type NewsroomRecord = ContentRecordSummary;

interface NewsroomHomeProps {
  homeActions?: ReactNode;
  canBrowsePages: boolean;
  canEditHomepage?: boolean;
  canBrowseRecords: boolean;
  canCreate: boolean;
  canUseMediaLibrary?: boolean;
  canViewActivity?: boolean;
  canViewEditorialQueue: boolean;
  canViewPublishActivity: boolean;
  currentUserId: string;
  loadRecords: () => Promise<LibrarySelection>;
  // The in-review count for staff who can open the editorial queue. Read separately from
  // loadRecords because the two answer different questions: loadRecords is the cmsPosts library,
  // while the queue projects review requests from cmsPages and cmsPosts alike. Counting records
  // beside a link to the queue would report zero next to waiting page requests.
  loadReviewRequestCount?: () => Promise<number>;
  loadPublishActivity?: () => Promise<PublishActivitySummary>;
  loadAdminStatus?: () => Promise<AdminStatusManifest>;
  loadHomeSettings?: () => Promise<{
    heading: string;
    milestoneNumber: number;
  }>;
}

type HomeState =
  | { status: "loading" }
  | { status: "ready"; selection: LibrarySelection | null }
  | { status: "error"; message: string };

type PublishState =
  | { status: "disabled" | "loading" | "error" }
  | { status: "ready"; summary: PublishActivitySummary };

// "records" is the state for staff without the editorial queue: their card links to the review
// filter over the record library, so the record-derived count is the count that matches it.
type ReviewCountState =
  | { status: "records" | "loading" | "error" }
  | { status: "ready"; count: number };

function loadDefaultHomeSettings(): Promise<{
  heading: string;
  milestoneNumber: number;
}> {
  return Promise.resolve({
    heading: DEFAULT_NEWSROOM_BANNER_HEADING,
    milestoneNumber: DEFAULT_NEWSROOM_MILESTONE_NUMBER,
  });
}

function displayUpdatedAt(value?: string): string[] {
  if (!value) return ["Update time unavailable"];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return ["Update time unavailable"];
  return [
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date),
    new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date),
  ];
}

function recordThumbnailIcon(kind: ContentRecordSummary["kind"]) {
  return kind === "event" ? "activity" : kind === "program" ? "media" : "file";
}

export function NewsroomHome({
  homeActions,
  canBrowsePages,
  canEditHomepage = false,
  canBrowseRecords,
  canCreate,
  canUseMediaLibrary = false,
  canViewActivity = false,
  canViewEditorialQueue,
  canViewPublishActivity,
  currentUserId,
  loadRecords,
  loadReviewRequestCount,
  loadPublishActivity,
  loadAdminStatus = fetchAdminStatus,
  loadHomeSettings = loadDefaultHomeSettings,
}: NewsroomHomeProps) {
  // Newsroom home is where most sessions start, so the editor opened from it should come back to
  // it rather than to a record list nobody chose (#1036).
  const origin = listOriginState(useLocation());
  const [attempt, setAttempt] = useState(0);
  // The review count's own retry. It shares nothing with `attempt`, so asking the queue again
  // never throws away a newsroom selection that loaded fine.
  const [reviewAttempt, setReviewAttempt] = useState(0);
  const [publishAttempt, setPublishAttempt] = useState(0);
  const [state, setState] = useState<HomeState>({ status: "loading" });
  const [publishState, setPublishState] = useState<PublishState>({ status: "disabled" });
  const [reviewCountState, setReviewCountState] = useState<ReviewCountState>({
    status: "records",
  });
  const [bannerHeading, setBannerHeading] = useState(
    DEFAULT_NEWSROOM_BANNER_HEADING,
  );
  const [milestoneNumber, setMilestoneNumber] = useState(
    DEFAULT_NEWSROOM_MILESTONE_NUMBER,
  );

  useEffect(() => {
    let cancelled = false;
    loadHomeSettings()
      .then(({ heading, milestoneNumber: selectedMilestone }) => {
        if (cancelled) return;
        if (heading.trim()) setBannerHeading(heading.trim());
        if (Number.isSafeInteger(selectedMilestone) && selectedMilestone > 0) {
          setMilestoneNumber(selectedMilestone);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBannerHeading(DEFAULT_NEWSROOM_BANNER_HEADING);
          setMilestoneNumber(DEFAULT_NEWSROOM_MILESTONE_NUMBER);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadHomeSettings]);

  useEffect(() => {
    let cancelled = false;
    if (!canBrowseRecords) {
      setState({ status: "ready", selection: null });
      return () => {
        cancelled = true;
      };
    }
    setState({ status: "loading" });
    loadRecords()
      .then((selection) => {
        if (!cancelled) setState({ status: "ready", selection });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "The newsroom work list could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, canBrowseRecords, loadRecords]);

  // Only staff whose card opens the editorial queue read it. A contributor's card points at the
  // record library instead, so this never calls the scoped queue endpoint on their behalf.
  useEffect(() => {
    let cancelled = false;
    if (!canViewEditorialQueue) {
      setReviewCountState({ status: "records" });
      return () => {
        cancelled = true;
      };
    }
    if (!loadReviewRequestCount) {
      // The queue is this card's destination and its own count is unavailable. Showing the
      // record count here would be a number for a different question.
      setReviewCountState({ status: "error" });
      return () => {
        cancelled = true;
      };
    }
    setReviewCountState({ status: "loading" });
    loadReviewRequestCount()
      .then((count) => {
        if (!cancelled) setReviewCountState({ status: "ready", count });
      })
      .catch(() => {
        if (!cancelled) setReviewCountState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [canViewEditorialQueue, loadReviewRequestCount, reviewAttempt]);

  useEffect(() => {
    let cancelled = false;
    if (!canViewPublishActivity || !loadPublishActivity) {
      setPublishState({ status: "disabled" });
      return () => {
        cancelled = true;
      };
    }
    setPublishState({ status: "loading" });
    loadPublishActivity()
      .then((summary) => {
        if (!cancelled) setPublishState({ status: "ready", summary });
      })
      .catch(() => {
        if (!cancelled) setPublishState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [canViewPublishActivity, loadPublishActivity, publishAttempt]);

  const selection = state.status === "ready" ? state.selection : null;
  const records = selection?.records ?? [];
  // A count still on its way shows motion, and a count that cannot be read shows a dash. The
  // two used to look identical, so a slow morning and a broken queue read the same on screen;
  // only the accessible label told them apart.
  const pendingCount = <ActivityIndicator />;
  const count = (
    status: keyof LibrarySelection["statusCounts"],
  ): ReactNode =>
    selection
      ? selection.statusCounts[status]
      : state.status === "loading"
        ? pendingCount
        : "—";
  const accessibleCount = (
    status: keyof LibrarySelection["statusCounts"],
  ): number | string =>
    selection
      ? selection.statusCounts[status]
      : state.status === "loading"
        ? "loading"
        : "unavailable";
  const reviewCount = (): ReactNode =>
    reviewCountState.status === "records"
      ? count("in_review")
      : reviewCountState.status === "ready"
        ? reviewCountState.count
        : reviewCountState.status === "loading"
          ? pendingCount
          : "—";
  const accessibleReviewCount = (): number | string =>
    reviewCountState.status === "records"
      ? accessibleCount("in_review")
      : reviewCountState.status === "ready"
        ? reviewCountState.count
        : reviewCountState.status === "loading"
          ? "loading"
          : "unavailable";
  const libraryPath = (patch: Partial<typeof DEFAULT_CONTENT_QUERY>) =>
    contentLibraryPath({ ...DEFAULT_CONTENT_QUERY, ...patch });
  const mineCount: ReactNode = selection
    ? selection.mineCount
    : state.status === "loading"
      ? pendingCount
      : "—";
  const assignedCount: ReactNode = selection
    ? selection.assignedCount
    : state.status === "loading"
      ? pendingCount
      : "—";
  const hasPublishRecovery =
    publishState.status === "ready" && publishState.summary.recoveryCount > 0;
  const publishRecoveryCount: ReactNode =
    publishState.status === "ready"
      ? publishState.summary.recoveryCount
      : publishState.status === "loading"
        ? pendingCount
        : "—";
  const hasShortcuts = canCreate || canBrowsePages || canUseMediaLibrary || canViewActivity;
  const adminStatus = useAdminStatus(loadAdminStatus);

  return (
    <section className="newsroom-home">
      <div className="newsroom-work-heading">
        <div className="newsroom-work-heading-copy">
          <h2>Home</h2>
          <p>Your current work and the next editorial actions.</p>
        </div>
        {homeActions}
      </div>

      {canBrowseRecords ? (
        <>
          <div
            className="newsroom-status-grid"
            role="group"
            aria-label="Editorial status counts"
          >
            <Panel className="newsroom-status-card" data-workflow="draft">
              <Link
                aria-label={`Drafts, ${accessibleCount("draft")}. Open drafts`}
                className="newsroom-status-link"
                to={libraryPath({ statuses: ["draft"] })}
              >
                <span>Drafts</span>
                <strong data-testid="draft-count">{count("draft")}</strong>
                <span className="newsroom-status-detail">Open drafts</span>
              </Link>
            </Panel>
            <Panel
              data-workflow="review"
              className={
                reviewCountState.status === "error"
                  ? "newsroom-status-card newsroom-status-card-with-retry"
                  : "newsroom-status-card"
              }
            >
              <Link
                aria-label={`In review, ${accessibleReviewCount()}. ${
                  canViewEditorialQueue
                    ? "Open review queue"
                    : "Open the review filter"
                }`}
                className="newsroom-status-link"
                to={
                  canViewEditorialQueue
                    ? publishQueuePath()
                    : libraryPath({ statuses: ["in_review"] })
                }
              >
                <span>In review</span>
                <strong data-testid="review-count">{reviewCount()}</strong>
                <span className="newsroom-status-detail">
                  {canViewEditorialQueue
                    ? "Open review queue"
                    : "Open the review filter"}
                </span>
              </Link>
              {reviewCountState.status === "error" ? (
                // The same way back the publish card offers: every card that can fail to
                // count says so and can be asked again from where it sits.
                <Button
                  className="newsroom-status-retry"
                  variant="ghost"
                  onClick={() => setReviewAttempt((value) => value + 1)}
                >
                  Retry review count
                </Button>
              ) : null}
            </Panel>
            <Panel className="newsroom-status-card" data-workflow="scheduled">
              <Link
                aria-label={`Scheduled, ${accessibleCount("scheduled")}. View scheduled work`}
                className="newsroom-status-link"
                to={libraryPath({
                  statuses: ["scheduled"],
                  sortField: "publishAt",
                  sortDirection: "asc",
                })}
              >
                <span>Scheduled</span>
                <strong data-testid="scheduled-count">{count("scheduled")}</strong>
                <span className="newsroom-status-detail">View scheduled work</span>
              </Link>
            </Panel>
            {canViewPublishActivity ? (
              <Panel
                className={`newsroom-status-card newsroom-status-card-recovery newsroom-status-card-with-retry${
                  hasPublishRecovery ? " newsroom-status-card-danger" : ""
                }`}
              >
                <Link
                  aria-label={`Publish recovery, ${
                    publishState.status === "ready"
                      ? publishState.summary.recoveryCount
                      : publishState.status === "loading"
                        ? "loading"
                        : "unavailable"
                  }. ${
                    publishState.status === "error"
                      ? "Publish recovery status is unavailable."
                      : "Check publish activity"
                  }`}
                  className="newsroom-status-link"
                  to={publishQueuePath()}
                >
                  <span>Publish recovery</span>
                  <strong data-testid="failed-publish-count">
                    {publishRecoveryCount}
                  </strong>
                  <span className="newsroom-status-detail">
                    {publishState.status === "error"
                      ? "Publish recovery status is unavailable."
                      : "Check publish activity"}
                  </span>
                </Link>
                {publishState.status === "error" ? (
                  <Button
                    className="newsroom-status-retry"
                    variant="ghost"
                    onClick={() => setPublishAttempt((value) => value + 1)}
                  >
                    Retry publish status
                  </Button>
                ) : null}
              </Panel>
            ) : null}
          </div>

          <div className="newsroom-home-grid">
            <Panel className="recent-work-panel" aria-label="Recent work">
              <div className="panel-heading">
                <div>
                  <h3>Recent work</h3>
                  <p>Newest records in your current scope</p>
                </div>
                <Link to={contentLibraryPath()}>Browse all</Link>
              </div>

              {state.status === "loading" ? <RecentWorkSkeleton /> : null}
              {state.status === "error" ? (
                <InlineMessage tone="error" title="Newsroom work could not be loaded">
                  <span>{state.message} No records were changed.</span>
                  <Button onClick={() => setAttempt((value) => value + 1)}>
                    Try loading newsroom work again
                  </Button>
                </InlineMessage>
              ) : null}
              {state.status === "ready" && records.length === 0 ? (
                <EmptyState
                  title="No editorial records yet"
                  description={
                    canCreate
                      ? "Start the first post and it will appear here."
                      : "Create the first newsroom record when the team is ready."
                  }
                  action={
                    canCreate ? (
                      <Link
                        className="button button-primary"
                        state={origin}
                        to={createRecordPath("post")}
                      >
                        New post
                      </Link>
                    ) : undefined
                  }
                />
              ) : null}
              {state.status === "ready" && records.length > 0 ? (
                <ol className="recent-work-list">
                  {records.slice(0, 8).map((record) => (
                    <li key={`${record.kind}:${record.id}`}>
                      <ContentRowThumbnail
                        src={record.thumbnailUrl}
                        icon={recordThumbnailIcon(record.kind)}
                      />
                      <div className="recent-work-main">
                        {isRetiredRecordKind(record.kind) ? (
                          <span aria-disabled="true">{record.title}</span>
                        ) : (
                          <Link
                            state={origin}
                            to={editRecordPath(record.kind, record.id)}
                          >
                            {record.title}
                          </Link>
                        )}
                        <span className="recent-work-metadata">
                          <span>{contentKindLabel(record.kind)}</span>
                          {displayUpdatedAt(record.updatedAt).map((part) => (
                            <span key={part}>{part}</span>
                          ))}
                          {record.updatedBy === currentUserId ? <span>Updated by you</span> : null}
                        </span>
                      </div>
                      <div className="recent-work-states">
                        <StatusBadge tone={contentStatusTone(record.status)}>
                          {displayContentStatus(record.status)}
                        </StatusBadge>
                        {record.kind === "post" ? <ScheduledPublicationTime status={record.status} publishAt={record.publishAt} /> : null}
                        <PublishedVersionStatus
                          compact
                          collection="cmsPosts"
                          documentId={record.id}
                          contentVersion={record.contentVersion}
                          publishedSourceVersion={record.publishedSourceVersion}
                          publishedContentVersion={record.publishedContentVersion}
                          loadPublicationMetadata={listRowNeedsPublicationWatch(record)}
                          watchPublicReceipts={false}
                          liveSourceVersion={record.liveSourceVersion}
                          recordPublication={record.recordPublication}
                          publicBuildQueueId={record.publicBuildQueueId}
                          publicUpdatePending={record.publicUpdatePending}
                          pendingSourceVersion={record.pendingSourceVersion}
                          workingVersion={record.version}
                        />
                      </div>
                    </li>
                  ))}
                </ol>
              ) : null}
            </Panel>

            <div className="newsroom-side-stack">
              <Panel className="newsroom-next-panel" tone="soft">
                <h3>Your work</h3>
                <ul className="newsroom-next-links">
                  <li>
                    <Link
                      aria-label={`Assigned to me (${
                        state.status === "loading" ? "loading" : state.status === "error"
                          ? "unavailable"
                          : assignedCount
                      })`}
                      to={libraryPath({ assignmentMode: "me" })}
                    >
                      <span>Assigned to me</span>
                      <strong aria-hidden="true">{assignedCount}</strong>
                    </Link>
                  </li>
                  <li>
                    <Link
                      aria-label={`My recent edits (${
                        state.status === "loading" ? "loading" : state.status === "error"
                          ? "unavailable"
                          : mineCount
                      })`}
                      to={libraryPath({ ownerMode: "me" })}
                    >
                      <span>My recent edits</span>
                      <strong aria-hidden="true">{mineCount}</strong>
                    </Link>
                  </li>
                  <li>
                    <Link to={accountProfilePath()}>
                      <span>Update your profile</span>
                      <Icon name="arrow-right" />
                    </Link>
                  </li>
                </ul>
              </Panel>

              {hasShortcuts ? (
                <Panel className="newsroom-shortcuts-panel" tone="soft">
                  <h3>Shortcuts</h3>
                  <ul className="newsroom-next-links">
                    {canCreate ? (
                      <li><Link state={origin} to={createRecordPath("post")}><span>New post</span><Icon name="plus" /></Link></li>
                    ) : null}
                    {canEditHomepage ? (
                      <li><Link state={origin} to={editPagePath("home")}><span>Edit homepage</span><Icon name="content" /></Link></li>
                    ) : null}
                    {canUseMediaLibrary ? (
                      <li>
                        <Link to={mediaLibraryPath()}>
                          <span>Find an image</span>
                          <Icon name="media" />
                        </Link>
                      </li>
                    ) : null}
                    {canBrowsePages ? (
                      <li>
                        <Link to={contentPagesPath()}>
                          <span>Site pages</span>
                          <Icon name="content" />
                        </Link>
                      </li>
                    ) : null}
                    {canViewActivity ? (
                      <li>
                        <Link to={activityPath()}>
                          <span>Recent activity</span>
                          <Icon name="activity" />
                        </Link>
                      </li>
                    ) : null}
                    {canCreate ? (
                      <li>
                        <Link state={origin} to={createRecordPath("event")}>
                          <span>New event</span>
                          <Icon name="plus" />
                        </Link>
                      </li>
                    ) : null}
                  </ul>
                </Panel>
              ) : null}

              <InlineMessage className="newsroom-save-guidance" title="Save is not publish">
                <Icon name="info" />
                <span>
                  Saving keeps your next revision in the CMS. The live site changes only through
                  the publishing workflow.
                </span>
              </InlineMessage>
            </div>
          </div>
        </>
      ) : (
        <InlineMessage tone="info" title="Newsroom work is outside your current scope">
          Stored records and pages do not carry an area yet, so this workspace requires a
          site-wide content grant. Ask an administrator to update your access before testing
          stored editorial work.
        </InlineMessage>
      )}
      <details className="newsroom-system-status">
        <summary>
          <span>Build and publication details</span>
        </summary>
        <div
          aria-label="Newsroom banner"
          className="newsroom-home-intro"
          role="region"
        >
          <div className="newsroom-banner-module" data-banner-module="heading">
            <p className="eyebrow">Build and milestone</p>
            <h2>{bannerHeading}</h2>
          </div>
          <div className="newsroom-banner-module" data-banner-module="buildStatus">
            <BuildStatus state={adminStatus.state} onRetry={adminStatus.retry} />
          </div>
          <div className="newsroom-banner-module" data-banner-module="milestone">
            <MilestoneStatus
              milestoneNumber={milestoneNumber}
              state={adminStatus.state}
              onRetry={adminStatus.retry}
            />
          </div>
        </div>
      </details>
    </section>
  );
}

// The recent work list while it loads: the same rows, thumbnail, title, metadata and status.
function RecentWorkSkeleton() {
  return (
    <SkeletonRegion label="Loading newsroom work">
      <ol className="recent-work-list">
        {Array.from({ length: 8 }, (_, index) => (
          <li key={index}>
            <SkeletonBlock className="content-row-thumbnail" radius="control" />
            <div className="recent-work-main">
              <span className="recent-work-skeleton-title">
                <SkeletonText width={index % 2 ? "58%" : "76%"} />
              </span>
              <span className="recent-work-skeleton-meta">
                <SkeletonText width="42%" />
              </span>
            </div>
            {/* The workflow badge over the public-status line, as the loaded row stacks them. */}
            <div className="recent-work-states">
              <SkeletonBlock width={72} height={22} radius="round" />
              <SkeletonBlock width={76} height={22} radius="round" />
            </div>
          </li>
        ))}
      </ol>
    </SkeletonRegion>
  );
}
