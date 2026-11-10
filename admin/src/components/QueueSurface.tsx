import { WorkspaceBrowseToolbar } from "./WorkspaceActions";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { useEffect, useMemo, useRef } from "react";
import type { ReviewQueueItem } from "../lib/review-queue";
import type { PublicationRecheckResult } from "../lib/functions";
import type { SiteUpdateRetryResult } from "../lib/site-update-retry";
import { AsyncActionButton, Button, InlineMessage, Panel, StatusBadge } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import { QueueList, type QueueItem } from "./QueueList";
import { ReviewQueueList } from "./ReviewQueueList";
import "../workflow-surfaces.css";

export interface QueueSurfaceProps {
  reviewRequests: ReviewQueueItem[];
  reviewLoading: boolean;
  reviewError: string | null;
  onReviewRefresh: () => void;
  showPublishActivity: boolean;
  publishItems: QueueItem[];
  publishLoading: boolean;
  publishError: string | null;
  publishRecoveryError?: string | null;
  publishRecoveryLoading?: boolean;
  publishRecoveryTruncated?: boolean;
  onPublishRefresh: () => void;
  onCheckAgain?: (queueId: string) => Promise<PublicationRecheckResult>;
  onRetrySiteUpdate?: (queueId: string, control: HTMLButtonElement) => Promise<SiteUpdateRetryResult>;
  siteUpdateResult?: SiteUpdateRetryResult & { focusOnAccept: boolean } | null;
}

// The same view for live queue reads and deterministic gallery states. Authentication,
// capabilities, retries and the privileged subscription stay with QueueTab.
export function QueueSurface(props: QueueSurfaceProps) {
  return <ControlSizingProvider size="standard"><QueueSurfaceContent {...props} /></ControlSizingProvider>;
}

