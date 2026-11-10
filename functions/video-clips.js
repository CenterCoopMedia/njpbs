"use strict";
const { processingChanges } = require("./lib/video-processing-status");
const { randomUUID, createHash } = require("node:crypto");
const { defineString } = require("firebase-functions/params");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { SFNClient, StartExecutionCommand, DescribeExecutionCommand } = require("@aws-sdk/client-sfn");
const { S3Client, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { db } = require("./lib/firebase");
const { assertBillingEnabled } = require("./lib/billing-state");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { authorizeMediaSource, objectKeyWithinSource } = require("./lib/media-sources");
const { parseSourceMediaAsset } = require("./lib/source-media-contract");
const { runtimeRegistry, runtimeAwsConfig, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const { previewProcessorConfig } = require("./video-previews");
const { createAwsRoleCredentialProvider } = require("./lib/aws-workload-credentials");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const { executionName, executionArn } = require("./lib/video-preview-processor");
const { CLIP_JOBS, CLIP_TTL_MS, SOURCE_EXPORT_MAX_DURATION_SECONDS, problem, parseClipRequest, clipSettings,
  OUTPUT_FRAME_RATES, EDITOR_FORMATS, jobScope, jobFormat, validateClipResolution, clipIdentity, sameClipSource, clipSummary,
  encodeClipHistoryCursor, validateClipOutput } = require("./lib/video-clip-contract");
const { createOriginalStorage } = require("./lib/source-originals");
const { assertOriginalReadable, safeStorageDiagnostic } = require("./lib/source-original-state");
const ENABLED = defineString("CMS_MEDIA_CLIP_PROCESSING_ENABLED", { default: "false" });
const EDITOR_EXPORTS_ENABLED = defineString("CMS_MEDIA_EDITOR_EXPORTS_ENABLED", { default: "false" });
const ORIGINAL_COPIES_ENABLED = defineString("CMS_MEDIA_ORIGINAL_COPIES_ENABLED", { default: "false" });
const USER_CLIP_EXPORTS_PER_DAY = 30;
const GLOBAL_CLIP_EXPORTS_PER_DAY = 120;
const USER_EDITOR_SECONDS_PER_DAY = 24 * 60 * 60;
const GLOBAL_EDITOR_SECONDS_PER_DAY = 4 * USER_EDITOR_SECONDS_PER_DAY;
// For an editor format, these worker codes come only from inspecting the pinned original, so a retry fails again.
// Rate and scan codes are left out: the output check raises them too. A source-export length mismatch is left out:
// that job's identity excludes the web copy, so a corrected web copy must be able to retry it.
const EDITOR_INPUT_CODES = {
  broadcast_video_track_unsupported: "editor_video_track_unsupported", broadcast_duration_unsupported: "editor_duration_unsupported",
  broadcast_video_format_unsupported: "editor_video_unsupported", broadcast_audio_layout_unsupported: "editor_audio_unsupported",
  prores_video_format_unsupported: "prores_video_unsupported", avid_video_format_unsupported: "avid_video_unsupported",
  clip_range_outside_input: "export_source_mismatch",
};
function workflowFailure(result, job) {
  let reason = null;
  try { reason = JSON.parse(result.cause ?? "null")?.errorMessage; } catch { reason = null; }
  if (jobFormat(job) === "original_copy") {
    if (result.status === "FAILED" && ["original_media_unsupported", "original_timing_unsupported", "original_output_limit"].includes(reason)) {
      return { retryable: false, errorCode: reason };
    }
    // An integration failure does not prove that its container stopped consuming compute.
    return { phase: "needs_reconciliation", retryable: false, errorCode: "processing_unconfirmed" };
  }
  const editor = jobFormat(job) !== "web_mp4";
  // MP4 retries reuse the same pinned web copy and range, so this rejection is final too.
  // Keep the general conversion code: export_source_mismatch describes the original.
  if (!editor && reason === "clip_range_outside_input") {
    return { retryable: false, errorCode: "conversion_failed" };
  }
  const errorCode = editor && typeof reason === "string" && Object.hasOwn(EDITOR_INPUT_CODES, reason) ? EDITOR_INPUT_CODES[reason] : null;
  return errorCode ? { retryable: false, errorCode } : { retryable: true, errorCode: "conversion_failed" };
}
function clipConfig() { return ENABLED.value() === "true" ? previewProcessorConfig() : null; }
function editorExportsEnabled() { return EDITOR_EXPORTS_ENABLED.value() === "true"; }
function originalCopiesEnabled() { return ORIGINAL_COPIES_ENABLED.value() === "true"; }
function quotaProblem(scope, unit, limit, used, now) {
  const resetAt = new Date(now);
  resetAt.setUTCHours(24, 0, 0, 0);
  const remaining = Math.max(0, limit - used);
  const owner = scope === "person" ? "Your" : "The station's";
  const message = unit === "exports"
    ? `${owner} daily allowance of ${limit} video exports has been reached. ${remaining} exports remain.`
    : `This export exceeds ${scope === "person" ? "your" : "the station's"} remaining daily editor export duration. ${remaining} seconds remain of ${limit} seconds.`;
  return Object.assign(problem(429, `${message} Resets at 00:00 UTC on ${resetAt.toISOString().slice(0, 10)}.`), {
    code: "clip_export_quota", quota: { scope, unit, limit, remaining, resetAt: resetAt.toISOString() },
  });
}
function actorClipSummary(job, actor, asset, now = Date.now()) {
  const summary = clipSummary(job, now);
  return { ...summary, matchesCurrentFile: sameClipSource(asset, job), canCancel: summary.canCancel && job.requestedBy === actor.uid };
}
function readAsset(snapshot, source) {
  const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
  if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) throw problem(404, "Video is no longer available");
  return asset;
}
async function requestClip({ firestore, actor, source, request, originalStorage, now = Date.now() }) {
  const assetRef = firestore.collection("mediaSourceAssets").doc(request.assetId);
  const limitRef = firestore.collection("mediaSourceClipLimits").doc(createHash("sha256").update(actor.uid).digest("hex"));
  const day = new Date(now).toISOString().slice(0, 10);
  const dayRef = firestore.collection("mediaSourceClipLimits").doc(`day-${day}`);
  const admit = checkedOriginal => firestore.runTransaction(async (tx) => {
    const [assetSnapshot, limitSnapshot, daySnapshot] = await Promise.all([tx.get(assetRef), tx.get(limitRef), tx.get(dayRef)]);
    const asset = readAsset(assetSnapshot, source);
    const web = asset.rendition?.state === "ready" ? asset.rendition.web : null;
    if (!web || !Number.isFinite(web.durationSeconds) || web.durationSeconds <= 0 ||
        web.durationSeconds > SOURCE_EXPORT_MAX_DURATION_SECONDS) {
      throw problem(409, "Use a ready video no longer than 24 hours");
    }
    const scope = jobScope(request);
    if (scope === "clip" && request.outMs > Math.floor(web.durationSeconds * 1000)) {
      throw problem(409, "Choose a range within a ready web viewing copy");
    }
    const settings = jobFormat(request) === "web_mp4" ? clipSettings(request)
      : request.frameRateMode === undefined ? {} : { frameRateMode: request.frameRateMode };
    if (jobFormat(request) === "broadcast_mp4") {
      const n = web.sourceFrameRateNumerator;
      const d = web.sourceFrameRateDenominator;
      if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0) {
        throw problem(409, "The original frame rate has not been measured. Ask a CMS administrator to prepare its metadata");
      }
      if (n / d < 1 || n / d > 60) {
        throw problem(409, "Frame rate copies support originals from 1 through 60 fps");
      }
      const target = request.frameRateMode === "source" ? [n, d] : OUTPUT_FRAME_RATES[request.frameRateMode ?? "broadcast"];
      if (!target || n * target[1] === d * target[0]) {
        throw problem(409, "This original already uses the chosen frame rate. Download the original without conversion");
      }
    }
    validateClipResolution(request, web);
    const identity = { ...settings, kind: "clip", scope, format: jobFormat(request), sourceId: source.id, assetId: asset.id,
      ...(web.sourceFrameRateNumerator === undefined ? {} : {
        sourceFrameRateNumerator: web.sourceFrameRateNumerator,
        sourceFrameRateDenominator: web.sourceFrameRateDenominator,
      }),
      sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
      inMs: scope === "source" ? 0 : request.inMs,
      outMs: scope === "source" ? Math.ceil(web.durationSeconds * 1000) : request.outMs,
      ...(scope === "clip" ? { inputObjectKey: web.objectKey, inputObjectVersionId: web.objectVersionId,
        inputSizeBytes: web.sizeBytes } : {}) };
    const id = clipIdentity(identity);
    const ref = firestore.collection(CLIP_JOBS).doc(id);
    const existing = (await tx.get(ref)).data();
    if (existing && sameClipSource(asset, existing)) {
      const expired = existing.phase === "ready" && Date.parse(existing.expiresAt) <= now;
      if (!expired && existing.phase !== "cancelled" && !(request.retry && clipSummary(existing, now).canRetry)) {
        return actorClipSummary(existing, actor, asset, now);
      }
    }
    if (request.retry && !["web_mp4", "original_copy"].includes(jobFormat(request)) &&
        request.frameRateMode === undefined && !(existing && sameClipSource(asset, existing) &&
        existing.frameRateMode === undefined && clipSummary(existing, now).canRetry)) {
      throw problem(409, "A saved retryable export is required for a legacy frame rate retry");
    }
    const limit = limitSnapshot.data() ?? {};
    if (limit.activeId && limit.activeId !== id) {
      const active = (await tx.get(firestore.collection(CLIP_JOBS).doc(limit.activeId))).data();
      if (active?.active || active?.phase === "needs_reconciliation") throw problem(429, "Wait for your current clip export to finish");
    }
    const userCount = limit.day === day ? limit.count : 0;
    let originalLimitRef = null;
    if (jobFormat(request) === "original_copy") {
      originalLimitRef = firestore.collection("mediaSourceClipLimits").doc("original-active");
      const originalLimit = (await tx.get(originalLimitRef)).data();
      if (originalLimit?.activeId && originalLimit.activeId !== id) {
        const active = (await tx.get(firestore.collection(CLIP_JOBS).doc(originalLimit.activeId))).data();
        if (active?.active || active?.phase === "needs_reconciliation") throw problem(429, "Wait for the current original-range extraction to finish");
      }
    }
    const userEditorSeconds = limit.day === day ? limit.editorSeconds ?? 0 : 0;
    const dayLimit = daySnapshot.data() ?? {};
    const globalCount = dayLimit.count ?? 0;
    const globalEditorSeconds = dayLimit.editorSeconds ?? 0;
    const editorSeconds = jobFormat(request) === "web_mp4" ? 0 : Math.ceil(
      scope === "source" ? web.durationSeconds : (request.outMs - request.inMs) / 1000,
    );
    if (userCount >= USER_CLIP_EXPORTS_PER_DAY) throw quotaProblem("person", "exports", USER_CLIP_EXPORTS_PER_DAY, userCount, now);
    if (globalCount >= GLOBAL_CLIP_EXPORTS_PER_DAY) throw quotaProblem("station", "exports", GLOBAL_CLIP_EXPORTS_PER_DAY, globalCount, now);
    if (userEditorSeconds + editorSeconds > USER_EDITOR_SECONDS_PER_DAY) throw quotaProblem("person", "seconds", USER_EDITOR_SECONDS_PER_DAY, userEditorSeconds, now);
    if (globalEditorSeconds + editorSeconds > GLOBAL_EDITOR_SECONDS_PER_DAY) throw quotaProblem("station", "seconds", GLOBAL_EDITOR_SECONDS_PER_DAY, globalEditorSeconds, now);
    if (originalStorage && jobFormat(request) !== "web_mp4") {
      if (!checkedOriginal) return { originalCheck: asset };
      if (asset.objectKey !== checkedOriginal.objectKey || asset.objectVersionId !== checkedOriginal.objectVersionId ||
          asset.sizeBytes !== checkedOriginal.sizeBytes) throw problem(409, "The original changed. Reopen the video and try again.");
    }
    const attempts = existing?.phase === "failed" ? existing.attempts + 1 : 1;
    const job = { ...identity, id, attempts, attemptId: randomUUID(), requestedBy: actor.uid,
      requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + CLIP_TTL_MS).toISOString(), phase: "pending", active: true, leaseUntil: 0, failures: 0 };
    tx.set(ref, job);
    tx.set(limitRef, { day, count: userCount + 1, editorSeconds: userEditorSeconds + editorSeconds, activeId: id });
    tx.set(dayRef, { count: globalCount + 1, editorSeconds: globalEditorSeconds + editorSeconds });
    if (originalLimitRef) tx.set(originalLimitRef, { activeId: id });
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: actor.uid, actorEmail: actor.email ?? null,
      action: "media.clip.request", target: `mediaSourceAssets/${asset.id}`, before: null,
      after: { clipId: id, scope, format: identity.format, ...settings, inMs: identity.inMs, outMs: identity.outMs,
        sourceVersion: asset.version, sourceObjectVersionId: asset.objectVersionId,
        ...(scope === "clip" ? { inputObjectVersionId: web.objectVersionId } : {}), attempt: attempts } }));
    return actorClipSummary(job, actor, asset, now);
  });
  const result = await admit();
  if (!result.originalCheck) return result;
  // Do not hold shared quota locks during S3 authentication or HEAD. Admission rechecks the asset and limits.
  assertOriginalReadable(await originalStorage.head(source, result.originalCheck));
  return admit(result.originalCheck);
}
// Completed exports own their output bytes for seven days, independently of
// later replacements. Running/cancel/retry operations still bind to current input.
function clipBelongsToAsset(asset, source, job) {
  return job?.kind === "clip" && job.assetId === asset.id && job.sourceId === source.id &&
    (sameClipSource(asset, job) || objectKeyWithinSource(source, job.sourceObjectKey) && job.id === clipIdentity(job));
}
function availableClip(asset, source, job, now) {
  return clipBelongsToAsset(asset, source, job) &&
    (sameClipSource(asset, job) || clipSummary(job, now).state === "ready");
}
async function getClip(firestore, source, request, now = Date.now()) {
  const [assetSnapshot, jobSnapshot] = await Promise.all([firestore.collection("mediaSourceAssets").doc(request.assetId).get(), firestore.collection(CLIP_JOBS).doc(request.clipId).get()]);
  const asset = readAsset(assetSnapshot, source);
  const job = jobSnapshot.data();
  if (!availableClip(asset, source, job, now)) throw problem(404, "Clip is no longer available");
  return { asset, job };
}
async function recentClips(firestore, source, request, actor, now = Date.now()) {
  const assetRef = firestore.collection("mediaSourceAssets").doc(request.assetId);
  const before = readAsset(await assetRef.get(), source);
  let cursorSnapshot = null;
  if (request.cursor) {
    cursorSnapshot = await firestore.collection(CLIP_JOBS).doc(request.cursor.id).get();
    const cursorJob = cursorSnapshot.data();
    if (!cursorSnapshot.exists || cursorJob?.kind !== "clip" || cursorJob.id !== cursorSnapshot.id ||
        cursorJob.requestedBy !== actor.uid || cursorJob.requestedAt !== request.cursor.requestedAt ||
        !clipBelongsToAsset(before, source, cursorJob)) {
      throw problem(400, "Video export cursor is invalid or the video changed");
    }
  }
  // Scan a bounded page across source versions; older completed outputs remain
  // downloadable until their own expiry. Scope is filtered below for legacy jobs
  // whose stored scope predates the explicit field.
  let query = firestore.collection(CLIP_JOBS)
    .where("requestedBy", "==", actor.uid).where("assetId", "==", request.assetId);
  query = query.orderBy("requestedAt", "desc");
  if (cursorSnapshot) query = query.startAfter(cursorSnapshot);
  const snapshot = await query.limit(51).get();
  const documents = snapshot.docs.slice(0, 50);
  // Recheck the stable asset/source after the query; deletion still hides every export.
  const asset = readAsset(await assetRef.get(), source);
  const eligible = documents.filter(document => {
    const job = document.data();
    return job.requestedBy === actor.uid && jobScope(job) === jobScope(request) && availableClip(asset, source, job, now);
  });
  const page = eligible.slice(0, 10);
  const last = eligible.length > 10 ? page.at(-1) : snapshot.docs.length > 50 ? documents.at(-1) : null;
  return { clips: page.map(document => actorClipSummary(document.data(), actor, asset, now)),
    nextCursor: last ? encodeClipHistoryCursor({ id: last.id, requestedAt: last.data().requestedAt }) : null };
}
async function cancelClip(firestore, source, request, actor, now = Date.now()) {
  const jobRef = firestore.collection(CLIP_JOBS).doc(request.clipId);
  const assetRef = firestore.collection("mediaSourceAssets").doc(request.assetId);
  return firestore.runTransaction(async (tx) => {
    const [assetSnapshot, jobSnapshot] = await Promise.all([tx.get(assetRef), tx.get(jobRef)]);
    const asset = readAsset(assetSnapshot, source);
    const job = jobSnapshot.data();
    if (!job || job.requestedBy !== actor.uid || !sameClipSource(asset, job)) {
      throw problem(404, "Clip is no longer available");
    }
    if (job.attemptId !== request.attemptId) {
      throw problem(409, "This export changed; reload it before cancelling");
    }
    if (job.phase === "cancelled") return clipSummary(job, now);
    if (job.phase !== "pending" || job.leaseOwner || job.executionArn) {
      throw problem(409, "This export was already claimed for processing and cannot be cancelled safely");
    }
    const cancelled = { ...job, phase: "cancelled", active: false, retryable: false,
      purgeAt: new Date(now + 30 * 86400 * 1000),
      completedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), errorCode: null };
    tx.update(jobRef, cancelled);
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
      actorUid: actor.uid, actorEmail: actor.email ?? null, action: "media.clip.cancel",
      target: `mediaSourceAssets/${asset.id}`, before: { clipId: job.id, phase: job.phase },
      after: { clipId: job.id, phase: "cancelled" },
    }));
    return clipSummary(cancelled, now);
  });
}
async function clipRead(config, source, job, now = Date.now(), deps = {}) {
  if (clipSummary(job, now).state !== "ready") throw problem(409, "The clip is not ready or has expired");
  const editorSpec = EDITOR_FORMATS[jobFormat(job)] ?? null;
  const original = jobFormat(job) === "original_copy";
  const output = validateClipOutput(job, { id: job.id, attemptId: job.attemptId,
    [original ? "original" : editorSpec?.resultKey ?? "web"]: job.output });
  const client = deps.client ?? new S3Client({ region: config.region, credentials: createAwsRoleCredentialProvider({ roleArn: source.roleArn, audience: config.audience, region: config.region }) });
  const target = { Bucket: config.renditionBucket, Key: output.objectKey, VersionId: output.objectVersionId, ExpectedBucketOwner: source.expectedBucketOwner };
  const head = await client.send(new HeadObjectCommand(target));
  if (head.VersionId !== output.objectVersionId || head.ContentLength !== output.sizeBytes) throw problem(409, "The clip output is no longer available");
  const ttl = Math.min(300, Math.floor((Date.parse(job.expiresAt) - now) / 1000));
  if (ttl < 10) throw problem(409, "The clip has expired; request it again");
  const extension = original ? "mov" : editorSpec?.filename.split(".").at(-1) ?? "mp4";
  const label = original ? "original" : editorSpec ? jobFormat(job).replaceAll("_", "-") : "web";
  const name = jobScope(job) === "source" ? `video-${job.assetId}-${label}` : `clip-${job.inMs}-${job.outMs}-${label}`;
  const url = await (deps.sign ?? getSignedUrl)(client, new GetObjectCommand({ ...target,
    ResponseContentType: output.mimeType,
    ResponseContentDisposition: `attachment; filename="${name}.${extension}"` }), { expiresIn: ttl });
  return { url, expiresAt: new Date(now + ttl * 1000).toISOString() };
}
function clipHandler(action, deps = {}) {
  let defaultOriginalStorage;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
      validateBoundedJsonRequest(req, 4096);
      await (deps.verifyAppCheck ?? verifyAppCheckToken)(req.headers?.["x-firebase-appcheck"]);
      const actor = await (deps.requirePrincipal ?? requirePrincipal)(req);
      const request = parseClipRequest(req.body, action);
      const firestore = deps.firestore ?? db;
      const source = (deps.registry ?? runtimeRegistry)().get(request.sourceId);
      await (deps.authorize ?? authorizeMediaSource)({ firestore, actor, source, operation: "browse" });
      const getEditorExportsEnabled = deps.editorExportsEnabled ?? editorExportsEnabled;
      const getOriginalCopiesEnabled = deps.originalCopiesEnabled ?? originalCopiesEnabled;
      if (action === "request") {
        if (!(deps.config ?? clipConfig)()) throw problem(503, "Clip exports are not enabled");
        if (jobFormat(request) === "original_copy" && !getOriginalCopiesEnabled()) {
          throw problem(503, "Original-range extraction is not enabled");
        }
        if (!["web_mp4", "original_copy"].includes(jobFormat(request)) && !getEditorExportsEnabled()) {
          throw problem(503, "Editor exports are not enabled");
        }
        const originalStorage = deps.originalStorage ?? (defaultOriginalStorage ??= createOriginalStorage(runtimeAwsConfig()));
        const clip = await requestClip({ firestore, actor, source, request, originalStorage });
        res.status(200).json({ success: true, clip }); return;
      }
      if (action === "get" && request.clipId === undefined) {
        const history = await recentClips(firestore, source, request, actor);
        res.status(200).json({ success: true, editorExportsEnabled: getEditorExportsEnabled(), ...history }); return;
      }
      const { asset, job } = await getClip(firestore, source, request);
      if (action === "cancel") {
        const clip = await (deps.cancelClip ?? cancelClip)(firestore, source, request, actor);
        res.status(200).json({ success: true, clip }); return;
      }
      const result = action === "read" ? { access: await (deps.clipRead ?? clipRead)((deps.readConfig ?? runtimeAwsConfig)(), source, job) } : { clip: actorClipSummary(job, actor, asset) };
      if (action === "read") {
        const current = (await getClip(firestore, source, request)).job;
        if (current.attemptId !== job.attemptId || clipSummary(current).state !== "ready") throw problem(409, "The clip changed; request it again");
      }
      res.status(200).json({ success: true,
        ...(action === "get" ? { editorExportsEnabled: getEditorExportsEnabled() } : {}), ...result });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      res.status(status).json({ error: status < 500 ? error.message : "Clip export request failed",
        ...(status === 429 && error.code === "clip_export_quota" ? { code: error.code, quota: error.quota } : {}),
        ...(["original_archived", "original_restoring"].includes(error?.code) ? { code: error.code } : {}) });
    }
  };
}
function providerInput(job) {
  const fields = ["id", "attemptId", "kind", "scope", "format", "sourceId", "assetId", "sourceObjectKey",
    "sourceObjectVersionId", "sourceSizeBytes", "inputObjectKey", "inputObjectVersionId", "inputSizeBytes",
    "inMs", "outMs", "resolution", "quality", "frameRateMode"];
  return Object.fromEntries(fields.flatMap((key) => job[key] === undefined ? [] : [[key, job[key]]]));
}
async function processClipTick({ firestore = db, config = clipConfig(), client, originalClient, now = Date.now, assertBillingEnabledFn = assertBillingEnabled } = {}) {
  if (!config) return;
  const aws = client ?? new SFNClient({ region: config.region, credentials: createAwsRoleCredentialProvider({ roleArn: config.controlRoleArn, audience: config.audience, region: config.region }) });
  const originalStorage = createOriginalStorage(config, { client: originalClient });
  const cursorRef = firestore.collection("system").doc("videoClipScheduler");
  const after = (await cursorRef.get()).data()?.after;
  // Document IDs include legacy jobs and remain usable after a cursor job is deleted.
  const query = firestore.collection(CLIP_JOBS).where("active", "==", true).orderBy("__name__").limit(GLOBAL_CLIP_EXPORTS_PER_DAY);
  let snapshots = await (after ? query.startAfter(after) : query).get();
  if (after && snapshots.docs.length === 0) snapshots = await query.get();
  // Stop leasing well inside the 240-second timeout; the next tick resumes after the last visited job.
  const deadline = now() + 180000;
  for (const snapshot of snapshots.docs) {
    if (now() > deadline) break;
    const owner = randomUUID();
    const job = await firestore.runTransaction(async (tx) => {
      const current = (await tx.get(snapshot.ref)).data();
      // Save before provider work, so a timeout or a full page of leases cannot pin the scan.
      tx.set(cursorRef, { after: snapshot.id });
      if (!current?.active || current.leaseUntil > now()) return null;
      tx.update(snapshot.ref, { leaseUntil: now() + 300000, leaseOwner: owner }); return current;
    });
    if (!job) continue;
    let dispatchAttempted = false;
    const save = async (changes, clearLeaseOwner = false) => firestore.runTransaction(async (tx) => {
      const current = (await tx.get(snapshot.ref)).data();
      const snap = await tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId));
      const asset = snap.exists ? parseSourceMediaAsset(snap.id, snap.data()) : null;
      if (current?.attemptId !== job.attemptId || current.leaseOwner !== owner) return false;
      const matches = sameClipSource(asset, job);
      if (!matches) {
        const originalMayBeRunning = jobFormat(current) === "original_copy" &&
          (dispatchAttempted || current.phase === "running" || current.executionArn || job.leaseOwner || (job.failures ?? 0) > 0);
        changes = { phase: originalMayBeRunning ? "needs_reconciliation" : "failed", active: false,
          retryable: false, errorCode: originalMayBeRunning ? "processing_unconfirmed" : "source_unavailable" };
      }
      const completed = changes.active === false && ["ready", "failed", "cancelled"].includes(changes.phase);
      tx.update(snapshot.ref, { ...processingChanges(current, changes, now()), leaseUntil: 0,
        ...(completed ? { purgeAt: new Date(now() + 30 * 86400 * 1000) } : {}),
        ...(clearLeaseOwner ? { leaseOwner: null } : {}) }); return matches;
    });
    try {
      await getClip(firestore, config.source, { assetId: job.assetId, clipId: job.id });
      const maximumAge = job.phase === "running" ? 49 * 60 * 60 * 1000
        : jobScope(job) === "source" ? 47 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const ageBasis = job.phase === "running" ? job.startedAt ?? job.requestedAt : job.requestedAt;
      if (now() - Date.parse(ageBasis) > maximumAge || !Number.isFinite(Date.parse(ageBasis))) {
        await save({ phase: "needs_reconciliation", active: false, retryable: false,
          errorCode: "processing_timeout" }, true);
        continue;
      }
      const arn = executionArn(config.workflowArn, job);
      if (job.phase === "pending") {
        const knownNeverDispatched = !job.leaseOwner && !job.executionArn && (job.failures ?? 0) === 0;
        try { await assertBillingEnabledFn(firestore); }
        catch {
          await save({ errorCode: "billing_unavailable" }, knownNeverDispatched); continue;
        }
        if (knownNeverDispatched && jobFormat(job) !== "web_mp4") {
          try {
            assertOriginalReadable(await originalStorage.head(config.source, { objectKey: job.sourceObjectKey,
              objectVersionId: job.sourceObjectVersionId, sizeBytes: job.sourceSizeBytes }));
          } catch (error) {
            if (["original_archived", "original_restoring"].includes(error?.code)) {
              await save({ phase: "failed", active: false, retryable: true, errorCode: "original_archived" }, true);
            } else if ([404, 409].includes(error?.status)) {
              await save({ phase: "failed", active: false, retryable: false, errorCode: "source_unavailable" }, true);
            } else {
              logger.warn("Original export check failed", { clipId: job.id, ...safeStorageDiagnostic(error) });
              await save({ errorCode: "original_check_failed" }, true);
            }
            continue;
          }
        }
        dispatchAttempted = true;
        try { await aws.send(new StartExecutionCommand({ stateMachineArn: config.workflowArn, name: executionName(job), input: JSON.stringify(providerInput(job)) })); }
        catch (error) { if (error.name !== "ExecutionAlreadyExists") throw error; }
        await save({ phase: "running", processingStage: "processing", executionArn: arn,
          startedAt: job.startedAt ?? new Date(now()).toISOString(), failures: 0, errorCode: null }, true);
      } else {
        if (job.executionArn !== arn) throw new Error("clip_execution_mismatch");
        const result = await aws.send(new DescribeExecutionCommand({ executionArn: arn }));
        if (["RUNNING", "PENDING_REDRIVE"].includes(result.status)) { await save({ failures: 0 }, true); continue; }
        if (result.status === "SUCCEEDED") {
          const output = validateClipOutput(job, JSON.parse(result.output ?? "null"));
          await save({ phase: "ready", active: false, output, failures: 0 }, true);
        } else if (["FAILED", "TIMED_OUT", "ABORTED"].includes(result.status)) {
          await save({ phase: "failed", active: false, ...workflowFailure(result, job) }, true);
        } else throw new Error("clip_execution_status_unknown");
      }
    } catch {
      const failures = (job.failures ?? 0) + 1;
      await save({ failures, ...(failures >= 5 ? { phase: "needs_reconciliation", active: false, retryable: false, errorCode: "processing_unconfirmed" } : {}) });
    }
  }
}
const options = { cors: true, timeoutSeconds: 60, maxInstances: 10, serviceAccount: FUNCTION_SERVICE_ACCOUNT };
const cmsRequestVideoClip = cmsOnRequest(options, clipHandler("request"));
const cmsGetVideoClip = cmsOnRequest(options, clipHandler("get"));
const cmsCreateVideoClipRead = cmsOnRequest(options, clipHandler("read"));
const cmsCancelVideoClip = cmsOnRequest(options, clipHandler("cancel"));
const onVideoClipTick = onSchedule({ schedule: "every 1 minutes", region: "us-central1", timeoutSeconds: 240, memory: "256MiB", maxInstances: 1, concurrency: 1, serviceAccount: FUNCTION_SERVICE_ACCOUNT }, () => processClipTick());
module.exports = { USER_CLIP_EXPORTS_PER_DAY, GLOBAL_CLIP_EXPORTS_PER_DAY, cmsRequestVideoClip, cmsGetVideoClip, cmsCreateVideoClipRead, cmsCancelVideoClip, onVideoClipTick,
  requestClip, getClip, recentClips, cancelClip, clipRead, clipHandler, processClipTick, providerInput };
