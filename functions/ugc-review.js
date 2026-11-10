"use strict";

const { enqueueVideoSearchShard } = require("./lib/video-search-outbox");

const { createHash } = require("node:crypto");
const sharp = require("sharp");
const { FieldValue } = require("firebase-admin/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { withMediaDiscovery } = require("./lib/media-discovery");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { hasGlobalCapability } = require("./lib/rbac");
const { principalFromStoredUserDoc } = require("./lib/principal");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { createDefaultStorage, MediaCapacityError, MediaRequestError, RESERVATION_LEASE_MS,
  reserveHashOwner, markObjectReady, commitUpload, objectMetadata, putOrConfirm,
  uploadRecordFromClaim, ownerRef, discardCapacityRejectedUpload,
  discardCategoryRejectedUpload, discardUgcDecisionUpload } = require("./media");
const { mediaProjection, normalizeUploadMetadata, finalObjectKey,
  stagingObjectKey, MAX_IMAGE_PIXELS } = require("./lib/media-contract");
const { addMediaThumbnails } = require("./lib/media-thumbnails");
const { MediaCategoryValidationError, requireActiveMediaCategory } = require("./lib/media-categories");
const { mayUseMediaCategory } = require("./media");
const { createS3MediaUploader } = require("./lib/s3-media-upload");
const { parseSourceMediaAsset } = require("./lib/source-media-contract");
const { runtimeAwsConfig, runtimeRegistry } = require("./lib/media-source-runtime");
const { completedAsset, objectKey } = require("./source-media-uploads");
const { PHOTO_MAX_BYTES, UGC_TYPES } = require("./lib/ugc-contract");
const { readBoundedBody, runtimeStorage } = require("./ugc-intake");

const UGC_R2_ACCESS_KEY_ID = defineSecret("UGC_R2_ACCESS_KEY_ID");
const UGC_R2_SECRET_ACCESS_KEY = defineSecret("UGC_R2_SECRET_ACCESS_KEY");
const CMS_MEDIA_R2_ACCESS_KEY_ID = defineSecret("CMS_MEDIA_R2_ACCESS_KEY_ID");
const CMS_MEDIA_R2_SECRET_ACCESS_KEY = defineSecret("CMS_MEDIA_R2_SECRET_ACCESS_KEY");
const { IN_PROGRESS, STALE_DECISION_MS, ReviewError, submissionId, listUgcSubmissions } = require("./ugc-review-list");

function licenseFor(record) {
  return `Public submission ${record.consentVersion}, broadcast, web, and social`;
}

function assertImportCategory(actor, category) {
  if (category === "staff-profile" || !mayUseMediaCategory(actor.principal, category)) {
    throw new ReviewError(403, "Media category access denied");
  }
}

function createUgcReviewHandlers(deps = {}) {
  const firestore = deps.firestore ?? db;
  const authenticate = deps.requirePrincipalFn ?? requirePrincipal;
  const verifyAppCheck = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  const storage = deps.storage ?? runtimeStorage;
  const mediaStorage = deps.mediaStorage ?? createDefaultStorage;
  const uploader = deps.uploader ?? (() => createS3MediaUploader(runtimeAwsConfig()));
  const registry = deps.registry ?? runtimeRegistry;
  const now = deps.now ?? (() => new Date());

  async function requireCurrentReviewer(tx, actor) {
    const user = await tx.get(firestore.collection("users").doc(actor.uid));
    const principal = await principalFromStoredUserDoc(firestore, actor.uid, user.data(), tx);
    if (!hasGlobalCapability(principal, "submissions.review")) {
      throw new ReviewError(403, "Global media management access required");
    }
  }

  async function list(req, res) {
    return listUgcSubmissions(firestore, now, req, res);
  }

  async function getPending(id) {
    const ref = firestore.collection("ugcSubmissions").doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data().status !== "pending") {
      throw new ReviewError(404, "Submission is not pending");
    }
    return { ref, record: snapshot.data() };
  }

  async function preview(req, res) {
    const { record } = await getPending(submissionId(req.body.submissionId));
    const store = storage();
    if (!UGC_TYPES[record.file?.type]) throw new ReviewError(404, "Preview unavailable");
    const url = await store.signGet(record.quarantineKey, 3600);
    res.status(200).json({ success: true, mimeType: record.file.type,
      url, expiresAt: new Date(now().getTime() + 3_600_000).toISOString() });
  }

  async function claim(id, decision, actor, category) {
    const ref = firestore.collection("ugcSubmissions").doc(id);
    const startedAt = now().toISOString();
    const record = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ReviewError(404, "Submission not found");
      const current = snap.data();
      if (current.status === "imported" || current.status === "rejected") return current;
      if (current.status !== "pending" && !IN_PROGRESS.includes(current.status)) {
        throw new ReviewError(409, "Submission decision is in progress");
      }
      if (IN_PROGRESS.includes(current.status) &&
          !(Date.parse(current.decisionStartedAt ?? "") <= now().getTime() - STALE_DECISION_MS)) {
        throw new ReviewError(409, "Submission decision is in progress");
      }
      if (decision === "importing") {
        await requireActiveMediaCategory(tx, firestore, category);
      }
      tx.update(ref, { status: decision, decisionActor: actor.uid,
        decisionCategory: category ?? null, decisionStartedAt: startedAt });
      return current;
    });
    return { ref, record, startedAt };
  }

  async function resetClaim(ref, actor, decision, startedAt) {
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.data()?.status === decision && snap.data()?.decisionActor === actor.uid &&
          snap.data()?.decisionStartedAt === startedAt) {
        tx.update(ref, { status: "pending", decisionActor: FieldValue.delete(),
          decisionCategory: FieldValue.delete(), decisionStartedAt: FieldValue.delete() });
      }
    });
  }

  async function finalize(ref, record, actor, decision, startedAt, asset = null) {
    const finalized = await firestore.runTransaction(async (tx) => {
      if (decision === "importing") await requireCurrentReviewer(tx, actor);
      const snap = await tx.get(ref);
      const current = snap.data();
      if (current?.status === decision && current.decisionStartedAt === startedAt &&
          current.decisionActor === actor.uid) {
        if (asset?.kind === "image" && asset.duplicate) {
          const existing = await tx.get(firestore.collection("media_assets").doc(asset.id));
          if (!existing.exists || existing.data()?.lifecycle !== "active" ||
              existing.data()?.contentHash !== asset.expectedHash) {
            throw new ReviewError(409, "This photo matches a library asset that is not active");
          }
        }
        const decidedAt = now().toISOString();
        const publicAsset = asset ? Object.fromEntries(Object.entries(asset)
          .filter(([key]) => key !== "expectedHash")) : null;
        tx.update(ref, {
          status: decision === "importing" ? "imported" : "rejected",
          email: FieldValue.delete(),
          ...(decision === "importing" ? { expireAt: FieldValue.delete() } : {}),
          ...(decision === "rejecting" ? {
            name: FieldValue.delete(), message: FieldValue.delete(),
          } : {}),
          ...(publicAsset ? { importedAsset: publicAsset } : {}),
          decidedAt, decisionActor: actor.uid,
        });
        tx.create(firestore.collection("ugcReviewAudit").doc(), {
          submissionId: ref.id, decision: decision === "importing" ? "imported" : "rejected",
          actorUid: actor.uid, decidedAt, consentVersion: record.consentVersion,
        });
        return true;
      }
      return false;
    });
    if (!finalized) throw new ReviewError(409, "Submission decision changed during processing");
    return finalized;
  }

  async function discardUncommittedPhotoClaim(ref, owner, media, nowIso) {
    if (!["reserved", "object_ready"].includes(owner.state)) {
      throw new ReviewError(409, "The photo import claim needs recovery before this decision");
    }
    await discardUgcDecisionUpload({ firestore, storage: media, ref,
      attemptId: owner.attemptId, finalKey: owner.finalKey,
      stagingKeys: [owner.stagingKey], nowIso, leaseExpiresAt: owner.leaseExpiresAt });
  }

  async function clearInterruptedImport(record) {
    const id = record.submissionId;
    if (UGC_TYPES[record.file.type]?.kind === "video") {
      const videoAsset = await firestore.collection("mediaSourceAssets").doc(id).get();
      if (videoAsset.exists && videoAsset.data()?.lifecycle !== "deleted") {
        throw new ReviewError(409, "The video is already in the library");
      }
      const source = registry().get("video-library");
      if (!source) throw new ReviewError(503, "Videos are unavailable");
      const upload = uploader();
      if (typeof upload.head !== "function") {
        throw new ReviewError(503, "Video object check is unavailable");
      }
      try {
        const object = await upload.head(source, {
          objectKey: objectKey(source, id, record.file.type) });
        if (object) throw new ReviewError(409,
          "The private video object must be recovered before rejection");
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        if (!["NotFound", "NoSuchKey"].includes(error?.name) &&
            error?.$metadata?.httpStatusCode !== 404) throw error;
      }
      return;
    }
    const photoAsset = await firestore.collection("media_assets").doc(id).get();
    if (photoAsset.exists && photoAsset.data()?.lifecycle === "deleted") return;
    if (photoAsset.exists) {
      throw new ReviewError(409, "The photo is already in the library");
    }
    const claims = await firestore.collection("system").doc("media")
      .collection("hashOwners").where("assetId", "==", id).get();
    if (claims.empty) return;
    const media = mediaStorage();
    for (const snap of claims.docs) {
      const owner = snap.data();
      if (owner.attemptId !== id) continue;
      await discardUncommittedPhotoClaim(snap.ref, owner, media, now().toISOString());
    }
  }

  async function reject(req, res, actor) {
    const id = submissionId(req.body.submissionId);
    const { ref, record, startedAt } = await claim(id, "rejecting", actor);
    if (record.status === "imported") throw new ReviewError(409, "Submission was imported");
    try {
      if (record.status !== "rejected") {
        await clearInterruptedImport(record);
        await finalize(ref, record, actor, "rejecting", startedAt);
      }
      if (record.quarantineKey) {
        await storage().rejectUpload(record.quarantineKey);
        await ref.update({ quotaKey: record.quarantineKey, quarantineKey: FieldValue.delete() });
      }
    } catch (error) {
      await resetClaim(ref, actor, "rejecting", startedAt);
      throw error;
    }
    res.status(200).json({ success: true, status: "rejected" });
  }

  async function importPhoto(record, actor, category) {
    const original = await readBoundedBody(await storage().read(record.quarantineKey), record.file.size);
    if (original.length !== record.file.size ||
        createHash("sha256").update(original).digest("hex") !== record.contentHash) {
      throw new ReviewError(409, "Quarantine file changed");
    }
    const { inspectUpload } = require("./media");
    const inspection = await inspectUpload(original, record.file.type);
    if (inspection.animated && record.file.type !== "image/webp") {
      throw new ReviewError(415, "Animated photo type is unavailable");
    }
    let bytes;
    try {
      const output = sharp(original, { animated: inspection.animated,
        failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
      switch (record.file.type) {
        case "image/jpeg": bytes = await output.jpeg({ quality: 85, mozjpeg: true }).toBuffer(); break;
        case "image/png": bytes = await output.png({ compressionLevel: 9 }).toBuffer(); break;
        case "image/webp": bytes = await output.webp({ quality: 85 }).toBuffer(); break;
        case "image/avif": bytes = await output.avif({ quality: 65 }).toBuffer(); break;
        default: throw new ReviewError(415, "Photo type is unavailable");
      }
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      throw new ReviewError(422, "The photo could not be decoded");
    }
    if (bytes.length > PHOTO_MAX_BYTES) throw new ReviewError(413, "Processed photo is too large");
    const dimensions = await inspectUpload(bytes, record.file.type);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const existingOwner = await ownerRef(firestore, contentHash).get();
    if (existingOwner.data()?.state === "committed" &&
        !existingOwner.data().supersededByContentHash) {
      const existing = await firestore.collection("media_assets")
        .doc(existingOwner.data().assetId).get();
      if (!existing.exists || existing.data()?.lifecycle !== "active" ||
          existing.data()?.contentHash !== contentHash) {
        throw new ReviewError(409, "This photo matches a library asset that is not active");
      }
      if (existing.data().category === "staff-profile") {
        throw new ReviewError(409, "This file belongs to the staff profile library");
      }
      return { kind: "image", id: existing.id, duplicate: true, expectedHash: contentHash };
    }
    const metadata = normalizeUploadMetadata({
      name: (record.file.name.replace(/\.[^.]+$/, "") || record.file.name).slice(0, 180), category,
      license: licenseFor(record), credit: record.name,
      description: record.message, altText: "", tags: ["public-submission"],
    }, record.file.name);
    const date = now();
    const nowIso = date.toISOString();
    const assetId = record.submissionId;
    const attemptId = record.submissionId;
    const finalKey = finalObjectKey({ category, assetId, contentHash,
      mimeType: record.file.type });
    const claim = { state: "reserved", attemptId, assetId, category, finalKey,
      stagingKey: stagingObjectKey(attemptId), sizeBytes: bytes.length,
      mimeType: record.file.type,
      recordSeed: { metadata, originalName: record.file.name,
        dimensions: { width: dimensions.width, height: dimensions.height },
        animated: dimensions.animated,
        actor: { uid: actor.uid, email: actor.email ?? null }, source: "ugc" },
      createdAt: nowIso, updatedAt: nowIso,
      leaseExpiresAt: new Date(date.getTime() + RESERVATION_LEASE_MS).toISOString() };
    const media = mediaStorage();
    if (existingOwner.data()?.attemptId === attemptId &&
        existingOwner.data().category !== category &&
        existingOwner.data().state !== "committed") {
      const previousRef = ownerRef(firestore, contentHash);
      await discardUncommittedPhotoClaim(previousRef, existingOwner.data(), media, nowIso);
    }
    const expected = { contentHash, assetId, attemptId,
      sizeBytes: bytes.length, mimeType: record.file.type };
    await media.putStaging({ key: claim.stagingKey, body: bytes,
      mimeType: record.file.type, metadata: objectMetadata(expected) });
    let reservation;
    try {
      reservation = await reserveHashOwner({ firestore, contentHash,
        claim, nowDate: date, principal: actor.principal, actorUid: actor.uid });
    } catch (error) {
      await media.deleteStaging(claim.stagingKey).catch(() => {});
      if (error instanceof MediaRequestError && error.status === 409 &&
          error.details?.duplicateAssetId) {
        const existing = await firestore.collection("media_assets")
          .doc(error.details.duplicateAssetId).get();
        if (!existing.exists || existing.data()?.lifecycle !== "active" ||
            existing.data()?.contentHash !== contentHash) {
          throw new ReviewError(409, "This photo matches a library asset that is not active");
        }
        if (existing.data()?.category === "staff-profile") {
          throw new ReviewError(409, "This file belongs to the staff profile library");
        }
        return { kind: "image", id: error.details.duplicateAssetId, duplicate: true, expectedHash: contentHash };
      }
      throw error;
    }
    const active = reservation.claim;
    const activeExpected = { contentHash, assetId: active.assetId,
      attemptId: active.attemptId, sizeBytes: active.sizeBytes, mimeType: active.mimeType };
    await putOrConfirm({ storage: media, method: "putFinal", key: active.finalKey,
      body: bytes, mimeType: active.mimeType, metadata: objectMetadata(activeExpected),
      expected: activeExpected });
    await markObjectReady({ firestore, ref: reservation.ref,
      attemptId: active.attemptId, nowIso });
    // A resumed reservation can belong to a different, now-revoked reviewer.
    const mediaRecord = withMediaDiscovery(active.assetId, { ...uploadRecordFromClaim({ contentHash,
      claim: active, publicOrigin: deps.publicOrigin ?? "https://media.njpbs.org", nowIso,
      thumbnailAttempt: true }),
    altText: "", createdBy: actor.uid, updatedBy: actor.uid });
    try {
      await commitUpload({ firestore, ref: reservation.ref, attemptId: active.attemptId,
        record: mediaRecord, projection: mediaProjection(mediaRecord),
        authorizeInTransaction: (tx) => requireCurrentReviewer(tx, actor),
        actor, source: "ugc", nowIso });
    } catch (error) {
      if (!(error instanceof MediaCapacityError) &&
          !(error instanceof MediaCategoryValidationError)) throw error;
      const discard = error instanceof MediaCapacityError
        ? discardCapacityRejectedUpload : discardCategoryRejectedUpload;
      await discard({ firestore, storage: media, ref: reservation.ref,
        attemptId: active.attemptId, finalKey: active.finalKey,
        stagingKeys: [active.stagingKey, claim.stagingKey], nowIso,
        leaseExpiresAt: active.leaseExpiresAt });
      throw error;
    }
    await media.deleteStaging(active.stagingKey).catch(() => {});
    await addMediaThumbnails({ firestore, storage: media, record: mediaRecord,
      buffer: bytes, publicOrigin: deps.publicOrigin ?? "https://media.njpbs.org",
      log: logger });
    return { kind: "image", id: active.assetId, duplicate: false };
  }

  async function importVideo(record, actor, category, startedAt) {
    const source = registry().get("video-library");
    if (!source?.writable) throw new ReviewError(503, "Videos are unavailable");
    const assetId = record.submissionId;
    const session = { id: record.submissionId, assetId, sourceId: source.id,
      actorUid: actor.uid, originalName: record.file.name,
      mimeType: record.file.type, sizeBytes: record.file.size,
      contentHash: record.contentHash,
      objectKey: objectKey(source, assetId, record.file.type),
      metadata: { name: record.file.name.replace(/\.[^.]+$/, ""),
        description: record.message, license: licenseFor(record),
        credit: record.name, tags: ["public-submission"], rightsStatus: "pending" } };
    const existing = await firestore.collection("mediaSourceAssets").doc(assetId).get();
    if (existing.exists) {
      const asset = parseSourceMediaAsset(assetId, existing.data());
      if (!asset || asset.objectKey !== session.objectKey ||
          asset.sourceId !== source.id || existing.data().ugcCategory !== category ||
          asset.rightsStatus !== "pending") {
        throw new ReviewError(409, "Video asset id is occupied");
      }
      return { kind: "video", id: assetId, sourceId: source.id };
    }
    const upload = uploader();
    let head = null;
    if (typeof upload.head === "function") {
      try {
        head = await upload.head(source, session);
      } catch (error) {
        if (!["NotFound", "NoSuchKey"].includes(error?.name) &&
            error?.$metadata?.httpStatusCode !== 404) throw error;
      }
    }
    if (head && (head.ContentLength !== session.sizeBytes ||
        head.Metadata?.["boardwalk-session"] !== session.id ||
        head.Metadata?.["boardwalk-asset"] !== session.assetId)) {
      throw new ReviewError(409, "Video object key is occupied");
    }
    head ??= await upload.importStream(source, session,
      await storage().read(record.quarantineKey));
    const asset = { ...completedAsset(session, head, now().toISOString()),
      ugcCategory: category, source: "upload", altText: "" };
    // The ordinary completion path starts preview jobs. Public submissions stay
    // rights-pending and have no rendition or transcript until staff acts later.
    if (!parseSourceMediaAsset(asset.id, asset)) throw new ReviewError(503, "Video asset is invalid");
    await firestore.runTransaction(async (tx) => {
      await requireCurrentReviewer(tx, actor);
      const ref = firestore.collection("mediaSourceAssets").doc(asset.id);
      const statsRef = firestore.collection("mediaSourceStats").doc(source.id);
      const submissionRef = firestore.collection("ugcSubmissions").doc(record.submissionId);
      const [snap, stats, submission] = await Promise.all([
        tx.get(ref), tx.get(statsRef), tx.get(submissionRef),
      ]);
      if (submission.data()?.status !== "importing" ||
          submission.data()?.decisionStartedAt !== startedAt ||
          submission.data()?.decisionActor !== actor.uid) {
        throw new ReviewError(409, "Submission decision changed during video import");
      }
      await requireActiveMediaCategory(tx, firestore, category);
      if (!snap.exists) {
        tx.create(ref, asset);
        enqueueVideoSearchShard(tx, firestore, asset.id, asset.sourceId);
        tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          adminLogEntry({ actorUid: actor.uid, actorEmail: actor.email ?? null,
            action: "media.upload", target: `mediaSourceAssets/${asset.id}`,
            after: { sourceId: asset.sourceId, name: asset.name,
              rightsStatus: asset.rightsStatus, tags: asset.tags } }));
        if (stats.data()?.exact === true && Number.isSafeInteger(stats.data().activeCount)) {
          tx.update(statsRef, { activeCount: stats.data().activeCount + 1,
            updatedAt: asset.updatedAt });
        }
      } else if (snap.data().objectKey !== asset.objectKey ||
          snap.data().ugcCategory !== category) {
        throw new ReviewError(409, "Video asset id is occupied");
      }
    });
    return { kind: "video", id: asset.id, sourceId: source.id };
  }

  async function importSubmission(req, res, actor) {
    const id = submissionId(req.body.submissionId);
    const category = req.body.category;
    if (typeof category !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category)) {
      throw new ReviewError(400, "Invalid media category");
    }
    assertImportCategory(actor, category);
    const { ref, record, startedAt } = await claim(id, "importing", actor, category);
    if (record.status === "rejected") throw new ReviewError(409, "Submission was rejected");
    if (record.status === "imported") {
      if (record.quarantineKey) {
        await storage().delete(record.quarantineKey);
        await ref.update({ quarantineKey: FieldValue.delete() });
      }
      res.status(200).json({ success: true, status: "imported", asset: record.importedAsset });
      return;
    }
    try {
      const asset = UGC_TYPES[record.file.type]?.kind === "image"
        ? await importPhoto(record, actor, category)
        : await importVideo(record, actor, category, startedAt);
      await finalize(ref, record, actor, "importing", startedAt, asset);
      await storage().delete(record.quarantineKey);
      await ref.update({ quarantineKey: FieldValue.delete() });
      const publicAsset = { ...asset };
      delete publicAsset.expectedHash;
      res.status(200).json({ success: true, status: "imported", asset: publicAsset });
    } catch (error) {
      await resetClaim(ref, actor, "importing", startedAt);
      throw error;
    }
  }

  function endpoint(handler) {
    return async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        if (req.method !== "POST") throw new ReviewError(405, "Method not allowed");
        validateBoundedJsonRequest(req, 4096);
        await verifyAppCheck(req.headers?.["x-firebase-appcheck"]);
        const actor = await authenticate(req);
        if (!hasGlobalCapability(actor.principal, "submissions.review")) {
          throw new ReviewError(403, "Global media management access required");
        }
        await handler(req, res, actor);
      } catch (error) {
        if ((error.status ?? 500) >= 500) logger.error("UGC review failed", { error });
        res.status(error.status ?? 500).json({ error: error.status && error.status < 500
          ? error.message : "Submission review is unavailable" });
      }
    };
  }
  return { list: endpoint(list), preview: endpoint(preview),
    reject: endpoint(reject), importSubmission: endpoint(importSubmission) };
}

const handlers = createUgcReviewHandlers();
const readOptions = { memory: "1GiB", concurrency: 10, maxInstances: 5,
  secrets: [UGC_R2_ACCESS_KEY_ID, UGC_R2_SECRET_ACCESS_KEY] };
const writeOptions = { memory: "1GiB", concurrency: 1, maxInstances: 5,
  timeoutSeconds: 540, secrets: [UGC_R2_ACCESS_KEY_ID, UGC_R2_SECRET_ACCESS_KEY,
    CMS_MEDIA_R2_ACCESS_KEY_ID, CMS_MEDIA_R2_SECRET_ACCESS_KEY] };
const cmsGetUgcSubmissionPreview = cmsOnRequest(readOptions, handlers.preview);
const cmsRejectUgcSubmission = cmsOnRequest(writeOptions, handlers.reject);
const cmsImportUgcSubmission = cmsOnRequest(writeOptions, handlers.importSubmission);

module.exports = { createUgcReviewHandlers,
  cmsGetUgcSubmissionPreview, cmsRejectUgcSubmission, cmsImportUgcSubmission };
