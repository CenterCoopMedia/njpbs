"use strict";

const { isDeepStrictEqual } = require("node:util");
const { FieldPath, FieldValue } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { cmsOnRequest } = require("./lib/cms-edge");
const { authorizeContentRead, contentResource, mayReadSomeContentRecord } = require("./lib/content-authorization");
const { db } = require("./lib/firebase");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { liveBlogVideoBlocks } = require("./lib/live-blog");
const { runtimeAwsConfig, runtimeRegistry } = require("./lib/media-source-runtime");
const { authorizeMediaSource, objectKeyWithinSource } = require("./lib/media-sources");
const { leadVideoBlocks } = require("./lib/post-lead-media");
const { publiclyVisible, videoCopies } = require("./lib/public-video-references");
const { createS3MediaRestoreCheck } = require("./lib/s3-media-source");
const { ID_PATTERN, encodeCursor, parseSourceMediaAsset, parseSourceMediaListRequest } = require("./lib/source-media-contract");
const { parseDeleteSourceMediaRequest } = require("./lib/source-media-upload-contract");
const { PREVIEW_JOBS, previewIdentity, sameOriginal } = require("./lib/video-preview-job");
const { enqueueVideoSearchShard } = require("./lib/video-search-outbox");
const { FUNCTION_SERVICE_ACCOUNT, respondWithError } = require("./source-media");

const USAGE_COLLECTIONS = ["cmsPosts", "cmsPages"];
const USAGE_BATCH_SIZE = 200;
const USAGE_SCAN_LIMIT = 5000;
const BIN_PAGE_SIZE = 24;
const problem = (status, message) => Object.assign(new Error(message), { status });

function parseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problem(400, "Video recycle bin request is invalid.");
  const { action, ...fields } = value;
  if (action === "restore") return { action, ...parseDeleteSourceMediaRequest(fields) };
  if (action === "list" && Object.keys(fields).every(key => key === "sourceId" || key === "cursor")) {
    return { action, ...parseSourceMediaListRequest(fields) };
  }
  if (action === "usage" && Object.keys(fields).every(key => ["sourceId", "assetId", "cursor"].includes(key))) {
    const { cursor = "cmsPosts:0", ...lookup } = fields;
    const match = typeof cursor === "string" && /^(cmsPosts|cmsPages):(\d{1,4})$/.exec(cursor);
    const offset = match ? Number(match[2]) : -1;
    if (match && offset < USAGE_SCAN_LIMIT && offset % USAGE_BATCH_SIZE === 0 &&
        typeof lookup.assetId === "string" && ID_PATTERN.test(lookup.assetId)) {
      return { action, ...parseSourceMediaListRequest(lookup), collection: match[1], offset };
    }
  }
  throw problem(400, "Video recycle bin request is invalid.");
}

function binnedAsset(snapshot, source) {
  const stored = snapshot.data();
  if (stored?.lifecycle !== "deleted" || stored.sourceId !== source.id ||
      !objectKeyWithinSource(source, stored.objectKey)) return null;
  return parseSourceMediaAsset(snapshot.id, { ...stored, lifecycle: "active" });
}

async function listBinnedVideos({ firestore, source, request }) {
  let query = firestore.collection("mediaSourceAssets")
    .where("sourceId", "==", source.id).where("lifecycle", "==", "deleted")
    .orderBy("updatedAtSort", "desc").orderBy(FieldPath.documentId(), "desc");
  if (request.cursor) query = query.startAfter(request.cursor.sort, request.cursor.id);
  const { docs } = await query.limit(BIN_PAGE_SIZE + 1).get();
  const page = docs.slice(0, BIN_PAGE_SIZE);
  const last = docs.length > BIN_PAGE_SIZE ? page.at(-1) : undefined;
  return {
    records: page.flatMap(snapshot => {
      const asset = binnedAsset(snapshot, source);
      return asset ? [{ id: asset.id, name: asset.name, version: asset.version, deletedAt: asset.updatedAtSort }] : [];
    }),
    nextCursor: last ? encodeCursor({
      sourceId: source.id, q: "", id: last.id, sort: last.data().updatedAtSort,
    }) : null,
  };
}

