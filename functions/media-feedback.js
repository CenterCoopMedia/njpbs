"use strict";

const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { isApprovedActiveAccount } = require("./lib/active-account");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const {
  canonicalMediaAssetRef,
  mediaAssetRefDocumentId,
} = require("./lib/media-asset-ref");
const { resolveMediaAssets } = require("./lib/media-asset-resolver");
const { isAudioReadAdmitted, mayUseMedia } = require("./lib/media-access");
const { mediaAssetSummary } = require("./lib/media-library");
const {
  ARCHIVE_CATEGORY_ID,
  objectKeyWithinSource,
  authorizeMediaSource,
} = require("./lib/media-sources");
const { can } = require("./lib/rbac");
const { parseSourceMediaAsset } = require("./lib/source-media-contract");
const { requesterName } = require("./lib/video-processing-status");
const {
  REVIEWS_COLLECTION: VOICEOVER_REVIEWS_COLLECTION,
  VoiceoverError,
  reviewProjection: voiceoverReviewProjection,
} = require("./lib/voiceover-review");
const {
  COMMENT_HAS_REPLIES_CODE,
  MEDIA_COMMENTS_COLLECTION,
  MEDIA_FEEDBACK_SCHEMA_VERSION,
  STAFF_UID_PATTERN,
  MediaFeedbackValidationError,
  commentCreateFingerprint,
  commentProjection,
  encodeCommentCursor,
  mediaCommentDocumentId,
  mediaCommentRequests,
  mediaComments,
  mediaReviewItems,
  parseGetMediaReviewRequest,
  parseListMediaCommentsRequest,
  parseMutateMediaCommentRequest,
  parseSaveMediaReviewRequest,
  reviewProjection,
  storedMediaComment,
  storedMediaReview,
  timedCommentFields,
  timestampIso,
} = require("./lib/media-feedback");

const MAX_FEEDBACK_JSON_BYTES = 16 * 1024;
const ACCESS_DENIED_MESSAGE = "Media feedback access denied";
const ITEM_UNAVAILABLE_MESSAGE = "Media asset is unavailable";
const REVIEW_CONFLICT_MESSAGE = "Media review changed. Reload and try again";
const COMMENT_CONFLICT_MESSAGE = "Media comment changed. Reload and try again";
const DEFAULT_STAFF_NAME = "NJ PBS staff";
// The mention list reads at most this many staff accounts.
const MAX_STAFF_DIRECTORY = 1_000;
// Export reads one complete asset, never a silently truncated set of threads.
const MAX_COMMENT_EXPORT = 1_000;

class MediaFeedbackRejection extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = "MediaFeedbackRejection";
    this.status = status;
    this.code = code;
  }
}

function privateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
}

function requirePost(req, res) {
  privateNoStore(res);
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return false;
  }
  validateBoundedJsonRequest(req, MAX_FEEDBACK_JSON_BYTES);
  return true;
}

function defaultRegistry() {
  return require("./source-media").runtimeRegistry();
}

async function requireFeedbackActor(firestore, req, requirePrincipalFn, isActiveFn) {
  const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
  const approvedActive = typeof actor.approvedActive === "boolean"
    ? actor.approvedActive
    : await isActiveFn(firestore, actor.uid);
  if (!approvedActive) {
    throw new MediaFeedbackRejection(403, ACCESS_DENIED_MESSAGE);
  }
  return { ...actor, approvedActive };
}

function unavailable() {
  throw new MediaFeedbackRejection(404, ITEM_UNAVAILABLE_MESSAGE);
}

