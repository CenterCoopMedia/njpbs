"use strict";

// cmsListContent is the server-owned read boundary for content collections and the combined
// library. Firestore rules reject every browser read of cmsPosts; one authenticated server read
// derives safe summaries, authoritative counts, ordering, and one 25-row addressed page
// for the combined library, typed record lists, and the newsroom home (#1066, #1138). The
// previous bounded unpaged request stays accepted for one staged Admin rollout.
//
// The same boundary owns the editorial review projection. A review request is
// the in-review content document plus its server-owned reviewRequest envelope,
// never an independently writable queue row. Authorization is applied before
// every derived value and before staff labels are resolved.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { FieldPath } = require("firebase-admin/firestore");
const { readPublishedVocabulary } = require("./lib/read-published-vocabulary");
const { requirePrincipal } = require("./lib/auth");
const { publicPageDefinition, publicPagePath } = require("./lib/public-page-contract");
const { hasCapability } = require("./lib/rbac");
const {
  authorizeContentRead,
  contentResource,
  isUnassignedPostDraft,
  mayReachContentRead,
  mayReadSomeContentRecord,
} = require("./lib/content-authorization");
const {
  contentRecordSummary,
  parseContentQuery,
  selectContentLibrary,
} = require("./lib/content-library");
const { isAudioReadAdmitted } = require("./lib/media-access");
const { isMediaAssetId, MAX_MEDIA_ASSET_IDS, mediaDisplayUrl } = require("./lib/media-library");
const { readPostLeadMedia, leadMediaAssetIds } = require("./lib/post-lead-media");
const {
  readMediaAssetSummariesByIds,
  visibleMediaSummaries,
} = require("./list-media");
const {
  MAX_REVIEW_REQUESTS,
  presentReviewRequests,
  readInReviewRecords,
  readStaffDirectory,
  sortReviewRequests,
  visibleReviewRequests,
} = require("./lib/review-queue");

const MAX_QUERY_LENGTH = 4096;
// A deployed Admin can call the new function before its own addressed-page build is live. Keep
// its former complete response bounded while that staged rollout crosses versions, then remove
// this bridge after the addressed-page Admin has been deployed for one release (#1138).
const MAX_UNPAGED_RECORDS = 500;
// Bound billed reads independently of authorization and document validity. One
// extra document proves overflow without returning partial counts or results.
const MAX_SUMMARY_SCAN_DOCUMENTS = 5000;
const SUMMARY_SCAN_PAGE_SIZE = 100;
const UNPAGED_LIMIT_MESSAGE =
  "Too many authorized summaries for one complete response. Narrow the record type or use the Library.";
const SUMMARY_FIELDS = Object.freeze([
  "type",
  "status",
  "title",
  "contentLinkMode", "contentLinkUrl", "contentLinkNewTab",
  "name",
  "createdAt",
  "publishAt",
  "startsAt",
  "updatedAt",
  "updatedBy",
  "createdBy",
  "assignee",
  "deleted",
  "version",
  "contentVersion",
  "publiclyVisible",
  "publishBuildPending",
  "publishBuildQueueId",
  "publicSourceVersion",
  "published.sourceVersion",
  "published.contentVersion",
  "publishBuildSettlement.status",
  "publishBuildSettlement.sourceVersion",
  "publishBuildSettlement.operation",
  "publishBuildSettlement.recordQueueId",
  // Current working-document references used only to resolve a safe thumbnail URL. The
  // handler removes these IDs before returning any page or record summary.
  "heroImage",
  "leadMedia",
  "logoAssetId",
  "imageAssetId",
  "keyArtAssetId",
  "heroBackgroundImage",
  "social.imageAssetId",
  // Read for the server-side authorization decision only, exactly like createdBy: the
  // handler drops it before selection, so the desk a record sits in never becomes a
  // response field and the list contract is unchanged (#845).
  "section",
  "unassignedDraft",
]);

