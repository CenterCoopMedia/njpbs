export type ContentStatusTone =
  | "draft"
  | "neutral"
  | "brand"
  | "pending"
  | "publishing"
  | "success"
  | "cancelled"
  | "deleted"
  | "failed"
  | "unknown";

function normalizedStatus(status: string | null | undefined): string {
  return status?.trim().toLowerCase() || "unknown";
}

export function displayContentStatus(status: string | null | undefined): string {
  if (normalizedStatus(status) === "archived") return "Deleted";
  const words = normalizedStatus(status).replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function contentStatusTone(
  status: string | null | undefined,
): ContentStatusTone {
  switch (normalizedStatus(status)) {
    case "approved":
      return "brand";
    case "in_review":
    case "reserved":
    case "pending":
    case "public_unconfirmed":
      return "pending";
    case "scheduled":
    case "publishing":
      return "publishing";
    case "published":
    case "success":
      return "success";
    case "archived":
      return "deleted";
    case "cancelled":
      return "cancelled";
    case "draft":
      return "draft";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * Return the immutable snapshot version that is still public, or null when this
 * working record has no live snapshot. The legacy published state predates the
 * explicit visibility flag, so it keeps the same admission rule as the public
 * content projection.
 */
export function livePublishedSourceVersion(
  record: Record<string, unknown>,
): number | null {
  const live =
    record.publiclyVisible === true ||
    (record.publiclyVisible === undefined && record.status === "published");
  if (!live) return null;
  if (positiveVersion(record.publicSourceVersion)) {
    return record.publicSourceVersion as number;
  }
  const published = record.published;
  if (
    typeof published !== "object" ||
    published === null ||
    Array.isArray(published)
  ) {
    return null;
  }
  const sourceVersion = (published as Record<string, unknown>).sourceVersion;
  if (!positiveVersion(sourceVersion)) return null;
  if (record.publishBuildPending === true) return null;
  return sourceVersion;
}

export function displayLiveVersion(
  liveSourceVersion: number | null | undefined,
  _publicUpdatePending = false,
): string {
  return positiveVersion(liveSourceVersion)
    ? `Version ${liveSourceVersion} live`
    : "Not live";
}

/** One staff-facing status, based on confirmed public evidence and editorial revisions. */
export function contentStatusPresentation({
  status,
  publicState,
  liveLabel,
  contentVersion,
  liveContentVersion,
  savedVersion,
  siteContentLive = false,
  withdrawn = false,
}: {
  status?: string | null;
  publicState: "live" | "not-live" | "unknown";
  liveLabel: string;
  contentVersion?: number | null;
  liveContentVersion?: number | null;
  savedVersion?: number | null;
  siteContentLive?: boolean;
  withdrawn?: boolean;
}): { label: string; tone: ContentStatusTone; newerDraft: boolean } {
  // Deletion remains visible while its public removal is pending or has failed.
  if (normalizedStatus(status) === "archived") {
    return { label: "Deleted", tone: "deleted", newerDraft: false };
  }
  if (publicState === "live") {
    // #3432 gives confirmed live records one label. Missing editorial counters
    // leave the marker off; workflow/transaction changes do not prove new content.
    // A site-code Page has no CMS revision number. Its saved unpublished copy
    // is the draft; an unsaved registry entry alone is not one.
    const siteDraft = siteContentLive && positiveVersion(savedVersion) &&
      ["draft", "in_review", "approved", "scheduled"].includes(normalizedStatus(status));
    return {
      label: liveLabel,
      tone: "success",
      newerDraft: siteDraft || positiveVersion(contentVersion) &&
        positiveVersion(liveContentVersion) && contentVersion > liveContentVersion,
    };
  }
  if (withdrawn && publicState === "not-live" && normalizedStatus(status) === "draft") {
    return { label: "Not live", tone: "cancelled", newerDraft: false };
  }
  if (normalizedStatus(status) === "published") {
    return { label: liveLabel, tone: publicState === "unknown" ? "unknown" : "cancelled", newerDraft: false };
  }
  return { label: displayContentStatus(status), tone: contentStatusTone(status), newerDraft: false };
}

const LIVE_PUBLISH_QUEUE = new Set([
  "reserved",
  "pending",
  "publishing",
  "unavailable",
]);

/** Compact list cells watch publication only when the list payload shows work in flight. */
export function listRowNeedsPublicationWatch(row: {
  recordPublication?: { status: string; sourceVersion: number };
  queueStatus?: string | null;
  publicUpdatePending?: boolean;
  publishedSourceVersion?: number | null;
  liveSourceVersion?: number | null;
} | null | undefined): boolean {
  if (!row) return false;
  if (LIVE_PUBLISH_QUEUE.has(row.queueStatus ?? "")) return true;
  if (row.publicUpdatePending === true) return true;
  const published = row.publishedSourceVersion;
  const live = row.liveSourceVersion;
  if (!Number.isSafeInteger(published) || (published as number) < 1) return false;
  if (row.recordPublication?.status === "success" && row.recordPublication.sourceVersion === published) return false;
  return !Number.isSafeInteger(live) || live !== published;
}