function r2TargetGuard(firestore, actor, ref, summary) {
  const legacy = summary.source === "voiceover"
    ? {
        takeId: summary.voiceoverTakeId,
        manifestVersion: summary.voiceover.manifestVersion,
      }
    : null;
  return {
    ref,
    canonicalRef: canonicalMediaAssetRef(ref),
    documentId: mediaAssetRefDocumentId(ref),
    legacy,
    reference: firestore.collection("media_assets").doc(ref.id),
    assertSnapshot(snapshot) {
      const current = snapshot.exists
        ? mediaAssetSummary(snapshot.id, snapshot.data())
        : null;
      if (!current || !mayUseMedia(
        actor.principal,
        current.category,
        current.kind,
        isAudioReadAdmitted(actor),
      )) {
        unavailable();
      }
      const currentLegacy = current.source === "voiceover"
        ? {
            takeId: current.voiceoverTakeId,
            manifestVersion: current.voiceover.manifestVersion,
          }
        : null;
      if (
        Boolean(legacy) !== Boolean(currentLegacy) ||
        legacy && (
          legacy.takeId !== currentLegacy.takeId ||
          legacy.manifestVersion !== currentLegacy.manifestVersion
        )
      ) {
        unavailable();
      }
      return null;
    },
    // The uploader and accounts that manage media in the item category may resolve threads.
    moderates(snapshot) {
      const current = mediaAssetSummary(snapshot.id, snapshot.data());
      return current.createdBy === actor.uid ||
        can(actor.principal, "media.manage");
    },
  };
}

function s3TargetGuard(firestore, actor, ref, source) {
  return {
    ref,
    canonicalRef: canonicalMediaAssetRef(ref),
    documentId: mediaAssetRefDocumentId(ref),
    legacy: null,
    reference: firestore.collection("mediaSourceAssets").doc(ref.id),
    assertSnapshot(snapshot) {
      const current = snapshot.exists
        ? parseSourceMediaAsset(snapshot.id, snapshot.data())
        : null;
      if (
        !source ||
        !current ||
        current.sourceId !== source.id ||
        !objectKeyWithinSource(source, current.objectKey)
      ) {
        unavailable();
      }
      return current;
    },
    // Match authorizeMediaSource's metadata capability and resource for this source.
    moderates(snapshot) {
      const current = parseSourceMediaAsset(snapshot.id, snapshot.data());
      const resource = source.access === "archive" ? { section: ARCHIVE_CATEGORY_ID } : {};
      return (Boolean(current.createdBy) && current.createdBy === actor.uid) ||
        can(actor.principal, "media.video.manage", resource);
    },
  };
}

async function resolveFeedbackTarget({
  firestore,
  actor,
  ref,
  registryFn,
  authorizeFn,
}) {
  const registry = ref.backend === "s3" ? registryFn() : new Map();
  const [resolved] = await resolveMediaAssets({
    firestore,
    actor,
    refs: [ref],
    registryFn: () => registry,
    authorizeFn,
  });
  if (!resolved?.available) unavailable();
  return ref.backend === "r2"
    ? r2TargetGuard(firestore, actor, ref, resolved.summary)
    : s3TargetGuard(firestore, actor, ref, registry.get(ref.sourceId));
}

function voiceoverReviewReference(firestore, uid, takeId) {
  return firestore
    .collection(VOICEOVER_REVIEWS_COLLECTION)
    .doc(uid)
    .collection("takes")
    .doc(takeId);
}

function reviewReference(firestore, uid, target) {
  return target.legacy
    ? voiceoverReviewReference(firestore, uid, target.legacy.takeId)
    : mediaReviewItems(firestore, uid).doc(target.documentId);
}

function commonVoiceoverReview(target, value) {
  const review = voiceoverReviewProjection(
    target.legacy.takeId,
    value,
    target.legacy.manifestVersion,
  );
  return {
    moreLikeThis: review.moreLikeThis,
    notes: review.notes,
    version: review.version,
    updatedAt: review.updatedAt,
  };
}

function storedReview(target, snapshot) {
  if (!snapshot.exists) return null;
  return target.legacy
    ? commonVoiceoverReview(target, snapshot.data())
    : storedMediaReview(target.ref, snapshot.data());
}

async function getMediaReview({ firestore, actor, target }) {
  const snapshot = await reviewReference(firestore, actor.uid, target).get();
  return storedReview(target, snapshot);
}

function reviewConflict() {
  throw new MediaFeedbackRejection(
    409,
    REVIEW_CONFLICT_MESSAGE,
    "media_review_conflict",
  );
}

