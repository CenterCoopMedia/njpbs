"use strict";

// cmsGetContent: the capability-authorized read boundary for a single CMS record
// (#536), the read-side companion to cmsSaveContent's write boundary (#529).
//
// The editor hydrates a page by reading its stored composition before editing,
// because a save sends the whole block list and a save from a blank editor would
// overwrite the live page (#515). Browser reads of cmsPages and cmsPosts are
// denied by Firestore rules; this endpoint owns that read and resolves it through
// the same capability decision core as the write, so the two cannot drift apart.
//
// It follows cmsListContent's shape (the library's server-owned read boundary)
// rather than inventing a second one: POST, the createXHandler(deps = {})
// dependency-injection factory, and failed-precondition -> 503 mapping. Like
// cmsListContent, it resolves a principal and asks the capability core.
//
// Three things it deliberately does not do:
//
//   - No audit row. A read changes nothing, and the audit collections model
//     mutations; writing one row per editor hydration would bury the actions
//     that matter. Refusals are logged, so a denied read is still visible.
//   - No legacy-template fallback and no composition seed. The client owns which
//     document it asks for and what an absent one hydrates to. This endpoint
//     answers one question -- may this principal read this record, and what is
//     stored in it.
//   - No section derivation. A content record carries no editorial desk yet
//     (#194), so, as on the write path, a section-scoped grant authorizes
//     nothing rather than being widened into site-wide authority.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { resolveEditorTarget } = require("./lib/boardwalk-open-target");
const { requirePrincipal } = require("./lib/auth");
const { PAGE_EDITOR_TEMPLATES } = require("./lib/public-page-contract");
const {
  authorizeContentRead,
  contentResource,
  mayAnswerAbsentRecordRead,
  mayReachContentRead,
} = require("./lib/content-authorization");

// The same two collections cmsSaveContent writes. An unknown collection name is
// refused rather than read, so this endpoint can never be pointed at users,
// audit rows, or system documents.
const READ_COLLECTIONS = new Set(["cmsPages", "cmsPosts"]);

// The cmsPages ids the editor legitimately asks about, and the only ids this
// endpoint will say "nothing is stored here" about. Two kinds, both finite and
// both already public:
//
//   - A canonical public page id, which the editor opens as an empty page whose
//     first save creates it at that same id.
//   - A legacy editor-template singleton (programLanding, genericPage), which
//     the editor probes as a seed source when a page has no document of its own,
//     because the former route contract kept real work under those ids
//     (admin/src/components/ContentTab.tsx). That probe has to be answerable, or
//     hydrating an unmigrated page fails on the read that exists to find out
//     whether there is anything to inherit.
//
// A site-wide editor may also receive an honest absent answer for cmsPosts. They
// may already list and open every active record, so this adds no existence
// oracle and gives a stale deep link the editor's safe missing state. Every
// other absent id is refused. Post ids are server-minted and page ids outside
// the registry name no page, so answering either for a lower-privilege caller
// would reveal whether an id names a record from the difference versus refusal.
const ANSWERABLE_ABSENT_PAGE_IDS = new Set([
  ...Object.keys(PAGE_EDITOR_TEMPLATES),
  ...Object.values(PAGE_EDITOR_TEMPLATES),
]);

function absentIdIsAnswerable(principal, collection, documentId) {
  return (
    (collection === "cmsPages" && ANSWERABLE_ABSENT_PAGE_IDS.has(documentId)) ||
    (collection === "cmsPosts" && mayAnswerAbsentRecordRead(principal))
  );
}

const MAX_DOCUMENT_ID_BYTES = 1_500;

// One message for every refusal, whether the principal holds no content
// capability, does not own this record, or named an id nobody may ask about.
const FORBIDDEN_MESSAGE = "You do not have permission to read this record.";

// Deletion is a separate state with its own capability and its own endpoint
// (cmsBulkArchiveContent). A soft-deleted record is gone from the site and from
// the library, so the editor must not hydrate one. Refusing here rather than
// answering "not found" matters: not-found is what the client opens a blank
// editor on, and a blank editor over a deleted record invites a save that
// resurrects it as empty content.
const DELETED_MESSAGE = "This record is no longer available.";

class ReadRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ReadRejection";
    this.status = status;
  }
}

// Firestore's own document-id constraints, mirroring assign-content.js. A path
// separator or a reserved name would address a different document than the one
// the caller named, so it is a bad request rather than something to normalize.
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

function validateReadRequest(body) {
  if (!READ_COLLECTIONS.has(body?.collection)) {
    return `collection must be one of ${[...READ_COLLECTIONS].join(", ")}`;
  }
  if (!isBoundedDocumentId(body.id)) {
    return "id must be a bounded Firestore document id";
  }
  if (body.publicationOnly !== undefined && typeof body.publicationOnly !== "boolean") {
    return "publicationOnly must be a boolean";
  }
  return null;
}

// Only server-owned check state leaves the queue: whether a confirmation holds
// the claim now, how many public reads failed, and when the next one is due.
function pageConfirmationState(queue) {
  if (queue?.status !== "pending") return null;
  return { checking: typeof queue.claim === "string",
    attempts: Number.isSafeInteger(queue.attempts) ? queue.attempts : 0,
    nextAttemptAt: Number.isFinite(queue.nextAttemptAt) ? queue.nextAttemptAt : null };
}

async function publicationMetadata(firestore, stored, collection, documentId) {
  if (collection === "cmsPosts") {
    const record = await require("./lib/no-build-record-metadata").recordPublicationMetadata({ firestore, documentId, stored });
    if (record) return record;
    const card = await require("./lib/no-build-library-card-publication").libraryCardMetadata({ firestore,
      stored: { ...stored, id: documentId } });
    if (card) return card;
  }
  let queueId = stored?.publishBuildQueueId;
  let queueStatus = null;
  let canResumeReservation = false;
  let homeWarning = null;
  let withdrawalBuildPending = false;
  const settlement = stored?.publishBuildSettlement;
  let pageReceipt = null;
  let publicationTransport = null;
  let pageConfirmation = null;
  let recheckQueueId = null;
  // Settlement clears the pointer. Retain its outcome only for this exact
  // public revision and operation; an older publish cannot describe a removal.
  if (settlement?.sourceVersion === stored?.published?.sourceVersion &&
    settlement?.operation === (stored?.publiclyVisible === false ? "withdraw" : "publish") &&
    ["success", "failed", "cancelled", "superseded", "public_unconfirmed"].includes(settlement?.status)) {
    queueStatus = settlement.status;
    pageReceipt = collection === "cmsPages" ? require("./lib/page-publication-receipt").confirmedPageReceipt(stored) : null;
    if (pageReceipt) {
      publicationTransport = "page-no-build-v1";
    }
  }
  if (typeof queueId === "string" && isBoundedDocumentId(queueId)) {
    const queue = await firestore.collection("cmsPublishQueue").doc(queueId).get();
    const status = queue.exists ? queue.data()?.status : null;
    if (["failed", "public_unconfirmed"].includes(status) &&
        ["page-no-build-v1", "post-no-build-v1"].includes(queue.data()?.transport)) recheckQueueId = queueId;
    if (collection === "cmsPages" && queue.data()?.transport === "page-no-build-v1") {
      publicationTransport = "page-no-build-v1";
      pageConfirmation = pageConfirmationState(queue.data());
    }
    withdrawalBuildPending = ["reserved", "pending", "publishing", "failed", "cancelled", "superseded", "public_unconfirmed"].includes(status) &&
      queue.data()?.homeFullBuild?.schemaVersion === 1;
    if (["reserved", "pending", "publishing", "failed", "cancelled", "superseded", "public_unconfirmed"].includes(status) && queue.data()?.homeFallback?.schemaVersion === 1) {
      homeWarning = require("./lib/no-build-home-withdrawal").HOME_FALLBACK_WARNING;
    } else if (["reserved", "pending", "publishing", "failed", "cancelled", "superseded", "public_unconfirmed"].includes(status) && queue.data()?.homeFullBuild?.schemaVersion === 1 && queue.data()?.homeFullBuild?.reason !== "post_withdrawal_safety") {
      homeWarning = require("./lib/no-build-home-withdrawal").HOME_WITHDRAWAL_WARNING;
    }
    canResumeReservation = status === "reserved" && Array.isArray(queue.data()?.changes) && queue.data().changes.length === 1;
    // Only the state of this document's server-owned queue pointer is exposed.
    // Never return queue changes, actors, logs, or another document's content.
    queueStatus = ["reserved", "pending", "publishing", "success", "failed", "public_unconfirmed", "superseded", "cancelled"].includes(status)
      ? status : "unavailable";

  }
  // A failed full build can clear the ordinary pointer while leaving the
  // withdrawal pending. Recover only this owned Post's retained Home receipt.
  if (!queueId && collection === "cmsPosts" && stored?.publiclyVisible === false &&
      settlement?.operation === "withdraw" && ["failed", "cancelled", "public_unconfirmed"].includes(settlement.status)) {
    const home = await require("./lib/transitional-post-withdrawal").readPostWithdrawalPublication({
      firestore, postId: documentId, sourceVersion: stored?.published?.sourceVersion });
    if (home) {
      queueId = home.queueId;
      queueStatus = home.queueStatus;
      homeWarning = home.warning;
      withdrawalBuildPending = true;
      canResumeReservation = home.queueStatus === "reserved";
    }
  }
  const version = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
  if (collection === "cmsPosts" && stored?.publiclyVisible === false) {
    const outputs = await require("./lib/no-build-post-withdrawal").readPostWithdrawalOutputs({
      firestore, postId: documentId, sourceVersion: stored?.published?.sourceVersion });
    if (outputs) {
      queueId = outputs.queueId;
      queueStatus = outputs.queueStatus;
      homeWarning = outputs.warning ?? homeWarning;
      withdrawalBuildPending = true;
      canResumeReservation = false;
    }
  }
  return {
    workingVersion: version(stored?.version),
    contentVersion: version(stored?.contentVersion ?? stored?.version),
    publishedContentVersion: version(stored?.published?.contentVersion),
    workingStatus: typeof stored?.status === "string" ? stored.status : "draft",
    publishedSourceVersion: version(stored?.published?.sourceVersion),
    publicSourceVersion: version(stored?.publicSourceVersion),
    publiclyVisible: stored?.publiclyVisible === true ||
      (stored?.publiclyVisible === undefined && stored?.status === "published"),
    publicUpdatePending: stored?.publishBuildPending === true || withdrawalBuildPending || Boolean(homeWarning),
    publicBuildQueueId: typeof queueId === "string" ? queueId : null,
    queueStatus,
    ...(recheckQueueId ? { recheckQueueId } : {}),
    canResumeReservation,
    ...(pageReceipt ? { pageReceipt } : {}),
    ...(publicationTransport ? { publicationTransport } : {}),
    ...(pageConfirmation ? { pageConfirmation } : {}),
    ...(withdrawalBuildPending ? { withdrawalBuildPending: true } : {}),
    ...(homeWarning ? { homeWarning } : {}),
    ...(collection === "cmsPosts" ? require("./lib/no-build-post-proof-state").postProofMetadata(stored) : {}),
  };
}

function createCmsGetContentHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requirePrincipalFn(req);
      if (req.body?.action === "resolveEditor") {
        try {
          const target = await resolveEditorTarget({ firestore, principal: user.principal, input: req.body });
          res.status(200).json({ success: true, target });
        } catch (error) {
          if (error?.status === 403) {
            // Log trusted diagnostics only. Invalid paths or IDs can contain secrets.
            log.warn("cmsGetContent refused an editor target", {
              uid: user.uid,
              targetMode: req.body.type !== undefined || req.body.id !== undefined ? "identity" : "path",
              reason: error.denialReason,
            });
          }
          throw error;
        }
        return;
      }
      const validationError = validateReadRequest(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const { collection, id } = req.body;

      // The coarse pre-check, before any document read: a caller holding no
      // content capability is refused without this endpoint touching Firestore.
      if (!mayReachContentRead(user.principal)) {
        log.warn("cmsGetContent refused a caller with no content capability", {
          uid: user.uid,
          collection,
          documentId: id,
        });
        throw new ReadRejection(403, FORBIDDEN_MESSAGE);
      }

      const snapshot = await firestore.collection(collection).doc(id).get();
      const stored = snapshot.exists ? snapshot.data() : null;

      // An absent id nobody may ask about is a permission answer rather than a
      // not-found one, and it carries the same message an unauthorized read
      // gets. Keeping the two indistinguishable is what stops a caller who may
      // not read a stored record from learning that the id names one. A stored
      // document is never filtered this way, so a page saved under an id that
      // has since left the registry stays readable.
      if (!snapshot.exists && !absentIdIsAnswerable(user.principal, collection, id)) {
        log.warn("cmsGetContent refused a read of an absent record", {
          uid: user.uid,
          collection,
          documentId: id,
        });
        throw new ReadRejection(403, FORBIDDEN_MESSAGE);
      }

      // The record-level decision, made against what was actually read.
      // Ownership is the stored author and the section is the document's own
      // desk (#845), so an unauthorized caller is refused before the endpoint
      // says anything about the record's contents. A never-saved canonical page
      // still states its registry desk, so a scoped editor can open the blank
      // editor for a page in their own area and create it; an absent record
      // states none, and the gate above has already limited that answer to
      // callers who may be told the id names nothing.
      const decision = authorizeContentRead(user.principal, {
        exists: snapshot.exists,
        resource: contentResource({ collection, documentId: id, stored }),
      });
      if (!decision.allowed) {
        log.warn("cmsGetContent refused a read", {
          uid: user.uid,
          collection,
          documentId: id,
          reason: decision.reason,
        });
        throw new ReadRejection(403, FORBIDDEN_MESSAGE);
      }

      // Only after the caller is authorized does the record's own state decide
      // the answer, so this never tells an unauthorized caller that a deleted
      // record exists.
      if (stored?.deleted === true) {
        log.warn("cmsGetContent refused a read of a deleted record", {
          uid: user.uid,
          collection,
          documentId: id,
        });
        throw new ReadRejection(404, DELETED_MESSAGE);
      }

      if (req.body.publicationOnly === true) {
        res.status(200).json({
          success: true,
          found: snapshot.exists,
          publication: await publicationMetadata(firestore, stored, collection, id),
        });
        return;
      }

      // The addressed id wins over any `id` the document carries: an older
      // record can still hold a conflicting one, and the client keys its editor
      // on the document it asked for.
      res.status(200).json({
        success: true,
        found: snapshot.exists,
        document: stored ? { ...stored, id } : null,
      });
    } catch (error) {
      if (res.headersSent) return;
      const status =
        error?.status || (error?.code === "failed-precondition" ? 503 : 500);
      // A ReadRejection is this handler refusing a request on purpose and is
      // already logged where the decision was made; anything else reaching here
      // as a 5xx is a fault worth a stack.
      if (!(error instanceof ReadRejection) && status >= 500) {
        log.error("cmsGetContent failed", error);
      }
      res.status(status).json({
        error: error?.message || "Failed to read content",
      });
    }
  };
}

const cmsGetContent = cmsOnRequest({ cors: true }, createCmsGetContentHandler());

module.exports = {
  ANSWERABLE_ABSENT_PAGE_IDS,
  DELETED_MESSAGE,
  FORBIDDEN_MESSAGE,
  MAX_DOCUMENT_ID_BYTES,
  READ_COLLECTIONS,
  ReadRejection,
  absentIdIsAnswerable,
  cmsGetContent,
  isBoundedDocumentId,
  createCmsGetContentHandler,
  validateReadRequest,
  publicationMetadata,
};
