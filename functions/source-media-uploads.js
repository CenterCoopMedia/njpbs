"use strict";

const { enqueueVideoSearchShard } = require("./lib/video-search-outbox");

const { PREVIEW_JOBS, pendingPreview, renditionState } = require("./lib/video-preview-job");


const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { can, hasCapability } = require("./lib/rbac");
const { presentSourceMediaAsset } = require("./lib/source-media-uploader");
const { authorizeMediaSource, objectKeyWithinSource } = require("./lib/media-sources");
const {
  normalizeSourceMediaNameSort,
  parseSourceMediaAsset,
  sourceMediaAssetDetail,
} = require("./lib/source-media-contract");
const {
  VIDEO_MIME_EXTENSIONS,
  choosePartSize,
  expectedPartSize,
  parseDeleteSourceMediaRequest,
  parseMetadataUpdateRequest,
  parseSessionRequest,
  parseSignUploadPartsRequest,
  parseStartUploadRequest,
} = require("./lib/source-media-upload-contract");
const { compositeSha256, createS3MediaUploader } = require("./lib/s3-media-upload");
const {
  FUNCTION_SERVICE_ACCOUNT,
  runtimeAwsConfig,
  runtimeRegistry,
} = require("./source-media");

const { WRITE_SECRETS } = require("./lib/private-video-runtime");

const KIB = 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COLLECTION = "mediaSourceUploads";
const PREVIEW_ADMISSION_LOCKS = "mediaSourcePreviewAdmissionLocks";
const MAX_ACTIVE_PREVIEWS_PER_ACTOR = 2;
const MAX_ACTIVE_PREVIEWS_GLOBAL = 20;

function previewHoldId(sessionId) {
  return `hold-${sessionId}`;
}

function assertPreviewCapacity(actorPreviews, globalPreviews) {
  if (actorPreviews.size >= MAX_ACTIVE_PREVIEWS_PER_ACTOR) {
    throw new SourceUploadError(429, "Wait for your viewing copies to finish");
  }
  if (globalPreviews.size >= MAX_ACTIVE_PREVIEWS_GLOBAL) {
    throw new SourceUploadError(503, "Viewing-copy processing is at capacity");
  }
}

function previewAdmissionLocks(firestore, actorUid) {
  const locks = firestore.collection(PREVIEW_ADMISSION_LOCKS);
  return [locks.doc("global"), locks.doc(`actor-${encodeURIComponent(actorUid)}`)];
}

function advancePreviewAdmissionLocks(transaction, refs, snapshots) {
  refs.forEach((ref, index) => transaction.set(ref, {
    revision: (snapshots[index].data()?.revision ?? 0) + 1,
  }));
}

async function reservePreviewAdmission(transaction, firestore, session) {
  if (session.sourceId !== "video-library") return;
  const previewJobs = firestore.collection(PREVIEW_JOBS);
  const holdRef = previewJobs.doc(previewHoldId(session.id));
  const lockRefs = previewAdmissionLocks(firestore, session.actorUid);
  const [holdSnapshot, actorPreviews, globalPreviews, ...lockSnapshots] = await Promise.all([
    transaction.get(holdRef),
    transaction.get(previewJobs.where("actorUid", "==", session.actorUid)
      .where("active", "==", true).limit(MAX_ACTIVE_PREVIEWS_PER_ACTOR)),
    transaction.get(previewJobs.where("active", "==", true)
      .limit(MAX_ACTIVE_PREVIEWS_GLOBAL)),
    ...lockRefs.map((ref) => transaction.get(ref)),
  ]);
  if (holdSnapshot.exists && holdSnapshot.data()?.active === true) return;
  assertPreviewCapacity(actorPreviews, globalPreviews);
  advancePreviewAdmissionLocks(transaction, lockRefs, lockSnapshots);
  transaction.set(holdRef, {
    active: true,
    actorUid: session.actorUid,
    phase: "reserved",
    sessionId: session.id,
  });
}

async function releasePreviewReservation(firestore, session) {
  if (session.sourceId !== "video-library") return;
  const sessionRef = firestore.collection(COLLECTION).doc(session.id);
  const holdRef = firestore.collection(PREVIEW_JOBS).doc(previewHoldId(session.id));
  await firestore.runTransaction(async (transaction) => {
    const [sessionSnapshot, holdSnapshot] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(holdRef),
    ]);
    const current = sessionSnapshot.exists
      ? validSession(sessionSnapshot.id, sessionSnapshot.data())
      : null;
    if (holdSnapshot.exists && holdSnapshot.data()?.active === true) {
      transaction.update(holdRef, { active: false, phase: "released" });
    }
    if (current?.status === "completing") {
      transaction.update(sessionRef, {
        status: "active",
        version: current.version + 1,
      });
    }
  });
}