function normalReviewRecord(target, request, currentVersion, currentData, timestamp) {
  return {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    ref: target.ref,
    canonicalRef: target.canonicalRef,
    moreLikeThis: request.moreLikeThis,
    notes: request.notes,
    version: currentVersion + 1,
    createdAt: currentData?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function voiceoverReviewRecord(target, request, currentVersion, currentData, timestamp) {
  const updatedAt = timestampIso(timestamp);
  if (!updatedAt) throw new Error("The media review timestamp is invalid");
  return {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    manifestVersion: target.legacy.manifestVersion,
    takeId: target.legacy.takeId,
    favorite: currentData?.favorite ?? false,
    moreLikeThis: request.moreLikeThis,
    notes: request.notes,
    version: currentVersion + 1,
    createdAt: currentData?.createdAt ?? updatedAt,
    updatedAt,
  };
}

async function saveMediaReview({ firestore, actor, target, request, nowFn }) {
  const reference = reviewReference(firestore, actor.uid, target);
  return firestore.runTransaction(async (transaction) => {
    const [targetSnapshot, reviewSnapshot] = await Promise.all([
      transaction.get(target.reference),
      transaction.get(reference),
    ]);
    target.assertSnapshot(targetSnapshot);
    const current = storedReview(target, reviewSnapshot);
    const currentVersion = current?.version ?? 0;
    if (request.baseVersion !== currentVersion) reviewConflict();
    const timestamp = nowFn();
    if (!timestampIso(timestamp)) {
      throw new Error("The media review timestamp is invalid");
    }
    const stored = target.legacy
      ? voiceoverReviewRecord(
          target,
          request,
          currentVersion,
          reviewSnapshot.exists ? reviewSnapshot.data() : null,
          timestamp,
        )
      : normalReviewRecord(
          target,
          request,
          currentVersion,
          reviewSnapshot.exists ? reviewSnapshot.data() : null,
          timestamp,
        );
    transaction.set(reference, stored);
    return target.legacy
      ? commonVoiceoverReview(target, stored)
      : reviewProjection(stored);
  });
}

// Names come from the staff directory at read time. A deactivated or missing account has no
// name here; the projection shows it as a former staff member.
async function activeStaffNames(firestore, uids) {
  const unique = [...new Set(uids)];
  if (unique.length === 0) return new Map();
  const snapshots = await firestore.getAll(
    ...unique.map((uid) => firestore.collection("users").doc(uid)),
  );
  const names = new Map();
  snapshots.forEach((snapshot, index) => {
    if (!snapshot.exists || snapshot.data()?.active === false) return;
    names.set(unique[index], requesterName(snapshot.data()?.displayName) ?? DEFAULT_STAFF_NAME);
  });
  return names;
}

function namedIds(comments) {
  return comments.flatMap((comment) => [
    ...comment.mentions,
    ...(comment.resolvedBy ? [comment.resolvedBy] : []),
  ]);
}

// The staff that can be mentioned: approved active accounts with a usable name. This is the
// same rule as isApprovedActiveAccount, which the server applies again to each mention.
async function listMentionStaff(firestore) {
  const snapshot = await firestore.collection("users").limit(MAX_STAFF_DIRECTORY).get();
  return snapshot.docs
    .flatMap((document) => {
      const data = document.data();
      const name = requesterName(data?.displayName);
      return data?.active !== false && name && STAFF_UID_PATTERN.test(document.id)
        ? [{ uid: document.id, name }]
        : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.uid.localeCompare(right.uid));
}

async function readCommentPage({
  firestore,
  actor,
  target,
  request,
  documentIdField,
  timestampFn,
}) {
  const targetSnapshot = await target.reference.get();
  const asset = target.assertSnapshot(targetSnapshot);
  const moderates = target.moderates(targetSnapshot);
  let query = mediaComments(firestore, request.ref)
    .orderBy("createdAt", "asc")
    .orderBy(documentIdField, "asc");
  if (request.cursor) {
    query = query.startAfter(
      timestampFn(request.cursor.seconds, request.cursor.nanoseconds),
      request.cursor.id,
    );
  }
  const snapshot = await query.limit(request.limit + 1).get();
  const hasMore = snapshot.docs.length > request.limit;
  const documents = snapshot.docs.slice(0, request.limit);
  const stored = documents.map((document) =>
    storedMediaComment(document.id, request.ref, document.data()));
  const names = await activeStaffNames(firestore, namedIds(stored));
  const comments = documents.map((document, index) => commentProjection(
    document.id,
    stored[index],
    actor.uid,
    asset?.objectVersionId ?? null,
    { names, moderates },
  ));
  return {
    comments,
    nextCursor: hasMore && documents.length > 0
      ? encodeCommentCursor(request.ref, documents.at(-1))
      : null,
  };
}

function commentConflict() {
  throw new MediaFeedbackRejection(
    409,
    COMMENT_CONFLICT_MESSAGE,
    "media_comment_conflict",
  );
}

function exportFilteredComments(comments, filter) {
  const tops = new Map(comments.filter(comment => !comment.parentId).map(comment => [comment.id, comment]));
  const threadId = comment => tops.has(comment.parentId) ? comment.parentId : comment.id;
  const matches = new Set();
  for (const comment of comments) {
    const first = tops.get(threadId(comment)) ?? comment;
    const match = filter === "all" ||
      filter === "open" && !first.resolvedAt ||
      filter === "resolved" && Boolean(first.resolvedAt) ||
      filter === "mine" && comment.canEdit ||
      filter === "mentions" && comment.mentionsYou;
    if (match) matches.add(threadId(comment));
  }
  return comments.filter(comment => matches.has(threadId(comment)));
}

async function exportMediaComments({ firestore, actor, target, request, documentIdField, auditFn }) {
  return firestore.runTransaction(async transaction => {
    const targetSnapshot = await transaction.get(target.reference);
    const asset = target.assertSnapshot(targetSnapshot);
    const snapshot = await transaction.get(mediaComments(firestore, target.ref)
      .orderBy("createdAt", "asc").orderBy(documentIdField, "asc").limit(MAX_COMMENT_EXPORT + 1));
    if (snapshot.size > MAX_COMMENT_EXPORT) {
      throw new MediaFeedbackRejection(413,
        "This asset has more than 1,000 comments. CSV export is not available for this many comments");
    }
    const comments = exportFilteredComments(snapshot.docs.map(document => commentProjection(
      document.id, storedMediaComment(document.id, target.ref, document.data()),
      actor.uid, asset?.objectVersionId ?? null,
    )), request.export);
    auditEntry(firestore, transaction, auditFn({
      actorUid: actor.uid,
      actorEmail: actor.email ?? null,
      action: "media_comment_export",
      target: { collection: MEDIA_COMMENTS_COLLECTION, documentId: target.documentId },
      after: { filter: request.export, count: comments.length, format: "csv" },
    }));
    return comments;
  });
}

function commentNotFound() {
  throw new MediaFeedbackRejection(404, "Media comment not found");
}

function commentAudit({ auditFn, actor, target, commentId, action, before, after }) {
  // Audit entries keep IDs and state, never comment text.
  const auditShape = (comment) => comment
    ? {
        authorUid: comment.authorUid,
        version: comment.version,
        parentId: comment.parentId ?? null,
        mentions: comment.mentions ?? [],
        resolved: Boolean(comment.resolvedAt),
      }
    : null;
  return auditFn({
    actorUid: actor.uid,
    actorEmail: actor.email ?? null,
    action: `media_comment_${action}`,
    target: {
      collection: MEDIA_COMMENTS_COLLECTION,
      documentId: target.documentId,
      commentId,
    },
    before: auditShape(before),
    after: auditShape(after),
  });
}

async function verifiedCommentAuthorName(firestore, uid) {
  const snapshot = await firestore.collection("users").doc(uid).get();
  return requesterName(snapshot.exists ? snapshot.data()?.displayName : null) ??
    DEFAULT_STAFF_NAME;
}

function createFingerprint(target, request) {
  return commentCreateFingerprint(
    target.ref,
    request.text,
    request.time,
    request.parentId,
    request.mentions,
  );
}

function newComment(target, actor, authorName, request, timestamp, time) {
  return {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    ref: target.ref,
    canonicalRef: target.canonicalRef,
    authorUid: actor.uid,
    authorName,
    text: request.text,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    createFingerprint: createFingerprint(target, request),
    parentId: request.parentId,
    mentions: request.mentions,
    resolvedAt: null,
    resolvedBy: null,
    replyCount: 0,
    ...time,
  };
}

function createReceipt(target, actor, request, commentId, timestamp) {
  return {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    canonicalRef: target.canonicalRef,
    authorUid: actor.uid,
    commentId,
    fingerprint: createFingerprint(target, request),
    createdAt: timestamp,
  };
}

function requestIdReused() {
  throw new MediaFeedbackRejection(
    409,
    "Request id was already used for a different media comment",
  );
}

function assertCreateReceipt(receipt, target, actor, request, commentId) {
  if (
    receipt?.schemaVersion !== MEDIA_FEEDBACK_SCHEMA_VERSION ||
    receipt.canonicalRef !== target.canonicalRef ||
    receipt.authorUid !== actor.uid ||
    receipt.commentId !== commentId ||
    receipt.fingerprint !== createFingerprint(target, request) ||
    !timestampIso(receipt.createdAt)
  ) {
    requestIdReused();
  }
}

function assertCreateReplay(current, target, actor, request) {
  if (
    current.authorUid !== actor.uid ||
    current.canonicalRef !== target.canonicalRef ||
    current.createFingerprint !== createFingerprint(target, request)
  ) {
    requestIdReused();
  }
}

// Resolve and reopen keep a receipt, so a repeated request returns the current thread
// instead of a version conflict.
function stateReceipt(target, actor, request, timestamp) {
  return {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    canonicalRef: target.canonicalRef,
    authorUid: actor.uid,
    action: request.action,
    commentId: request.commentId,
    baseVersion: request.baseVersion,
    createdAt: timestamp,
  };
}

function assertStateReceipt(receipt, target, actor, request) {
  if (
    receipt?.schemaVersion !== MEDIA_FEEDBACK_SCHEMA_VERSION ||
    receipt.canonicalRef !== target.canonicalRef ||
    receipt.authorUid !== actor.uid ||
    receipt.action !== request.action ||
    receipt.commentId !== request.commentId ||
    receipt.baseVersion !== request.baseVersion ||
    !timestampIso(receipt.createdAt)
  ) {
    requestIdReused();
  }
}

function assertCommentMutation(current, actor, request) {
  if (!current) commentNotFound();
  if (current.authorUid !== actor.uid) {
    throw new MediaFeedbackRejection(403, "Only the comment author can change it");
  }
  if (current.version !== request.baseVersion) commentConflict();
}

function assertThreadStateChange(current, actor, moderates, request) {
  if (!current) commentNotFound();
  if (current.parentId !== null) {
    throw new MediaFeedbackValidationError(
      "Only the first comment in a thread can be resolved or reopened",
    );
  }
  if (current.authorUid !== actor.uid && !moderates) {
    throw new MediaFeedbackRejection(
      403,
      "Only the comment author, the uploader, or a media manager can resolve or reopen this thread",
    );
  }
  if (current.version !== request.baseVersion) commentConflict();
  // A matching version with the requested state already set means another tab changed it.
  if ((current.resolvedAt !== null) === (request.action === "resolve")) commentConflict();
}

// Every mentioned ID must name an approved active account. Unknown IDs are refused, not dropped.
function assertMentionedStaff(uids, snapshots) {
  const unknown = uids.filter((_, index) =>
    !snapshots[index].exists || snapshots[index].data()?.active === false);
  if (unknown.length > 0) {
    throw new MediaFeedbackRejection(
      400,
      unknown.length === 1
        ? "One mentioned person is not active staff. Remove the mention and try again"
        : `${unknown.length} mentioned people are not active staff. Remove the mentions and try again`,
      "media_comment_mention_invalid",
    );
  }
}

function auditEntry(firestore, transaction, entry) {
  transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), entry);
}

/**
 * One comment change in one transaction with its audit entry. Returns the changed comment in
 * stored form (or null) so the caller can project it with current staff names.
 */
async function commitCommentChange({
  firestore,
  actor,
  target,
  request,
  authorName,
  nowFn,
  auditFn,
}) {
  const action = request.action;
  const receiptId = mediaCommentDocumentId(actor.uid, request.requestId);
  const commentId = action === "create" ? receiptId : request.commentId;
  const comments = mediaComments(firestore, target.ref);
  const reference = comments.doc(commentId);
  const receiptReference = ["create", "resolve", "reopen"].includes(action)
    ? mediaCommentRequests(firestore, target.ref).doc(receiptId)
    : null;
  const parentReference = action === "create" && request.parentId
    ? comments.doc(request.parentId)
    : null;
  const mentions = action === "create" || action === "edit" ? request.mentions ?? [] : [];
  return firestore.runTransaction(async (transaction) => {
    const [targetSnapshot, commentSnapshot, receiptSnapshot, parentSnapshot, ...mentionSnapshots] =
      await Promise.all([
        transaction.get(target.reference),
        transaction.get(reference),
        receiptReference ? transaction.get(receiptReference) : null,
        parentReference ? transaction.get(parentReference) : null,
        ...mentions.map((uid) => transaction.get(firestore.collection("users").doc(uid))),
      ]);
    const asset = target.assertSnapshot(targetSnapshot);
    const result = (comment) => ({
      commentId,
      comment,
      sourceVersion: asset?.objectVersionId ?? null,
      moderates: target.moderates(targetSnapshot),
    });
    const current = commentSnapshot.exists
      ? storedMediaComment(commentId, target.ref, commentSnapshot.data())
      : null;
    const audit = (before, after) => auditEntry(firestore, transaction, commentAudit({
      auditFn, actor, target, commentId, action, before, after,
    }));

    if (action === "create") {
      if (receiptSnapshot.exists) {
        assertCreateReceipt(receiptSnapshot.data(), target, actor, request, commentId);
        if (current) assertCreateReplay(current, target, actor, request);
        return result(current);
      }
      if (current) throw new Error(`Media comment ${commentId} has no create receipt`);
      // The parent is read from this item's comments, so a parent on another item is missing.
      const parent = parentSnapshot?.exists
        ? storedMediaComment(request.parentId, target.ref, parentSnapshot.data())
        : null;
      if (request.parentId && !parent) {
        throw new MediaFeedbackRejection(
          404,
          "The comment you replied to is no longer available. Reload the comments",
        );
      }
      if (parent && parent.parentId !== null) {
        throw new MediaFeedbackValidationError(
          "Reply to the first comment in the thread, not to a reply",
        );
      }
      assertMentionedStaff(mentions, mentionSnapshots);
      const timestamp = nowFn();
      if (!timestampIso(timestamp)) throw new Error("The media comment timestamp is invalid");
      const created = newComment(
        target,
        actor,
        authorName,
        request,
        timestamp,
        timedCommentFields(asset, request.time),
      );
      transaction.create(reference, created);
      transaction.create(
        receiptReference,
        createReceipt(target, actor, request, commentId, timestamp),
      );
      // The parent keeps a private reply count, so a reply and a delete of its parent conflict.
      if (parent) transaction.update(parentReference, { replyCount: parent.replyCount + 1 });
      audit(null, created);
      return result(storedMediaComment(commentId, target.ref, created));
    }

    if (action === "resolve" || action === "reopen") {
      if (receiptSnapshot.exists) {
        assertStateReceipt(receiptSnapshot.data(), target, actor, request);
        return result(current);
      }
      assertThreadStateChange(current, actor, target.moderates(targetSnapshot), request);
      const timestamp = nowFn();
      if (!timestampIso(timestamp)) throw new Error("The media comment timestamp is invalid");
      const changed = {
        ...current,
        resolvedAt: action === "resolve" ? timestamp : null,
        resolvedBy: action === "resolve" ? actor.uid : null,
        version: current.version + 1,
      };
      transaction.update(reference, {
        resolvedAt: changed.resolvedAt,
        resolvedBy: changed.resolvedBy,
        version: changed.version,
      });
      transaction.create(receiptReference, stateReceipt(target, actor, request, timestamp));
      audit(current, changed);
      return result(changed);
    }

    assertCommentMutation(current, actor, request);
    if (action === "delete") {
      // Decision: a first comment with replies stays. Deleting it would orphan the replies.
      if (current.parentId === null && current.replyCount > 0) {
        throw new MediaFeedbackRejection(
          409,
          "This comment has replies, so it cannot be deleted. Edit it instead",
          COMMENT_HAS_REPLIES_CODE,
        );
      }
      const parentOfReply = current.parentId === null
        ? null
        : comments.doc(current.parentId);
      const parentOfReplySnapshot = parentOfReply ? await transaction.get(parentOfReply) : null;
      transaction.delete(reference);
      if (parentOfReplySnapshot?.exists) {
        const parent = storedMediaComment(current.parentId, target.ref, parentOfReplySnapshot.data());
        transaction.update(parentOfReply, { replyCount: Math.max(0, parent.replyCount - 1) });
      }
      audit(current, null);
      return result(null);
    }

    // An edit checks only the people it adds. A stored mention of someone who has since left
    // stays, so an edit that keeps it is not refused.
    if (request.mentions !== null) {
      const stored = new Set(current.mentions);
      assertMentionedStaff(
        mentions.filter((uid) => !stored.has(uid)),
        mentionSnapshots.filter((_, index) => !stored.has(mentions[index])),
      );
    }
    const timestamp = nowFn();
    if (!timestampIso(timestamp)) throw new Error("The media comment timestamp is invalid");
    const edited = {
      ...current,
      text: request.text,
      version: current.version + 1,
      updatedAt: timestamp,
      ...(request.mentions !== null ? { mentions: request.mentions } : {}),
    };
    transaction.update(reference, {
      text: edited.text,
      version: edited.version,
      updatedAt: edited.updatedAt,
      ...(request.mentions !== null ? { mentions: edited.mentions } : {}),
    });
    audit(current, edited);
    return result(edited);
  });
}

async function mutateMediaComment(options) {
  const { firestore, actor } = options;
  const { commentId, comment, sourceVersion, moderates } = await commitCommentChange(options);
  if (!comment) return null;
  const names = await activeStaffNames(firestore, namedIds([comment]));
  return commentProjection(commentId, comment, actor.uid, sourceVersion, { names, moderates });
}

function expectedError(error) {
  return error instanceof JsonRequestError ||
    error instanceof MediaFeedbackValidationError ||
    error instanceof MediaFeedbackRejection ||
    error instanceof VoiceoverError ||
    Number.isInteger(error?.status);
}

function respondWithError(res, log, operation, error) {
  if (res.headersSent) return;
  const known = expectedError(error);
  const status = error?.status ?? 500;
  if (!known || status >= 500) log.error(`${operation} failed`, error);
  res.status(status).json({
    error: known ? error.message : `Failed to ${operation}`,
    ...(known && error.code ? { code: error.code } : {}),
  });
}

function feedbackDependencies(deps) {
  return {
    firestore: deps.firestore ?? db,
    requirePrincipalFn: deps.requirePrincipalFn ?? requirePrincipal,
    isActiveFn: deps.isActiveFn ?? isApprovedActiveAccount,
    registryFn: deps.registryFn ?? defaultRegistry,
    authorizeFn: deps.authorizeFn ?? authorizeMediaSource,
    nowFn: deps.nowFn ?? (() => Timestamp.now()),
    documentIdField: deps.documentIdField ?? FieldPath.documentId(),
    timestampFn: deps.timestampFn ?? ((seconds, nanoseconds) =>
      new Timestamp(seconds, nanoseconds)),
    auditFn: deps.auditFn ?? adminLogEntry,
    log: deps.log ?? logger,
  };
}

async function actorAndTarget(runtime, req, ref) {
  const actor = await requireFeedbackActor(
    runtime.firestore,
    req,
    runtime.requirePrincipalFn,
    runtime.isActiveFn,
  );
  const target = await resolveFeedbackTarget({
    ...runtime,
    actor,
    ref,
  });
  return { actor, target };
}

function createCmsGetMediaReviewHandler(deps = {}) {
  const runtime = feedbackDependencies(deps);
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseGetMediaReviewRequest(req.body);
      const { actor, target } = await actorAndTarget(runtime, req, request.ref);
      const review = await getMediaReview({ ...runtime, actor, target });
      res.status(200).json({ success: true, review });
    } catch (error) {
      respondWithError(res, runtime.log, "get media review", error);
    }
  };
}

