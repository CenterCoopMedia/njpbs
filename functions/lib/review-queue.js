"use strict";

// The editorial queue is a projection of authoritative content records, not a
// second collection that can drift. A successful submit stores a server-owned
// reviewRequest envelope on the same cmsPage/cmsPost transaction that enters
// `in_review`; this module validates that envelope, filters it through the
// reviewer's resource scope, and resolves staff-facing labels without returning
// account ids to the browser.
//
// Older in-review records may predate the envelope. They remain recoverable: the
// projection derives the same deterministic request id from collection + record
// id and uses the current lifecycle metadata until the record leaves review.

const { createHash } = require("node:crypto");
const { can, hasCapability } = require("./rbac");
const { RECORD_KINDS } = require("./content-library");
const { contentResourceSection } = require("./content-authorization");
const { editorTemplateForPage, PAGE_SECTIONS } = require("./public-page-contract");

const REVIEW_STATE = "in_review";
const MAX_REVIEW_REQUESTS = 500;
const MAX_SECTION_QUERY_VALUES = 30;
const REVIEW_SUMMARY_FIELDS = Object.freeze([
  "type",
  "template",
  "title",
  "name",
  "status",
  "version",
  "contentVersion",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "section",
  "assignee",
  "deleted",
  "reviewRequest",
]);

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function instantToIso(value) {
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value && typeof value.toDate === "function") {
    return instantToIso(value.toDate());
  }
  if (value && Number.isFinite(value.seconds)) {
    return instantToIso(value.seconds * 1_000);
  }
  if (value && Number.isFinite(value._seconds)) {
    return instantToIso(value._seconds * 1_000);
  }
  return null;
}

function reviewRequestId(collection, id) {
  return `review_${createHash("sha256")
    .update(`${collection}/${id}`, "utf8")
    .digest("hex")}`;
}

function createReviewRequest({
  collection,
  id,
  sourceVersion,
  requestedBy,
  requestedAt,
}) {
  return {
    requestId: reviewRequestId(collection, id),
    collection,
    recordId: id,
    state: REVIEW_STATE,
    sourceVersion,
    requestedBy,
    requestedAt,
  };
}

function normalizedStoredReviewRequest(collection, id, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const expectedId = reviewRequestId(collection, id);
  const requestedBy = stringOrNull(value.requestedBy);
  const requestedAt = instantToIso(value.requestedAt);
  if (
    value.requestId !== expectedId ||
    value.collection !== collection ||
    value.recordId !== id ||
    value.state !== REVIEW_STATE ||
    !Number.isSafeInteger(value.sourceVersion) ||
    value.sourceVersion < 1 ||
    !requestedBy ||
    !requestedAt
  ) {
    return null;
  }
  return createReviewRequest({
    collection,
    id,
    sourceVersion: value.sourceVersion,
    requestedBy,
    requestedAt,
  });
}

// Version-changing mutations may occur while a request is waiting (for example,
// an administrator reassigns it or an editor corrects a typo). Advance only the
// mutable version pointer; the submitter and submission instant remain evidence
// of the original submit transaction.
function advanceReviewRequest(value, { collection, id, sourceVersion }) {
  const stored = normalizedStoredReviewRequest(collection, id, value);
  if (!stored || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    return null;
  }
  return { ...stored, sourceVersion };
}

function resourceFor(collection, id, document) {
  const section = contentResourceSection({
    collection,
    documentId: id,
    stored: document,
  });
  return {
    ...(stringOrNull(document?.createdBy)
      ? { ownerId: document.createdBy.trim() }
      : {}),
    ...(section === undefined ? {} : { section }),
  };
}

function contentTypeFor(collection, id, document) {
  if (collection === "cmsPages") {
    return editorTemplateForPage(id) === null ? null : "page";
  }
  return RECORD_KINDS.includes(document?.type) ? document.type : null;
}

function titleFor(document, contentType) {
  for (const field of ["title", "name"]) {
    const value = stringOrNull(document?.[field]);
    if (value) return value;
  }
  return contentType === "page" ? "Untitled page" : "Untitled record";
}

function reviewRequestSummary(collection, id, document) {
  if (
    !document ||
    document.deleted === true ||
    document.status !== REVIEW_STATE ||
    !Number.isSafeInteger(document.version) ||
    document.version < 1
  ) {
    return null;
  }
  const contentType = contentTypeFor(collection, id, document);
  if (!contentType) return null;

  const stored = normalizedStoredReviewRequest(
    collection,
    id,
    document.reviewRequest,
  );
  const requestedByUid =
    stored?.requestedBy ??
    stringOrNull(document.updatedBy) ??
    stringOrNull(document.createdBy);
  const requestedAt =
    stored?.requestedAt ??
    instantToIso(document.updatedAt) ??
    instantToIso(document.createdAt);

  return {
    requestId: reviewRequestId(collection, id),
    collection,
    recordId: id,
    contentType,
    title: titleFor(document, contentType),
    state: REVIEW_STATE,
    // The row always points at the current reviewable version. Mutation
    // boundaries advance a valid envelope; using the document version here is a
    // final defensive reconciliation if an older deploy missed one.
    sourceVersion: document.version,
    contentVersion:
      Number.isSafeInteger(document.contentVersion) && document.contentVersion >= 1
        ? document.contentVersion
        : document.version,
    requestedByUid,
    requestedAt,
    assigneeUid: stringOrNull(document.assignee),
    recovered: stored === null,
    resource: resourceFor(collection, id, document),
  };
}

