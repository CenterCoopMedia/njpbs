"use strict";

// Vertical and horizontal exports of library videos. The local worker that
// runs transcription claims these jobs through the same broker and lease slot,
// renders them with FFmpeg, uploads the MP4 to the originals bucket and the
// broker saves it as a new library video linked to its source.

const { createHash, randomUUID } = require("node:crypto");
const { enqueueVideoSearchShard } = require("./video-search-outbox");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const { SourceMediaValidationError } = require("./source-media-contract");
const { PREVIEW_JOBS, pendingPreview, renditionState, sameOriginal } = require("./video-preview-job");
const { WORKERS, WORKER_ID } = require("./video-transcript-worker");

const EXPORTS = "mediaSourceOrientationExports";
// Issued uploads of exports that failed; each gets one storage check at its deadline.
const STRAYS = "mediaSourceOrientationExportStrays";
// The worker's latest export-capable claim. Staff see whether exports will run soon.
const WORKER_CHECK_IN = ["mediaWorkerCapabilities", "node-gpu-b-orientation"];
const WORKER_READY_MS = 15 * 60_000;
const WORKER_RECORD_MS = 5 * 60_000;
const ENGINE = "ffmpeg-orientation-v1";
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const MAX_DURATION_SECONDS = 3600;
// The worker accepts the same 2 GB input as transcription.
const MAX_INPUT_BYTES = 2_000_000_000;
// H.264 at an 8 Mbit/s ceiling plus AAC stays under 4 GB for one hour; a
// single presigned PUT accepts up to 5 GB.
const MAX_OUTPUT_BYTES = 4_500_000_000;
const UPLOAD_URL_SECONDS = 3600;
// One fixed deadline per issued upload address. The worker owns the job until
// it confirms or this deadline passes; then the broker checks storage once.
// The worker stops sending 100 minutes after it receives the address
// (UPLOAD_SEND_SECONDS in worker.py), so no upload can store a file later.
const UPLOAD_DEADLINE_MS = 2 * 3600 * 1000;
const FRAMES = { vertical: { width: 1080, height: 1920 }, horizontal: { width: 1920, height: 1080 } };
const LABELS = { vertical: "vertical", horizontal: "horizontal" };
const STAGES = new Set(["downloading", "rendering", "uploading", "finalizing"]);
const FAILURES = new Set(["export_processing_failed", "export_input_failed", "export_upload_failed"]);
const RETRYABLE = new Set(["failed", "stale", "needs_reconciliation"]);
const invalid = (message = "Export worker request is invalid", status = 400) => Object.assign(new Error(message), { status });
const slotRef = (firestore) => firestore.collection(WORKERS).doc(WORKER_ID);
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const ref = (firestore, id) => firestore.collection(EXPORTS).doc(id);
const assetRef = (firestore, id) => firestore.collection("mediaSourceAssets").doc(id);

// Exports join the same viewing-copy admission as staff uploads. A hold is
// reserved when the upload is issued, consumed by the new video's viewing-copy
// job, and released when the export ends without a video.
const uploads = () => require("../source-media-uploads");
async function readPreviewHold(tx, firestore, job, { capacity = false } = {}) {
  const previewJobs = firestore.collection(PREVIEW_JOBS);
  const holdRef = previewJobs.doc(uploads().previewHoldId(job.id));
  const hold = await tx.get(holdRef);
  const held = hold.exists && hold.data()?.active === true;
  if (!capacity || held) return { holdRef, held };
  const lockRefs = uploads().previewAdmissionLocks(firestore, job.requestedBy);
  const [actorPreviews, globalPreviews, ...locks] = await Promise.all([
    tx.get(previewJobs.where("actorUid", "==", job.requestedBy).where("active", "==", true)
      .limit(uploads().MAX_ACTIVE_PREVIEWS_PER_ACTOR)),
    tx.get(previewJobs.where("active", "==", true).limit(uploads().MAX_ACTIVE_PREVIEWS_GLOBAL)),
    ...lockRefs.map((lock) => tx.get(lock)),
  ]);
  let full = false;
  try { uploads().assertPreviewCapacity(actorPreviews, globalPreviews); } catch { full = true; }
  return { holdRef, held, full, lockRefs, locks };
}

