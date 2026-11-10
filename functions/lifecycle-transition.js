"use strict";

const { randomUUID } = require("node:crypto");
const { curatedLifecycleFailureMessage, lifecycleErrorDiagnostic } = require("./lib/lifecycle-error");

const { publishedBlockResourceError } = require("./lib/published-resource-check");

const { preparePublicReleaseProducerInTransaction, publicContentChange, publicReleaseProducerOperation } = require("./lib/public-release-producer");

const { prepareDatasetUsageWrites } = require("./lib/dataset-usage");
const { prepareNoBuildContentPublication } = require("./lib/no-build-content-publication");
const { bumpPublicContextRevision } = require("./lib/public-context-revision");
const { readFrozenLibraryPublicationMessage } = require("./lib/frozen-library-publication");
const { isLibraryCard, operationIdFor, readLibraryCardPublication, prepareLibraryCardPublication,
  prepareLibraryCardRetry } = require("./lib/no-build-library-card-publication");
const { readSerializerPublicationControlInTransaction } = require("./lib/serializer-publication-control");
const { buildFreeRefusalInTransaction } = require("./lib/build-free-refusal");

const { contentVersion } = require("./lib/content-version");
const { approveElectionResults } = require("./lib/election-results-approval");
const { visibleLayoutBlocks } = require("./lib/content-layout");
const { registeredPrincipalFromUserDoc } = require("./lib/principal");
const { userDocUsesAccessTier } = require("./lib/access-tier-activation");

// Editorial workflow actions are not content edits. This boundary changes only
// the trusted lifecycle envelope. It checks the exact document version and
// resource-scoped capability, then commits the document, immutable version
// history, and compact compliance receipt in one transaction.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { automationWriteRefusal, readAutomationAccount } = require("./lib/automation-accounts");
const {
  AUDIT_COLLECTIONS,
  adminLogEntry,
  versionHistoryEntry,
} = require("./lib/audit");
const {
  MAX_DOCUMENT_BYTES,
  documentSizeError,
  firestoreDocumentBytes,
} = require("./lib/document-size");
const { parseBlocks } = require("./lib/content-blocks");
const { validateContentFieldValues } = require("./lib/content-document-contract");
const { validateSection } = require("./lib/editor-section-contract");
const { blockContentError } = require("./lib/block-content-validation");
const {
  normalizeLegacyPostDate,
  validateKnownMetadata,
} = require("./lib/content-metadata");
const {
  RECORD_KINDS,
  retiredRecordKindError,
} = require("./lib/content-library");
const { can, canEditContent, hasCapability } = require("./lib/rbac");
const { contentResource, isUnassignedPostDraft } = require("./lib/content-authorization");
const { editorTemplateForPage } = require("./lib/public-page-contract");
const { collectWorkingMediaUsage, mediaUsageDocument } = require("./lib/media-usage");
const { mediaReplacementRef } = require("./lib/media-replacement");
const { postPresentationError } = require("./lib/post-formats");
const { createReviewRequest, advanceReviewRequest } = require("./lib/review-queue");
const { enqueuePublishBuild } = require("./publish");
const { publishSecretBindings } = require("./lib/cms-publish-credentials");
const { routePurgeSecretNames } = require("./lib/post-route-purge");
const { addressedPublishChanges } = require("./lib/publish-build-state");
const {
  assertSerializerPublicationAdmissionInTransaction,
} = require("./lib/cms-publication-runtime-control");

const TRANSITION_COLLECTIONS = new Set(["cmsPages", "cmsPosts"]);
const MAX_DOCUMENT_ID_BYTES = 1_500;
const FORBIDDEN_MESSAGE =
  "You do not have permission to change this record's lifecycle.";
const NOT_FOUND_MESSAGE = "This content record is no longer available.";
const CONFLICT_MESSAGE =
  "This document changed since you opened it. Reload before changing its lifecycle.";
const MAX_COMMENT_BYTES = 4_000;