class SourceUploadError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "SourceUploadError";
    this.status = status;
    this.details = details;
  }
}

function objectKey(source, assetId, mimeType) {
  const prefix = source.prefix && !source.prefix.endsWith("/")
    ? `${source.prefix}/`
    : source.prefix;
  return `${prefix}objects/${assetId}${VIDEO_MIME_EXTENSIONS[mimeType]}`;
}

function publicUpload(session, completedParts = []) {
  return {
    sessionId: session.id,
    assetId: session.assetId,
    sourceId: session.sourceId,
    originalName: session.originalName,
    mimeType: session.mimeType,
    sizeBytes: session.sizeBytes,
    lastModified: session.lastModified,
    partSize: session.partSize,
    totalParts: session.totalParts,
    completedParts,
    expiresAt: session.expiresAt,
    version: session.version,
  };
}

function validSession(id, data) {
  return data && typeof data === "object" && data.id === id &&
    typeof data.actorUid === "string" && typeof data.sourceId === "string" &&
    typeof data.assetId === "string" && typeof data.objectKey === "string" &&
    typeof data.s3UploadId === "string" && Number.isSafeInteger(data.version) &&
    ["active", "canceling", "completing", "completed", "canceled"].includes(data.status)
    ? data
    : null;
}

async function loadSession(firestore, sessionId) {
  const snapshot = await firestore.collection(COLLECTION).doc(sessionId).get();
  const session = snapshot.exists ? validSession(snapshot.id, snapshot.data()) : null;
  if (!session) throw new SourceUploadError(404, "Upload session not found");
  return session;
}

function requireOwnedSession(
  session,
  actor,
  request,
  { checkExpiry = true, checkVersion = true, nowMs = Date.now() } = {},
) {
  if (!session) {
    throw new SourceUploadError(409, "Upload session changed; resume it and try again");
  }
  if (session.actorUid !== actor.uid || session.sourceId !== request.sourceId) {
    throw new SourceUploadError(404, "Upload session not found");
  }
  if (session.replacement && !can(actor.principal, "media.video.manage", {})) {
    throw new SourceUploadError(403, "You do not have permission to replace video files");
  }
  if (checkVersion && session.version !== request.version) {
    throw new SourceUploadError(409, "Upload session changed; resume it and try again");
  }
  if (
    checkExpiry && Date.parse(session.expiresAt) <= nowMs &&
    session.status !== "completed"
  ) {
    throw new SourceUploadError(410, "Upload session expired");
  }
}

function currentTime(nowFn) {
  const now = nowFn();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Upload clock returned an invalid timestamp");
  return { now, nowMs };
}

function requireActiveSession(session) {
  if (session.status !== "active") {
    throw new SourceUploadError(409, "Upload session is not ready for more parts");
  }
}

function validatePartWindow(session, parts) {
  for (const part of parts) {
    if (part.partNumber > session.totalParts) {
      throw new SourceUploadError(400, "Part number exceeds this upload");
    }
    const expected = expectedPartSize(
      session.sizeBytes,
      session.partSize,
      part.partNumber,
      session.totalParts,
    );
    if (part.sizeBytes !== expected) {
      throw new SourceUploadError(400, "Part size does not match this upload");
    }
  }
}

function verifiedCompletedParts(session, parts) {
  if (parts.length !== session.totalParts) {
    throw new SourceUploadError(409, "Upload still has incomplete parts");
  }
  return parts
    .sort((left, right) => left.partNumber - right.partNumber)
    .map((part, index) => {
      const partNumber = index + 1;
      const signed = session.signedParts?.[partNumber];
      const size = expectedPartSize(
        session.sizeBytes,
        session.partSize,
        partNumber,
        session.totalParts,
      );
      if (
        part.partNumber !== partNumber || part.sizeBytes !== size ||
        typeof part.etag !== "string" || !part.etag ||
        part.checksumSha256 !== signed?.checksumSha256 || signed?.sizeBytes !== size
      ) {
        throw new SourceUploadError(409, "Uploaded parts do not match the signed manifest");
      }
      return part;
    });
}

function signedManifestChecksum(session) {
  const parts = [];
  for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
    const part = session.signedParts?.[partNumber];
    const size = expectedPartSize(
      session.sizeBytes,
      session.partSize,
      partNumber,
      session.totalParts,
    );
    if (part?.partNumber !== partNumber || part.sizeBytes !== size ||
        typeof part.checksumSha256 !== "string") {
      throw new SourceUploadError(409, "Upload checksum manifest is incomplete");
    }
    parts.push(part);
  }
  return compositeSha256(parts);
}

function browserPreview(mimeType) {
  return ["video/mp4", "video/webm", "video/mpeg"].includes(mimeType)
    ? "browser"
    : "download_only";
}

