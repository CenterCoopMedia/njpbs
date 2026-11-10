"use strict";

const { preparePublicMediaChangeInTransaction } = require("./lib/public-release-producer");

// This is the browser-facing detail and removal mutation for a station-managed asset. It accepts
// an explicit field allowlist, authorizes against the stored category, requires a strong If-Match
// condition, and commits each private/public state change with its audit row.

const { isDeepStrictEqual } = require("node:util");
const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { can, hasCapability } = require("./lib/rbac");
const {
  JsonRequestError,
  requestHeader,
  validateBoundedJsonRequest,
} = require("./lib/http-json");
const {
  MediaValidationError,
  MAX_MEDIA_CATEGORY_ASSIGNMENTS,
  CATEGORY_PATTERN,
  mediaProjection,
  normalizeEditableOriginalName,
  normalizeOriginalName,
  normalizeMediaCategoryAssignments,
  normalizeUploadMetadata,
} = require("./lib/media-contract");
const { requireManagedMediaCategories } = require("./lib/media-categories");
const {
  MediaLibraryValidationError,
  formatMediaEtag,
  isMediaAssetId,
  mediaAssetSummary,
  parseMediaIfMatch,
} = require("./lib/media-library");
const {
  bumpMediaDiscoveryRevision,
  prepareMediaAdmissionRelease,
  withMediaDiscovery,
} = require("./lib/media-discovery");
const { mediaReplacementRef } = require("./lib/media-replacement");
const { createImagePurgeEntry, mediaPurgeRef, purgeAfterFor } = require("./lib/media-bin");
const { setPrivateNoStore } = require("./list-media");

const REQUEST_FIELDS = new Set(["assetId", "metadata", "action"]);
const EDITABLE_METADATA_FIELDS = Object.freeze([
  "metadataUpdateRequested",
  "originalName",
  "name",
  "description",
  "altText",
  "license",
  "credit",
  "tags",
  "categories",
]);
// The alt-text sweep (#242) sends altTextGenerated: true with the text it
// wrote. A person's later change to the alt text or description clears the marker.
const EDITABLE_METADATA_FIELD_SET = new Set([
  ...EDITABLE_METADATA_FIELDS,
  "altTextGenerated",
]);
const NOT_FOUND_MESSAGE = "This media asset is not available.";

class UpdateMediaRejection extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "UpdateMediaRejection";
    this.status = status;
    this.details = details;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validNullableString(value, max) {
  return value === null ||
    (typeof value === "string" && value.trim().length <= max);
}