const THUMBNAIL_FIELDS = Object.freeze([
  "logoAssetId",
  "imageAssetId",
  "keyArtAssetId",
  "heroBackgroundImage",
  "social.imageAssetId",
]);
const MAX_CONCURRENT_THUMBNAIL_READS = 4;
// Content rows draw a 52px thumbnail. Two device pixels is 104. The smallest
// generated thumbnail is 480, which covers that without fetching the original.
const CONTENT_ROW_THUMBNAIL_WIDTH = 104;

function thumbnailAssetIds(stored, { post = false } = {}) {
  if (!stored || typeof stored !== "object") return [];
  const lead = post ? readPostLeadMedia(stored) : null;
  const leadIds = post ? leadMediaAssetIds(lead) : [];
  const videoLead = lead && lead.kind !== "image";
  const values = [
    ...leadIds,
    stored.logoAssetId,
    stored.imageAssetId,
    stored.keyArtAssetId,
    ...(videoLead ? [] : [stored.heroBackgroundImage]),
    stored.social?.imageAssetId,
  ];
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const id = value.trim();
    return isMediaAssetId(id) ? [id] : [];
  }))];
}

function withoutThumbnailAssetIds(record) {
  const summary = { ...record };
  delete summary.thumbnailAssetIds;
  return summary;
}

async function attachThumbnailUrls(
  firestore,
  principal,
  records,
  {
    readRecordsByIdsFn = readMediaAssetSummariesByIds,
    visibleRecordsFn = visibleMediaSummaries,
    audioReadAdmitted = false,
  } = {},
) {
  const output = records.map(withoutThumbnailAssetIds);
  const unresolved = new Set(records.map((_record, index) => index));
  const attemptedIds = new Set();
  const urlsById = new Map();
  const maximumCandidates = records.reduce(
    (maximum, record) => Math.max(maximum, record.thumbnailAssetIds?.length ?? 0),
    0,
  );

  for (let priority = 0; priority < maximumCandidates && unresolved.size > 0; priority += 1) {
    const ids = [...new Set([...unresolved].flatMap((index) => {
      const id = records[index].thumbnailAssetIds?.[priority];
      return id && !attemptedIds.has(id) ? [id] : [];
    }))];

    const chunks = [];
    for (let start = 0; start < ids.length; start += MAX_MEDIA_ASSET_IDS) {
      const chunk = ids.slice(start, start + MAX_MEDIA_ASSET_IDS);
      chunk.forEach((id) => attemptedIds.add(id));
      chunks.push(chunk);
    }

    for (
      let start = 0;
      start < chunks.length;
      start += MAX_CONCURRENT_THUMBNAIL_READS
    ) {
      await Promise.all(chunks
        .slice(start, start + MAX_CONCURRENT_THUMBNAIL_READS)
        .map(async (chunk) => {
          try {
            const result = await readRecordsByIdsFn(firestore, chunk);
            const visible = visibleRecordsFn(
              principal,
              result.records ?? [],
              null,
              audioReadAdmitted,
            );
            for (const asset of visible) {
              if (asset.kind !== "image") continue;
              const url = mediaDisplayUrl(
                asset,
                CONTENT_ROW_THUMBNAIL_WIDTH,
                CONTENT_ROW_THUMBNAIL_WIDTH,
              );
              if (typeof url === "string") urlsById.set(asset.id, url);
            }
          } catch {
            // A thumbnail is optional list decoration. Continue to lower-priority candidates and
            // keep every content row usable if a media read fails.
          }
        }));
    }

    for (const index of unresolved) {
      const id = records[index].thumbnailAssetIds?.[priority];
      const url = id ? urlsById.get(id) : undefined;
      if (!url) continue;
      output[index] = { ...output[index], thumbnailUrl: url };
      unresolved.delete(index);
    }
  }

  return output;
}

const LIBRARY_VIEW = "library";
const REVIEW_QUEUE_VIEW = "review_queue";
const PUBLISH_ACTIVITY_VIEW = "publish_activity";
const FORBIDDEN_MESSAGE = "You do not have permission to list content.";
const REVIEW_FORBIDDEN_MESSAGE =
  "You do not have permission to review content.";

