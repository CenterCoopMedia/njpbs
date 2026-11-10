"use strict";
const { parseLiveBlogDraft, assertLiveBlogRetainsPublished } = require("./lib/live-blog");

const { contentVersion, hasContentChanges } = require("./lib/content-version");
const { changesPublicLibraryFields } = require("./lib/library-card-publication");

// Restore one historical CMS working snapshot without rewriting history or
// changing the current record's operational state. The client names only the
// immutable history row and the exact current version it opened. The server
// reads both records in one transaction, re-authorizes the current record,
// copies only fields owned by its active editor contract, revalidates the full
// result, and appends a new revision and compliance receipt atomically.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { automationWriteRefusal, readAutomationAccount } = require("./lib/automation-accounts");
const { can } = require("./lib/rbac");
const {
  authorizeContentRead,
  authorizeContentWrite,
  contentResource,
  mayReachContentWrite,
} = require("./lib/content-authorization");
const {
  AUDIT_COLLECTIONS,
  adminLogEntry,
  versionHistoryEntry,
} = require("./lib/audit");
const { parseBlocks } = require("./lib/content-blocks");
const { blockContentError } = require("./lib/block-content-validation");
const { creditsFromLegacyAuthor } = require("./lib/story-credits");
const {
  CONTENT_DOCUMENT_CONTRACTS,
  retiredContentKindError,
  validateContentFieldValues,
} = require("./lib/content-document-contract");
const { validateSection } = require("./lib/editor-section-contract");
const { homeCompositionError } = require("./lib/home-composition-contract");
const { serviceCompositionError } = require("./lib/service-composition");
const {
  documentSizeError,
  firestoreDocumentBytes,
} = require("./lib/document-size");
const {
  normalizeLegacyPostDate,
  validateKnownMetadata,
} = require("./lib/content-metadata");
const { editorTemplateForPage } = require("./lib/public-page-contract");
const { CONTENT_STATUSES } = require("./lib/content-statuses");
const {
  MediaUsageError,
  collectWorkingMediaUsage,
  prepareMediaUsageWrite,
} = require("./lib/media-usage");

const RESTORE_COLLECTIONS = new Set(["cmsPages", "cmsPosts"]);
const REVISION_COLLECTION = AUDIT_COLLECTIONS.versionHistory;
const MAX_DOCUMENT_ID_BYTES = 1_500;
const FORBIDDEN_MESSAGE = "You do not have permission to restore this record.";
const RECORD_NOT_FOUND_MESSAGE = "This record is no longer available.";
const REVISION_NOT_FOUND_MESSAGE = "That revision could not be found.";
const CONFLICT_MESSAGE =
  "This document changed since you opened it. Reload it before restoring a revision.";

// These fields are part of an editor form, but restoring them would perform a
// separate operational action. Keep the current kind, canonical page template,
// workflow state, and schedule. Server-managed identity, routing, assignment,
// published snapshots, and future approval fields are not in the editor contract
// and are therefore preserved automatically from the current record.
const PRESERVED_EDITOR_FIELDS = new Set([
  "type",
  "template",
  "status",
  "publishAt",
  "serviceCompositionVersion",
  // Privacy classification is a current decision, not historical copy.
  "childDirected",
  // Restoring a revision restores the words, not the dates (#1041). The editorial
  // display date, the meaningful-update request, and the show-the-update decision
  // are publication decisions with their own controls and their own authority
  // check; rolling the body back to an earlier draft must not silently move the
  // date the story reports, and must not re-announce it as updated.
  "date",
  "recordMeaningfulUpdate",
  "showUpdatedDate",
]);

class RestoreRevisionRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "RestoreRevisionRejection";
    this.status = status;
  }
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

function validateRestoreRequest(body) {
  if (!isPlainObject(body)) return "Request body must be an object";
  if (!RESTORE_COLLECTIONS.has(body.collection)) {
    return `collection must be one of ${[...RESTORE_COLLECTIONS].join(", ")}`;
  }
  if (!isBoundedDocumentId(body.id)) {
    return "id must be a bounded Firestore document id";
  }
  if (!isBoundedDocumentId(body.revisionId)) {
    return "revisionId must be a bounded Firestore document id";
  }
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1) {
    return "baseVersion must be a positive safe integer";
  }
  return null;
}

function contentContract(collection, kind) {
  if (collection === "cmsPages" && kind === "page") {
    return CONTENT_DOCUMENT_CONTRACTS.page;
  }
  if (
    collection === "cmsPosts" &&
    kind !== "page" &&
    Object.prototype.hasOwnProperty.call(CONTENT_DOCUMENT_CONTRACTS, kind)
  ) {
    return CONTENT_DOCUMENT_CONTRACTS[kind];
  }
  return null;
}