function auditMetadata(asset) {
  return {
    sourceId: asset.sourceId,
    name: asset.name,
    originalName: asset.originalName,
    description: asset.description,
    metadataUpdateRequested: asset.metadataUpdateRequested === true,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    preview: asset.preview,
    license: asset.license,
    credit: asset.credit,
    tags: asset.tags,
    markers: asset.markers ?? [],
    parentSource: asset.parentSource ?? null,
    rightsStatus: asset.rightsStatus,
    version: asset.version,
  };
}

function completedAsset(session, head, now) {
  const versionId = head.VersionId;
  if (
    typeof versionId !== "string" || !versionId ||
    head.ContentLength !== session.sizeBytes ||
    head.Metadata?.["boardwalk-session"] !== session.id ||
    head.Metadata?.["boardwalk-asset"] !== session.assetId
  ) {
    throw new SourceUploadError(409, "Completed object does not match its upload session");
  }
  return {
    id: session.assetId,
    sourceId: session.sourceId,
    lifecycle: "active",
    name: session.metadata.name,
    originalName: session.originalName,
    description: session.metadata.description,
    metadataUpdateRequested: session.metadata.metadataUpdateRequested === true,
    nameSort: normalizeSourceMediaNameSort(session.metadata.name),
    updatedAtSort: now,
    mimeType: session.mimeType,
    kind: "video",
    sizeBytes: session.sizeBytes,
    preview: browserPreview(session.mimeType),
    license: session.metadata.license,
    credit: session.metadata.credit,
    tags: session.metadata.tags,
    markers: session.metadata.markers ?? [],
    parentSource: session.parentSource ?? null,
    rightsStatus: session.metadata.rightsStatus,
    version: 1,
    createdAt: now,
    createdBy: session.actorUid,
    updatedAt: now,
    updatedBy: session.actorUid,
    objectKey: session.objectKey,
    objectVersionId: versionId,
    checksumSha256: head.ChecksumSHA256,
  };
}

async function storeCompletedAsset(
  firestore,
  session,
  asset,
  actor = { uid: session.actorUid },
  adminLogEntryFn = adminLogEntry,
) {
  if (session.replacement) return require("./lib/source-video-replacement").storeReplacementCandidate({
    firestore, session, candidate: asset, actor, audit: adminLogEntryFn });
  const sessionRef = firestore.collection(COLLECTION).doc(session.id);
  const assetRef = firestore.collection("mediaSourceAssets").doc(asset.id);
  const statsRef = firestore.collection("mediaSourceStats").doc(asset.sourceId);
  return firestore.runTransaction(async (transaction) => {
    const previewJobs = firestore.collection(PREVIEW_JOBS);
    const holdRef = previewJobs.doc(previewHoldId(session.id));
    const lockRefs = previewAdmissionLocks(firestore, session.actorUid);
    const actorPreviewQuery = previewJobs.where("actorUid", "==", session.actorUid)
      .where("active", "==", true).limit(MAX_ACTIVE_PREVIEWS_PER_ACTOR);
    const globalPreviewQuery = previewJobs.where("active", "==", true)
      .limit(MAX_ACTIVE_PREVIEWS_GLOBAL);
    const [currentSessionSnapshot, existingAssetSnapshot, statsSnapshot,
      actorPreviews, globalPreviews, holdSnapshot, ...lockSnapshots] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(assetRef),
      transaction.get(statsRef),
      transaction.get(actorPreviewQuery),
      transaction.get(globalPreviewQuery),
      transaction.get(holdRef),
      ...lockRefs.map((ref) => transaction.get(ref)),
    ]);
    const current = currentSessionSnapshot.exists
      ? validSession(currentSessionSnapshot.id, currentSessionSnapshot.data())
      : null;
    if (!current || current.actorUid !== session.actorUid) {
      throw new SourceUploadError(409, "Upload session changed");
    }
    if (existingAssetSnapshot.exists) {
      const existing = parseSourceMediaAsset(asset.id, existingAssetSnapshot.data());
      if (!existing || existing.objectKey !== asset.objectKey ||
          existing.objectVersionId !== asset.objectVersionId) {
        throw new SourceUploadError(409, "Asset id is already in use");
      }
    } else {
      if (asset.sourceId === "video-library") {
        const holdActive = holdSnapshot.exists && holdSnapshot.data()?.active === true;
        if (!holdActive) {
          assertPreviewCapacity(actorPreviews, globalPreviews);
          advancePreviewAdmissionLocks(transaction, lockRefs, lockSnapshots);
        }
        const job = { ...pendingPreview(asset), actorUid: session.actorUid };
        asset = { ...asset, rendition: renditionState(job, "processing") };
        transaction.create(firestore.collection(PREVIEW_JOBS).doc(job.id), job);
      }
      transaction.create(assetRef, asset);
      enqueueVideoSearchShard(transaction, firestore, asset.id, asset.sourceId);
      transaction.create(
        firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
        adminLogEntryFn({
          actorUid: actor.uid,
          actorEmail: actor.email ?? null,
          action: "media.upload",
          target: `mediaSourceAssets/${asset.id}`,
          before: null,
          after: auditMetadata(asset),
        }),
      );
      const stats = statsSnapshot.exists ? statsSnapshot.data() : null;
      if (stats?.exact === true && Number.isSafeInteger(stats.activeCount)) {
        transaction.update(statsRef, {
          activeCount: stats.activeCount + 1,
          updatedAt: asset.updatedAt,
        });
      }
    }
    if (holdSnapshot.exists && holdSnapshot.data()?.active === true) {
      transaction.update(holdRef, { active: false, phase: "consumed" });
    }
    const summary = sourceMediaAssetDetail(existingAssetSnapshot.exists
      ? parseSourceMediaAsset(asset.id, existingAssetSnapshot.data())
      : parseSourceMediaAsset(asset.id, asset));
    transaction.set(sessionRef, {
      status: "completed",
      version: current.status === "completed" ? current.version : current.version + 1,
      completedAt: asset.updatedAt,
      assetSummary: summary,
    }, { merge: true });
    return summary;
  });
}

