"use strict";

const { preparePublicReleaseProducerInTransaction, publicContentChange, publicReleaseProducerOperation } = require("./lib/public-release-producer");

const { bumpPublicContextRevision } = require("./lib/public-context-revision");
const { prepareDatasetUsageWrites } = require("./lib/dataset-usage");

const { contentVersion } = require("./lib/content-version");

// cmsBulkArchiveContent is the mutation half of the combined content library. The UI selects no
// more than the 25 records on its current server-selected page and echoes each summary's version.
// The submitted id/version pairs are the authorized caller's exact mutation intent;
// current-page membership is a bounded interaction rule, not an authorization property. Replaying
// the list query here would be a stale preflight (an unrelated reorder could move a selected row,
// and the page could change again before the independent transactions). content.delete and the
// per-record version checks are the authoritative boundaries. Every record is then archived in
// its own transaction: a stale row conflicts without touching that document, while unrelated
// current rows can still commit and report success. Each committed mutation includes its
// version-history snapshot and admin audit row atomically.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { ForbiddenError, requirePrincipal } = require("./lib/auth");
const { confirmationErrorCauses } = require("./lib/confirmation-error-causes");
const { principalFromStoredUserDoc } = require("./lib/principal");
const { hasCapability } = require("./lib/rbac");

async function requireContentDeletion(req) {
  const actor = await requirePrincipal(req);
  if (!hasCapability(actor.principal, "content.delete")) {
    throw new ForbiddenError("Content deletion access is required");
  }
  return actor;
}
const {
  AUDIT_COLLECTIONS,
  adminLogEntry,
  versionHistoryEntry,
} = require("./lib/audit");
const { CONTENT_LIBRARY_PAGE_SIZE, RECORD_KINDS } = require("./lib/content-library");
const { mediaUsageDocument } = require("./lib/media-usage");
const { enqueuePublishBuild } = require("./publish");
const { publishSecretBindings } = require("./lib/cms-publish-credentials");
const { routePurgeSecretNames } = require("./lib/post-route-purge");
const { addressedPublishChanges } = require("./lib/publish-build-state");
const {
  assertSerializerPublicationAdmissionInTransaction,
  CmsPublicationRuntimeControlError,
} = require("./lib/cms-publication-runtime-control");
const { buildFreeRefusalInTransaction } = require("./lib/build-free-refusal");
const { DISABLED_MESSAGE } = require("./lib/serializer-publication-control");
const { WITHDRAWAL_REPAIR_MESSAGE } = require("./lib/transitional-post-withdrawal");

const PUBLICATION_REFUSAL_CODES = new Set([
  "library_card_publication_replaced",
  "library_card_publication_unavailable",
  "library_publication_unavailable",
  "post_publication_unavailable",
  "record_publication_replaced",
  "record_publication_unavailable",
]);

class BulkArchivePublicationRefusal extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
  }
}

function archiveRefusalMessage(error) {
  if (error instanceof BulkArchivePublicationRefusal) return error.message;
  if (error?.code === "serializer_publication_unavailable") {
    if (error.message === WITHDRAWAL_REPAIR_MESSAGE) return WITHDRAWAL_REPAIR_MESSAGE;
    return error.message === DISABLED_MESSAGE ? DISABLED_MESSAGE : undefined;
  }
  if (error?.code === "serializer_publication_control_invalid") return "Publication control is unavailable. Try again later.";
  if (error instanceof CmsPublicationRuntimeControlError) {
    return error.message === "CMS publication is paused for a serializer handoff"
      ? error.message : "Publishing is unavailable. Try again later or ask an administrator.";
  }
  if (error?.status === 409 && PUBLICATION_REFUSAL_CODES.has(error.code) &&
      typeof error.message === "string" && error.message.length > 0 && error.message.length <= 1_000 &&
      !/[\r\n]/.test(error.message)) return error.message;
  return undefined;
}