function serverDate(value) {
  let date = null;
  if (value instanceof Date) {
    date = value;
  } else if (
    typeof value === "object" &&
    value !== null &&
    typeof value.toDate === "function"
  ) {
    date = value.toDate();
  }
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : null;
}

// Firestore can return legacy Timestamp values for editor date fields that now use a JSON string
// contract. Normalize only trusted server reads, never client input. Post editorial dates remain
// calendar-only; event dates and the shared schedule field retain the complete instant.
function normalizeServerReadDates(kind, document) {
  let normalized = kind === "post" ? normalizeLegacyPostDate(document) : document;
  const instantFields = kind === "event"
    ? ["publishAt", "startsAt", "endsAt"]
    : ["publishAt"];
  for (const field of instantFields) {
    const normalizedDate = serverDate(normalized[field]);
    if (normalizedDate === null) continue;
    if (normalized === document) normalized = { ...document };
    normalized[field] = normalizedDate;
  }
  return normalized;
}

/**
 * Read a pre-#1040 revision's byline in the shape the current contract stores.
 *
 * A revision taken before the ordered byline existed carries the free-text
 * `author` and no `credits`. `author` is no longer a contract field, so nothing
 * copies it, while `credits` IS one and is therefore deleted for being absent
 * from the historical snapshot -- between them the restore drops the byline
 * without saying so. Converting here applies the same one-way rule the save
 * boundary applies (`resolveStoryCredits`): the historical string becomes one
 * custom credit, deterministically, with no name matching against staff.
 *
 * Returns the historical snapshot unchanged whenever it already speaks the
 * current contract, so an ordinary restore is untouched by this.
 */
function withConvertedLegacyByline(kind, historical, contract) {
  if (kind !== "post") return historical;
  if (!Object.prototype.hasOwnProperty.call(contract.fields, "credits")) {
    return historical;
  }
  if (Array.isArray(historical.credits)) return historical;
  const credits = creditsFromLegacyAuthor(historical.author);
  if (credits.length === 0) return historical;
  return { ...historical, credits };
}

function restoreEditorFields(current, historical, contract) {
  const candidate = { ...current };
  for (const field of Object.keys(contract.fields)) {
    if (PRESERVED_EDITOR_FIELDS.has(field)) continue;
    if (Object.prototype.hasOwnProperty.call(historical, field)) {
      candidate[field] = historical[field];
    } else {
      delete candidate[field];
    }
  }
  return candidate;
}