function createCmsSaveMediaReviewHandler(deps = {}) {
  const runtime = feedbackDependencies(deps);
  const verifyAppCheckFn = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseSaveMediaReviewRequest(req.body);
      await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const { actor, target } = await actorAndTarget(runtime, req, request.ref);
      const review = await saveMediaReview({
        ...runtime,
        actor,
        target,
        request,
      });
      res.status(200).json({ success: true, review });
    } catch (error) {
      respondWithError(res, runtime.log, "save media review", error);
    }
  };
}

function createCmsListMediaCommentsHandler(deps = {}) {
  const runtime = feedbackDependencies(deps);
  const verifyAppCheckFn = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseListMediaCommentsRequest(req.body);
      if (request.export) await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const { actor, target } = await actorAndTarget(runtime, req, request.ref);
      if (request.export) {
        const comments = await exportMediaComments({ ...runtime, actor, target, request });
        res.status(200).json({ success: true, exported: true, comments });
        return;
      }
      if (request.staff) {
        // The staff list is read only after item access is confirmed.
        res.status(200).json({ success: true, staff: await listMentionStaff(runtime.firestore) });
        return;
      }
      const page = await readCommentPage({ ...runtime, actor, target, request });
      res.status(200).json({ success: true, ...page });
    } catch (error) {
      respondWithError(res, runtime.log, "list media comments", error);
    }
  };
}

