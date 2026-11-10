"use strict";

const { randomUUID } = require("node:crypto");
const { defineSecret } = require("firebase-functions/params");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { S3Client } = require("@aws-sdk/client-s3");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { makeHandler } = require("./source-media-uploads");
const { runtimeRegistry, runtimeAwsConfig, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const { createAwsRoleCredentialProvider } = require("./lib/aws-workload-credentials");
const { parseSourceMediaAsset, sourceMediaAssetDetail, ID_PATTERN, SourceMediaValidationError } = require("./lib/source-media-contract");
const { REPLACEMENTS, PURGE_QUEUE, replacementRef, requestVideoRollback, promoteReplacement, failReplacementPromotion, sameBinary } = require("./lib/source-video-replacement");
const { migrateVideoReferences } = require("./lib/source-video-replacement-publication");
const { createVideoVersionStorage, cleanupVideoVersion } = require("./lib/source-video-replacement-cleanup");
const { acquirePublicVideoCopy, publishSourceVideo, PublicVideoError } = require("./lib/public-video");
const { REQUEST_COLLECTION, withdrawalRequest } = require("./lib/public-video-withdrawal");
const { WRITE_SECRETS, privateVideoStorage } = require("./lib/private-video-runtime");
const R2_ACCESS_KEY_ID = defineSecret("CMS_MEDIA_R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = defineSecret("CMS_MEDIA_R2_SECRET_ACCESS_KEY");
const MEDIA_CACHE_PURGE_TOKEN = defineSecret("CMS_MEDIA_CACHE_PURGE_TOKEN");

const { videoReplacementRuntimeConfig } = require("./lib/media-source-runtime");
const REPLICA_REGION = "us-west-2";
const CLEANUP_RETRY_CODES = new Set([
  "video_cleanup_configuration_missing", "video_cleanup_replication_pending", "video_cleanup_scope_invalid",
  "video_cleanup_inventory_invalid", "video_cleanup_inventory_incomplete", "video_cleanup_public_scope_invalid",
  "video_cleanup_lease_changed",
]);

function parseReplacementRequest(value, rollback = false) {
  const fields = rollback ? ["sourceId", "assetId", "expectedVersion", "confirmed"] : ["sourceId", "assetId"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) ||
      value.sourceId !== "video-library" || !ID_PATTERN.test(value.assetId ?? "") ||
      rollback && (value.confirmed !== true || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1)) {
    throw new SourceMediaValidationError("A video asset and confirmed current version are required");
  }
  return value;
}

async function getReplacement({ firestore, request, now = Date.now() }) {
  const assetRow = await firestore.doc(`mediaSourceAssets/${request.assetId}`).get();
  const asset = assetRow.exists ? parseSourceMediaAsset(assetRow.id, assetRow.data()) : null;
  if (!asset || asset.sourceId !== request.sourceId) throw Object.assign(Error("Media asset not found"), { status: 404 });
  const ref = replacementRef(firestore, request.assetId), record = (await ref.get()).data();
  const previous = record?.previousId ? await ref.collection("versions").doc(record.previousId).get() : null;
  const history = await ref.collection("history").orderBy("at", "desc").limit(20).get();
  return { asset: sourceMediaAssetDetail(asset), state: record?.state ?? "none",
    errorCode: record?.errorCode ?? record?.migrationError ?? record?.transcriptError ?? null,
    lastAction: record?.lastAction ?? null,
    migrationPending: Boolean(record?.migrationPending), transcriptPending: Boolean(record?.transcriptPending),
    previous: previous?.data()?.state === "retained" && previous.data().expiresAt > now
      ? { id: previous.id, originalName: previous.data().binary.originalName, expiresAt: new Date(previous.data().expiresAt).toISOString() } : null,
    previousDeleted: Boolean(record?.promotedAt) && !previous?.exists,
    previousCleanupPending: Boolean(previous?.exists && previous.data().expiresAt <= now),
    history: history.docs.map(row => row.data()) };
}

const httpOptions = { cors: true, maxInstances: 20, timeoutSeconds: 60, serviceAccount: FUNCTION_SERVICE_ACCOUNT };
const cmsGetSourceVideoReplacement = cmsOnRequest(httpOptions, makeHandler({
  maxBytes: 4096, parse: value => parseReplacementRequest(value), operation: "metadata", usesUploader: false, run: getReplacement,
}));
const cmsRollbackSourceVideoReplacement = cmsOnRequest(httpOptions, makeHandler({
  maxBytes: 4096, parse: value => parseReplacementRequest(value, true), operation: "metadata", usesUploader: false,
  run: async ({ firestore, actor, source, request }) => ({ asset: await requestVideoRollback({
    firestore, actor, source, ...request, sessionId: randomUUID() }) }),
}));

async function preparePublicCopy({ firestore, asset, source, actorUid, config = runtimeAwsConfig(), s3, r2 }) {
  // Own the public-copy slot even for a private asset: a first publication must
  // not finish an old copy across the atomic binary-pointer change.
  const copy = await acquirePublicVideoCopy({ firestore, assetId: asset.id, freshGeneration: true });
  if (!copy.previous?.media || copy.previous.revoked) return { ...copy, record: null };
  try {
    s3 ??= new S3Client({ region: config.region, credentials: createAwsRoleCredentialProvider({ ...config, roleArn: source.roleArn }) });
    r2 ??= require("./source-video-publication").defaultR2();
    let record;
    await publishSourceVideo({ firestore, asset, actorUid, s3, r2: r2.client, r2Bucket: r2.bucket,
      renditionBucket: config.renditionBucket, expectedBucketOwner: config.renditionExpectedBucketOwner,
      publicOrigin: require("./media").MEDIA_PUBLIC_ORIGIN.value(), pendingWithdrawalUrls: copy.pendingWithdrawalUrls,
      publicGeneration: copy.publicGeneration,
      beforeCopy: media => firestore.runTransaction(async tx => {
        const publicRef = firestore.doc(`cmsPublicVideos/${asset.id}`);
        const requestRef = firestore.collection(REQUEST_COLLECTION).doc(asset.id);
        const [current, request] = await tx.getAll(publicRef, requestRef);
        if (current.data()?.operation?.id !== copy.operationId) {
          throw new PublicVideoError("The public video copy changed during replacement");
        }
        // Write ahead of any public bytes, including a partially failed copy.
        // The existing withdrawal owner is fenced by this copy operation; only
        // an atomic successful promotion removes its claim on the new URLs.
        tx.set(requestRef, withdrawalRequest(request.data(), [media.url, media.posterUrl], Date.now()));
      }),
      writeRecord: async value => { record = value; } });
    return { ...copy, record };
  } catch (error) { await copy.release(); throw error; }
}

async function queueReplacementTranscript({ firestore, source, record, config }) {
  if (!config.enabled || !config.localEnabled) throw Error("replacement_local_transcription_unavailable");
  const user = (await firestore.collection("users").doc(record.actor.uid).get()).data();
  const principal = await require("./lib/principal").registeredPrincipalFromUserDoc(firestore, record.actor.uid, user);
  await require("./lib/media-sources").authorizeMediaSource({ firestore, actor: { uid: record.actor.uid, principal }, source, operation: "transcript" });
  return require("./lib/video-transcript-job").requestTranscript({ firestore, source,
    request: require("./lib/video-transcript-contract").parseTranscriptRequest({ sourceId: source.id, assetId: record.assetId }),
    actor: { ...record.actor, displayName: record.actor.name, principal }, localEnabled: true, paidFallbackEnabled: false });
}

async function processReplacement({ firestore, ref, source, now = Date.now(), prepareCopy = preparePublicCopy,
  requestTranscript = queueReplacementTranscript, transcriptConfig = require("./video-transcripts").transcriptConfig, log = logger }) {
  let record = (await ref.get()).data();
  if (!record) return;
  if (["ready", "promoting"].includes(record.state)) {
    const owned = await firestore.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (!["ready", "promoting"].includes(current?.state) || current.leaseUntil > now) return null;
      tx.update(ref, { state: "promoting", leaseUntil: now + 12 * 60_000 });
      return { ...current, state: "promoting" };
    });
    if (!owned) return;
    let copy;
    try {
      const assetRow = (await firestore.doc(`mediaSourceAssets/${ref.id}`).get()).data();
      if (assetRow?.lifecycle !== "active") throw Object.assign(Error("Video is no longer available"), { status: 404 });
      if (!sameBinary(assetRow, owned.base)) throw Object.assign(Error("Video file changed"), { code: "replacement_base_changed" });
      const candidate = parseSourceMediaAsset(ref.id, { ...assetRow, ...owned.candidate });
      if (!candidate?.rendition || candidate.rendition.state !== "ready") {
        throw Object.assign(Error("replacement_candidate_not_ready"), { code: "replacement_candidate_not_ready" });
      }
      copy = await prepareCopy({ firestore, asset: candidate, source, actorUid: owned.actor.uid });
      await promoteReplacement({ firestore, assetId: ref.id, sessionId: owned.sessionId, now, publicCopy: copy });
    } catch (error) {
      if (copy) await copy.release();
      if ([403, 404].includes(error.status) || ["replacement_base_changed", "replacement_candidate_not_ready"].includes(error.code)) {
        await failReplacementPromotion({ firestore, ref, sessionId: owned.sessionId, now,
          errorCode: error.code === "replacement_candidate_not_ready" ? error.code
            : error.status === 403 ? "replacement_permission_changed" : "replacement_video_changed",
          publicMedia: copy?.record?.media });
      } else await firestore.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.sessionId === owned.sessionId && current.state === "promoting") tx.update(ref, { state: "ready", leaseUntil: 0, errorCode: "promotion_retry" });
      });
      throw error;
    }
    record = (await ref.get()).data();
  }
  if (record.state === "complete" && record.migrationPending) {
    let result;
    try {
      const publicRecord = (await firestore.doc(`cmsPublicVideos/${ref.id}`).get()).data();
      result = await migrateVideoReferences({ firestore, assetId: ref.id, media: publicRecord?.media });
    } catch { result = { pending: true, failedOwners: ["reference_scan"] }; }
    const migrationError = result.failedOwners.length ? "publication_refresh_failed" : null;
    await firestore.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      const assetRef = firestore.doc(`mediaSourceAssets/${ref.id}`), asset = (await tx.get(assetRef)).data();
      if (current?.sessionId !== record.sessionId || current.state !== "complete") return;
      tx.update(ref, { migrationPending: result.pending, migrationError, migrationFailedOwners: result.failedOwners });
      if (asset) tx.update(assetRef, { "replacement.errorCode": migrationError ?? require("firebase-admin/firestore").FieldValue.delete() });
    });
    if (migrationError) log.warn("Video replacement publication needs repair", { assetId: ref.id, owners: result.failedOwners });
    record = (await ref.get()).data();
  }
  if (record.transcriptPending) {
    try {
      await requestTranscript({ firestore, source, record, config: transcriptConfig() });
      await ref.update({ transcriptPending: false, transcriptError: null });
    } catch {
      await ref.update({ transcriptError: "transcription_waiting" });
      log.warn("Replacement transcription waiting", { assetId: ref.id });
    }
  }
}