function releasePreviewHold(tx, hold) {
  if (hold.held) tx.update(hold.holdRef, { active: false, phase: "released" });
}

function exportId(asset, orientation) {
  const web = asset.rendition.web;
  return createHash("sha256").update(JSON.stringify([ENGINE, asset.sourceId, asset.id,
    asset.objectKey, asset.objectVersionId, web.objectKey, web.objectVersionId, orientation])).digest("hex");
}

// The job must still describe the asset's current original and viewing copy.
function sourceMatches(asset, job) {
  const web = asset?.rendition?.web;
  return sameOriginal(asset, job) && asset.rendition.state === "ready" &&
    web?.objectKey === job.input.objectKey && web.objectVersionId === job.input.objectVersionId &&
    web.sizeBytes === job.input.sizeBytes;
}

function exportableInput(asset) {
  const web = asset?.rendition?.state === "ready" ? asset.rendition.web : null;
  if (!web || typeof web.objectKey !== "string" || !web.objectKey.startsWith("outputs/") ||
      typeof web.objectVersionId !== "string" || !web.objectVersionId ||
      !Number.isSafeInteger(web.sizeBytes) || web.sizeBytes <= 0 ||
      !Number.isFinite(web.durationSeconds) || web.durationSeconds <= 0) {
    throw new SourceMediaValidationError("This video needs a ready viewing copy before it can be exported", 409);
  }
  if (web.durationSeconds > MAX_DURATION_SECONDS || web.sizeBytes > MAX_INPUT_BYTES) {
    throw new SourceMediaValidationError("Exports are limited to videos of one hour or less and 2 GB or less", 409);
  }
  return { objectKey: web.objectKey, objectVersionId: web.objectVersionId, sizeBytes: web.sizeBytes,
    durationSeconds: web.durationSeconds };
}

function publicExport(job) {
  const running = job.uploadIssued ? "finishing_upload" : "processing";
  return { id: job.id, orientation: job.orientation, state: job.phase === "running" ? running : job.phase,
    outputAssetId: job.phase === "complete" ? job.outputAssetId : null,
    errorCode: job.errorCode ?? null, requestedAt: job.createdAt, updatedAt: job.updatedAt };
}

function parseExportRequest(value, { list = false } = {}) {
  const allowed = new Set(list ? ["sourceId", "assetId"] : ["sourceId", "assetId", "orientation"]);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.has(key)) || value.sourceId !== "video-library" ||
      typeof value.assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.assetId) ||
      (!list && (typeof value.orientation !== "string" || !Object.hasOwn(FRAMES, value.orientation)))) {
    throw new SourceMediaValidationError("Video export request is invalid");
  }
  return list ? { sourceId: value.sourceId, assetId: value.assetId }
    : { sourceId: value.sourceId, assetId: value.assetId, orientation: value.orientation };
}

async function requestExport({ firestore, request, actor, now = Date.now(), audit = adminLogEntry }) {
  return firestore.runTransaction(async (tx) => {
    const asset = (await tx.get(assetRef(firestore, request.assetId))).data();
    if (!asset || asset.lifecycle !== "active" || asset.sourceId !== request.sourceId || asset.kind !== "video") {
      throw new SourceMediaValidationError("Video was not found", 404);
    }
    const input = exportableInput(asset);
    const id = exportId({ ...asset, id: request.assetId }, request.orientation);
    const previous = (await tx.get(ref(firestore, id))).data();
    const output = previous?.phase === "complete" ? (await tx.get(assetRef(firestore, previous.outputAssetId))).data() : null;
    // A finished export stays the answer until someone deletes its video.
    if (previous && !RETRYABLE.has(previous.phase) && !(previous.phase === "complete" && output?.lifecycle !== "active")) {
      return { job: previous, cached: true };
    }
    const at = new Date(now).toISOString();
    const job = { id, kind: "orientation", engine: ENGINE, orientation: request.orientation,
      assetId: request.assetId, sourceId: asset.sourceId, sourceObjectKey: asset.objectKey,
      sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes, input,
      // Each export gets its own upload key, so a late upload of a failed one cannot collide.
      outputAssetId: randomUUID(),
      phase: "queued", active: true, attempt: 0, leaseToken: null, leaseUntil: 0, stage: null, errorCode: null,
      output: null, uploadIssued: false, requestedBy: actor.uid, createdAt: at, updatedAt: at,
      parent: { name: asset.name, originalName: asset.originalName, description: asset.description ?? null,
        license: asset.license ?? null, credit: asset.credit ?? null, tags: asset.tags ?? [], rightsStatus: asset.rightsStatus } };
    tx.set(ref(firestore, id), job);
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({ actorUid: actor.uid,
      actorEmail: actor.email ?? null, action: "media.video.export.request", target: `${EXPORTS}/${id}`,
      after: { assetId: request.assetId, orientation: request.orientation, retry: Boolean(previous) } }));
    return { job, cached: false };
  });
}