function validateMediaMetadataPatch(body) {
  if (!plainObject(body)) return "The media metadata request must be an object";
  const unknownRequestField = Object.keys(body).find(
    (field) => !REQUEST_FIELDS.has(field),
  );
  if (unknownRequestField) return `Unknown request field ${unknownRequestField}`;
  if (!isMediaAssetId(body.assetId)) return "assetId must be a bounded media asset id";
  if (body.action !== undefined) {
    if (body.action !== "delete") return "action must be delete";
    if (body.metadata !== undefined) {
      return "metadata cannot be included with a delete action";
    }
    return null;
  }
  if (!plainObject(body.metadata)) return "metadata must be an object";
  const fields = Object.keys(body.metadata);
  if (fields.length === 0) return "metadata must include at least one editable field";
  const unknownMetadataField = fields.find(
    (field) => !EDITABLE_METADATA_FIELD_SET.has(field),
  );
  if (unknownMetadataField) return `Unknown metadata field ${unknownMetadataField}`;
  if (body.metadata.originalName !== undefined) {
    try {
      normalizeOriginalName(body.metadata.originalName);
    } catch (error) {
      if (error instanceof MediaValidationError) return error.message;
      throw error;
    }
  }
  if (
    body.metadata.name !== undefined &&
    (
      typeof body.metadata.name !== "string" ||
      body.metadata.name.trim().length === 0 ||
      body.metadata.name.trim().length > 180
    )
  ) {
    return "name must be a non-empty string of 180 characters or fewer";
  }
  for (const [field, max] of [
    ["license", 120],
    ["description", 2_000],
    ["altText", 500],
    ["credit", 300],
  ]) {
    if (
      body.metadata[field] !== undefined &&
      !validNullableString(body.metadata[field], max)
    ) {
      return `${field} must be null or a string of ${max} characters or fewer`;
    }
  }
  if (body.metadata.metadataUpdateRequested !== undefined && typeof body.metadata.metadataUpdateRequested !== "boolean") {
    return "metadataUpdateRequested must be a boolean";
  }
  if (body.metadata.altTextGenerated !== undefined) {
    if (body.metadata.altTextGenerated !== true) {
      return "altTextGenerated must be true";
    }
    if (
      typeof body.metadata.altText !== "string" ||
      body.metadata.altText.trim().length === 0
    ) {
      return "altTextGenerated needs non-empty altText in the same update";
    }
  }
  if (body.metadata.tags !== undefined) {
    if (!Array.isArray(body.metadata.tags) || body.metadata.tags.length > 20) {
      return "tags must be an array with 20 values or fewer";
    }
    if (body.metadata.tags.some(
      (tag) =>
        typeof tag !== "string" ||
        tag.trim().length === 0 ||
        tag.trim().length > 40,
    )) {
      return "Each tag must be a non-empty string of 40 characters or fewer";
    }
  }
  if (body.metadata.categories !== undefined) {
    const categories = body.metadata.categories;
    if (
      !Array.isArray(categories) ||
      categories.length < 1 ||
      categories.length > MAX_MEDIA_CATEGORY_ASSIGNMENTS
    ) {
      return `categories must be an array with 1 to ${MAX_MEDIA_CATEGORY_ASSIGNMENTS} values`;
    }
    if (categories.some(
      (category) =>
        typeof category !== "string" ||
        category.length === 0 ||
        category.length > 60 ||
        category !== category.trim() ||
        !CATEGORY_PATTERN.test(category),
    )) {
      return "Each category must be a managed path-safe category id";
    }
    if (new Set(categories).size !== categories.length) {
      return "categories cannot contain duplicates";
    }
  }
  return null;
}

function usageQuery(firestore, state, assetId) {
  return firestore
    .collectionGroup("mediaUsage")
    .where("state", "==", state)
    .where("assetIds", "array-contains", assetId)
    .limit(1);
}

function editableMetadata(record) {
  const editable = Object.fromEntries(
    EDITABLE_METADATA_FIELDS.map((field) => [field, record[field] ?? null]),
  );
  editable.metadataUpdateRequested = record.metadataUpdateRequested === true;
  editable.categories = normalizeMediaCategoryAssignments(
    record.categories,
    record.category,
  );
  return editable;
}

function createCmsUpdateMediaMetadataHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    adminLogEntryFn = adminLogEntry,
    now = () => new Date().toISOString(),
    log = logger,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      validateBoundedJsonRequest(req, 16 * 1024);
      const user = await requirePrincipalFn(req);
      const validationError = validateMediaMetadataPatch(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      const { assetId, metadata, action } = req.body;
      const ifMatch = requestHeader(req, "if-match");
      if (ifMatch === undefined) {
        res.status(428).json({ error: "If-Match is required for a media update" });
        return;
      }
      const baseVersion = parseMediaIfMatch(ifMatch, assetId);
      if (baseVersion === null) {
        res.status(400).json({
          error: "If-Match must be one strong ETag for this media asset",
        });
        return;
      }
      if (!hasCapability(user.principal, "media.manage")) {
        throw new UpdateMediaRejection(404, NOT_FOUND_MESSAGE);
      }

      const source = requestHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
        req.ip || null;
      const outcome = await firestore.runTransaction(async (transaction) => {
        const assetRef = firestore.collection("media_assets").doc(assetId);
        const reads = [
          transaction.get(assetRef),
          transaction.get(mediaReplacementRef(firestore, assetId)),
        ];
        if (action === "delete") {
          reads.push(
            transaction.get(usageQuery(firestore, "working", assetId)),
            transaction.get(usageQuery(firestore, "published", assetId)),
            transaction.get(usageQuery(firestore, "deployed", assetId)),
          );
        }
        const [assetSnapshot, replacementSnapshot, workingUsage, publishedUsage, deployedUsage] =
          await Promise.all(reads);
        if (!assetSnapshot.exists) {
          throw new UpdateMediaRejection(404, NOT_FOUND_MESSAGE);
        }
        const stored = assetSnapshot.data();
        if (
          stored?.lifecycle !== "active" ||
          typeof stored.category !== "string" ||
          !can(user.principal, "media.manage")
        ) {
          throw new UpdateMediaRejection(404, NOT_FOUND_MESSAGE);
        }
        if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
          throw new UpdateMediaRejection(
            409,
            "This media asset has no current metadata version.",
          );
        }
        if (stored.version !== baseVersion) {
          throw new UpdateMediaRejection(
            412,
            "This media asset changed since you opened it. Reload before saving.",
            { etag: formatMediaEtag(assetId, stored.version) },
          );
        }
        if (replacementSnapshot.exists) {
          throw new UpdateMediaRejection(
            409,
            "A file replacement is in progress. Try again after it finishes.",
          );
        }

        if (action === "delete") {
          if (stored.source !== "upload") {
            throw new UpdateMediaRejection(
              409,
              "Only uploaded media can be deleted from the library.",
            );
          }
          if (!workingUsage.empty || !publishedUsage.empty || !deployedUsage.empty) {
            throw new UpdateMediaRejection(
              409,
              "This media asset is still used by content. Remove it from that content first.",
            );
          }
          const timestamp = now();
          const purgeAfter = stored.kind === "image" ? purgeAfterFor(timestamp) : null;
          const updatedRecord = { ...stored };
          delete updatedRecord.reactivatedAt;
          delete updatedRecord.reactivatedBy;
          Object.assign(updatedRecord, {
            id: assetId,
            lifecycle: "tombstoned",
            version: stored.version + 1,
            updatedAt: timestamp,
            updatedBy: user.uid,
            tombstonedAt: timestamp,
            tombstonedBy: user.uid,
            ...(purgeAfter ? { purgeAfter } : {}),
          });
          const updated = withMediaDiscovery(assetId, updatedRecord);
          const etag = formatMediaEtag(assetId, updated.version);
          const admission = await prepareMediaAdmissionRelease(transaction, firestore);
          const writeReleaseChange = await preparePublicMediaChangeInTransaction({ firestore, transaction,
            id: assetId, version: updated.version, before: mediaProjection(stored), after: null });
          writeReleaseChange();
          transaction.set(assetRef, updated);
          bumpMediaDiscoveryRevision(transaction, firestore, { withdrawal: true, ...admission });
          if (purgeAfter) {
            transaction.set(mediaPurgeRef(firestore, assetId),
              createImagePurgeEntry(assetId, stored, timestamp, purgeAfter));
          }
          // Keep objects available for recovery and withdraw new attachment access.
          transaction.delete(
            firestore.collection("media_assets_public").doc(assetId),
          );
          transaction.set(
            firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
            adminLogEntryFn({
              actorUid: user.uid,
              actorEmail: user.email ?? null,
              action: "media.library.delete",
              target: `media_assets/${assetId}`,
              before: { lifecycle: stored.lifecycle, version: stored.version },
              after: {
                lifecycle: updated.lifecycle,
                version: updated.version,
                ...(purgeAfter ? { purgeAfter, purgeEntryId: `asset:${assetId}` } : {}),
              },
              source,
            }),
          );
          return {
            asset: {
              id: assetId,
              lifecycle: updated.lifecycle,
              version: updated.version,
              etag,
            },
            changed: true,
            deleted: true,
          };
        }

        if (metadata.originalName !== undefined && stored.source !== "upload") {
          throw new UpdateMediaRejection(
            409,
            "Only uploaded media filenames can be changed.",
          );
        }
        const nextOriginalName = metadata.originalName === undefined
          ? stored.originalName
          : normalizeEditableOriginalName(
            metadata.originalName,
            stored.mimeType,
          );
        const storedCategories = normalizeMediaCategoryAssignments(
          stored.categories,
          stored.category,
        );
        const nextCategories = normalizeMediaCategoryAssignments(
          metadata.categories ?? storedCategories,
          stored.category,
        );
        const storedCategoryIds = new Set(storedCategories);
        const addedCategories = nextCategories.filter(
          (category) => !storedCategoryIds.has(category),
        );
        if (addedCategories.length > 0) {
          await requireManagedMediaCategories(
            transaction,
            firestore,
            addedCategories,
          );
        }
        const before = editableMetadata(stored);
        let canonicalBefore;
        try {
          canonicalBefore = {
            ...normalizeUploadMetadata(
              {
                ...before,
                category: stored.category,
                categories: storedCategories,
              },
              stored.originalName,
            ),
            originalName: stored.originalName,
          };
        } catch (error) {
          if (!(error instanceof MediaValidationError)) throw error;
          canonicalBefore = {
            ...before,
            category: stored.category,
            categories: storedCategories,
          };
        }
        const normalized = {
          ...normalizeUploadMetadata(
            {
              ...canonicalBefore,
              ...metadata,
              category: stored.category,
              categories: nextCategories,
            },
            nextOriginalName,
          ),
          originalName: nextOriginalName,
        };
        const comparableBefore = editableMetadata(canonicalBefore);
        const after = editableMetadata(normalized);
        const storedGenerated = stored.altTextGenerated === true;
        const textChanged =
          comparableBefore.altText !== after.altText ||
          comparableBefore.description !== after.description;
        const nextGenerated = metadata.altTextGenerated === true ||
          (storedGenerated && !textChanged);
        if (
          isDeepStrictEqual(comparableBefore, after) &&
          nextGenerated === storedGenerated
        ) {
          const summary = mediaAssetSummary(assetId, stored);
          if (!summary) {
            throw new UpdateMediaRejection(409, "This media asset record is invalid.");
          }
          return { asset: summary, changed: false };
        }

        const timestamp = now();
        const updatedRecord = {
          ...stored,
          ...normalized,
          altTextGenerated: nextGenerated,
          id: assetId,
          version: stored.version + 1,
          updatedAt: timestamp,
          updatedBy: user.uid,
        };
        const summary = mediaAssetSummary(assetId, updatedRecord);
        if (!summary) {
          throw new UpdateMediaRejection(409, "This media asset record is invalid.");
        }
        let updated;
        try {
          updated = withMediaDiscovery(assetId, updatedRecord);
        } catch {
          throw new UpdateMediaRejection(409, "This media asset record is invalid.");
        }
        const writeReleaseChange = await preparePublicMediaChangeInTransaction({ firestore, transaction,
          id: assetId, version: updated.version, before: mediaProjection(stored), after: mediaProjection(updated), mediaSource: updated });
        writeReleaseChange();
        transaction.set(assetRef, updated);
        bumpMediaDiscoveryRevision(transaction, firestore, { preserveAdmission: true });
        transaction.set(
          firestore.collection("media_assets_public").doc(assetId),
          mediaProjection(updated),
        );
        transaction.set(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          adminLogEntryFn({
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            action: "media.metadata.update",
            target: `media_assets/${assetId}`,
            before: {
              ...before,
              altTextGenerated: storedGenerated,
              version: stored.version,
            },
            after: {
              ...after,
              altTextGenerated: nextGenerated,
              version: updated.version,
            },
            source,
          }),
        );
        return { asset: summary, changed: true };
      });

      res.set("ETag", outcome.asset.etag);
      res.status(200).json({ success: true, ...outcome });
    } catch (error) {
      if (res.headersSent) return;
      const expected =
        error instanceof UpdateMediaRejection ||
        error instanceof MediaValidationError ||
        error instanceof MediaLibraryValidationError ||
        error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      const status = error?.status ||
        (error?.code === "failed-precondition" ? 503 : 500);
      if (error?.details?.etag) res.set("ETag", error.details.etag);
      if (!expected || status >= 500) {
        log.error("cmsUpdateMediaMetadata failed", error);
      }
      res.status(status).json({
        error: expected
          ? error.message
          : "Failed to update media",
      });
    }
  };
}

const cmsUpdateMediaMetadata = cmsOnRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 30 },
  createCmsUpdateMediaMetadataHandler(),
);

module.exports = {
  EDITABLE_METADATA_FIELDS,
  NOT_FOUND_MESSAGE,
  UpdateMediaRejection,
  cmsUpdateMediaMetadata,
  createCmsUpdateMediaMetadataHandler,
  editableMetadata,
  usageQuery,
  validateMediaMetadataPatch,
};
