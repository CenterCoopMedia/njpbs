import { Fragment, useState } from "react";
import { ActionControl } from "./ui/ActionControl";
import {
  EmptyState,
  StatusBadge,
  TableFrame,
  type StatusTone,
} from "./ui/Primitives";
import { contentStatusTone, displayContentStatus } from "../lib/content-status";
import type { PublicationRecheckResult } from "../lib/functions";
import { PublicationRecheckAction } from "./PublicationRecheckAction";
import { SiteUpdateRetryAction } from "./SiteUpdateRetryAction";
import type { SiteUpdateRetryResult } from "../lib/site-update-retry";
import { editRecordPath } from "../lib/routes";

export interface QueueItem {
  id: string;
  status?: string | null;
  triggeredBy?: string | null;
  triggeredById?: string | null;
  changes?: unknown;
  timestamp?: Date | null;
  completedAt?: Date | null;
  error?: string | null;
  transport?: string | null;
  proofRecovery?: boolean;
  contextRetry?: boolean;
  proofExhausted?: boolean;
  recheckMessage?: string;
  recheckOutcome?: string;
}

interface QueueChangeDetail {
  label: string;
  targetId: string | null;
  sourceVersion: number | null;
  operation: string | null;
}

function normalizedStatus(status: string | null | undefined): string {
  return status?.trim().toLowerCase() || "unknown";
}

function publicationStatusLabel(status: string): string {
  switch (status) {
    case "success":
      return "Completed";
    case "public_unconfirmed":
      return "Needs confirmation";
    case "pending":
      return "Queued";
    default:
      return displayContentStatus(status);
  }
}

function publicationStatusTone(status: string): StatusTone {
  if (status === "superseded") return "cancelled";
  if (status === "checking") return "publishing";
  return contentStatusTone(status);
}

function publicationStatusClass(status: string): string {
  const suffix = status.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `publication-status-${suffix || "unknown"}`;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function queueChangeDetail(entry: unknown): QueueChangeDetail {
  if (typeof entry === "string" && entry.trim()) {
    return {
      label: entry,
      targetId: /^cms[A-Z][^/]*\//.test(entry) ? entry : null,
      sourceVersion: null,
      operation: null,
    };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      label: "Summary unavailable",
      targetId: null,
      sourceVersion: null,
      operation: null,
    };
  }

  const value = entry as Record<string, unknown>;
  const collection = nonemptyString(value.collection);
  const id = nonemptyString(value.id);
  const targetId = collection && id ? `${collection}/${id}` : id;
  const label =
    nonemptyString(value.title) ??
    nonemptyString(value.slug) ??
    nonemptyString(value.path) ??
    targetId ??
    (Object.keys(value).slice(0, 3).join("/") || "Summary unavailable");
  return {
    label: label || "Summary unavailable",
    targetId,
    sourceVersion:
      Number.isSafeInteger(value.sourceVersion) && Number(value.sourceVersion) > 0
        ? Number(value.sourceVersion)
        : null,
    operation: nonemptyString(value.operation),
  };
}

function queueChangeDetails(changes: unknown): QueueChangeDetail[] {
  if (Array.isArray(changes)) return changes.map(queueChangeDetail);
  if (changes === null || changes === undefined) return [];
  return [queueChangeDetail(changes)];
}

function changesSummary(changes: unknown): string {
  const details = queueChangeDetails(changes);
  if (details.length === 0) return "Summary unavailable";
  const isInternalId = (detail: QueueChangeDetail) =>
    detail.label === detail.targetId && /^cms[A-Z][^/]*\//.test(detail.label);
  const visibleDetails = details.slice(0, 3);
  const visible = visibleDetails.filter((detail) => !isInternalId(detail)).map((detail) => detail.label);
  const unnamedCount = visibleDetails.length - visible.length;
  if (unnamedCount > 0) {
    visible.push(`${unnamedCount}${visible.length ? " other" : ""} publication ${unnamedCount === 1 ? "change" : "changes"}`);
  }
  return details.length > visibleDetails.length
    ? `${visible.join(", ")} +${details.length - visibleDetails.length} more`
    : visible.join(", ");
}

function formatTimestamp(timestamp: Date | null | undefined): string {
  if (!timestamp || Number.isNaN(timestamp.getTime())) return "Time unavailable";
  return timestamp.toLocaleString();
}

function exactTimestamp(timestamp: Date | null | undefined): string {
  return timestamp && !Number.isNaN(timestamp.getTime())
    ? timestamp.toISOString()
    : "Unavailable";
}