const checkInRef = (firestore) => firestore.collection(WORKER_CHECK_IN[0]).doc(WORKER_CHECK_IN[1]);

async function recordExportWorker({ firestore, now = Date.now() }) {
  const ref = checkInRef(firestore);
  if (((await ref.get()).data()?.lastSeenAt ?? 0) > now - WORKER_RECORD_MS) return;
  await ref.set({ lastSeenAt: now });
}

// Status covers only exports of the asset's current file and viewing copy.
async function listExports({ firestore, request, now = Date.now() }) {
  const [asset, snapshot, worker] = await Promise.all([assetRef(firestore, request.assetId).get(),
    firestore.collection(EXPORTS).where("assetId", "==", request.assetId).orderBy("createdAt", "desc").limit(10).get(),
    checkInRef(firestore).get()]);
  const current = asset.data();
  const workerReady = (worker.data()?.lastSeenAt ?? 0) > now - WORKER_READY_MS;
  if (!current || current.sourceId !== request.sourceId) return { exports: [], workerReady };
  return { exports: snapshot.docs.map((doc) => doc.data()).filter((job) => sourceMatches(current, job)).map(publicExport),
    workerReady };
}

// Until an issued upload's deadline its worker owns the job by token alone,
// so a waiting export holds no place in the shared worker slot. After the
// deadline the broker's storage check claims the slot like any other job.
const waiting = (job, now) => Boolean(job.uploadIssued && job.uploadDeadline > now);

function validLease(job, request, slot, now) {
  if (!job?.active || job.leaseToken !== request.leaseToken) return false;
  if (job.uploadIssued) return waiting(job, now) || job.leaseUntil > now;
  return job.leaseUntil > now && slot?.kind === "orientation" && slot.jobId === job.id && slot.leaseUntil > now;
}

const slotHeldByOther = (slot, jobId, now) => Boolean(slot?.jobId && slot.jobId !== jobId && slot.leaseUntil > now);

function freeSlot(tx, firestore, slot, jobId, now) {
  if (slot?.jobId === jobId) tx.set(slotRef(firestore), { kind: null, jobId: null, leaseUntil: 0, lastSeenAt: now });
}