function QueueSurfaceContent({ reviewRequests, reviewLoading, reviewError, onReviewRefresh,
  showPublishActivity, publishItems, publishLoading, publishError, publishRecoveryError,
  publishRecoveryLoading = false, publishRecoveryTruncated = false, onPublishRefresh, onCheckAgain, onRetrySiteUpdate, siteUpdateResult }: QueueSurfaceProps) {
  const retryResult = useRef<HTMLDivElement>(null);
  useEffect(() => { if (siteUpdateResult?.focusOnAccept) retryResult.current?.focus(); }, [siteUpdateResult]);
  const activePublishCount = useMemo(
    () =>
      publishItems.filter(
        (item) =>
          item.status === "reserved" ||
          item.status === "pending" ||
          item.status === "checking" ||
          item.status === "publishing",
      ).length,
    [publishItems],
  );
  const recoveryPublishCount = useMemo(
    () =>
      publishItems.filter(
        (item) => item.status === "public_unconfirmed" || item.status === "failed" || item.proofRecovery,
      ).length,
    [publishItems],
  );

  return (
    <section className="queue-surface" aria-labelledby="queue-heading">
      <div className="surface-intro">
        <div>
          <h2 id="queue-heading">Editorial queue</h2>
          <p>
            Keep editorial decisions separate from publication operations.
          </p>
        </div>
        <WorkspaceBrowseToolbar><AsyncActionButton
          aria-label="Refresh review requests"
          icon="refresh"
          label="Refresh"
          pending={reviewLoading}
          pendingLabel="Refreshing review requests"
          onClick={onReviewRefresh}
        /></WorkspaceBrowseToolbar>
      </div>

      <section
        className="queue-section queue-review-section"
        aria-labelledby="review-queue-heading"
      >
        <div className="queue-section-heading">
          <div>
            <h3 id="review-queue-heading">Review requests</h3>
            {!reviewLoading && !reviewError ? (
              <p>
                {reviewRequests.length}{" "}
                {reviewRequests.length === 1
                  ? "request awaiting review"
                  : "requests awaiting review"}
              </p>
            ) : null}
          </div>
          {!reviewLoading && !reviewError ? (
            <StatusBadge
              tone={reviewRequests.length > 0 ? "pending" : "neutral"}
            >
              {reviewRequests.length > 0
                ? `${reviewRequests.length} pending ${reviewRequests.length === 1 ? "review" : "reviews"}`
                : "No pending reviews"}
            </StatusBadge>
          ) : null}
        </div>
        {reviewLoading ? (
          <Panel className="loading-panel">
            <LoadingIndicator
              label="Loading editorial queue"
              stages={[
                "Asking the CMS for content submitted for review",
                "Working out how long each item has waited",
              ]}
            />
          </Panel>
        ) : null}
        {reviewError ? (
          <InlineMessage tone="error" title="Editorial queue could not be loaded">
            <span>{reviewError} No review requests were changed.</span>
            <Button onClick={onReviewRefresh}>
              Try loading the editorial queue again
            </Button>
          </InlineMessage>
        ) : null}
        {!reviewLoading && !reviewError ? (
          <ReviewQueueList requests={reviewRequests} />
        ) : null}
      </section>

      {showPublishActivity ? (
        <section
          className="queue-section queue-publication-section"
          aria-labelledby="publish-activity-heading"
        >
          <div className="queue-section-heading">
            <div>
              <h3 id="publish-activity-heading">Publish activity</h3>
              <p>
                Latest 100 requests, active requests, and latest 100 needing recovery.
                Completed jobs do not prove that every saved draft is live.
              </p>
            </div>
            <div className="queue-summary-badges">
              <AsyncActionButton label="Refresh" aria-label="Refresh publish activity" icon="refresh"
                pending={publishLoading} pendingLabel="Refreshing publish activity" onClick={onPublishRefresh} />
              {!publishLoading && !publishError ? <>
                <StatusBadge
                  tone={activePublishCount > 0 ? "pending" : "neutral"}
                >
                  {activePublishCount}{" "}
                  {activePublishCount === 1
                    ? "active deployment"
                    : "active deployments"}
                </StatusBadge>
                {/* A failed or publicly unconfirmed deployment needs recovery, so count it
                    above the table instead of leaving it to be found by scrolling. */}
                {recoveryPublishCount > 0 ? (
                  <StatusBadge tone="failed">
                    {recoveryPublishCount}{publishRecoveryTruncated ? "+" : ""}{" "}
                    {recoveryPublishCount === 1
                      ? "deployment needing recovery"
                      : "deployments needing recovery"}
                  </StatusBadge>
                ) : null}
              </> : null}
            </div>
          </div>

          {publishLoading ? (
            <Panel className="loading-panel">
              <LoadingIndicator
                label="Loading publish activity"
                stages={[
                  "Subscribing to the publish queue in Firestore",
                  "Reading each job's stage and outcome",
                ]}
              />
            </Panel>
          ) : null}
          {publishError ? (
            <InlineMessage
              tone="error"
              title="Publish activity could not be loaded"
            >
              <span>{publishError} No deployment requests were changed.</span>
              <Button onClick={onPublishRefresh}>
                Try loading publish activity again
              </Button>
            </InlineMessage>
          ) : null}
          {!publishLoading && !publishError && publishRecoveryError ? (
            <InlineMessage className="queue-recovery-warning" tone="warning" title="Some recovery requests could not be loaded">
              <span>{publishRecoveryError}</span>
              <Button size="comfortable" onClick={onPublishRefresh}>Retry recovery checks</Button>
            </InlineMessage>
          ) : null}
          {!publishLoading && !publishError && publishRecoveryLoading ? (
            <p role="status">Checking public confirmations and site updates…</p>
          ) : null}
          {siteUpdateResult ? <div ref={retryResult} tabIndex={-1} role="status">
            <InlineMessage tone="success">{siteUpdateResult.message}</InlineMessage>
          </div> : null}
          {!publishLoading && !publishError ? (
            <QueueList items={publishItems} onCheckAgain={onCheckAgain} onRetrySiteUpdate={onRetrySiteUpdate} />
          ) : null}
        </section>
      ) : null}

      {showPublishActivity ? (
        <InlineMessage
          className="queue-boundary-notice"
          title="Editorial approval and deployment are different"
        >
          Review decisions stay in the editorial queue. Confirm the exact public
          version on the content record before you say that a saved version is live.
        </InlineMessage>
      ) : null}
    </section>
  );
}