// This is the deployed mirror of the admitted edges and capabilities in
// site/src/lib/editorial-workflow.ts. Keep the actions finite and own-key
// checked because the request body is untrusted runtime data.
const LIFECYCLE_TRANSITIONS = Object.freeze({
  edit: Object.freeze({
    from: Object.freeze(["in_review", "approved", "scheduled", "published"]),
    to: "draft",
    authorization: "edit",
  }),
  submit: Object.freeze({
    from: "draft",
    to: "in_review",
    authorization: "edit",
  }),
  sendBack: Object.freeze({
    from: "in_review",
    to: "draft",
    capability: "content.edit.any",
    requiresComment: true,
  }),
  approve: Object.freeze({
    from: "in_review",
    to: "approved",
    capability: "content.edit.any",
  }),
  reopen: Object.freeze({
    from: "approved",
    to: "draft",
    capability: "content.edit.any",
  }),
  revise: Object.freeze({
    from: "published",
    to: "draft",
    capability: "content.edit.any",
  }),
  unschedule: Object.freeze({
    from: "scheduled",
    to: "draft",
    capability: "content.publish",
  }),
  unpublish: Object.freeze({
    from: "published",
    to: "draft",
    capability: "content.unpublish",
  }),
  archive: Object.freeze({
    from: Object.freeze(["draft", "in_review", "approved", "scheduled", "published"]),
    to: "archived",
    capability: "content.delete",
  }),
  restore: Object.freeze({
    from: "archived",
    to: "draft",
    capability: "content.delete",
  }),
});

class LifecycleTransitionRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "LifecycleTransitionRejection";
    this.status = status;
  }
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedDocumentId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_DOCUMENT_ID_BYTES &&
    value === value.trim() &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  );
}

function validateTransitionRequest(body) {
  if (!isPlainObject(body) || !TRANSITION_COLLECTIONS.has(body.collection)) {
    return "collection must be cmsPages or cmsPosts";
  }
  if (!isBoundedDocumentId(body.id)) {
    return "id must be a bounded Firestore document id";
  }
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1) {
    return "baseVersion must be a positive safe integer";
  }
  if (!Object.hasOwn(LIFECYCLE_TRANSITIONS, body.action)) {
    return "action must be an admitted lifecycle action";
  }
  if (LIFECYCLE_TRANSITIONS[body.action].requiresComment) {
    if (typeof body.comment !== "string" || body.comment.trim().length === 0) {
      return "comment is required when content is sent back";
    }
    if (Buffer.byteLength(body.comment.trim(), "utf8") > MAX_COMMENT_BYTES) {
      return `comment must be no more than ${MAX_COMMENT_BYTES} bytes`;
    }
  }
  return null;
}

function authorizationLabel(transition) {
  return transition.authorization === "edit"
    ? "content.edit.any or content.edit.own"
    : transition.capability;
}

function mayAttemptTransition(principal, transition) {
  if (transition.authorization === "edit") {
    return (
      hasCapability(principal, "content.edit.any") ||
      hasCapability(principal, "content.edit.own")
    );
  }
  return hasCapability(principal, transition.capability);
}

function canTransition(principal, transition, resource) {
  if (resource.homePage === true && !can(principal, "content.edit.any", resource)) return false;
  return transition.authorization === "edit"
    ? canEditContent(principal, resource)
    : can(principal, transition.capability, resource);
}

function acceptsStatus(transition, status) {
  return Array.isArray(transition.from)
    ? transition.from.includes(status)
    : transition.from === status;
}

function requiredStatusLabel(transition) {
  return Array.isArray(transition.from)
    ? transition.from.join(", ")
    : transition.from;
}

// The desk resolution here matches every other content boundary (#845): a canonical
// page's server-owned public area answers first, so a page stored before the registry
// landed is still scoped by the area it belongs to rather than staying unreachable to
// a scoped grant until someone saves it. A record keeps its stored desk, and a
// document with no desk at all confers nothing on a scoped grant.
function resourceFor(collection, id, document) {
  return contentResource({ collection, documentId: id, stored: document });
}