async function claimExportJob({ firestore, now = Date.now() }) {
  // Waiting exports each hold a viewing-copy place, so at most the global
  // limit of them can wait; the query reaches past them to queued work.
  const waitLimit = uploads().MAX_ACTIVE_PREVIEWS_GLOBAL;
  const queued = await firestore.collection(EXPORTS).where("active", "==", true)
    .orderBy("createdAt", "asc").limit(waitLimit + 5).get();
  const candidates = queued.docs.filter((doc) => !waiting(doc.data(), now)).slice(0, 5);
  return firestore.runTransaction(async (tx) => {
    const slot = (await tx.get(slotRef(firestore))).data();
    if (slot?.jobId && slot.leaseUntil > now && slot.kind !== "orientation") return null;
    const refs = slot?.jobId && slot.leaseUntil > now
      ? [ref(firestore, slot.jobId), ...candidates.filter((doc) => doc.id !== slot.jobId).map((doc) => doc.ref)]
      : candidates.map((doc) => doc.ref);
    const records = [];
    for (const jobRef of refs) {
      const job = (await tx.get(jobRef)).data();
      if (!job?.active || waiting(job, now)) continue;
      records.push({ jobRef, job, asset: (await tx.get(assetRef(firestore, job.assetId))).data(),
        hold: await readPreviewHold(tx, firestore, job) });
    }
    // Firestore requires all reads before the first write.
    const at = new Date(now).toISOString();
    for (const { jobRef, job, asset, hold } of records) {
      // After its deadline, an issued upload gets one storage check
      // (settleIssuedUpload) whatever happened to its source.
      if (!job.uploadIssued && !sourceMatches(asset, job)) {
        tx.update(jobRef, { active: false, phase: "stale", leaseToken: null, leaseUntil: 0,
          errorCode: "export_source_changed", updatedAt: at });
        releasePreviewHold(tx, hold);
        continue;
      }
      if (job.leaseToken && job.leaseUntil > now && slot?.kind === "orientation" && slot.jobId === job.id) return job;
      if (!job.uploadIssued && job.attempt >= MAX_ATTEMPTS) {
        tx.update(jobRef, { active: false, phase: "needs_reconciliation", leaseToken: null, leaseUntil: 0,
          errorCode: "export_worker_lost", updatedAt: at });
        releasePreviewHold(tx, hold);
        continue;
      }
      // A claim that only checks an issued upload is not a render attempt.
      const changes = { phase: "running", leaseToken: randomUUID(), leaseUntil: now + LEASE_MS,
        attempt: job.uploadIssued ? job.attempt : job.attempt + 1, stage: "downloading", updatedAt: at };
      tx.update(jobRef, changes);
      tx.set(slotRef(firestore), { kind: "orientation", jobId: job.id, leaseUntil: changes.leaseUntil, lastSeenAt: now });
      return { ...job, ...changes };
    }
    if (slot?.kind === "orientation") tx.set(slotRef(firestore), { kind: null, jobId: null, leaseUntil: 0, lastSeenAt: now });
    return null;
  });
}

async function withExportLease({ firestore, request, now = Date.now(), mutate }) {
  return firestore.runTransaction(async (tx) => {
    const jobRef = ref(firestore, request.jobId);
    const job = (await tx.get(jobRef)).data();
    const asset = job ? (await tx.get(assetRef(firestore, job.assetId))).data() : null;
    const slot = (await tx.get(slotRef(firestore))).data();
    if (job?.phase === "complete" && job.completedLeaseHash === tokenHash(request.leaseToken)) return { job, completed: true };
    // After an upload address is issued the export finishes as requested.
    if (!job || (!job.uploadIssued && !sourceMatches(asset, job))) throw invalid("Video export changed", 409);
    if (!validLease(job, request, slot, now)) throw invalid("Export worker lease expired", 409);
    return mutate({ tx, jobRef, job, asset, slot, now });
  });
}

// An uploading worker keeps the slot only while no other job has taken it.
function renewLease(tx, firestore, jobRef, job, slot, now, changes = {}) {
  const leaseUntil = now + LEASE_MS;
  tx.update(jobRef, { leaseUntil, updatedAt: new Date(now).toISOString(), ...changes });
  if (!slotHeldByOther(slot, job.id, now)) {
    tx.set(slotRef(firestore), { kind: "orientation", jobId: job.id, leaseUntil, lastSeenAt: now });
  }
  return leaseUntil;
}

async function heartbeatExportJob(args) {
  return withExportLease({ ...args, mutate: ({ tx, jobRef, job, slot, now }) =>
    ({ leaseUntil: renewLease(tx, args.firestore, jobRef, job, slot, now, { stage: args.request.stage }) }) });
}