async function restoreBinnedVideo({ actor, firestore, request, source, verifyFiles, now, audit = adminLogEntry }) {
  const ref = firestore.collection("mediaSourceAssets").doc(request.assetId);
  const statsRef = firestore.collection("mediaSourceStats").doc(source.id);
  const conflict = () => problem(409, "This video changed. Refresh the bin before trying again.");
  const selected = await ref.get();
  const asset = binnedAsset(selected, source);
  if (!asset || asset.version !== request.expectedVersion) throw conflict();
  if (selected.data().rendition?.state === "ready" && asset.rendition?.state !== "ready") {
    throw problem(409, "The recorded viewing copy or poster is unavailable.");
  }
  const originalState = await verifyFiles(source, asset);

  const viewingCopyUnavailable = await firestore.runTransaction(async transaction => {
    const [fresh, statsSnapshot] = await Promise.all([transaction.get(ref), transaction.get(statsRef)]);
    // Background processing can change rendition metadata without advancing the asset version.
    if (!isDeepStrictEqual(fresh.data(), selected.data())) throw conflict();
    let orphanedRendition = false;
    if (asset.rendition?.state === "processing") {
      const job = (await transaction.get(firestore.collection(PREVIEW_JOBS).doc(previewIdentity(asset)))).data();
      orphanedRendition = job?.active !== true || job.assetId !== asset.id ||
        job.attemptId !== asset.rendition.attemptId || !sameOriginal({ ...asset, lifecycle: "active" }, job);
    }
    const updatedAt = now();
    transaction.update(ref, {
      lifecycle: "active", version: asset.version + 1,
      deletedAt: FieldValue.delete(), deletedBy: FieldValue.delete(),
      updatedAt, updatedAtSort: updatedAt, updatedBy: actor.uid,
      // Restore the surviving original. Keep an inactive job's attempt intact
      // so an uncertain provider execution can still be reconciled.
      ...(orphanedRendition ? {
        rendition: { ...asset.rendition, state: "failed", errorCode: "processing_failed", updatedAt },
      } : {}),
    });
    enqueueVideoSearchShard(transaction, firestore, asset.id, source.id);
    const stats = statsSnapshot.data();
    if (stats?.sourceId === source.id && stats.exact === true &&
        Number.isSafeInteger(stats.activeCount) && stats.activeCount >= 0 &&
        stats.activeCount < Number.MAX_SAFE_INTEGER) {
      transaction.update(statsRef, { activeCount: stats.activeCount + 1, updatedAt });
    } else {
      transaction.set(statsRef, { sourceId: source.id, exact: false, updatedAt }, { merge: true });
    }
    transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({
      actorUid: actor.uid, actorEmail: actor.email ?? null,
      action: "media.library.restore", target: `mediaSourceAssets/${asset.id}`,
      before: { name: asset.name, lifecycle: "deleted", version: asset.version },
      after: { name: asset.name, lifecycle: "active", version: asset.version + 1 },
    }));
    return orphanedRendition;
  });
  return { restored: true,
    ...(originalState === "archived" || originalState === "restoring" ? { originalState } : {}),
    ...(viewingCopyUnavailable ? { viewingCopyUnavailable } : {}) };
}

function contentUsage(snapshot, actor, source, assetId) {
  const stored = snapshot.data();
  if (stored.deleted === true) return [];
  const collection = snapshot.ref.parent.id;
  const documentId = snapshot.id;
  const resource = contentResource({ collection, documentId, stored });
  if (!authorizeContentRead(actor.principal, { exists: true, resource }).allowed) return [];
  const working = [
    ...(Array.isArray(stored.blocks) ? stored.blocks : []),
    ...leadVideoBlocks(stored.leadMedia),
    ...liveBlogVideoBlocks(stored.type === "post" ? stored.liveBlog : undefined),
  ].some(block => block?.type === "video" && block.data?.sourceId === source.id && block.data.assetId === assetId);
  const published = publiclyVisible(stored) && videoCopies([
    ...(Array.isArray(stored.published?.blocks) ? stored.published.blocks : []),
    ...leadVideoBlocks(stored.published?.metadata?.leadMedia),
    ...liveBlogVideoBlocks(stored.published?.metadata?.type === "post" ? stored.published.metadata.liveBlog : undefined),
  ]).some(copy => copy.assetId === assetId);
  if (!working && !published) return [];
  const title = typeof stored.title === "string" && stored.title.trim() ? stored.title.trim().slice(0, 200) : documentId;
  return [{ collection, documentId, title, working, published }];
}