function createCmsMutateMediaCommentHandler(deps = {}) {
  const runtime = feedbackDependencies(deps);
  const verifyAppCheckFn = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseMutateMediaCommentRequest(req.body);
      await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const { actor, target } = await actorAndTarget(runtime, req, request.ref);
      const authorName = request.action === "create"
        ? await verifiedCommentAuthorName(runtime.firestore, actor.uid)
        : null;
      const comment = await mutateMediaComment({
        ...runtime,
        actor,
        target,
        request,
        authorName,
      });
      res.status(200).json({ success: true, comment });
    } catch (error) {
      respondWithError(res, runtime.log, "change media comment", error);
    }
  };
}

const readOptions = {
  cors: true,
  cpu: 1,
  concurrency: 80,
  maxInstances: 10,
  timeoutSeconds: 30,
};
const writeOptions = { cors: true, maxInstances: 10, timeoutSeconds: 30 };

const cmsGetMediaReview = cmsOnRequest(
  readOptions,
  createCmsGetMediaReviewHandler(),
);
const cmsSaveMediaReview = cmsOnRequest(
  writeOptions,
  createCmsSaveMediaReviewHandler(),
);
const cmsListMediaComments = cmsOnRequest(
  readOptions,
  createCmsListMediaCommentsHandler(),
);
const cmsMutateMediaComment = cmsOnRequest(
  writeOptions,
  createCmsMutateMediaCommentHandler(),
);

module.exports = {
  ACCESS_DENIED_MESSAGE,
  COMMENT_CONFLICT_MESSAGE,
  ITEM_UNAVAILABLE_MESSAGE,
  MAX_FEEDBACK_JSON_BYTES,
  REVIEW_CONFLICT_MESSAGE,
  MediaFeedbackRejection,
  cmsGetMediaReview,
  cmsListMediaComments,
  cmsMutateMediaComment,
  cmsSaveMediaReview,
  createCmsGetMediaReviewHandler,
  createCmsListMediaCommentsHandler,
  createCmsMutateMediaCommentHandler,
  createCmsSaveMediaReviewHandler,
  getMediaReview,
  listMentionStaff,
  mutateMediaComment,
  readCommentPage,
  resolveFeedbackTarget,
  reviewReference,
  saveMediaReview,
  verifiedCommentAuthorName,
};