// A reported failure ends the export at once, so staff can export again. An
// upload address it was given gets one storage check at its deadline
// (checkStrayUpload).
async function failExportJob(args) {
  return withExportLease({ ...args, mutate: async ({ tx, jobRef, job, slot, now }) => {
    const hold = await readPreviewHold(tx, args.firestore, job);
    releasePreviewHold(tx, hold);
    tx.update(jobRef, { active: false, phase: "failed", errorCode: args.request.errorCode, leaseToken: null,
      leaseUntil: 0, updatedAt: new Date(now).toISOString() });
    if (job.uploadIssued) {
      tx.set(args.firestore.collection(STRAYS).doc(job.outputAssetId), { id: job.id, outputAssetId: job.outputAssetId,
        sourceId: job.sourceId, output: job.output, uploadDeadline: job.uploadDeadline });
    }
    freeSlot(tx, args.firestore, slot, job.id, now);
    return { completed: true };
  } });
}

// Boardwalk has no S3 delete permission, so a file that a failed export's
// upload stored late is recorded for an operator; staff never see it.
async function checkStrayUpload({ firestore, source, uploader, objectKeyFn, now = Date.now() }) {
  const due = await firestore.collection(STRAYS).where("uploadDeadline", "<=", now).limit(1).get();
  if (due.docs.length === 0) return null;
  // The record stays until its storage check and audit entry land together,
  // so a failed check is retried by a later claim.
  const recordRef = due.docs[0].ref;
  const stray = due.docs[0].data();
  const session = uploadSession(stray, source, stray.output, objectKeyFn);
  const head = await headUpload(uploader, source, session);
  return firestore.runTransaction(async (tx) => {
    if (!(await tx.get(recordRef)).exists) return null;
    tx.delete(recordRef);
    if (!head) return "absent";
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: "media-worker",
      action: "media.video.export.stray", target: session.objectKey,
      after: { exportId: stray.id, versionId: head.VersionId ?? null, sizeBytes: head.ContentLength ?? null } }));
    return "recorded";
  });
}

function uploadSession(job, source, output, objectKeyFn) {
  return { id: job.id, assetId: job.outputAssetId, sourceId: job.sourceId, mimeType: "video/mp4",
    objectKey: objectKeyFn(source, job.outputAssetId, "video/mp4"), sizeBytes: output.sizeBytes,
    checksumSha256: Buffer.from(output.sha256, "hex").toString("base64") };
}

function outputName(name, orientation) {
  const suffix = ` (${LABELS[orientation]})`;
  return `${name.slice(0, 500 - suffix.length)}${suffix}`;
}

// The first completion call reserves the upload and returns a presigned PUT
// bound to the rendered file's size and SHA-256. The second call, after the
// upload, checks the stored object and creates the library video.
async function completeExportJob(args) {
  const { firestore, request, source, uploader, objectKeyFn, assertBillingEnabled, clock = Date.now } = args;
  const output = request.output;
  if (!request.uploaded) {
    // The billing stop applies to storage and viewing-copy work after a long render.
    await assertBillingEnabled();
    const checked = await withExportLease({ ...args, mutate: async ({ tx, jobRef, job, slot, now }) => {
      // One address per export: a second one would move the deadline.
      if (job.uploadIssued) throw invalid("Export upload already started", 409);
      const hold = await readPreviewHold(tx, firestore, job, { capacity: true });
      renewLease(tx, firestore, jobRef, job, slot, now, { stage: "uploading", output });
      // A full viewing-copy queue keeps the rendered file waiting on the worker.
      if (!hold.held && hold.full) return { job, wait: true };
      if (!hold.held) {
        uploads().advancePreviewAdmissionLocks(tx, hold.lockRefs, hold.locks);
        tx.set(hold.holdRef, { active: true, actorUid: job.requestedBy, phase: "reserved", exportId: job.id });
      }
      tx.update(jobRef, { uploadIssued: true, uploadDeadline: now + UPLOAD_DEADLINE_MS });
      return { job };
    } });
    if (checked.completed) return { completed: true, outputAssetId: checked.job.outputAssetId };
    if (checked.wait) return { completed: false, retryAfterSeconds: 60 };
    const session = uploadSession(checked.job, source, output, objectKeyFn);
    const upload = await uploader.signPut(source, session, UPLOAD_URL_SECONDS);
    return { completed: false, upload };
  }
  const checked = await withExportLease({ ...args, mutate: ({ job }) => ({ job }) });
  if (checked.completed) return { completed: true, outputAssetId: checked.job.outputAssetId };
  const job = checked.job;
  if (!job.output || job.output.sha256 !== output.sha256 || job.output.sizeBytes !== output.sizeBytes) {
    throw invalid("Export output changed", 409);
  }
  await assertBillingEnabled();
  const session = uploadSession(job, source, output, objectKeyFn);
  const head = await uploader.head(source, session);
  if (head.ChecksumSHA256 !== session.checksumSha256) throw invalid("Export upload is incomplete", 409);
  return finishExport({ ...args, now: clock() }, session, head);
}