function getClientIp(req) {
  return req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function blockCount(document) {
  return Array.isArray(document?.blocks) ? document.blocks.length : 0;
}

function createCmsRestoreRevisionHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    versionHistoryEntryFn = versionHistoryEntry,
    adminLogEntryFn = adminLogEntry,
    parseBlocksFn = parseBlocks,
    validateSectionFn = validateSection,
    documentSizeErrorFn = documentSizeError,
    now = () => new Date().toISOString(),
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
      if (!mayReachContentWrite(user.principal)) {
        log.warn("cmsRestoreRevision denied", {
          uid: user.uid,
          reason: "principal holds no content-write capability",
        });
        res.status(403).json({ error: FORBIDDEN_MESSAGE });
        return;
      }

      const body = req.body === undefined ? {} : req.body;
      const requestError = validateRestoreRequest(body);
      if (requestError) {
        res.status(400).json({ error: requestError });
        return;
      }
      const { collection, id, revisionId, baseVersion } = body;
      const source = getClientIp(req);
      const contentRef = firestore.collection(collection).doc(id);
      const sourceRevisionRef = firestore
        .collection(REVISION_COLLECTION)
        .doc(revisionId);

      const automationAccount = await readAutomationAccountFn(user.uid);
      const result = await firestore.runTransaction(async (tx) => {
        const contentSnapshot = await tx.get(contentRef);
        if (!contentSnapshot.exists) {
          const absentDecision = authorizeContentRead(user.principal, {
            exists: true,
            resource: {},
          });
          if (!absentDecision.allowed) {
            throw new RestoreRevisionRejection(403, FORBIDDEN_MESSAGE);
          }
          throw new RestoreRevisionRejection(404, RECORD_NOT_FOUND_MESSAGE);
        }

        const current = contentSnapshot.data() ?? {};
        // A restore reads the record's history and then writes the record, so both
        // decisions are made against the live document's owner and editorial desk
        // (#845), resolved once so they cannot disagree. Restoring is an edit, not a
        // way around the desk an edit would be confined to.
        const resource = contentResource({
          collection,
          documentId: id,
          stored: current,
        });
        const readDecision = authorizeContentRead(user.principal, {
          exists: true,
          resource,
        });
        if (!readDecision.allowed) {
          log.warn("cmsRestoreRevision denied", {
            uid: user.uid,
            collection,
            documentId: id,
            reason: readDecision.reason,
          });
          throw new RestoreRevisionRejection(403, FORBIDDEN_MESSAGE);
        }
        if (current.deleted === true) {
          throw new RestoreRevisionRejection(404, RECORD_NOT_FOUND_MESSAGE);
        }

        const authorizationStatus =
          typeof current.status === "string" ? current.status : "__invalid_status__";
        const writeDecision = authorizeContentWrite(user.principal, {
          creating: false,
          publishing: false,
          storedStatus: current.status,
          nextStatus: authorizationStatus,
          resource,
        });
        if (!writeDecision.allowed) {
          log.warn("cmsRestoreRevision denied", {
            uid: user.uid,
            collection,
            documentId: id,
            reason: writeDecision.reason,
          });
          throw new RestoreRevisionRejection(403, FORBIDDEN_MESSAGE);
        }
        const automationRefusal = await automationWriteRefusal(tx, firestore, {
          automationAccount, uid: user.uid, collection, documentId: id, echoesVersion: true,
        });
        if (automationRefusal) {
          throw Object.assign(new RestoreRevisionRejection(automationRefusal.status, automationRefusal.message),
            automationRefusal.details);
        }
        if (!CONTENT_STATUSES.has(current.status)) {
          throw new RestoreRevisionRejection(
            400,
            `The current record has an unknown status ${String(current.status)}`,
          );
        }
        if (current.version !== baseVersion) {
          throw new RestoreRevisionRejection(409, CONFLICT_MESSAGE);
        }
        if (current.status === "in_review") {
          throw new RestoreRevisionRejection(
            400,
            "Select Edit before restoring a revision.",
          );
        }
        if (current.status === "approved") {
          throw new RestoreRevisionRejection(
            400,
            "Reopen approved content before restoring a revision.",
          );
        }
        if (current.status === "scheduled") {
          throw new RestoreRevisionRejection(
            400,
            "Cancel scheduled publication before restoring a revision.",
          );
        }
        if (current.status === "published") {
          throw new RestoreRevisionRejection(
            400,
            "Start a revision before restoring an older version.",
          );
        }

        const revisionSnapshot = await tx.get(sourceRevisionRef);
        const revision = revisionSnapshot.exists ? revisionSnapshot.data() : null;
        if (
          !revisionSnapshot.exists ||
          revision?.collection !== collection ||
          revision?.documentId !== id
        ) {
          throw new RestoreRevisionRejection(404, REVISION_NOT_FOUND_MESSAGE);
        }
        if (revision.restorable === false || !isPlainObject(revision.after)) {
          throw new RestoreRevisionRejection(
            400,
            "That revision does not contain a complete restorable snapshot.",
          );
        }

        const kind = collection === "cmsPages" ? "page" : current.type;
        const retiredError = retiredContentKindError(kind);
        if (retiredError) {
          throw new RestoreRevisionRejection(400, retiredError);
        }
        const contract = contentContract(collection, kind);
        if (!contract) {
          throw new RestoreRevisionRejection(
            400,
            `The current record has an unknown content type ${String(kind)}`,
          );
        }
        if (collection === "cmsPosts" && revision.after.type !== kind) {
          throw new RestoreRevisionRejection(
            400,
            "That revision belongs to a different record type.",
          );
        }
        // Old service snapshots still use template slots and may omit copy
        // inserted by migration. Keeping layout ownership while copying those
        // blocks would produce an incomplete or misordered composed page.
        if (collection === "cmsPages" &&
          current.serviceCompositionVersion !== undefined &&
          revision.after.serviceCompositionVersion === undefined) {
          throw new RestoreRevisionRejection(
            400,
            "That revision was saved before this page's layout was migrated. Restore a revision saved after the layout migration.",
          );
        }

        const normalizedCurrent = normalizeServerReadDates(kind, current);
        const normalizedHistorical = normalizeServerReadDates(kind, revision.after);
        let candidate = restoreEditorFields(
          normalizedCurrent,
          withConvertedLegacyByline(kind, normalizedHistorical, contract),
          contract,
        );
        if (kind === "post") {
          try {
            if (candidate.liveBlog !== undefined) candidate.liveBlog = parseLiveBlogDraft(candidate.liveBlog);
            await require("./lib/live-blog-compatibility").assertLiveBlogFollowUpsRenderer({ firestore, transaction: tx, liveBlog: candidate.liveBlog });
            if (candidate.liveBlog?.presentation !== undefined &&
                await require("./lib/live-blog-compatibility").readLiveBlogContractVersion({ firestore, transaction: tx }) < 2) {
              throw new RestoreRevisionRejection(409, require("./lib/live-blog-compatibility").PRESENTATION_PENDING);
            }
            require("./lib/live-blog").assertLiveBlogFollowUpsEditable(candidate.liveBlog, current.liveBlog, current.published?.metadata?.liveBlog);
            assertLiveBlogRetainsPublished(candidate.liveBlog, current.published?.metadata?.liveBlog);
          } catch (error) {
            if (error instanceof RestoreRevisionRejection) throw error;
            throw new RestoreRevisionRejection(error.status ?? 400, error.message);
          }
        }
        if (collection === "cmsPosts" && changesPublicLibraryFields(current, candidate) &&
            !can(user.principal, "content.publish", resource)) {
          throw new RestoreRevisionRejection(403, "You need publication permission to change public sponsor or newsletter fields.");
        }
        // Complete the one-way byline conversion, exactly as an ordinary save
        // does. Whatever the restored byline came from -- the historical
        // `credits`, or the historical `author` converted above -- it is now in
        // `credits`, so a legacy `author` still sitting on the current record
        // would be a second byline free to disagree with it on the next edit.
        if (collection === "cmsPosts" && kind === "post") {
          delete candidate.author;
        }
        const timestamp = now();
        const nextVersion = baseVersion + 1;
        candidate = {
          ...candidate,
          id,
          updatedAt: timestamp,
          updatedBy: user.uid,
          version: nextVersion,
          contentVersion: contentVersion(current) + (hasContentChanges(current, candidate) ? 1 : 0),
        };

        let section = null;
        if (collection === "cmsPages") {
          section = editorTemplateForPage(id);
          if (section === null) {
            throw new RestoreRevisionRejection(400, `Unknown public page id ${id}`);
          }
          candidate.template = section;
        } else if (kind === "post") {
          section = "post";
        }

        const incompleteDraftIsAllowed = current.status === "draft" &&
          (collection === "cmsPages" || kind === "post");
        const fieldError = validateContentFieldValues(
          collection,
          kind,
          candidate,
          { complete: !incompleteDraftIsAllowed, validateTypes: true, allowIncomplete: incompleteDraftIsAllowed },
        );
        if (fieldError) {
          throw new RestoreRevisionRejection(400, fieldError);
        }

        const metadataError = validateKnownMetadata(candidate, {
          descriptionIsString: collection === "cmsPages",
        });
        if (metadataError) {
          throw new RestoreRevisionRejection(400, metadataError);
        }

        if (Object.prototype.hasOwnProperty.call(candidate, "blocks")) {
          const parsed = parseBlocksFn(candidate.blocks, { complete: candidate.status !== "draft",
            pageId: collection === "cmsPages" ? id : undefined });
          if (!parsed.ok) {
            throw new RestoreRevisionRejection(400, parsed.error);
          }
          const contentError = blockContentError(parsed.blocks, { complete: current.status !== "draft" });
          if (contentError) throw new RestoreRevisionRejection(400, contentError);
          // Array position is authoritative in the editor. Canonicalize the persisted order too,
          // so the public loader, preview, scheduler, and next ordinary save render the same list.
          candidate.blocks = parsed.blocks.map((block, index) =>
            block.order === index ? block : { ...block, order: index },
          );
          if (section !== null) {
            const sectionError = validateSectionFn(section, candidate.blocks);
            if (sectionError) {
              throw new RestoreRevisionRejection(400, sectionError.reason);
            }
          }
        }

        if (collection === "cmsPages") {
          const serviceError = serviceCompositionError(id, candidate.serviceCompositionVersion);
          if (serviceError) throw new RestoreRevisionRejection(400, serviceError);
          const homeError = homeCompositionError(id, candidate.homeCompositionVersion, candidate.blocks ?? [], { complete: current.status !== "draft" });
          if (homeError) throw new RestoreRevisionRejection(400, homeError);
        }

        const newRevisionRef = firestore.collection(REVISION_COLLECTION).doc();
        const sourceVersion = positiveVersion(revision.after.version);
        let historyEntry = {
          ...versionHistoryEntryFn({
            collection,
            documentId: id,
            action: "restore",
            before: current,
            after: candidate,
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            source,
          }),
          sourceRevisionId: revisionId,
          sourceVersion,
          restoredVersion: nextVersion,
          newRevisionId: newRevisionRef.id,
        };
        const documentPath = `${collection}/${id}`;
        const historyPath = newRevisionRef.path;
        const contentSizeError = documentSizeErrorFn(
          candidate,
          documentPath,
          { label: "the restored content document" },
        );
        let historySizeError = documentSizeErrorFn(
          historyEntry,
          historyPath,
          { label: "the version-history row for this restore" },
        );

        // A large legacy record can fit by itself while its full before plus the smaller
        // restored result does not fit in one history row. Permit only a strict shrink, and
        // retain the current identity, state, version, and measured size as a bounded receipt.
        // The restored after-state stays complete and the bounded row is measured again.
        const currentBytes = firestoreDocumentBytes(current, documentPath);
        const candidateBytes = firestoreDocumentBytes(candidate, documentPath);
        if (!contentSizeError && historySizeError && candidateBytes < currentBytes) {
          const boundedBefore = {
            ...(current.id === undefined ? {} : { id: current.id }),
            ...(current.status === undefined ? {} : { status: current.status }),
            ...(current.version === undefined ? {} : { version: current.version }),
            beforeTruncated: true,
            beforeEstimatedBytes: currentBytes,
          };
          historyEntry = {
            ...versionHistoryEntryFn({
              collection,
              documentId: id,
              action: "restore",
              before: boundedBefore,
              after: candidate,
              actorUid: user.uid,
              actorEmail: user.email ?? null,
              source,
            }),
            sourceRevisionId: revisionId,
            sourceVersion,
            restoredVersion: nextVersion,
            newRevisionId: newRevisionRef.id,
            beforeTruncated: true,
            beforeEstimatedBytes: currentBytes,
          };
          historySizeError = documentSizeErrorFn(historyEntry, historyPath, {
            label: "the bounded version-history row for this repair",
          });
        }

        const sizeError = contentSizeError ?? historySizeError;
        if (sizeError) {
          log.warn("cmsRestoreRevision refused an oversized document", {
            uid: user.uid,
            collection,
            documentId: id,
            detail: sizeError.detail,
          });
          throw new RestoreRevisionRejection(413, sizeError.reason);
        }

        let workingMediaUsageWrite;
        try {
          workingMediaUsageWrite = await prepareMediaUsageWrite({
            firestore,
            transaction: tx,
            collection,
            documentId: id,
            state: "working",
            sourceVersion: candidate.version,
            usage: collectWorkingMediaUsage({
              collection,
              document: candidate,
            }),
          });
        } catch (error) {
          if (error instanceof MediaUsageError) {
            throw new RestoreRevisionRejection(error.status, error.message);
          }
          throw error;
        }

        const receipt = {
          sourceRevisionId: revisionId,
          sourceVersion,
          newRevisionId: newRevisionRef.id,
          version: nextVersion,
        };
        tx.set(contentRef, candidate);
        tx.set(
          workingMediaUsageWrite.ref,
          workingMediaUsageWrite.document,
        );
        tx.set(newRevisionRef, historyEntry);
        tx.set(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          adminLogEntryFn({
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            action: "cms.restore-revision",
            target: `${collection}/${id}`,
            before: {
              status: current.status,
              version: current.version,
              blockCount: blockCount(current),
            },
            after: {
              status: candidate.status,
              blockCount: blockCount(candidate),
              ...receipt,
            },
            source,
          }),
        );

        return { candidate, receipt };
      });

      res.status(200).json({
        success: true,
        collection,
        id,
        revisionId: result.receipt.newRevisionId,
        sourceRevisionId: result.receipt.sourceRevisionId,
        sourceVersion: result.receipt.sourceVersion,
        version: result.receipt.version,
        document: result.candidate,
      });
    } catch (error) {
      if (res.headersSent) return;
      const status =
        error?.status || (error?.code === "failed-precondition" ? 503 : 500);
      if (!(error instanceof RestoreRevisionRejection) && status >= 500) {
        log.error("cmsRestoreRevision failed", error);
      }
      res.status(status).json({
        error: error?.message || "That revision could not be restored",
        ...(error?.lockRequired === true ? { lockRequired: true } : {}),
      });
    }
  };
}

const cmsRestoreRevision = cmsOnRequest(
  { cors: true, invoker: "public" },
  createCmsRestoreRevisionHandler(),
);

module.exports = {
  CONFLICT_MESSAGE,
  FORBIDDEN_MESSAGE,
  RestoreRevisionRejection,
  cmsRestoreRevision,
  createCmsRestoreRevisionHandler,
  restoreEditorFields,
  validateRestoreRequest,
};
