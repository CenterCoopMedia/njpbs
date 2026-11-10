import { Link, useLocation } from "react-router";
import type { ReviewQueueItem } from "../lib/review-queue";
import { isPublicPageId } from "../../../packages/content-core/src/public-pages";
import { isRetiredRecordKind } from "../../../packages/content-core/src/editor-admin";
import { listOriginState } from "../lib/editor-back";
import { formatReviewWaitingTime } from "../lib/review-waiting-time";
import { DEFAULT_CONTENT_QUERY } from "../lib/content-query";
import {
  contentLibraryPath,
  editPagePath,
  editRecordPath,
} from "../lib/routes";
import { Icon } from "./ui/Icon";
import { buttonClassName, TableFrame } from "./ui/Primitives";

function requestHref(request: ReviewQueueItem): string | null {
  if (request.collection === "cmsPages") {
    return isPublicPageId(request.recordId)
      ? editPagePath(request.recordId)
      : null;
  }
  // A retired kind (Article, #1039) has no editor to open, so the row names the
  // request in plain text instead of linking to a route that cannot resolve.
  return isRetiredRecordKind(request.contentType)
    ? null
    : editRecordPath(request.contentType, request.recordId);
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Submission time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Submission time unavailable"
    : date.toLocaleString();
}

export function ReviewQueueList({
  requests,
}: {
  requests: ReviewQueueItem[];
}) {
  // The queue a reviewer is working is the list their editor should return to. Recorded on the
  // navigation, address and query together, so Back lands back on it rather than on a content list
  // they never opened and would have to navigate out of again (#1036).
  const origin = listOriginState(useLocation());
  // This is a bounded snapshot, not a live timer. Refreshing the queue measures it again.
  const measuredAt = new Date();

  if (requests.length === 0) {
    return (
      <p className="review-queue-empty">
        <span>No content is waiting for review. Submitted drafts appear here.</span>
        <Link to={contentLibraryPath({ ...DEFAULT_CONTENT_QUERY, statuses: ["draft"] })}>
          <Icon name="file" /> Browse drafts
        </Link>
      </p>
    );
  }

  return (
    <TableFrame>
      <table
        className="data-table browse-table review-queue-table"
        aria-label="Review requests"
      >
        <thead>
          <tr>
            <th>Content</th>
            <th>Waiting</th>
            <th>Version</th>
            <th>Submitted by</th>
            <th>Submitted</th>
            <th>Assigned to</th>
            <th scope="col" className="content-index-actions-cell"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => {
            const href = requestHref(request);
            return (
              <tr
                data-testid="review-queue-item"
                data-request-id={request.requestId}
                key={request.requestId}
              >
                <td data-label="Content" className="content-title">
                  {href ? (
                    <Link to={href} state={origin}>
                      {request.title}
                    </Link>
                  ) : (
                    request.title
                  )}
                </td>
                <td data-label="Waiting">
                  {formatReviewWaitingTime(request.requestedAt, measuredAt)}
                </td>
                <td data-label="Version">{request.contentVersion ?? request.sourceVersion}</td>
                <td data-label="Submitted by" className="review-queue-person">
                  {request.requestedByLabel || "Submitter unavailable"}
                </td>
                <td data-label="Submitted">
                  <time dateTime={request.requestedAt ?? undefined}>
                    {formatTimestamp(request.requestedAt)}
                  </time>
                  {request.recovered ? (
                    <span className="sr-only">
                      This request was recovered from existing review state.
                    </span>
                  ) : null}
                </td>
                <td data-label="Assigned to" className="review-queue-person">
                  {request.assigneeLabel || "Unassigned"}
                </td>
                <td data-label="Actions" className="content-index-actions-cell">
                  {href ? (
                    <Link
                      className={buttonClassName("secondary", "compact", "browse-row-edit")}
                      to={href}
                      state={origin}
                      aria-label={`Open draft: ${request.title}`}
                    >
                      Open draft
                    </Link>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableFrame>
  );
}