function makeHandler({ maxBytes, parse, operation, run, usesUploader = true }, deps = {}) {
  const firestore = deps.firestore ?? db;
  const requirePrincipalFn = deps.requirePrincipalFn ?? requirePrincipal;
  const verifyAppCheckFn = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  const registryFn = deps.registryFn ?? runtimeRegistry;
  const authorizeFn = deps.authorizeFn ?? authorizeMediaSource;
  const adminLogEntryFn = deps.adminLogEntryFn ?? adminLogEntry;
  let defaultUploader;
  function uploaderForRequest() {
    defaultUploader ??= createS3MediaUploader(runtimeAwsConfig());
    return deps.uploader ?? defaultUploader;
  }
  const log = deps.log ?? logger;
  const nowFn = deps.nowFn ?? (() => new Date().toISOString());
  const uuidFn = deps.uuidFn ?? randomUUID;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    let actor;
    try {
      validateBoundedJsonRequest(req, maxBytes);
      const request = parse(req.body);
      await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      actor = await requirePrincipalFn(req);
      const source = registryFn().get(request.sourceId);
      await authorizeFn({ firestore, actor, source, operation });
      if (request.replacement || request.sessionId) {
        const session = request.sessionId ? await loadSession(firestore, request.sessionId) : null;
        if (request.replacement || session?.replacement) {
          require("./lib/source-video-replacement").requireReplacePermission(actor, source);
          if (request.replacement && !(deps.replacementEnabledFn ?? require("./lib/media-source-runtime").videoReplacementRuntimeConfig)().enabled) {
            throw new SourceUploadError(503, "Video replacement is waiting for storage cleanup activation. The current video is unchanged.", { code: "replacement_unavailable" });
          }

        }
      }
      const result = await run({
        actor,
        adminLogEntryFn,
        firestore,
        nowFn,
        request,
        source,
        uploader: usesUploader ? uploaderForRequest() : undefined,
        uuidFn,
      });
      const canViewUsers = hasCapability(actor?.principal, "users.view");
      if (result?.asset) {
        result.asset = await presentSourceMediaAsset(firestore, result.asset, canViewUsers);
      }
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      if (res.headersSent) return;
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) log.error("Source media upload request failed", error);
      const details = { ...(error?.details ?? {}) };
      if (details.current) {
        details.current = await presentSourceMediaAsset(
          firestore,
          details.current,
          hasCapability(actor?.principal, "users.view"),
        );
      }
      res.status(status).json({
        error: Number.isInteger(error?.status)
          ? error.message
          : "Source media upload request failed",
        ...details,
      });
    }
  };
}

function replayStartedUpload(session, actor, request) {
  if (session.actorUid !== actor.uid || session.sourceId !== request.sourceId) {
    throw new SourceUploadError(404, "Upload session not found");
  }
  if (session.originalName !== request.originalName || session.mimeType !== request.mimeType ||
      session.sizeBytes !== request.sizeBytes || session.lastModified !== request.lastModified ||
      !isDeepStrictEqual(session.metadata, request.metadata) ||
      !isDeepStrictEqual(session.replacement ?? null, request.replacement ?? null) ||
      !isDeepStrictEqual(session.parentSource ?? null, request.parentSource ?? null)) {
    throw new SourceUploadError(409, "Upload request changed; use the original file and details");
  }
  return { upload: publicUpload(session) };
}