function safeFailureCode(error) {
  if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16) return error.code;
  if (error instanceof BulkArchivePublicationRefusal) return "bulk_archive_publication_refusal";
  if (error instanceof CmsPublicationRuntimeControlError) return "cms_publication_runtime_control";
  if (["serializer_publication_control_invalid", "serializer_publication_unavailable"].includes(error?.code) ||
      PUBLICATION_REFUSAL_CODES.has(error?.code)) return error.code;
  return "unknown";
}

const MAX_RECORD_ID_BYTES = 1_500;
const OUTCOME_STATUSES = Object.freeze([
  "archived",
  "already_archived",
  "conflict",
  "missing",
  "failed",
]);

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBulkArchiveItems(items) {
  if (!Array.isArray(items)) return "items must be an array";
  if (items.length === 0) return "items must contain at least one record";
  if (items.length > CONTENT_LIBRARY_PAGE_SIZE) {
    return `items cannot contain more than ${CONTENT_LIBRARY_PAGE_SIZE} records`;
  }

  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isPlainObject(item)) return `items[${index}] must be an object`;
    if (
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      Buffer.byteLength(item.id, "utf8") > MAX_RECORD_ID_BYTES ||
      item.id !== item.id.trim() ||
      item.id.includes("/") ||
      item.id === "." ||
      item.id === ".." ||
      /^__.*__$/.test(item.id)
    ) {
      return `items[${index}].id must be a bounded Firestore document id`;
    }
    if (!Number.isSafeInteger(item.baseVersion) || item.baseVersion < 1) {
      return `items[${index}].baseVersion must be a positive safe integer`;
    }
    if (seen.has(item.id)) return `items contains duplicate record id ${item.id}`;
    seen.add(item.id);
  }
  return null;
}

function emptyCounts() {
  return Object.fromEntries(OUTCOME_STATUSES.map((status) => [status, 0]));
}