function reviewSections(principal) {
  if (hasCapability(principal, "content.view")) return null;
  const sections = new Set();
  for (const grant of principal?.grants ?? []) {
    if (!hasCapability({ grants: [grant] }, "content.edit.any")) continue;
    if (grant.sections === undefined) return null;
    for (const section of grant.sections) {
      sections.add(section);
    }
  }
  return [...sections];
}

async function readInReviewRecords(firestore, principal) {
  const sections = reviewSections(principal);
  const sectionChunks = sections === null ? [null] : [];
  if (sections !== null) {
    for (let start = 0; start < sections.length; start += MAX_SECTION_QUERY_VALUES) {
      sectionChunks.push(sections.slice(start, start + MAX_SECTION_QUERY_VALUES));
    }
  }
  const readCollection = async (collection) => {
    const base = firestore
      .collection(collection)
      .where("status", "==", REVIEW_STATE);
    const snapshots = await Promise.all(sectionChunks.map(async (chunk) => {
      const query = chunk === null ? base : base.where("section", "in", chunk);
      // A canonical page's stored section may be stale. Reserve enough room for
      // every canonical ID so those rows cannot crowd out 500 custom pages.
      const canonicalAllowance = collection === "cmsPages" && chunk !== null
        ? Object.keys(PAGE_SECTIONS).length : 0;
      return query.select(...REVIEW_SUMMARY_FIELDS)
        .orderBy("reviewRequest.requestedAt", "desc")
        .limit(MAX_REVIEW_REQUESTS + canonicalAllowance + 1)
        .get();
    }));
    return snapshots.flatMap((snapshot) => snapshot.docs.map((entry) => ({
      collection,
      id: entry.id,
      document: entry.data(),
    })));
  };

  // Registry sections remain authoritative for canonical pages, including older
  // records without a stored section or reviewRequest. Read only the granted IDs
  // instead of scanning other desks to find them.
  const canonicalIds = sections === null ? [] : Object.entries(PAGE_SECTIONS)
    .filter(([, section]) => sections.includes(section))
    .map(([id]) => id);
  const readCanonicalPages = async () => {
    if (canonicalIds.length === 0) return [];
    const snapshots = await firestore.getAll(
      ...canonicalIds.map((id) => firestore.doc(`cmsPages/${id}`)),
      { fieldMask: REVIEW_SUMMARY_FIELDS },
    );
    return snapshots.flatMap((entry) => {
      if (!entry.exists || entry.data().status !== REVIEW_STATE) return [];
      return [{ collection: "cmsPages", id: entry.id, document: entry.data() }];
    });
  };

  const [pages, posts, canonicalPages] = await Promise.all([
    readCollection("cmsPages"),
    readCollection("cmsPosts"),
    readCanonicalPages(),
  ]);
  return [...new Map([...pages, ...posts, ...canonicalPages]
    .map((record) => [`${record.collection}/${record.id}`, record])).values()];
}

function visibleReviewRequests(principal, records) {
  return records.flatMap((record) => {
    if (
      !record ||
      (record.collection !== "cmsPages" &&
        record.collection !== "cmsPosts") ||
      typeof record.id !== "string"
    ) {
      return [];
    }
    const summary = reviewRequestSummary(
      record.collection,
      record.id,
      record.document,
    );
    if (!summary) return [];
    if (!can(principal, "content.view") && !can(principal, "content.edit.any", summary.resource)) return [];
    return [summary];
  });
}

async function readStaffDirectory(firestore, userIds) {
  const uniqueIds = [
    ...new Set(userIds.map(stringOrNull).filter((value) => value !== null)),
  ];
  if (uniqueIds.length === 0) return new Map();
  const refs = uniqueIds.map((uid) => firestore.collection("users").doc(uid));
  const snapshots = await firestore.getAll(...refs);
  const directory = new Map();
  snapshots.forEach((snapshot, index) => {
    if (!snapshot?.exists) return;
    const data = snapshot.data();
    directory.set(uniqueIds[index], {
      active: data?.active !== false,
      displayName: stringOrNull(data?.displayName),
    });
  });
  return directory;
}

function staffLabel(uid, viewerUid, directory) {
  if (!uid) return null;
  if (uid === viewerUid) return "You";
  const staff = directory.get(uid);
  if (staff?.active && staff.displayName) return staff.displayName;
  return "Another staff member";
}

function presentReviewRequests(requests, { viewerUid, directory }) {
  return requests.map((request) => {
    const { requestedByUid, assigneeUid, ...publicRequest } = request;
    delete publicRequest.resource;
    return {
      ...publicRequest,
      requestedByLabel: staffLabel(requestedByUid, viewerUid, directory),
      assigneeLabel: staffLabel(assigneeUid, viewerUid, directory),
    };
  });
}

function sortReviewRequests(requests) {
  return [...requests].sort((left, right) => {
    const leftTime = left.requestedAt ? Date.parse(left.requestedAt) : 0;
    const rightTime = right.requestedAt ? Date.parse(right.requestedAt) : 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.requestId.localeCompare(right.requestId);
  });
}

module.exports = {
  MAX_REVIEW_REQUESTS,
  REVIEW_STATE,
  REVIEW_SUMMARY_FIELDS,
  advanceReviewRequest,
  createReviewRequest,
  normalizedStoredReviewRequest,
  presentReviewRequests,
  readInReviewRecords,
  readStaffDirectory,
  reviewRequestId,
  reviewRequestSummary,
  reviewSections,
  sortReviewRequests,
  staffLabel,
  visibleReviewRequests,
};