function QueueJobDetails({ item, status }: { item: QueueItem; status: string }) {
  const changes = queueChangeDetails(item.changes);
  return (
    <div className="publication-job-detail-content">
      <dl className="publication-job-metadata">
        <div>
          <dt>Job ID</dt>
          <dd><code>{item.id}</code></dd>
        </div>
        <div>
          <dt>Status code</dt>
          <dd><code>{status}</code></dd>
        </div>
        <div>
          <dt>Submitted at</dt>
          <dd><code>{exactTimestamp(item.timestamp)}</code></dd>
        </div>
        {item.completedAt ? (
          <div>
            <dt>Completed at</dt>
            <dd><code>{exactTimestamp(item.completedAt)}</code></dd>
          </div>
        ) : null}
        {item.transport ? (
          <div>
            <dt>Transport</dt>
            <dd><code>{item.transport}</code></dd>
          </div>
        ) : null}
        {item.triggeredById && item.triggeredById !== item.triggeredBy ? (
          <div>
            <dt>Requester ID</dt>
            <dd><code>{item.triggeredById}</code></dd>
          </div>
        ) : null}
      </dl>
      {item.error ? (
        <p className="publication-job-error">
          <strong>Recorded error</strong>
          <span>{item.error}</span>
        </p>
      ) : null}
      {changes.length > 0 ? (
        <section aria-label="Recorded publication changes">
          <h4>Recorded changes</h4>
          <ol className="publication-change-list">
            {changes.map((change, index) => (
              <li key={`${change.targetId ?? change.label}-${index}`}>
                <strong>{change.label}</strong>
                {change.targetId && change.targetId !== change.label ? (
                  <span><code>{change.targetId}</code></span>
                ) : null}
                {change.sourceVersion ? (
                  <span>Source version {change.sourceVersion}</span>
                ) : null}
                {change.operation ? <span>Operation: {change.operation}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

export function QueueList({ items, onCheckAgain, onRetrySiteUpdate }: { items: QueueItem[];
  onCheckAgain?: (queueId: string) => Promise<PublicationRecheckResult>;
  onRetrySiteUpdate?: (queueId: string, control: HTMLButtonElement) => Promise<SiteUpdateRetryResult> }) {
  const [expandedJobs, setExpandedJobs] = useState<ReadonlySet<string>>(new Set());
  if (items.length === 0) {
    return (
      <EmptyState
        title="No deployment requests yet."
        description="Publication jobs appear here after a publish or removal request succeeds."
      />
    );
  }

  return (
    <TableFrame className="publication-table-frame">
      <p className="publication-scroll-cue">Scroll sideways for all columns</p>
      <table className="data-table browse-table queue-table" aria-label="Publish activity">
        <thead>
          <tr>
            <th>Result</th>
            <th>Changes</th>
            <th>Requested by</th>
            <th>Submitted</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const status = normalizedStatus(item.status);
            const submittedAt = exactTimestamp(item.timestamp);
            const expanded = expandedJobs.has(item.id);
            const detailsId = `publication-details-${item.id}`;
            const supported = ["page-no-build-v1", "post-no-build-v1"].includes(item.transport ?? "");
            const recoverable = ["failed", "public_unconfirmed"].includes(status) || item.proofRecovery === true;
            const change = Array.isArray(item.changes) ? item.changes[0] : null;
            const recordPath = supported && typeof change?.id === "string" ? item.transport === "page-no-build-v1"
              ? `/content/pages/${encodeURIComponent(change.id)}/edit` : editRecordPath("post", change.id) : null;
            return (
              <Fragment key={item.id}>
              <tr data-testid="queue-item" data-expanded={expanded ? "true" : "false"}>
                <td data-label="Result">
                  <StatusBadge
                    className={publicationStatusClass(status)}
                    tone={item.proofRecovery ? "failed" : publicationStatusTone(status)}
                  >
                    {item.proofRecovery ? "Public check failed" : publicationStatusLabel(status)}
                  </StatusBadge>
                  {onCheckAgain && supported && (recoverable || item.recheckMessage) ? (
                    <PublicationRecheckAction onCheck={() => onCheckAgain(item.id)} available={recoverable}
                      recordedResult={item.recheckMessage ? { message: item.recheckMessage, failed: item.recheckOutcome === "failed" } : undefined} />
                  ) : null}
                  {onCheckAgain && recoverable && recordPath ? <a className="publication-recheck-record" href={recordPath}>Open record</a> : null}
                  {["failed", "public_unconfirmed"].includes(status) &&
                    !["page-no-build-v1", "post-no-build-v1"].includes(item.transport ?? "") && !item.contextRetry ? (
                    <span className="published-version-note">This publication cannot be checked here. Open the record to retry publication.</span>
                  ) : null}
                  {item.contextRetry && onRetrySiteUpdate ?
                    <SiteUpdateRetryAction available={status === "failed"} onRetry={control => onRetrySiteUpdate(item.id, control)} /> : null}
                </td>
                <td data-label="Changes" className="content-title">
                  {changesSummary(item.changes)}
                </td>
                <td data-label="Requested by" className="queue-requester">
                  {item.triggeredBy || "Unresolved account"}
                </td>
                <td data-label="Submitted">
                  <time
                    dateTime={submittedAt === "Unavailable" ? undefined : submittedAt}
                  >
                    {formatTimestamp(item.timestamp)}
                  </time>
                </td>
                <td data-label="Details">
                  <ActionControl
                    action={expanded ? "collapse" : "expand"}
                    size="compact"
                    label="Details"
                    contextLabel={`Publication job ${item.id}`}
                    type="button"
                    className="publication-details-toggle"
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    onClick={() => setExpandedJobs((current) => {
                      const next = new Set(current);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    })}
                  />
                </td>
              </tr>
              <tr className="publication-details-row" id={detailsId} hidden={!expanded}>
                  <td colSpan={5}><QueueJobDetails item={item} status={status} /></td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </TableFrame>
  );
}
