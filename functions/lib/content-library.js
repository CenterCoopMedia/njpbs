"use strict";

// Server-owned content-library selection. The browser sends the same canonical query string it
// keeps in the URL; this module validates that untrusted string, derives safe record summaries,
// and returns only one page plus the counts needed by the library chrome. Keeping this pure makes
// the HTTP boundary and its Firestore read independently testable.

// Generic Staff records join Article in the retired vocabulary: public staff
// identities now live in cmsAuthorProfiles (#1227).
const CREATABLE_RECORD_KINDS = Object.freeze([
  "program",
  "event",
  "sponsor",
  "newsletter",
  "post",
]);
// Kinds no boundary will write again but that may still be stored. They stay in the
// read vocabulary on purpose: removing a retired kind from the library would not
// delete a record saved before the retirement, it would only make it invisible --
// unlistable and unarchivable. Keep it visible so it can be triaged.
//
// Read-wide is not write-wide. A caller that admits a document by RECORD_KINDS is
// deciding what it can SHOW; a caller that mutates one must ask isRetiredRecordKind
// first, because the only mutation a retired record accepts is archiving.
const RETIRED_RECORD_KINDS = Object.freeze(["article", "staff"]);

// The name a retired kind is refused under, so a boundary says which type was
// retired rather than reporting the record as missing or malformed (#1039).
const RETIRED_RECORD_KIND_LABELS = Object.freeze({
  article: "Article",
  staff: "Staff record",
});

function isRetiredRecordKind(type) {
  return typeof type === "string" && RETIRED_RECORD_KINDS.includes(type);
}

/**
 * The refusal for a mutation a retired record cannot accept. `allowedAction` names
 * what a caller can still do with it, so the message ends in a way forward rather
 * than a dead end.
 */
function retiredRecordKindError(type, allowedAction = "archived") {
  if (!isRetiredRecordKind(type)) return null;
  return `The ${RETIRED_RECORD_KIND_LABELS[type]} type was retired. This record can only be ${allowedAction}.`;
}
// What the library READS. The browser mirror is LIBRARY_RECORD_KINDS in
// admin/src/lib/content-vocab.ts and must hold this same order, because the query
// codecs derive their filter order from it on both surfaces.
const RECORD_KINDS = Object.freeze([
  ...CREATABLE_RECORD_KINDS,
  ...RETIRED_RECORD_KINDS,
]);
const CONTENT_STATUSES = Object.freeze([
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "archived",
]);
const NON_ASSIGNABLE_CONTENT_STATUSES = new Set(["published", "archived"]);
const ASSIGNABLE_CONTENT_STATUSES = Object.freeze(
  CONTENT_STATUSES.filter(
    (status) => !NON_ASSIGNABLE_CONTENT_STATUSES.has(status),
  ),
);
const SORT_FIELDS = Object.freeze([
  "updatedAt",
  "createdAt",
  "title",
  "status",
  "publishAt",
]);
const SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);
const CONTENT_LIBRARY_PAGE_SIZE = 25;
const MAX_SEARCH_LENGTH = 200;

const DEFAULT_CONTENT_QUERY = Object.freeze({
  types: [],
  statuses: [],
  ownerMode: "any",
  ownerUid: null,
  assignmentMode: "any",
  assigneeUid: null,
  q: "",
  sortField: "updatedAt",
  sortDirection: "desc",
  sortExplicit: false,
  page: 1,
});

function normalizeSet(values, allowed) {
  const seen = new Set(values);
  return allowed.filter((value) => seen.has(value));
}

function isAssignableContentStatus(value) {
  return ASSIGNABLE_CONTENT_STATUSES.includes(value);
}