// Creates the library video from a stored upload under the current lease.
function finishExport(args, session, head) {
  const { firestore, request, completedAssetFn } = args;
  return withExportLease({ ...args, mutate: async ({ tx, jobRef, job: current, asset: parent, slot, now }) => {
    const outputRef = assetRef(firestore, current.outputAssetId);
    const existing = await tx.get(outputRef);
    const statsRef = firestore.collection("mediaSourceStats").doc(current.sourceId);
    const stats = (await tx.get(statsRef)).data();
    const hold = await readPreviewHold(tx, firestore, current);
    if (existing.exists) throw invalid("Export video id is already in use", 409);
    if (!hold.held) throw invalid("Viewing-copy reservation was lost", 409);
    const at = new Date(now).toISOString();
    // A replaced or deleted file keeps the exported file's metadata snapshot.
    const meta = sameOriginal(parent, current) ? parent : current.parent;
    const base = meta.originalName.replace(/\.[^./\\]{1,8}$/u, "");
    let asset = completedAssetFn({ ...session, actorUid: current.requestedBy,
      originalName: `${base.slice(0, 480)}-${LABELS[current.orientation]}.mp4`,
      parentSource: { sourceId: current.sourceId, assetId: current.assetId },
      metadata: { name: outputName(meta.name, current.orientation), description: meta.description ?? null,
        license: meta.license ?? null, credit: meta.credit ?? null, tags: meta.tags ?? [], markers: [],
        rightsStatus: meta.rightsStatus } }, head, at);
    const preview = { ...pendingPreview(asset, now), actorUid: current.requestedBy };
    asset = { ...asset, rendition: renditionState(preview, "processing") };
    tx.create(firestore.collection(PREVIEW_JOBS).doc(preview.id), preview);
    tx.update(hold.holdRef, { active: false, phase: "consumed" });
    tx.create(outputRef, asset);
    enqueueVideoSearchShard(tx, firestore, asset.id, asset.sourceId);
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: current.requestedBy,
      actorEmail: null, action: "media.upload", target: `mediaSourceAssets/${asset.id}`, before: null,
      after: { sourceId: asset.sourceId, name: asset.name, sizeBytes: asset.sizeBytes,
        parentSource: asset.parentSource, exportId: current.id, orientation: current.orientation } }));
    if (stats?.exact === true && Number.isSafeInteger(stats.activeCount)) {
      tx.update(statsRef, { activeCount: stats.activeCount + 1, updatedAt: at });
    }
    tx.update(jobRef, { active: false, phase: "complete", stage: null, errorCode: null, leaseToken: null,
      leaseUntil: 0, completedLeaseHash: tokenHash(request.leaseToken), completedAt: at, updatedAt: at });
    freeSlot(tx, firestore, slot, current.id, now);
    return { completed: true, outputAssetId: asset.id };
  } });
}

function headUpload(uploader, source, session) {
  return uploader.head(source, session).catch((error) => {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  });
}