async function startUpload({ actor, firestore, nowFn, request, source, uploader, uuidFn }) {
  // Upload authorization already grants read access to this same shared source.
  if (request.parentSource) {
    const parentRef = firestore.collection("mediaSourceAssets").doc(request.parentSource.assetId);
    const snapshot = await parentRef.get();
    const parent = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
    if (!parent || source.id !== "video-library" || parent.sourceId !== source.id ||
        !objectKeyWithinSource(source, parent.objectKey)) {
      throw new SourceUploadError(404, "Parent media asset not found");
    }
  }
  const id = request.requestId ?? uuidFn();
  const sessionRef = firestore.collection(COLLECTION).doc(id);
  if (request.requestId) {
    const existing = await sessionRef.get();
    if (existing.exists) {
      const session = validSession(existing.id, existing.data());
      if (!session) throw new SourceUploadError(409, "Upload request is unavailable");
      return replayStartedUpload(session, actor, request);
    }
  }
  const assetId = request.replacement?.assetId ?? uuidFn();
  const { now } = currentTime(nowFn);
  const partSize = choosePartSize(request.sizeBytes);
  const session = {
    id,
    actorUid: actor.uid,
    sourceId: source.id,
    assetId,
    objectKey: request.replacement
      ? `${objectKey(source, assetId, request.mimeType).replace(/\.[^.]+$/, "")}/replacements/${id}${VIDEO_MIME_EXTENSIONS[request.mimeType]}`
      : objectKey(source, assetId, request.mimeType),
    originalName: request.originalName,
    mimeType: request.mimeType,
    sizeBytes: request.sizeBytes,
    lastModified: request.lastModified,
    metadata: request.metadata,
    ...(request.replacement ? { replacement: request.replacement } : {}),
    ...(request.parentSource ? { parentSource: request.parentSource } : {}),
    partSize,
    totalParts: Math.ceil(request.sizeBytes / partSize),
    status: "active",
    version: 1,
    signedParts: {},
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + SESSION_TTL_MS).toISOString(),
  };
  if (request.replacement) {
    // Fail before creating multipart storage state; the reservation transaction
    // repeats this check to cover content edits during the external call.
    const publicRecord = (await firestore.doc(`cmsPublicVideos/${assetId}`).get()).data();
    await require("./lib/source-video-replacement").requirePublicationPermission({ firestore, actor, assetId, publicRecord });

  }
  const started = await uploader.start(source, session);
  session.s3UploadId = started.uploadId;
  try {
    if (request.replacement) {
      await firestore.runTransaction(async transaction => {
        // Session and lock commit together. A lost response is replayed below.
        if ((await transaction.get(sessionRef)).exists) throw new SourceUploadError(409, "Upload request is already in use");
        await require("./lib/source-video-replacement").reserveReplacement({
          firestore, transaction, session, actor, source, now });
        transaction.create(sessionRef, session);
      });
    } else await sessionRef.create(session);
  } catch (error) {
    // A failed create response can still mean Firestore committed the session.
    // Read it before deciding whether this S3 upload is safe to abort.
    const stored = await sessionRef.get();
    const persisted = stored.exists ? validSession(stored.id, stored.data()) : null;
    if (persisted?.s3UploadId !== session.s3UploadId) {
      await uploader.cancel(source, session).catch(() => undefined);
    }
    if (!persisted) throw error;
    return replayStartedUpload(persisted, actor, request);
  }
  return { upload: publicUpload(session) };
}

async function signUploadParts({
  actor,
  firestore,
  nowFn = () => new Date().toISOString(),
  request,
  source,
  uploader,
}) {
  const { nowMs } = currentTime(nowFn);
  const session = await loadSession(firestore, request.sessionId);
  requireOwnedSession(session, actor, request, { nowMs });
  requireActiveSession(session);
  validatePartWindow(session, request.parts);
  const parts = await uploader.signParts(source, session, request.parts);
  const sessionRef = firestore.collection(COLLECTION).doc(session.id);
  const newVersion = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(sessionRef);
    const current = snapshot.exists ? validSession(snapshot.id, snapshot.data()) : null;
    requireOwnedSession(current, actor, request, { nowMs });
    requireActiveSession(current);
    const signedParts = { ...current.signedParts };
    for (const part of request.parts) signedParts[part.partNumber] = part;
    transaction.update(sessionRef, { signedParts, version: current.version + 1 });
    return current.version + 1;
  });
  return { version: newVersion, parts };
}

async function readCompletedUploadAsset(firestore, session) {
  const snapshot = await firestore.collection("mediaSourceAssets").doc(session.assetId).get();
  const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
  if (!asset || asset.sourceId !== session.sourceId || (!session.replacement && asset.objectKey !== session.objectKey)) {
    throw new SourceUploadError(410, "Uploaded video is no longer in the library");
  }
  return sourceMediaAssetDetail(asset);
}

