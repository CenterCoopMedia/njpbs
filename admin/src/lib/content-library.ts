import { CONTENT_STATUSES, type ContentStatus } from "./content-vocab";
import type { ContentQuery, SortField } from "./content-query";
import type { ContentRecordSummary } from "./content-records";

export const CONTENT_LIBRARY_PAGE_SIZE = 25;

export interface LibrarySelection {
  records: ContentRecordSummary[];
  total: number;
  allCount: number;
  mineCount: number;
  assignedCount: number;
  page: number;
  pageCount: number;
  statusCounts: Record<ContentStatus, number>;
}

function sortValue(record: ContentRecordSummary, field: SortField): string | undefined {
  switch (field) {
    case "title":
      return record.title;
    case "status":
      return record.status;
    case "createdAt":
      return record.createdAt;
    case "publishAt":
      return record.publishAt;
    case "updatedAt":
      return record.updatedAt;
  }
}

function compareStatus(left: string, right: string): number {
  const leftIndex = CONTENT_STATUSES.indexOf(left as ContentStatus);
  const rightIndex = CONTENT_STATUSES.indexOf(right as ContentStatus);
  const normalizedLeft = leftIndex === -1 ? CONTENT_STATUSES.length : leftIndex;
  const normalizedRight = rightIndex === -1 ? CONTENT_STATUSES.length : rightIndex;
  return normalizedLeft - normalizedRight || left.localeCompare(right);
}

function compareRecords(
  left: ContentRecordSummary,
  right: ContentRecordSummary,
  query: ContentQuery,
): number {
  const leftValue = sortValue(left, query.sortField);
  const rightValue = sortValue(right, query.sortField);
  // Missing dates stay after real dates in either direction; otherwise switching to ascending
  // would put every undated legacy record before the work an editor can actually recognize.
  if (leftValue === undefined && rightValue !== undefined) return 1;
  if (leftValue !== undefined && rightValue === undefined) return -1;

  let result = 0;
  if (leftValue !== undefined && rightValue !== undefined) {
    result =
      query.sortField === "status"
        ? compareStatus(leftValue, rightValue)
        : leftValue.localeCompare(rightValue, undefined, { sensitivity: "base" });
  }
  if (query.sortDirection === "desc") result *= -1;
  return (
    result ||
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

// Apply the URL's normalized library query to one already-read alpha snapshot. Status counts are
// derived after search/type/owner filtering but before status filtering, so the status row tells an
// editor what each neighboring choice would reveal instead of repeating the current result count.
export function selectLibraryRecords(
  records: readonly ContentRecordSummary[],
  query: ContentQuery,
  currentUserId?: string,
  pageSize = CONTENT_LIBRARY_PAGE_SIZE,
): LibrarySelection {
  const search = query.q.toLocaleLowerCase();
  const ownerId =
    query.ownerMode === "me"
      ? currentUserId
      : query.ownerMode === "specific"
        ? query.ownerUid ?? undefined
        : undefined;
  const assigneeId =
    query.assignmentMode === "me"
      ? currentUserId
      : query.assignmentMode === "specific"
        ? query.assigneeUid ?? undefined
        : undefined;

  const beforeStatus = records.filter((record) => {
    if (query.types.length > 0 && !query.types.includes(record.kind)) return false;
    if (query.ownerMode !== "any" && (!ownerId || record.updatedBy !== ownerId)) return false;
    if (
      query.assignmentMode !== "any" &&
      (!assigneeId || record.assignee !== assigneeId)
    ) {
      return false;
    }
    if (
      search !== "" &&
      !`${record.title} ${record.id} ${record.kind}`.toLocaleLowerCase().includes(search)
    ) {
      return false;
    }
    return true;
  });

  const statusCounts = Object.fromEntries(
    CONTENT_STATUSES.map((status) => [
      status,
      beforeStatus.filter((record) => record.status === status).length,
    ]),
  ) as Record<ContentStatus, number>;

  const filtered = beforeStatus
    .filter(
      (record) => query.statuses.length === 0
        ? record.status !== "archived"
        : query.statuses.includes(record.status as ContentStatus),
    )
    .sort((left, right) => {
      if (query.types.length === 1 && query.types[0] === "event" && !query.q && !query.sortExplicit) {
        const now = Date.now();
        const a = left.startsAt ? Date.parse(left.startsAt) : NaN;
        const b = right.startsAt ? Date.parse(right.startsAt) : NaN;
        const aUpcoming = Number.isFinite(a) && a >= now;
        const bUpcoming = Number.isFinite(b) && b >= now;
        if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return aUpcoming ? a - b : b - a;
      }
      return compareRecords(left, right, query);
    });

  const safePageSize = Number.isInteger(pageSize) && pageSize > 0
    ? pageSize
    : CONTENT_LIBRARY_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(filtered.length / safePageSize));
  const page = Math.min(query.page, pageCount);
  const start = (page - 1) * safePageSize;
  const activeRecords = records.filter(record => record.status !== "archived");

  return {
    records: filtered.slice(start, start + safePageSize),
    total: filtered.length,
    allCount: activeRecords.length,
    mineCount: currentUserId
      ? activeRecords.filter((record) => record.updatedBy === currentUserId).length
      : 0,
    assignedCount: currentUserId
      ? activeRecords.filter((record) => record.assignee === currentUserId).length
      : 0,
    page,
    pageCount,
    statusCounts,
  };
}