function cleanupConfig() {
  const replacement = videoReplacementRuntimeConfig();
  return { ...runtimeAwsConfig(), source: runtimeRegistry().get("video-library"), cleanupRoleArn: replacement.cleanupRoleArn,
    publicOrigin: require("./media").MEDIA_PUBLIC_ORIGIN.value(),
    replicaRegion: REPLICA_REGION, replicaBucket: replacement.replicaBucket };
}
function removeVersion() {
  return createVideoVersionStorage(cleanupConfig(), { privateStorage: () => privateVideoStorage(true),
    publicStorage: () => require("./source-video-publication").defaultR2(),
    purge: urls => require("./source-video-publication").purgeVideoReplacementCopies(urls) });
}
const cleanupIsDryRun = () => videoReplacementRuntimeConfig().dryRun;
async function processReplacements({ firestore = db, source = runtimeRegistry().get("video-library"),
  remove, log = logger, now = Date.now(), dryRun = cleanupIsDryRun(), ...deps } = {}) {
  if (!source) return;
  const collection = firestore.collection(REPLACEMENTS);
  const scan = firestore.doc("mediaSourceReplacementScans/tick");
  const cursors = (await scan.get()).data() ?? {};
  const kinds = ["promotions", "migrations", "transcripts"];
  const batches = await Promise.all([
    collection.where("state", "in", ["ready", "promoting"]),
    collection.where("migrationPending", "==", true),
    collection.where("transcriptPending", "==", true),
  ].map(async (query, index) => {
    const ordered = query.orderBy(require("firebase-admin/firestore").FieldPath.documentId());
    const cursor = cursors[kinds[index]];
    let batch = await (cursor ? ordered.startAfter(cursor) : ordered).limit(100).get();
    if (batch.empty && cursor) batch = await ordered.limit(100).get();
    return batch;
  }));
  // Persist selection before work so a failing or interrupted batch cannot starve
  // later IDs, including across scheduler cold starts. Each kind wraps separately.
  await scan.set(Object.fromEntries(batches.map((batch, index) => [kinds[index], batch.docs.at(-1)?.id ?? null])));
  const rows = batches.flatMap(batch => batch.docs);
  for (const row of new Map(rows.map(row => [row.id, row])).values()) {
    try { await processReplacement({ firestore, ref: row.ref, source, now, log, ...deps }); }
    catch { log.warn("Video replacement waiting for recovery", { assetId: row.id }); }
  }
  const cleanup = await firestore.collection(PURGE_QUEUE).where("expiresAt", "<=", now).limit(10).get();
  for (const row of cleanup.docs) {
    try { await cleanupVideoVersion({ firestore, queueRef: row.ref, now, dryRun, remove: remove ?? (dryRun ? undefined : removeVersion()), log }); }
    catch (error) {
      const code = CLEANUP_RETRY_CODES.has(error?.message) ? error.message : "video_cleanup_failed";
      log.warn("Video version cleanup will retry", { queueId: row.id, code });
    }
  }
}

const options = { region: "us-central1", serviceAccount: FUNCTION_SERVICE_ACCOUNT, timeoutSeconds: 540,
  memory: "512MiB", maxInstances: 1, concurrency: 1,
  secrets: [...WRITE_SECRETS, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
    MEDIA_CACHE_PURGE_TOKEN] };
const onSourceVideoReplacementTick = onSchedule({ ...options, schedule: "every 1 minutes", retryCount: 0 }, () => processReplacements());
module.exports = { cmsGetSourceVideoReplacement, cmsRollbackSourceVideoReplacement, onSourceVideoReplacementTick,
  getReplacement, parseReplacementRequest, preparePublicCopy, queueReplacementTranscript,
  processReplacement, processReplacements, removeVersion, cleanupIsDryRun };