async function resumeUpload({
  actor,
  adminLogEntryFn = adminLogEntry,
  firestore,
  nowFn = () => new Date().toISOString(),
  request,
  source,
  uploader,
}) {
  const { now, nowMs } = currentTime(nowFn);
  const session = await loadSession(firestore, request.sessionId);
  requireOwnedSession(session, actor, request, { checkVersion: false, nowMs });
  if (session.status === "completed") return { asset: await readCompletedUploadAsset(firestore, session) };
  if (session.status === "canceled" || session.status === "canceling") {
    throw new SourceUploadError(410, "Upload session was canceled");
  }
  if (session.status === "completing") {
    const head = await tryCompletedHead(uploader, source, session);
    if (head) {
      const checksum = signedManifestChecksum(session);
      if (head.ChecksumSHA256 !== checksum) {
        throw new SourceUploadError(409, "Completed object checksum does not match its parts");
      }
      const asset = completedAsset(session, head, now);
      return {
        asset: await storeCompletedAsset(firestore, session, asset, actor, adminLogEntryFn),
      };
    }
  }
  const listed = await uploader.listParts(source, session);
  const completedParts = listed.flatMap((part) => {
    const signed = session.signedParts?.[part.partNumber];
    return signed?.sizeBytes === part.sizeBytes &&
      signed?.checksumSha256 === part.checksumSha256 && typeof part.etag === "string"
      ? [part]
      : [];
  });
  return { upload: publicUpload(session, completedParts) };
}

async function tryCompletedHead(uploader, source, session, versionId) {
  try {
    return await uploader.head(source, session, versionId);
  } catch (error) {
    if (error?.name === "NotFound" || error?.name === "NoSuchKey" ||
        error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function completeUpload({
  actor,
  adminLogEntryFn = adminLogEntry,
  firestore,
  nowFn = () => new Date().toISOString(),
  request,
  source,
  uploader,
}) {
  const { now, nowMs } = currentTime(nowFn);
  const session = await loadSession(firestore, request.sessionId);
  requireOwnedSession(session, actor, request, { nowMs });
  if (session.status === "completed") return { asset: await readCompletedUploadAsset(firestore, session) };
  if (session.status === "canceled" || session.status === "canceling") {
    throw new SourceUploadError(410, "Upload session was canceled");
  }
  let head = session.status === "completing"
    ? await tryCompletedHead(uploader, source, session)
    : null;
  let checksum = head ? signedManifestChecksum(session) : undefined;
  let versionId;
  if (!head) {
    const parts = verifiedCompletedParts(session, await uploader.listParts(source, session));
    checksum = compositeSha256(parts);
    const sessionRef = firestore.collection(COLLECTION).doc(session.id);
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(sessionRef);
      const current = snapshot.exists ? validSession(snapshot.id, snapshot.data()) : null;
      requireOwnedSession(current, actor, request, { nowMs });
      if (current.status === "completed") return;
      if (current.status === "canceled" || current.status === "canceling") {
        throw new SourceUploadError(410, "Upload session was canceled");
      }
      await reservePreviewAdmission(transaction, firestore, current);
      if (current.status !== "completing") {
        transaction.update(sessionRef, { status: "completing", version: current.version + 1 });
      }
    });
    try {
      const result = await uploader.complete(source, session, parts);
      versionId = result.VersionId;
      if (result.ChecksumSHA256 && result.ChecksumSHA256 !== checksum) {
        throw new SourceUploadError(409, "S3 returned a different multipart checksum");
      }
    } catch (error) {
      head = await tryCompletedHead(uploader, source, session);
      if (!head) {
        await releasePreviewReservation(firestore, session);
        throw error;
      }
    }
  }
  head ??= await uploader.head(source, session, versionId);
  checksum ??= head.ChecksumSHA256;
  if (head.ChecksumSHA256 !== checksum) {
    throw new SourceUploadError(409, "Completed object checksum does not match its parts");
  }
  const asset = completedAsset(session, head, now);
  return {
    asset: await storeCompletedAsset(firestore, session, asset, actor, adminLogEntryFn),
  };
}

function multipartUploadAlreadyAbsent(error) {
  return error?.name === "NoSuchUpload" ||
    error?.code === "NoSuchUpload" || error?.Code === "NoSuchUpload";
}

async function claimCancellation({ actor, firestore, now, nowMs, request, session }) {
  const ref = firestore.collection(COLLECTION).doc(session.id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? validSession(snapshot.id, snapshot.data()) : null;
    requireOwnedSession(current, actor, request, {
      checkExpiry: false,
      checkVersion: false,
      nowMs,
    });
    if (current.status === "completed") {
      throw new SourceUploadError(409, "Completed uploads cannot be canceled", { code: "upload_completed" });
    }
    if (current.status === "canceled" || current.status === "canceling") return current;
    requireOwnedSession(current, actor, request, { checkExpiry: false, nowMs });
    requireActiveSession(current);
    const claimed = {
      ...current,
      status: "canceling",
      version: current.version + 1,
      cancelRequestedAt: now,
    };
    transaction.update(ref, claimed);
    return claimed;
  });
}