function isEligibleTarget(collection, id, document) {
  if (!document || document.deleted === true) return false;
  if (collection === "cmsPages") {
    return editorTemplateForPage(id) !== null;
  }
  return RECORD_KINDS.includes(document.type);
}

function approvalError(collection, id, document, {
  parseBlocksFn = parseBlocks,
  validateSectionFn = validateSection,
} = {}) {
  const publishableDocument =
    collection === "cmsPosts" ? normalizeLegacyPostDate(document) : document;
  const kind = collection === "cmsPages" ? "page" : publishableDocument.type;
  const fieldError = validateContentFieldValues(collection, kind, publishableDocument, {
    complete: true,
    validateTypes: true,
  });
  if (fieldError) return fieldError;

  const metadataError = validateKnownMetadata(publishableDocument, {
    descriptionIsString: collection === "cmsPages",
  });
  if (metadataError) return metadataError;

  const section = collection === "cmsPages"
    ? editorTemplateForPage(id)
    : kind === "post"
      ? "post"
      : null;
  if (section === null) return null;
  const parsed = parseBlocksFn(publishableDocument.blocks, { pageId: collection === "cmsPages" ? id : undefined });
  if (!parsed.ok) return parsed.error;
  const resourceError = publishedBlockResourceError(parsed.blocks, collection === "cmsPages" ? `/${id}/` : "/posts/");
  if (resourceError) return resourceError;
  const contentError = blockContentError(parsed.blocks);
  if (contentError) return contentError;
  if (kind === "post") {
    const presentationError = postPresentationError({
      tags: publishableDocument.tags,
      blocks: parsed.blocks,
      heroImage: publishableDocument.heroImage,
      leadMedia: publishableDocument.leadMedia,
    });
    if (presentationError) return presentationError;
  }
  const sectionError = validateSectionFn(section, parsed.blocks);
  return sectionError?.reason ?? null;
}

function boundedHistoryEntry({
  collection,
  id,
  action,
  before,
  after,
  actor,
  source,
  historyPath,
  versionHistoryEntryFn,
  comment,
}) {
  const documentPath = `${collection}/${id}`;
  const afterBytes = firestoreDocumentBytes(after, documentPath);
  if (afterBytes > MAX_DOCUMENT_BYTES) {
    throw new LifecycleTransitionRejection(
      413,
      "This record is too large for a safe lifecycle change. Shorten it before trying again.",
    );
  }

  let entry = versionHistoryEntryFn({
    collection,
    documentId: id,
    action,
    before,
    after,
    actorUid: actor.uid,
    actorEmail: actor.email ?? null,
    source,
  });
  if (comment) entry = { ...entry, comment };
  if (!documentSizeError(entry, historyPath, {
    label: `the version-history row for this ${action}`,
  })) {
    return entry;
  }

  const beforeBytes = firestoreDocumentBytes(before, documentPath);
  const beforeReceipt = {
    ...(before.id === undefined ? {} : { id: before.id }),
    ...(before.status === undefined ? {} : { status: before.status }),
    ...(before.version === undefined ? {} : { version: before.version }),
    beforeTruncated: true,
    beforeEstimatedBytes: beforeBytes,
  };
  entry = {
    ...versionHistoryEntryFn({
      collection,
      documentId: id,
      action,
      before: beforeReceipt,
      after,
      actorUid: actor.uid,
      actorEmail: actor.email ?? null,
      source,
    }),
    ...(comment ? { comment } : {}),
    beforeTruncated: true,
    beforeEstimatedBytes: beforeBytes,
  };
  if (firestoreDocumentBytes(entry, historyPath) > MAX_DOCUMENT_BYTES) {
    throw new LifecycleTransitionRejection(
      413,
      "This record is too large for a safe lifecycle change. Shorten it before trying again.",
    );
  }
  return entry;
}

function createCmsTransitionContentHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    versionHistoryEntryFn = versionHistoryEntry,
    adminLogEntryFn = adminLogEntry,
    now = () => new Date().toISOString(),
    parseBlocksFn = parseBlocks,
    validateSectionFn = validateSection,
    enqueuePublishBuildFn = enqueuePublishBuild,
    log = logger,
    readAutomationAccountFn = (uid) => readAutomationAccount(firestore, uid),
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requirePrincipalFn(req);
      const validationError = validateTransitionRequest(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const { collection, id, baseVersion, action } = req.body;
      const transition = LIFECYCLE_TRANSITIONS[action];
      if (!mayAttemptTransition(user.principal, transition)) {
        log.warn("cmsTransitionContent denied", {
          uid: user.uid,
          action,
          reason: `principal holds no ${authorizationLabel(transition)} capability`,
        });
        res.status(403).json({ error: FORBIDDEN_MESSAGE });
        return;
      }

      const source = getClientIp(req);
      const automationAccount = await readAutomationAccountFn(user.uid);
      const result = await firestore.runTransaction(async (tx) => {
        const ref = firestore.collection(collection).doc(id);
        const snapshot = await tx.get(ref);
        const current = snapshot.exists ? snapshot.data() : null;

        // A missing target has no section or owner. Only site-wide authority may
        // receive the useful 404; a scoped grant receives the same 403 it would
        // receive for an out-of-scope stored record.
        if (!current) {
          if (!canTransition(user.principal, transition, {})) {
            throw new LifecycleTransitionRejection(403, FORBIDDEN_MESSAGE);
          }
          throw new LifecycleTransitionRejection(404, NOT_FOUND_MESSAGE);
        }

        const resource = resourceFor(collection, id, current);
        if (!canTransition(user.principal, transition, resource)) {
          log.warn("cmsTransitionContent denied", {
            uid: user.uid,
            collection,
            documentId: id,
            action,
            reason: `resource is outside ${authorizationLabel(transition)} authority`,
          });
          throw new LifecycleTransitionRejection(403, FORBIDDEN_MESSAGE);
        }
        const automationRefusal = await automationWriteRefusal(tx, firestore, {
          automationAccount, uid: user.uid, collection, documentId: id, echoesVersion: true,
        });
        if (automationRefusal) {
          throw Object.assign(new LifecycleTransitionRejection(automationRefusal.status, automationRefusal.message),
            automationRefusal.details);
        }
        if (!isEligibleTarget(collection, id, current)) {
          throw new LifecycleTransitionRejection(404, NOT_FOUND_MESSAGE);
        }
        // A retired kind (#1039) is still a legible library row, so it is still an
        // eligible target -- but the only lifecycle move it accepts is out of
        // circulation. Refusing here rather than at the approval gate is what makes
        // that true for every action: submit, send back, approve, reopen, revise,
        // unschedule, unpublish, and restore all write the record, and restoring an
        // archived article would put a type nothing can edit or publish back into
        // the draft workflow.
        const retiredKindError =
          action === "archive"
            ? null
            : retiredRecordKindError(current.type, "archived");
        if (retiredKindError) {
          throw new LifecycleTransitionRejection(400, retiredKindError);
        }
        if (!Number.isSafeInteger(current.version) || current.version < 1) {
          throw new LifecycleTransitionRejection(
            409,
            "This record has no current version. Save it before changing its lifecycle.",
          );
        }
        const card = collection === "cmsPosts" && isLibraryCard(current);
        if (card && action === "approve" && !can(user.principal, "content.publish", resource)) {
          throw new LifecycleTransitionRejection(403, FORBIDDEN_MESSAGE);
        }
        if (card && ["approve", "unpublish", "archive"].includes(action)) {
          // An exact lost-response request or explicit retry resumes its accepted
          // card operation. It never approves a later private draft.
          for (const version of [baseVersion + 1, baseVersion]) {
            const accepted = await readLibraryCardPublication({ firestore, transaction: tx,
              operationId: operationIdFor(id, version, action), document: current });
            if (!accepted) continue;
            const retry = await prepareLibraryCardRetry({ firestore, transaction: tx, accepted });
            retry.write();
            return { before: current, after: current, withdrawal: false, publication: retry.publication };
          }
        }
        const pairRequest = ["unpublish", "archive"].includes(action)
          ? await require("./lib/public-release-publication-request").preparePairPublicationRequestInTransaction({
            firestore, transaction: tx, endpoint: "transition", actorUid: user.uid, body: req.body, collection, documentId: id }) : null;
        if (pairRequest?.replay) return { before: pairRequest.replay.before, after: pairRequest.replay.after,
          ...pairRequest.replay.metadata, withdrawal: false };
        if (current.version !== baseVersion) {
          throw new LifecycleTransitionRejection(409, CONFLICT_MESSAGE);
        }
        // The working stage and admitted public snapshot are independent. A
        // newer draft can still need its older public version withdrawn.
        const withdrawingSnapshot = action === "unpublish" && (current.publiclyVisible === true || card) &&
          ["draft", "in_review", "approved", "scheduled"].includes(current.status);
        if (!acceptsStatus(transition, current.status) && !withdrawingSnapshot) {
          const requiredStatus = requiredStatusLabel(transition);
          throw new LifecycleTransitionRejection(
            409,
            `This action requires ${requiredStatus} content. Reload to see its current status.`,
          );
        }

        if (isUnassignedPostDraft(current) && action !== "archive") {
          throw new LifecycleTransitionRejection(400, "Choose a section before moving this draft toward publication.");
        }
        if (action === "approve" && !card) {
          const frozenMessage = await readFrozenLibraryPublicationMessage({ firestore, transaction: tx, collection, documentId: id, document: current });
          if (frozenMessage) throw new LifecycleTransitionRejection(409, frozenMessage);
        }
        if (action === "submit" || action === "approve") {
          const error = approvalError(collection, id, current, {
            parseBlocksFn,
            validateSectionFn,
          });
          if (error) throw new LifecycleTransitionRejection(400, error);
        }
        if (action === "approve") {
          // Approval must not strand an in-flight replacement or approve bytes
          // that are about to change. The claim read serializes with replacement.
          const usage = collectWorkingMediaUsage({ collection, documentId: id, document: current });
          for (const assetId of usage.assetIds) {
            const replacement = await tx.get(mediaReplacementRef(firestore, assetId));
            if (replacement.exists) {
              throw new LifecycleTransitionRejection(409,
                "An image replacement is in progress. Wait for it to finish, then review the image before approving.");
            }
          }
        }

        const timestamp = now();
        let electionResultsApprovals;
        if (action === "approve" && visibleLayoutBlocks(current.blocks ?? []).some(block => block.type === "election_results")) {
          const profile = (await tx.get(firestore.doc(`users/${user.uid}`))).data();
          const tiersActive = await userDocUsesAccessTier(firestore, profile, tx);
          const freshPrincipal = await registeredPrincipalFromUserDoc(firestore, user.uid, profile, tx, tiersActive);
          if (!profile || profile.active === false || tiersActive && user.emailVerified !== true ||
              !canTransition(freshPrincipal, transition, resource)) {
            throw new LifecycleTransitionRejection(403, FORBIDDEN_MESSAGE);
          }
          const displayName = typeof profile.displayName === "string" && profile.displayName.trim()
            ? profile.displayName.trim().slice(0, 120) : "Editor";
          electionResultsApprovals = approveElectionResults(current, { uid: user.uid, displayName }, timestamp);
        }
        const comment = transition.requiresComment ? req.body.comment.trim() : undefined;
        const changed = {
          ...current,
          status: withdrawingSnapshot
            ? (card || current.status === "scheduled" ? "draft" : current.status)
            : transition.to,
          updatedAt: timestamp,
          updatedBy: user.uid,
          version: current.version + 1,
          contentVersion: contentVersion(current),
          ...(electionResultsApprovals ? { electionResultsApprovals } : {}),
        };
        if (action === "submit") {
          // The review request lands in the same transaction and on the same
          // authoritative document as the lifecycle change. There is no
          // independently writable queue row that can succeed or fail apart.
          changed.reviewRequest = createReviewRequest({
            collection,
            id,
            sourceVersion: changed.version,
            requestedBy: user.uid,
            requestedAt: timestamp,
          });
        } else if (current.status === "in_review" && changed.status !== "in_review") {
          delete changed.reviewRequest;
        } else if (changed.status === "in_review") {
          const request = advanceReviewRequest(current.reviewRequest, {
            collection, id, sourceVersion: changed.version,
          });
          if (request) changed.reviewRequest = request;
        }
        if (["unschedule", "edit", "unpublish", "archive"].includes(action)) {
          delete changed.publishAt;
        }
        if (changed.status !== "scheduled") delete changed.scheduledPublicationTransport;
        // Cancelling or reopening content supersedes any recorded
        // scheduled-publish failure, so clear it on the changed document.
        if (["unschedule", "reopen", "edit", "unpublish", "archive"].includes(action)) {
          delete changed.scheduledPublishFailure;
        }
        if (
          action === "revise" ||
          (action === "edit" &&
            (current.publiclyVisible === true ||
              (current.publiclyVisible === undefined &&
                current.status === "published")))
        ) {
          changed.publiclyVisible = true;
        }
        if (["unpublish", "archive", "restore"].includes(action)) {
          changed.publiclyVisible = false;
        }
        if (card && action === "approve") changed.publiclyVisible = true;
        const cardPublication = card ? await prepareLibraryCardPublication({ firestore, transaction: tx, collection,
          documentId: id, beforeDocument: current, nextDocument: changed, action, actor: user }) : null;
        let withdrawal = ["unpublish", "archive"].includes(action) &&
          Number.isSafeInteger(current.published?.sourceVersion) && current.published.sourceVersion > 0;
        let publication = cardPublication?.publication ?? null;
        if (withdrawal && current.publiclyVisible === false) {
          // A retained snapshot can already be removed or have a withdrawal in flight.
          if (!current.publishBuildPending && current.publicSourceVersion === null) {
            withdrawal = false;
          } else if (typeof current.publishBuildQueueId === "string" &&
              current.publishBuildQueueId && !current.publishBuildQueueId.includes("/")) {
            const queue = await tx.get(firestore.collection("cmsPublishQueue").doc(current.publishBuildQueueId));
            const active = queue.exists && ["reserved", "pending", "publishing"].includes(queue.data().status);
            const pairRemoval = pairRequest && queue.data()?.transport === "release-pair-publication-v2"
              ? await require("./lib/public-release-publication-request").readPendingPairWithdrawalInTransaction({ firestore, transaction: tx,
                operationId: current.publishBuildQueueId, collection, documentId: id, sourceVersion: current.published.sourceVersion,
                sourceKind: collection === "cmsPages" ? "page" : ["program", "event"].includes(current.type) ? "record" : "post" }) : null;
            const retainedRecord = queue.data()?.transport !== "release-pair-publication-v2" && collection === "cmsPosts" && ["program", "event"].includes(current.type)
              ? await require("./lib/no-build-record-publication").readRecordPublication({ firestore, transaction: tx,
                operationId: current.publishBuildQueueId, document: current }) : null;
            const ownsRemoval = pairRemoval || (retainedRecord ? !retainedRecord.state.visible && retainedRecord.publication.status === "pending"
              : active && addressedPublishChanges(queue.data().changes).some((change) =>
                change.collection === collection && change.id === id &&
                change.sourceVersion === current.published.sourceVersion && change.operation === "withdraw"));
            if (ownsRemoval) {
              publication = { status: "queued", queueId: current.publishBuildQueueId,
                ...(pairRemoval ? { transport: "release-pair-publication-v2" } : {}) };
              withdrawal = false;
            }
          }
        }
        if (withdrawal && collection === "cmsPosts" && !(pairRequest && ["program", "event"].includes(current.type))) {
          // Once the full build is disabled, a frozen kind has no removal path.
          const frozenMessage = await readFrozenLibraryPublicationMessage({ firestore, transaction: tx, collection, documentId: id, document: current, withdrawal: true });
          if (frozenMessage && !(await readSerializerPublicationControlInTransaction({ firestore, transaction: tx })).enabled) {
            throw new LifecycleTransitionRejection(409, frozenMessage);
          }
        }
        const noBuildFallback = {};
        const pageWithdrawal = withdrawal && collection === "cmsPages" && !pairRequest ? await require("./lib/no-build-page-publication").prepareNoBuildPagePublication({
          firestore, transaction: tx, collection, documentId: id, nextDocument: changed,
          queueRef: firestore.collection("cmsPublishQueue").doc(), actor: user, source, config: deps.noBuildConfig,
        }) : null;
        if (withdrawal) {
          changed.publishBuildPending = true;
          changed.publishBuildQueueId = null;
        }
        const noBuildPublication = pageWithdrawal ?? (withdrawal ? await prepareNoBuildContentPublication({
          firestore, transaction: tx, collection, documentId: id, nextDocument: changed,
          queueRef: pairRequest?.queueRef ?? firestore.collection("cmsPublishQueue").doc(), actor: user, source,
          config: deps.noBuildConfig, fallback: noBuildFallback,
        }) : null);
        if (withdrawal && !pageWithdrawal && noBuildPublication?.requiresPrimaryAdmission !== false) {
          const refusal = await buildFreeRefusalInTransaction({ firestore, transaction: tx, collection,
            document: changed, fallbackReason: noBuildFallback.reason, withdrawal: true });
          if (refusal) throw new LifecycleTransitionRejection(409, refusal);
          await assertSerializerPublicationAdmissionInTransaction({ firestore, transaction: tx });
        }
        if (noBuildPublication) {
          changed.publishBuildQueueId = noBuildPublication.contentQueueId;
          publication = { status: "queued", queueId: noBuildPublication.queueId, transport: noBuildPublication.transport,
            affectedHomeSections: noBuildPublication.affectedHomeSections, warnings: noBuildPublication.warnings,
            homeFullBuildQueueId: noBuildPublication.homeFullBuildQueueId };
        }
        const historyRef = firestore
          .collection(AUDIT_COLLECTIONS.versionHistory)
          .doc();
        const historyEntry = boundedHistoryEntry({
          collection,
          id,
          action,
          before: current,
          after: changed,
          actor: user,
          source,
          historyPath: historyRef.path,
          versionHistoryEntryFn,
          comment,
        });
        const clearsPublishedUsage = ["unpublish", "archive"].includes(action);
        const publishedUsageRef = clearsPublishedUsage || card && action === "approve"
          ? firestore
              .collection(`${collection}/${id}/mediaUsage`)
              .doc("published")
          : null;

        const datasetUsageWrite = withdrawal ? await prepareDatasetUsageWrites({ firestore, transaction: tx,
          collection, documentId: id, snapshot: current.published, previousSnapshot: current.published, visible: false }) : () => {};
        const writeReleaseChange = !cardPublication && !noBuildPublication && withdrawal
          ? await preparePublicReleaseProducerInTransaction({ firestore, transaction: tx,
              operationId: publicReleaseProducerOperation(collection, id, changed.version, { action, snapshot: current.published }),
              changes: [publicContentChange(collection, id, current, false)] }) : () => {};
        writeReleaseChange();
        if (cardPublication) cardPublication.write();
        else if (noBuildPublication) noBuildPublication.write();
        else if (withdrawal) bumpPublicContextRevision(tx, firestore, { withdrawal: true });
        datasetUsageWrite();
        tx.set(ref, changed);
        if (publishedUsageRef) {
          tx.set(
            publishedUsageRef,
            mediaUsageDocument({
              state: "published",
              sourceVersion: changed.version,
              usage: clearsPublishedUsage ? { assetIds: [], occurrenceCount: 0 }
                : collectWorkingMediaUsage({ collection, documentId: id, document: changed }),
            }),
          );
        }
        tx.set(historyRef, historyEntry);
        tx.set(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          adminLogEntryFn({
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            action: `cms.${action}`,
            target: `${collection}/${id}`,
            before: { status: current.status, version: current.version },
            after: {
              status: changed.status,
              version: changed.version,
              ...(changed.reviewRequest
                ? { requestId: changed.reviewRequest.requestId }
                : {}),
              ...(comment ? { comment } : {}),
            },
            source,
          }),
        );
        if (noBuildPublication?.transport === "release-pair-publication-v2") {
          if (!pairRequest || noBuildPublication.queueId !== pairRequest.operationId) throw new LifecycleTransitionRejection(409, "Publication request identity changed.");
          pairRequest.write({ historyRef, version: changed.version, metadata: { publication } });
        }
        return { before: current, after: changed, withdrawal: withdrawal && !noBuildPublication, publication };
      });

      let publication = result.publication;
      if (publication?.homeFullBuildQueueId) {
        try { await require("./lib/transitional-post-withdrawal").enqueuePostWithdrawalBuild({ firestore, operationId: publication.queueId }); }
        catch {
          log.error("Post withdrawal full build could not start");
          publication = { ...publication, status: "failed", queueId: publication.homeFullBuildQueueId };
        }
      }
      if (result.withdrawal) {
        try {
          const queued = await enqueuePublishBuildFn({
            actor: user,
            changes: [{ collection, id, sourceVersion: result.before.published.sourceVersion, operation: "withdraw" }],
            source,
          }, { ...deps, firestore });
          publication = { status: "queued", queueId: queued.queueId };
          result.after.publishBuildQueueId = queued.queueId;
        } catch (error) {
          // Withdrawal is already stored. Keep it pending and report that fact;
          // retrying publication must not need to undo and repeat Unpublish.
          const errorId = randomUUID();
          log.error("Public withdrawal was not queued", { errorId, ...lifecycleErrorDiagnostic(error) });
          publication = { status: "failed", queueId: null, errorId };
        }
      }
      res.status(200).json({
        success: true,
        collection,
        id,
        action,
        fromStatus: result.before.status,
        toStatus: result.after.status,
        version: result.after.version,
        ...(action === "submit"
          ? { reviewRequest: result.after.reviewRequest }
          : {}),
        document: result.after,
        ...(publication ? { publication } : {}),
      });
    } catch (error) {
      if (res.headersSent) return;
      const status =
        error?.status || (error?.code === "failed-precondition" ? 503 : 500);
      const expected = Number.isInteger(error?.status) && status >= 400 && status < 500;
      const errorId = expected ? null : randomUUID();
      if (errorId) {
        log.error("cmsTransitionContent failed", {
          errorId, status: Number.isInteger(status) ? status : null, ...lifecycleErrorDiagnostic(error),
        });
      }
      res.status(status).json({
        error: expected ? error.message :
          curatedLifecycleFailureMessage(error, status) ?? "The lifecycle change could not be completed.",
        ...(errorId ? { errorId } : {}),
        ...(error?.lockRequired === true ? { lockRequired: true } : {}),
      });
    }
  };
}

const cmsTransitionContent = cmsOnRequest(
  { cors: true, invoker: "public", secrets: [...publishSecretBindings, ...routePurgeSecretNames()] },
  createCmsTransitionContentHandler(),
);

module.exports = {
  CONFLICT_MESSAGE,
  FORBIDDEN_MESSAGE,
  LIFECYCLE_TRANSITIONS,
  LifecycleTransitionRejection,
  cmsTransitionContent,
  createCmsTransitionContentHandler,
  validateTransitionRequest,
};