function summarizeContentDocument(document) {
  const stored = document.data();
  const summary = contentRecordSummary(document.id, stored);
  if (summary === null) return null;
  // createdBy and section are read only for the server-side authorization
  // decision. The handler removes them before selection, so the response
  // contract stays unchanged.
  return {
    ...summary,
    thumbnailAssetIds: thumbnailAssetIds(stored, { post: stored.type === "post" }),
    createdBy:
      typeof stored.createdBy === "string" ? stored.createdBy : undefined,
    section: typeof stored.section === "string" ? stored.section : undefined,
    unassignedDraft: isUnassignedPostDraft(stored),
  };
}

// Default library reads projected summaries, then authorizes and pages in
// memory. Firestore offset cannot run before that authorization. Free-text
// search also runs after authorization because title substring is not indexed
// (#1900).
async function readAddressedContentSummaries(firestore, _parsedQuery, {
  unpaged = false,
  principal = null,
} = {}) {
  // Do not apply list filters here. allCount, mine, and assignment totals are
  // derived from the authorized set after this read.
  let query = firestore.collection("cmsPosts").select(...SUMMARY_FIELDS);
  if (!unpaged) {
    const snapshot = await query.get();
    return snapshot.docs
      .map(summarizeContentDocument)
      .filter((record) => record !== null);
  }

  query = query.orderBy(FieldPath.documentId());
  const authorized = [];
  let cursor = null;
  let scanned = 0;
  while (authorized.length <= MAX_UNPAGED_RECORDS) {
    const pageSize = Math.min(
      SUMMARY_SCAN_PAGE_SIZE,
      MAX_SUMMARY_SCAN_DOCUMENTS + 1 - scanned,
    );
    const page = await (cursor ? query.startAfter(cursor) : query)
      .limit(pageSize)
      .get();
    scanned += page.docs.length;
    if (scanned > MAX_SUMMARY_SCAN_DOCUMENTS) {
      throw new ListRejection(413, "Content search exceeds its scan limit. Use the Library without a search term.");
    }
    for (const document of page.docs) {
      const record = summarizeContentDocument(document);
      if (record && visibleContentSummaries(principal, [record]).length > 0) {
        authorized.push(record);
        if (authorized.length > MAX_UNPAGED_RECORDS) break;
      }
    }
    if (page.docs.length < pageSize) break;
    cursor = page.docs.at(-1).id;
  }
  return authorized;
}