async function finishCancellation({ actor, firestore, now, nowMs, request, session }) {
  const ref = firestore.collection(COLLECTION).doc(session.id);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? validSession(snapshot.id, snapshot.data()) : null;
    requireOwnedSession(current, actor, request, {
      checkExpiry: false,
      checkVersion: false,
      nowMs,
    });
    if (current.status === "canceled") return;
    if (current.status !== "canceling") {
      throw new SourceUploadError(409, "Upload session changed during cancellation");
    }
    transaction.update(ref, {
      status: "canceled",
      version: current.version + 1,
      canceledAt: now,
    });
  });
}

async function cancelUpload({
  actor,
  firestore,
  request,
  source,
  uploader,
  nowFn = () => new Date().toISOString(),
}) {
  const { now, nowMs } = currentTime(nowFn);
  const session = await loadSession(firestore, request.sessionId);
  requireOwnedSession(session, actor, request, {
    checkExpiry: false,
    checkVersion: false,
    nowMs,
  });
  if (session.status === "completed") {
    throw new SourceUploadError(409, "Completed uploads cannot be canceled", { code: "upload_completed" });
  }
  if (session.status === "canceled") {
    await require("./lib/source-video-replacement").cancelReplacement({ firestore, session });
    return { canceled: true };
  }
  const canceling = await claimCancellation({
    actor,
    firestore,
    now,
    nowMs,
    request,
    session,
  });
  if (canceling.status === "canceled") {
    await require("./lib/source-video-replacement").cancelReplacement({ firestore, session: canceling });
    return { canceled: true };
  }
  try {
    await uploader.cancel(source, canceling);
  } catch (error) {
    if (!multipartUploadAlreadyAbsent(error)) throw error;
  }
  await finishCancellation({
    actor,
    firestore,
    now,
    nowMs,
    request,
    session: canceling,
  });
  await require("./lib/source-video-replacement").cancelReplacement({ firestore, session: canceling });
  return { canceled: true };
}

async function updateMetadata({
  actor,
  adminLogEntryFn = adminLogEntry,
  firestore,
  nowFn,
  request,
  source,
}) {
  const ref = firestore.collection("mediaSourceAssets").doc(request.assetId);
  const asset = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
    if (!current || current.sourceId !== source.id ||
        !objectKeyWithinSource(source, current.objectKey)) {
      throw new SourceUploadError(404, "Media asset not found");
    }
    if (current.version !== request.expectedVersion) {
      throw new SourceUploadError(
        409,
        "Media asset changed; reload it and try again",
        { current: sourceMediaAssetDetail(current) },
      );
    }
    const now = nowFn();
    const changes = {
      ...request.changes,
      ...(request.changes.name
        ? { nameSort: normalizeSourceMediaNameSort(request.changes.name) }
        : {}),
      version: current.version + 1,
      updatedAt: now,
      updatedAtSort: now,
      updatedBy: actor.uid,
    };
    transaction.update(ref, changes);
    enqueueVideoSearchShard(transaction, firestore, current.id, current.sourceId);
    const updated = { ...current, ...changes };
    transaction.create(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      adminLogEntryFn({
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        action: "media.metadata.update",
        target: `mediaSourceAssets/${current.id}`,
        before: auditMetadata(current),
        after: auditMetadata(updated),
      }),
    );
    return sourceMediaAssetDetail(updated);
  });
  return { asset };
}