// The one storage check after a lost worker's issued upload deadline. A stored file
// becomes the new video; otherwise the export fails and frees its place in
// the viewing-copy queue. Staff press Export again to retry.
// Returns "complete" or "failed".
async function settleIssuedUpload(args) {
  const { firestore, source, uploader, objectKeyFn } = args;
  const clock = args.clock ?? Date.now;
  const { job } = await withExportLease({ ...args, mutate: ({ job: current }) => ({ job: current }) });
  const session = uploadSession(job, source, job.output, objectKeyFn);
  const head = await headUpload(uploader, source, session);
  if (head?.ChecksumSHA256 === session.checksumSha256 && head.ContentLength === session.sizeBytes) {
    await args.assertBillingEnabled();
    await finishExport({ ...args, now: clock() }, session, head);
    return "complete";
  }
  return withExportLease({ ...args, now: clock(), mutate: async ({ tx, jobRef, job: current, slot, now }) => {
    releasePreviewHold(tx, await readPreviewHold(tx, firestore, current));
    tx.update(jobRef, { active: false, phase: "failed", errorCode: "export_upload_failed", leaseToken: null,
      leaseUntil: 0, updatedAt: new Date(now).toISOString() });
    freeSlot(tx, firestore, slot, current.id, now);
    return "failed";
  } });
}

// The scheduled transcript tick settles uploads even with no worker online.
// Storage checks need a job lease, but do not occupy the rendering worker slot.
async function settleExpiredUploads(args) {
  const { firestore, clock = Date.now, log = require("firebase-functions/logger") } = args;
  const due = await firestore.collection(EXPORTS).where("active", "==", true)
    .where("uploadDeadline", "<=", clock()).orderBy("uploadDeadline", "asc").limit(5).get();
  for (const candidate of due.docs) {
    const request = await firestore.runTransaction(async (tx) => {
      const job = (await tx.get(candidate.ref)).data();
      const now = clock();
      if (!job?.active || !job.uploadIssued || job.uploadDeadline > now || job.leaseUntil > now) return null;
      const leaseToken = randomUUID();
      tx.update(candidate.ref, { leaseToken, leaseUntil: now + LEASE_MS, updatedAt: new Date(now).toISOString() });
      return { jobId: job.id, leaseToken };
    });
    if (!request) continue;
    try {
      await settleIssuedUpload({ ...args, now: clock(), request });
    } catch (error) {
      // The next tick retries after the lease expires; do not block transcription.
      log.warn("Video export settlement failed", { jobId: candidate.id,
        status: Number.isInteger(error?.status) ? error.status : null });
    }
  }
}

function parseExportWorkerRequest(operation, body) {
  const fields = { heartbeat: ["kind", "jobId", "leaseToken", "stage"],
    complete: ["kind", "jobId", "leaseToken", "engine", "output", "uploaded"],
    fail: ["kind", "jobId", "leaseToken", "errorCode"] }[operation];
  const output = body?.output;
  if (!fields || !body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== fields.length || !fields.every((field) => Object.hasOwn(body, field)) ||
      body.kind !== "orientation" || typeof body.jobId !== "string" || !/^[a-f0-9]{64}$/.test(body.jobId) ||
      typeof body.leaseToken !== "string" || !/^[a-f0-9-]{36}$/.test(body.leaseToken) ||
      (operation === "heartbeat" && !STAGES.has(body.stage)) ||
      (operation === "fail" && !FAILURES.has(body.errorCode)) ||
      (operation === "complete" && (body.engine !== ENGINE || typeof body.uploaded !== "boolean" ||
        !output || typeof output !== "object" || Array.isArray(output) || Object.keys(output).length !== 2 ||
        !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes <= 0 || output.sizeBytes > MAX_OUTPUT_BYTES ||
        typeof output.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(output.sha256)))) throw invalid();
  return body;
}

function workerJob(job, input) {
  return { kind: "orientation", id: job.id, leaseToken: job.leaseToken, leaseUntil: job.leaseUntil,
    engine: ENGINE, orientation: job.orientation, ...FRAMES[job.orientation],
    durationSeconds: job.input.durationSeconds, maxOutputBytes: MAX_OUTPUT_BYTES, input };
}

module.exports = { EXPORTS, STRAYS, ENGINE, FRAMES, LEASE_MS, MAX_ATTEMPTS, MAX_DURATION_SECONDS, MAX_OUTPUT_BYTES,
  exportId, parseExportRequest, requestExport, listExports, recordExportWorker, publicExport, claimExportJob, withExportLease,
  heartbeatExportJob, failExportJob, completeExportJob, settleIssuedUpload, settleExpiredUploads, checkStrayUpload, parseExportWorkerRequest, workerJob };