// Mirrors the browser codec's normalization rather than trusting a client-created object. Unknown
// keys and values are ignored, duplicated filters collapse, and paging can never be less than 1.
function parseContentQuery(input) {
  const params = new URLSearchParams(
    typeof input === "string" && input.startsWith("?") ? input.slice(1) : input,
  );
  const types = normalizeSet(params.getAll("type"), RECORD_KINDS);
  const statuses = normalizeSet(params.getAll("status"), CONTENT_STATUSES);

  const ownerRaw = params.get("owner")?.trim() ?? "";
  let ownerMode = "any";
  let ownerUid = null;
  if (ownerRaw === "me") {
    ownerMode = "me";
  } else if (ownerRaw !== "" && ownerRaw !== "any") {
    ownerMode = "specific";
    ownerUid = ownerRaw;
  }

  const assignedRaw = params.get("assigned")?.trim() ?? "";
  let assignmentMode = "any";
  let assigneeUid = null;
  if (assignedRaw === "me") {
    assignmentMode = "me";
  } else if (assignedRaw !== "" && assignedRaw !== "any") {
    assignmentMode = "specific";
    assigneeUid = assignedRaw;
  }

  const q = (params.get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH);
  const sortRaw = params.get("sort") ?? "";
  const sortField = SORT_FIELDS.includes(sortRaw)
    ? sortRaw
    : DEFAULT_CONTENT_QUERY.sortField;
  const directionRaw = params.get("dir") ?? "";
  const sortDirection = SORT_DIRECTIONS.includes(directionRaw)
    ? directionRaw
    : DEFAULT_CONTENT_QUERY.sortDirection;
  const pageRaw = Number(params.get("page"));
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  return {
    types,
    statuses,
    ownerMode,
    ownerUid,
    assignmentMode,
    assigneeUid,
    q,
    sortField,
    sortDirection,
    sortExplicit: SORT_FIELDS.includes(sortRaw) || SORT_DIRECTIONS.includes(directionRaw),
    page,
  };
}

function dateString(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  return undefined;
}

// Only the record confirmation owner writes this settlement identity.
function confirmedRecordPublication(data) {
  const settlement = data.publishBuildSettlement;
  const visible = data.publiclyVisible === true || data.publiclyVisible === undefined && data.status === "published";
  if (!["program", "event"].includes(data.type) || data.publishBuildPending === true || settlement?.status !== "success" ||
      !/^[A-Za-z0-9]{20}$/.test(settlement.recordQueueId ?? "") ||
      !Number.isSafeInteger(settlement.sourceVersion) || settlement.sourceVersion < 1 ||
      settlement.sourceVersion !== data.published?.sourceVersion || settlement.operation !== (visible ? "publish" : "withdraw") ||
      (visible ? data.publicSourceVersion !== settlement.sourceVersion : data.publicSourceVersion !== null)) return null;
  return { queueId: settlement.recordQueueId, sourceVersion: settlement.sourceVersion,
    withdrawal: !visible, status: "success", missingConsumers: [] };
}