async function readPageSummaries(firestore, principal) {
  let pageQuery = firestore.collection("cmsPages")
    .select("contentLinkMode", "contentLinkUrl", "contentLinkNewTab", "title", "slug", "section", "status", "publishAt", "createdBy", "deleted", "version", "contentVersion", "publiclyVisible", "publishBuildPending", "publishBuildQueueId", "publicSourceVersion", "published.metadata.slug", "published.metadata.title", "published.sourceVersion", "published.contentVersion",
      "publishBuildSettlement.status", "publishBuildSettlement.operation", "publishBuildSettlement.sourceVersion", "publishBuildSettlement.pageReceipt", ...THUMBNAIL_FIELDS);
  if (typeof pageQuery.limit === "function") {
    pageQuery = pageQuery.limit(MAX_UNPAGED_RECORDS + 1);
  }
  const snapshot = await pageQuery.get();
  const pages = snapshot.docs.flatMap(document => {
    const stored = document.data();
    if (!publicPageDefinition(document.id) || stored.deleted) return [];
    const decision = authorizeContentRead(principal, { exists: true,
      resource: contentResource({ collection: "cmsPages", documentId: document.id, stored }) });
    if (!decision.allowed) return [];
    const path = publicPagePath(document.id, stored);
    if (path === null) return [];
    const visible = stored.publiclyVisible === true ||
      (stored.publiclyVisible === undefined && stored.status === "published");
    const livePath = publicPagePath(document.id, stored.published?.metadata);
    const publishedSourceVersion = stored.published?.sourceVersion;
    const published = visible && Number.isSafeInteger(publishedSourceVersion) &&
      publishedSourceVersion > 0 && livePath !== null &&
      stored.publishBuildPending !== true && stored.publicSourceVersion === publishedSourceVersion;
    const publication = {};
    const pageReceipt = require("./lib/page-publication-receipt").confirmedPageReceipt(stored);
    if (pageReceipt) Object.assign(publication, { pageReceipt, publicationTransport: "page-no-build-v1" });
    if (Number.isSafeInteger(publishedSourceVersion) && publishedSourceVersion > 0) {
      publication.publishedSourceVersion = publishedSourceVersion;
    }
    if (visible && Number.isSafeInteger(stored.publicSourceVersion) && stored.publicSourceVersion > 0) {
      publication.liveSourceVersion = stored.publicSourceVersion;
    }
    if (stored.publishBuildPending === true) {
      publication.publicUpdatePending = true;
      publication.publicBuildQueueId =
        typeof stored.publishBuildQueueId === "string" ? stored.publishBuildQueueId : null;
      if (publication.publishedSourceVersion) {
        publication.pendingSourceVersion = publication.publishedSourceVersion;
      }
    }
    if (Number.isSafeInteger(stored.version) && stored.version > 0) {
      publication.version = stored.version;
    }
    if (Number.isSafeInteger(stored.contentVersion) && stored.contentVersion > 0) {
      publication.contentVersion = stored.contentVersion;
    }
    if (Number.isSafeInteger(stored.published?.contentVersion) && stored.published.contentVersion > 0) {
      publication.publishedContentVersion = stored.published.contentVersion;
    }
    return [{ id: document.id, title: typeof stored.title === "string" ? stored.title : document.id,
      path,
      ...(stored.contentLinkMode === "custom" && !require("./lib/content-link").contentLinkError(stored) ? { contentLinkDomain: new URL(stored.contentLinkUrl).hostname } : {}),
      thumbnailAssetIds: thumbnailAssetIds(stored),
      section: typeof stored.section === "string" ? stored.section : undefined,
      status: typeof stored.status === "string" ? stored.status : undefined,
      publishAt: typeof stored.publishAt === "string" ? stored.publishAt : undefined,
      published, ...publication, ...(published ? { livePath,
        ...(typeof stored.published.metadata?.title === "string" ? { liveTitle: stored.published.metadata.title } : {}),
      } : {}),
    }];
  });
  if (pages.length > MAX_UNPAGED_RECORDS) throw new ListRejection(413, "The page directory exceeds its 500-page limit.");
  return pages.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

class ListRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ListRejection";
    this.status = status;
  }
}

function visibleContentSummaries(principal, storedRecords) {
  return storedRecords.flatMap((storedRecord) => {
    if (!storedRecord || typeof storedRecord !== "object") return [];
    const { createdBy, section, unassignedDraft, ...summary } = storedRecord;
    // Every row is decided against the record's own desk (#845). A scoped grant keeps
    // the rows in its sections and drops the rest, including every record stored before
    // the registry existed: those carry no desk, and rbac.js denies an unstated one.
    const decision = authorizeContentRead(principal, {
      exists: true,
      resource: contentResource({ collection: "cmsPosts", stored: { ...summary, type: summary.kind, createdBy, section, unassignedDraft } }),
    });
    return decision.allowed ? [summary] : [];
  });
}

function requestView(body) {
  const view = body?.view ?? LIBRARY_VIEW;
  return view === LIBRARY_VIEW
    || view === REVIEW_QUEUE_VIEW
    || view === PUBLISH_ACTIVITY_VIEW
    || view === "pages"
    || view === "data-hub-reporting"
    || view === "published-vocabulary"
    ? view
    : null;
}