async function readVideoUsage({ actor, firestore, request, source }) {
  if (!mayReadSomeContentRecord(actor.principal)) {
    throw problem(403, "You do not have permission to read content usage.");
  }
  const assetRef = firestore.collection("mediaSourceAssets").doc(request.assetId);
  return firestore.runTransaction(async transaction => {
    if (!binnedAsset(await transaction.get(assetRef), source)) {
      throw problem(404, "This video is no longer in the recycle bin.");
    }
    const query = firestore.collection(request.collection).orderBy(FieldPath.documentId()).offset(request.offset)
      .select("title", "type", "blocks", "leadMedia", "liveBlog", "createdBy", "section", "deleted", "unassignedDraft",
        "status", "publiclyVisible", "published.blocks", "published.metadata.type",
        "published.metadata.leadMedia", "published.metadata.liveBlog");
    const { docs } = await transaction.get(query.limit(USAGE_BATCH_SIZE + 1));
    const page = docs.slice(0, USAGE_BATCH_SIZE);
    const followingCollection = USAGE_COLLECTIONS[USAGE_COLLECTIONS.indexOf(request.collection) + 1];
    const nextOffset = request.offset + USAGE_BATCH_SIZE;
    const moreInCollection = docs.length > USAGE_BATCH_SIZE;
    const incomplete = moreInCollection && nextOffset >= USAGE_SCAN_LIMIT;
    return {
      items: page.flatMap(snapshot => contentUsage(snapshot, actor, source, request.assetId)),
      // A continuation never discloses an unauthorized content document ID.
      nextCursor: moreInCollection && !incomplete ? `${request.collection}:${nextOffset}`
        : followingCollection ? `${followingCollection}:0` : null,
      incomplete,
    };
  }, { readOnly: true });
}

function createVideoBinHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  let defaultVerifyFiles;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 4096);
      const request = parseRequest(req.body);
      if (request.action === "restore") {
        await (deps.verifyAppCheck ?? verifyAppCheckToken)(req.headers?.["x-firebase-appcheck"]);
      }
      const actor = await (deps.requirePrincipal ?? requirePrincipal)(req);
      const source = (deps.registry ?? runtimeRegistry)().get(request.sourceId);
      await (deps.authorize ?? authorizeMediaSource)({ firestore, actor, source, operation: "delete" });
      const args = { actor, firestore, request, source };
      if (request.action === "list") {
        return res.status(200).json({ success: true, ...await listBinnedVideos(args) });
      }
      if (request.action === "usage") {
        return res.status(200).json({ success: true, ...await readVideoUsage(args) });
      }
      const verifyFiles = deps.verifyFiles ?? (defaultVerifyFiles ??= createS3MediaRestoreCheck(runtimeAwsConfig()));
      const now = deps.now ?? (() => new Date().toISOString());
      return res.status(200).json({ success: true, ...await restoreBinnedVideo({ ...args, verifyFiles, now, audit: deps.audit }) });
    } catch (error) {
      respondWithError(res, deps.log ?? logger, "complete the video recycle bin request", error);
    }
  };
}

const cmsSourceVideoBin = cmsOnRequest({ cors: true, timeoutSeconds: 30, maxInstances: 10,
  serviceAccount: FUNCTION_SERVICE_ACCOUNT }, createVideoBinHandler());

module.exports = { cmsSourceVideoBin, createVideoBinHandler };