// Snapshot identity is authoritative. Unknown record types stay out of the library just as they
// did when the browser issued one typed query per known kind, and soft-deleted records stay hidden.
function contentRecordSummary(id, data) {
  if (!data || typeof data !== "object" || data.deleted === true) return null;
  if (!RECORD_KINDS.includes(data.type)) return null;
  const titleValue = data.type === "staff" || data.type === "sponsor" ? data.name : data.title;
  const record = {
    id,
    kind: data.type,
    status: typeof data.status === "string" ? data.status : "unknown",
    title:
      typeof titleValue === "string" && titleValue.trim() !== ""
        ? titleValue.trim()
        : `Untitled ${data.type}`,
  };
  if (data.type === "post" && data.contentLinkMode === "custom" && !require("./content-link").contentLinkError(data)) record.contentLinkDomain = new URL(data.contentLinkUrl).hostname;
  const createdAt = dateString(data.createdAt);
  const publishAt = dateString(data.publishAt);
  const updatedAt = dateString(data.updatedAt);
  const startsAt = data.type === "event" ? dateString(data.startsAt) : undefined;
  if (createdAt) record.createdAt = createdAt;
  if (publishAt) record.publishAt = publishAt;
  if (updatedAt) record.updatedAt = updatedAt;
  if (startsAt) record.startsAt = startsAt;
  if (typeof data.updatedBy === "string") record.updatedBy = data.updatedBy;
  if (typeof data.assignee === "string" && data.assignee.trim() !== "") {
    record.assignee = data.assignee;
  }
  // Bulk mutations echo this projected value into a positive-safe-integer request contract.
  // Do not expose an integer the mutation boundary must reject, or one malformed row can poison
  // an otherwise valid page batch.
  if (Number.isSafeInteger(data.version) && data.version >= 1) {
    record.version = data.version;
    const contentVersion = data.type === "post" ? data.contentVersion : data.contentVersion ?? data.version;
    if (Number.isSafeInteger(contentVersion) && contentVersion >= 1) {
      record.contentVersion = contentVersion;
    }
  }
  const publishedSourceVersion = data.published?.sourceVersion;
  if (Number.isSafeInteger(publishedSourceVersion) && publishedSourceVersion >= 1) {
    record.publishedSourceVersion = publishedSourceVersion;
    const publishedContentVersion = data.type === "post"
      ? data.published.contentVersion : data.published.contentVersion ?? publishedSourceVersion;
    if (Number.isSafeInteger(publishedContentVersion) && publishedContentVersion >= 1) {
      record.publishedContentVersion = publishedContentVersion;
    }
  }
  const explicitPublicSourceVersion = data.publicSourceVersion;
  const publiclyVisible =
    data.publiclyVisible === true ||
    (data.publiclyVisible === undefined && data.status === "published");
  const publishedSnapshotIsLive =
    data.publishBuildPending !== true && publiclyVisible;
  if (data.publishBuildPending === true) {
    record.publicUpdatePending = true;
    record.publicBuildQueueId =
      typeof data.publishBuildQueueId === "string"
        ? data.publishBuildQueueId
        : null;
    if (
      Number.isSafeInteger(publishedSourceVersion) &&
      publishedSourceVersion >= 1
    ) {
      record.pendingSourceVersion = publishedSourceVersion;
    }
  }
  if (
    publiclyVisible &&
    Number.isSafeInteger(explicitPublicSourceVersion) &&
    explicitPublicSourceVersion >= 1
  ) {
    record.liveSourceVersion = explicitPublicSourceVersion;
  } else if (
    publishedSnapshotIsLive &&
    Number.isSafeInteger(publishedSourceVersion) &&
    publishedSourceVersion >= 1
  ) {
    record.liveSourceVersion = publishedSourceVersion;
  }
  const recordPublication = confirmedRecordPublication(data);
  if (recordPublication) record.recordPublication = recordPublication;
  return record;
}

function sortValue(record, field) {
  return record[field];
}

function compareStatus(left, right) {
  const leftIndex = CONTENT_STATUSES.indexOf(left);
  const rightIndex = CONTENT_STATUSES.indexOf(right);
  const normalizedLeft = leftIndex === -1 ? CONTENT_STATUSES.length : leftIndex;
  const normalizedRight = rightIndex === -1 ? CONTENT_STATUSES.length : rightIndex;
  return normalizedLeft - normalizedRight || left.localeCompare(right);
}

function compareRecords(left, right, query) {
  const leftValue = sortValue(left, query.sortField);
  const rightValue = sortValue(right, query.sortField);
  // Undated legacy records stay after dated work in either direction.
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

function selectContentLibrary(
  records,
  query,
  currentUserId,
  pageSize = CONTENT_LIBRARY_PAGE_SIZE,
) {
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
  );
  const filtered = beforeStatus
    .filter(
      (record) => query.statuses.length === 0
        ? record.status !== "archived"
        : query.statuses.includes(record.status),
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

module.exports = {
  ASSIGNABLE_CONTENT_STATUSES,
  CONTENT_LIBRARY_PAGE_SIZE,
  CONTENT_STATUSES,
  CREATABLE_RECORD_KINDS,
  DEFAULT_CONTENT_QUERY,
  MAX_SEARCH_LENGTH,
  RECORD_KINDS,
  RETIRED_RECORD_KINDS,
  SORT_DIRECTIONS,
  SORT_FIELDS,
  contentRecordSummary,
  isAssignableContentStatus,
  isRetiredRecordKind,
  retiredRecordKindError,
  parseContentQuery,
  selectContentLibrary,
};