function createCmsBulkArchiveHandler(deps = {}) {
  const {
    firestore = db,
    requireAdminFn = requireContentDeletion,
    versionHistoryEntryFn = versionHistoryEntry,
    adminLogEntryFn = adminLogEntry,
    now = () => new Date().toISOString(),
    enqueuePublishBuildFn = enqueuePublishBuild,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requireAdminFn(req);
      const items = req.body?.items;
      const validationError = validateBulkArchiveItems(items);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const source = getClientIp(req);
      const outcomes = [];
      const withdrawals = [];
      const actorRef = firestore.collection("users").doc(user.uid);

      // Deliberately independent and sequential. Independent transactions preserve partial
      // success; the small page-sized bound keeps latency and Firestore pressure predictable.
      for (const item of items) {
        try {
          const outcome = await firestore.runTransaction(async (tx) => {
            const ref = firestore.collection("cmsPosts").doc(item.id);
            const [actorSnapshot, snapshot] = await Promise.all([
              tx.get(actorRef),
              tx.get(ref),
            ]);
            const actor = actorSnapshot.exists ? actorSnapshot.data() : null;
            if (
              !hasCapability(await principalFromStoredUserDoc(firestore, user.uid, actor, tx), "content.delete")
            ) {
              throw new ForbiddenError("Content deletion access is required");
            }
            if (!snapshot.exists) return { id: item.id, status: "missing" };

            const stored = snapshot.data();
            if (
              stored?.deleted === true ||
              !RECORD_KINDS.includes(stored?.type)
            ) {
              return { id: item.id, status: "missing" };
            }
            // The request version is already a positive safe integer. Make the corresponding
            // stored invariant explicit before either echoing or incrementing it, so a legacy or
            // malformed document can never put an invalid version into a typed outcome or write.
            if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
              return { id: item.id, status: "conflict" };
            }
            if (stored.status === "archived") {
              return {
                id: item.id,
                status: "already_archived",
                version: stored.version,
              };
            }
            if (stored.version !== item.baseVersion) {
              return { id: item.id, status: "conflict" };
            }

            const timestamp = now();
            const archived = {
              ...stored,
              status: "archived",
              publiclyVisible: false,
              updatedAt: timestamp,
              updatedBy: user.uid,
              version: stored.version + 1,
              contentVersion: contentVersion(stored),
            };
            let withdrawalVersion = Number.isSafeInteger(stored.published?.sourceVersion) &&
              stored.published.sourceVersion > 0 ? stored.published.sourceVersion : null;
            let publication;
            if (withdrawalVersion && stored.publiclyVisible === false) {
              // A retained snapshot is not evidence that it is still public.
              // Preserve a confirmed removal or the exact queue already doing it.
              if (!stored.publishBuildPending && stored.publicSourceVersion === null) {
                withdrawalVersion = null;
              } else if (typeof stored.publishBuildQueueId === "string" &&
                  stored.publishBuildQueueId && !stored.publishBuildQueueId.includes("/")) {
                const queue = await tx.get(firestore.collection("cmsPublishQueue").doc(stored.publishBuildQueueId));
                const active = queue.exists && ["reserved", "pending", "publishing"].includes(queue.data().status);
                const retainedRecord = ["program", "event"].includes(stored.type)
                  ? await require("./lib/no-build-record-publication").readRecordPublication({ firestore, transaction: tx,
                    operationId: stored.publishBuildQueueId, document: stored }) : null;
                const ownsRemoval = retainedRecord ? !retainedRecord.state.visible && retainedRecord.publication.status === "pending"
                  : active && addressedPublishChanges(queue.data().changes).some((change) =>
                    change.collection === "cmsPosts" && change.id === item.id &&
                    change.sourceVersion === withdrawalVersion && change.operation === "withdraw");
                if (ownsRemoval) {
                  publication = { status: "queued", queueId: stored.publishBuildQueueId };
                  withdrawalVersion = null;
                }
              }
            }
            if (withdrawalVersion) {
              archived.publishBuildPending = true;
              archived.publishBuildQueueId = null;
            }
            // Archiving ends a review, so the server-owned request envelope goes with it. The
            // spread above would otherwise carry a stale request onto the archived document, and
            // a later restore starts from `archived`, so no other path would ever clear it. The
            // version-history snapshot below still records the request that was open.
            if (stored.status === "in_review") delete archived.reviewRequest;

            const noBuildFallback = {};
            const cardPublication = await require("./lib/no-build-library-card-publication").prepareLibraryCardPublication({
              firestore, transaction: tx, collection: "cmsPosts", documentId: item.id,
              beforeDocument: stored, nextDocument: archived, action: "archive", actor: user });
            const noBuildPublication = withdrawalVersion ? await require("./lib/no-build-content-publication").prepareNoBuildContentPublication({
              firestore, transaction: tx, collection: "cmsPosts", documentId: item.id,
              nextDocument: archived, queueRef: firestore.collection("cmsPublishQueue").doc(),
              actor: user, source, config: deps.noBuildConfig, fallback: noBuildFallback,
            }) : null;
            // Keep legacy admission per item; cloud Post preparation checks its own runtime.
            if (withdrawalVersion && noBuildPublication?.requiresPrimaryAdmission !== false) {
              const refusal = await buildFreeRefusalInTransaction({ firestore, transaction: tx, collection: "cmsPosts",
                document: archived, fallbackReason: noBuildFallback.reason, withdrawal: true });
              if (refusal) throw new BulkArchivePublicationRefusal(refusal);
              await assertSerializerPublicationAdmissionInTransaction({ firestore, transaction: tx });
            }
            const writeDatasetUsage = await prepareDatasetUsageWrites({ firestore, transaction: tx,
              collection: "cmsPosts", documentId: item.id, snapshot: archived.published,
              previousSnapshot: stored.published, visible: false });
            const writeReleaseChange = !cardPublication && !noBuildPublication && withdrawalVersion
              ? await preparePublicReleaseProducerInTransaction({ firestore, transaction: tx,
                  operationId: publicReleaseProducerOperation("cmsPosts", item.id, archived.version, { action: "archive", snapshot: stored.published }),
                  changes: [publicContentChange("cmsPosts", item.id, stored, false)] }) : () => {};
            writeReleaseChange();
            if (cardPublication) {
              publication = cardPublication.publication;
              cardPublication.write();
            } else if (noBuildPublication) {
              archived.publishBuildQueueId = noBuildPublication.contentQueueId;
              publication = { status: "queued", queueId: noBuildPublication.queueId, transport: noBuildPublication.transport,
                affectedHomeSections: noBuildPublication.affectedHomeSections, warnings: noBuildPublication.warnings,
                homeFullBuildQueueId: noBuildPublication.homeFullBuildQueueId };
              noBuildPublication.write();
            } else if (withdrawalVersion) bumpPublicContextRevision(tx, firestore, { withdrawal: true });
            writeDatasetUsage();
            tx.set(ref, archived);
            tx.set(
              firestore
                .collection(`cmsPosts/${item.id}/mediaUsage`)
                .doc("published"),
              mediaUsageDocument({
                state: "published",
                sourceVersion: archived.version,
                usage: { assetIds: [], occurrenceCount: 0 },
              }),
            );
            tx.set(
              firestore.collection(AUDIT_COLLECTIONS.versionHistory).doc(),
              versionHistoryEntryFn({
                collection: "cmsPosts",
                documentId: item.id,
                action: "archive",
                before: stored,
                after: archived,
                actorUid: user.uid,
                actorEmail: user.email ?? null,
                source,
              }),
            );
            tx.set(
              firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
              adminLogEntryFn({
                actorUid: user.uid,
                actorEmail: user.email ?? null,
                action: "cms.bulk_archive",
                target: `cmsPosts/${item.id}`,
                before: { status: stored.status ?? null, version: stored.version },
                after: { status: "archived", version: archived.version },
                source,
              }),
            );

            return { id: item.id, status: "archived", version: archived.version, withdrawalVersion: noBuildPublication ? null : withdrawalVersion,
              ...(publication ? { publication } : {}) };
          });
          const { withdrawalVersion, ...publicOutcome } = outcome;
          if (publicOutcome.publication?.homeFullBuildQueueId) {
            try { await require("./lib/transitional-post-withdrawal").enqueuePostWithdrawalBuild({ firestore, operationId: publicOutcome.publication.queueId }); }
            catch {
              log.error("Post bulk withdrawal full build could not start");
              publicOutcome.publication = { ...publicOutcome.publication, status: "failed",
                queueId: publicOutcome.publication.homeFullBuildQueueId };
            }
          }
          outcomes.push(publicOutcome);
          if (withdrawalVersion) withdrawals.push({
            collection: "cmsPosts", id: item.id, sourceVersion: withdrawalVersion, operation: "withdraw",
          });
        } catch (error) {
          const message = archiveRefusalMessage(error);
          log.error("cmsBulkArchiveContent item failed", {
            recordId: item.id,
            code: safeFailureCode(error),
            causes: confirmationErrorCauses(error),
          });
          outcomes.push({ id: item.id, status: "failed", ...(message ? { message } : {}) });
        }
      }

      if (withdrawals.length) {
        let publication;
        try {
          const queued = await enqueuePublishBuildFn({ actor: user, changes: withdrawals, source }, { ...deps, firestore });
          publication = { status: "queued", queueId: queued.queueId };
        } catch (error) {
          log.error("Bulk public withdrawal was not queued", error);
          publication = { status: "failed", queueId: null };
        }
        for (const outcome of outcomes) {
          if (withdrawals.some((change) => change.id === outcome.id)) outcome.publication = publication;
        }
      }

      const counts = emptyCounts();
      for (const outcome of outcomes) counts[outcome.status] += 1;
      res.status(200).json({ success: true, outcomes, counts });
    } catch (error) {
      if (res.headersSent) return;
      const status =
        error?.status || (error?.code === "failed-precondition" ? 503 : 500);
      if (status >= 500) log.error("cmsBulkArchiveContent failed", error);
      res.status(status).json({ error: error?.message || "Failed to archive content" });
    }
  };
}

const cmsBulkArchiveContent = cmsOnRequest(
  { cors: true, secrets: [...publishSecretBindings, ...routePurgeSecretNames()] },
  createCmsBulkArchiveHandler(),
);

module.exports = {
  MAX_RECORD_ID_BYTES,
  OUTCOME_STATUSES,
  cmsBulkArchiveContent,
  createCmsBulkArchiveHandler,
  validateBulkArchiveItems,
};