async function readPublishActivitySummary(firestore, includePostProofRecovery = false) {
  // One snapshot, then local buckets, so a status change cannot land in two
  // aggregations or in none while those queries race.
  const snapshot = await firestore.collection("cmsPublishQueue")
    .select("status", "transport", "postProof.status", "postProof.attempts", "postProof.nextAttemptAt", "noBuildPost.postId").get();
  let activeCount = 0;
  let recoveryCount = 0;
  for (const doc of snapshot.docs) {
    const status = doc.data()?.status;
    if (status === "reserved" || status === "pending" || status === "publishing") {
      activeCount += 1;
    } else if (status === "failed" || status === "public_unconfirmed") {
      recoveryCount += 1;
    }
  }
  const postProofRecoveryIds = await require("./lib/no-build-post-proof-state")
    .currentPostProofRecoveryIds(firestore, snapshot.docs);
  const contextRetry = includePostProofRecovery ? await require("./lib/generic-context-retry").genericContextRetry(firestore) : null;
  recoveryCount += postProofRecoveryIds.length;
  return { activeCount, recoveryCount, ...(includePostProofRecovery ? { postProofRecoveryIds: postProofRecoveryIds.slice(0, 100),
    postProofRecoveryTruncated: postProofRecoveryIds.length > 100, contextRetry } : {}) };
}

function reviewUserIds(requests) {
  return requests.flatMap((request) => [
    request.requestedByUid,
    request.assigneeUid,
  ]);
}

function createCmsListContentHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    readRecordsFn,
    readAddressedRecordsFn = readAddressedContentSummaries,
    readMediaRecordsByIdsFn = readMediaAssetSummariesByIds,
    readReviewRecordsFn = readInReviewRecords,
    readStaffDirectoryFn = readStaffDirectory,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requirePrincipalFn(req, { includeAccountStatus: true });
      const view = requestView(req.body);
      if (view === null) {
        res.status(400).json({ error: "view is not supported" });
        return;
      }

      if (view === "pages") {
        if (!mayReachContentRead(user.principal)) throw new ListRejection(403, FORBIDDEN_MESSAGE);
        const pageSummaries = await readPageSummaries(firestore, user.principal);
        const pages = await attachThumbnailUrls(
          firestore,
          user.principal,
          pageSummaries,
          {
            readRecordsByIdsFn: readMediaRecordsByIdsFn,
            audioReadAdmitted: isAudioReadAdmitted(user),
          },
        );
        res.status(200).json({ success: true, pages });
        return;
      }

      if (view === "data-hub-reporting") {
        const result = await require("./lib/data-hub-reporting-preview").readReportingPreview({firestore,principal:user.principal,body:req.body});
        res.status(200).json({success:true,...result}); return;
      }

      if (view === "published-vocabulary") {
        if (!mayReachContentRead(user.principal) || !mayReadSomeContentRecord(user.principal)) {
          throw new ListRejection(403, FORBIDDEN_MESSAGE);
        }
        const vocabulary = await readPublishedVocabulary(firestore, user.principal);
        res.status(200).json({ success: true, ...vocabulary });
        return;
      }

      if (view === PUBLISH_ACTIVITY_VIEW) {
        if (!hasCapability(user.principal, "settings.manage")) {
          throw new ListRejection(403, FORBIDDEN_MESSAGE);
        }
        const summary = await readPublishActivitySummary(firestore, req.body?.includePostProofRecovery === true);
        res.status(200).json({ success: true, ...summary });
        return;
      }

      if (view === REVIEW_QUEUE_VIEW) {
        // Shared content readers can see the queue. Legacy reviewers retain
        // their section scope; legacy contributors are refused before a read.
        if (!hasCapability(user.principal, "content.view") && !hasCapability(user.principal, "content.edit.any")) {
          log.warn("cmsListContent refused a non-reviewer queue read", {
            uid: user.uid,
          });
          throw new ListRejection(403, REVIEW_FORBIDDEN_MESSAGE);
        }

        const storedRecords = await readReviewRecordsFn(
          firestore,
          user.principal,
        );
        const visible = sortReviewRequests(
          visibleReviewRequests(user.principal, storedRecords),
        ).slice(0, MAX_REVIEW_REQUESTS);
        if (req.body?.countOnly === true) {
          res.status(200).json({ success: true, count: visible.length });
          return;
        }
        // Resolve names only after resource filtering, so a caller cannot learn
        // staff participation on requests outside their desks.
        const directory = await readStaffDirectoryFn(
          firestore,
          reviewUserIds(visible),
        );
        const requests = presentReviewRequests(visible, {
          viewerUid: user.uid,
          directory,
        });
        res.status(200).json({ success: true, requests });
        return;
      }

      const queryInput = req.body?.query;
      if (
        typeof queryInput !== "string" ||
        queryInput.length > MAX_QUERY_LENGTH
      ) {
        res.status(400).json({ error: "query must be a bounded query string" });
        return;
      }
      if (
        req.body?.unpaged !== undefined &&
        typeof req.body.unpaged !== "boolean"
      ) {
        res.status(400).json({ error: "unpaged must be a boolean" });
        return;
      }

      // Refuse a caller who could not be shown a single row before touching the
      // collection. `mayReadSomeContentRecord` asks the read decision itself
      // about the shapes this principal could actually be handed, so a site-wide
      // grant, a contributor's own drafts and a scoped grant's desks all pass
      // while a malformed grant still confers nothing.
      if (
        !mayReachContentRead(user.principal) ||
        !mayReadSomeContentRecord(user.principal)
      ) {
        log.warn("cmsListContent refused a caller with no readable content", {
          uid: user.uid,
        });
        throw new ListRejection(403, FORBIDDEN_MESSAGE);
      }

      const legacyUnpaged = req.body.unpaged === true;
      const ownerQuery = parseContentQuery(queryInput);
      const resolvedQuery = {
        ...ownerQuery,
        ownerUid: ownerQuery.ownerMode === "me" ? user.uid : ownerQuery.ownerUid,
        ownerMode: ownerQuery.ownerMode === "me" ? "specific" : ownerQuery.ownerMode,
        assigneeUid: ownerQuery.assignmentMode === "me" ? user.uid : ownerQuery.assigneeUid,
        assignmentMode: ownerQuery.assignmentMode === "me" ? "specific" : ownerQuery.assignmentMode,
      };
      const boundedScan = legacyUnpaged || Boolean(resolvedQuery.q);
      const storedRecords = readRecordsFn
        ? await readRecordsFn(firestore)
        : await readAddressedRecordsFn(firestore, resolvedQuery, {
          unpaged: boundedScan,
          principal: user.principal,
        });
      const records = visibleContentSummaries(user.principal, storedRecords);
      if (boundedScan && records.length > MAX_UNPAGED_RECORDS) {
        res.status(413).json({ error: UNPAGED_LIMIT_MESSAGE });
        return;
      }
      const selection = selectContentLibrary(
        records,
        legacyUnpaged ? { ...ownerQuery, page: 1 } : ownerQuery,
        user.uid,
        boundedScan ? MAX_UNPAGED_RECORDS : undefined,
      );
      const hydratedRecords = await attachThumbnailUrls(
        firestore,
        user.principal,
        selection.records,
        {
          readRecordsByIdsFn: readMediaRecordsByIdsFn,
          audioReadAdmitted: isAudioReadAdmitted(user),
        },
      );
      res.status(200).json({
        success: true,
        ...selection,
        records: hydratedRecords,
      });
    } catch (err) {
      if (res.headersSent) return;
      const status =
        err?.status || (err?.code === "failed-precondition" ? 503 : 500);
      if (!(err instanceof ListRejection) && status >= 500) {
        log.error("cmsListContent failed", err);
      }
      res
        .status(status)
        .json({ error: err?.message || "Failed to list content" });
    }
  };
}

const cmsListContent = cmsOnRequest({ cors: true }, createCmsListContentHandler());

module.exports = {
  FORBIDDEN_MESSAGE,
  LIBRARY_VIEW,
  ListRejection,
  MAX_QUERY_LENGTH,
  MAX_UNPAGED_RECORDS,
  REVIEW_FORBIDDEN_MESSAGE,
  REVIEW_QUEUE_VIEW,
  SUMMARY_FIELDS,
  UNPAGED_LIMIT_MESSAGE,
  attachThumbnailUrls,
  cmsListContent,
  createCmsListContentHandler,
  readAddressedContentSummaries,
  thumbnailAssetIds,
  requestView,
  reviewUserIds,
  visibleContentSummaries,
};