async function deleteSourceMedia({
  actor, adminLogEntryFn = adminLogEntry, firestore, nowFn, request, source,
}) {
  const ref = firestore.collection("mediaSourceAssets").doc(request.assetId);
  const statsRef = firestore.collection("mediaSourceStats").doc(source.id);
  await firestore.runTransaction(async (transaction) => {
    const [snapshot, statsSnapshot] = await Promise.all([
      transaction.get(ref), transaction.get(statsRef),
    ]);
    const stored = snapshot.exists ? snapshot.data() : null;
    const wasDeleted = stored?.lifecycle === "deleted";
    const current = stored ? parseSourceMediaAsset(snapshot.id,
      wasDeleted ? { ...stored, lifecycle: "active" } : stored) : null;
    if (!current || current.sourceId !== source.id ||
        !objectKeyWithinSource(source, current.objectKey)) {
      throw new SourceUploadError(404, "Media asset not found");
    }
    // A lost response may retry the exact committed deletion. No second audit or count change.
    if (wasDeleted) {
      if (current.version === request.expectedVersion + 1) return;
      throw new SourceUploadError(404, "Media asset not found");
    }
    if (current.version !== request.expectedVersion) {
      throw new SourceUploadError(409, "Media asset changed; reload it and try again",
        { current: sourceMediaAssetDetail(current) });
    }
    const now = nowFn();
    const changes = {
      lifecycle: "deleted", version: current.version + 1,
      deletedAt: now, deletedBy: actor.uid,
      updatedAt: now, updatedAtSort: now, updatedBy: actor.uid,
    };
    // S3 originals and processing copies remain. Private R2 delivery is revoked below.
    transaction.update(ref, changes);
    enqueueVideoSearchShard(transaction, firestore, current.id, current.sourceId);
    const stats = statsSnapshot.exists ? statsSnapshot.data() : null;
    if (stats?.sourceId === source.id && stats.exact === true &&
        Number.isSafeInteger(stats.activeCount) && stats.activeCount > 0) {
      transaction.update(statsRef, { activeCount: stats.activeCount - 1, updatedAt: now });
    } else {
      transaction.set(statsRef, { sourceId: source.id, exact: false, updatedAt: now }, { merge: true });
    }
    transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntryFn({
      actorUid: actor.uid, actorEmail: actor.email ?? null,
      action: "media.library.delete", target: `mediaSourceAssets/${current.id}`,
      before: { ...auditMetadata(current), lifecycle: "active" },
      after: { ...auditMetadata(current), ...changes },
    }));
  });
  const { reconcilePrivateVideo } = require("./private-video-copies");
  await reconcilePrivateVideo({ firestore, source, assetId: request.assetId });
  return { deleted: true };
}

const commonOptions = {
  cors: true,
  maxInstances: 20,
  timeoutSeconds: 60,
  serviceAccount: FUNCTION_SERVICE_ACCOUNT,
};
const cmsStartSourceMediaUpload = cmsOnRequest(commonOptions, makeHandler({
  maxBytes: 96 * KIB,
  parse: parseStartUploadRequest,
  operation: "upload",
  run: startUpload,
}));
const cmsSignSourceMediaUploadParts = cmsOnRequest(commonOptions, makeHandler({
  maxBytes: 16 * KIB,
  parse: parseSignUploadPartsRequest,
  operation: "upload",
  run: signUploadParts,
}));
const cmsResumeSourceMediaUpload = cmsOnRequest(commonOptions, makeHandler({
  maxBytes: 4 * KIB,
  parse: (value) => parseSessionRequest(value),
  operation: "upload",
  run: resumeUpload,
}));
const cmsCompleteSourceMediaUpload = cmsOnRequest(commonOptions, makeHandler({
  maxBytes: 4 * KIB,
  parse: (value) => parseSessionRequest(value, { requiresVersion: true }),
  operation: "upload",
  run: completeUpload,
}));
const cmsCancelSourceMediaUpload = cmsOnRequest(commonOptions, makeHandler({
  maxBytes: 4 * KIB,
  parse: (value) => parseSessionRequest(value, { requiresVersion: true }),
  operation: "upload",
  run: cancelUpload,
}));
const cmsDeleteSourceMedia = cmsOnRequest({ ...commonOptions, secrets: WRITE_SECRETS }, makeHandler({
  maxBytes: 4 * KIB,
  parse: parseDeleteSourceMediaRequest,
  operation: "delete",
  run: deleteSourceMedia,
  usesUploader: false,
}));
const cmsUpdateSourceMediaMetadata = cmsOnRequest(commonOptions, makeHandler({
  maxBytes: 96 * KIB,
  parse: parseMetadataUpdateRequest,
  operation: "metadata",
  run: updateMetadata,
  usesUploader: false,
}));

module.exports = {
  COLLECTION,
  MAX_ACTIVE_PREVIEWS_GLOBAL,
  MAX_ACTIVE_PREVIEWS_PER_ACTOR,
  advancePreviewAdmissionLocks,
  assertPreviewCapacity,
  previewAdmissionLocks,
  previewHoldId,
  SESSION_TTL_MS,
  SourceUploadError,
  cancelUpload,
  cmsDeleteSourceMedia,
  deleteSourceMedia,
  cmsCancelSourceMediaUpload,
  cmsCompleteSourceMediaUpload,
  cmsResumeSourceMediaUpload,
  cmsSignSourceMediaUploadParts,
  cmsStartSourceMediaUpload,
  cmsUpdateSourceMediaMetadata,
  completeUpload,
  completedAsset,
  objectKey,
  loadSession,
  makeHandler,
  publicUpload,
  resumeUpload,
  signUploadParts,
  signedManifestChecksum,
  startUpload,
  storeCompletedAsset,
  updateMetadata,
  verifiedCompletedParts,
};
