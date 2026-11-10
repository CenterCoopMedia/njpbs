"use strict";

const p = require("./public-release-pair");
const deployment = require("./public-deployment-pointer");
const runtime = require("./cms-publication-runtime-control");
const adoption = require("./public-release-bootstrap-adoption");
const admission = require("./public-release-bootstrap-admission");
const writer = require("./public-release-writer-fence");
const { exhaustedPostProof } = require("./no-build-post-proof-state");
const { readPublicContextInTransaction } = require("./public-context-revision");
const { verifiedPreparation } = require("./public-context-publication");
const { retryExhausted } = require("./no-build-cloud-work");
const { publicationTarget } = require("./publication-target");
const isDevelopment = attempt => attempt.environment === "development";
const publicReleasePauseRoot = attempt => isDevelopment(attempt) ? "system/devPublicReleasePause" : "system/productionPublicReleasePause";
const kind = (attempt, suffix) => `${isDevelopment(attempt) ? "dev" : "production"}-${suffix}`;
const DEV_PUBLIC_PAUSE_RECOVERY_ISSUE = 4471;
const PRODUCTION_FAILED_PAUSE_GAP = 4582;
function productionFailedPauseRefused() {
  const error = new Error("Production failed-pause recovery/return STOP pending #4582");
  error.code = "production-failed-pause-recovery-unreviewed";
  throw error;
}
const recoveryIssue = attempt => attempt.environment === "production" ? PRODUCTION_FAILED_PAUSE_GAP : DEV_PUBLIC_PAUSE_RECOVERY_ISSUE;
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const claimed = value => typeof value?.claim === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.claim);
const refuse = () => { throw new p.PublicReleaseProtocolError(); };
function parsePublicReleasePauseAttempt(value) {
  p.exact(value, ["schemaVersion", "operationId", "environment", "projectId", "oldRuntime", "legacyPointerDigest"]);
  const old = runtime.parseCmsPublicationRuntimeControl(value.oldRuntime);
  const target = publicationTarget(value.environment), cloud = runtime.cloudCmsPublicationRuntimeControl(old);
  if (value.schemaVersion !== 1 || !deployment.isPublicDeploymentIdentifier(value.operationId) ||
      value.projectId !== target.projectId || !p.digest(value.legacyPointerDigest) ||
      old.phase !== "ready" || cloud.phase !== "ready" || cloud.serializerId !== target.serializerId || old.commitSha !== cloud.commitSha ||
      value.environment === "development" && (!old.cloud || ["cloudflare-publisher", "cloudflare-dev-publisher"].includes(old.serializerId)) ||
      value.environment === "production" && old.cloud && ["cloudflare-publisher", "cloudflare-dev-publisher"].includes(old.serializerId) && old.serializerId !== target.serializerId) refuse();
  return p.freeze(structuredClone(value));
}
function parseDevPublicReleasePauseAttempt(value) {
  if (value?.environment !== "development") refuse();
  return parsePublicReleasePauseAttempt(value);
}
function database(firestore, attempt) {
  if (firestore?.projectId !== publicationTarget(attempt.environment).projectId) refuse();
}
const paused = attempt => ({ ...attempt.oldRuntime, phase: "paused",
  ...(attempt.oldRuntime.cloud ? { cloud: { ...attempt.oldRuntime.cloud, phase: "paused" } } : {}) });
const bootstrapAttempt = attempt => ({ schemaVersion: 2, operationId: attempt.operationId,
  environment: attempt.environment, legacyPointerDigest: attempt.legacyPointerDigest });
const pauseReceipt = (attempt, initialQueueFailures = []) => ({ schemaVersion: 1, kind: kind(attempt, "public-runtime-paused"), attempt,
  attemptDigest: p.publicReleaseDigest(attempt), runtime: paused(attempt), initialQueueFailures });
function original(row, expected) {
  if (!row.exists || !row.createTime.isEqual(row.updateTime) || !same(row.data(), expected)) refuse();
  return row.data();
}
function readOriginalPause(s, attempt) {
  if (!s.saved.exists) refuse();
  const value = s.saved.data(), entries = value.initialQueueFailures;
  if (!Array.isArray(entries) || entries.length > 1000 || new Set(entries.map(row => row.operationId)).size !== entries.length) refuse();
  for (const row of entries) {
    p.exact(row, ["operationId", "status"]);
    if (!deployment.isPublicDeploymentIdentifier(row.operationId) || !["failed", "public_unconfirmed"].includes(row.status)) refuse();
  }
  return original(s.saved, pauseReceipt(attempt, entries));
}
async function state(firestore, transaction, attempt) {
  const paths = [`${publicReleasePauseRoot(attempt)}/attempts/${attempt.operationId}`, `${publicReleasePauseRoot(attempt)}/drains/${attempt.operationId}`,
    runtime.RUNTIME_DOCUMENT_PATH, "system/publicDeployment", admission.BOOTSTRAP_ADMISSION_FENCE_PATH,
    writer.RELEASE_WRITER_FENCE_PATH, `${admission.BOOTSTRAP_ADMISSION_ATTEMPTS}/${attempt.operationId}`,
    "system/publicReleaseChanges", "system/publicReleaseChanges/enrollment/initial", "system/publicReleaseChangeLog",
    `${publicReleasePauseRoot(attempt)}/failures/${attempt.operationId}`];
  const [saved, drained, pins, pointer, fence, writerRow, bootstrap, head, enrollment, producer, failed] =
    await transaction.getAll(...paths.map(path => firestore.doc(path)));
  return { saved, drained, pins, pointer, fence, writerRow, bootstrap, head, enrollment, producer, failed };
}
function ownsFences(s, attempt) {
  if (!s.fence.exists || !s.writerRow.exists || !s.bootstrap.exists) return false;
  const expected = bootstrapAttempt(attempt), attemptDigest = p.publicReleaseDigest(expected);
  const fence = admission.parseBootstrapAdmissionFence(s.fence.data());
  return fence.status === "closed" && fence.operationId === attempt.operationId && fence.attemptDigest === attemptDigest &&
    same(s.bootstrap.data(), expected) && same(writer.parseReleaseWriterFence(s.writerRow.data()),
      { schemaVersion: 2, operationId: attempt.operationId, attemptDigest });
}
function current(s, attempt) {
  let pointerMatches = false;
  try { pointerMatches = adoption.legacyBootstrapPointerDigest(s.pointer.data()) === attempt.legacyPointerDigest &&
    s.pointer.data().state === "idle" && s.pointer.data().activeCommitSha === attempt.oldRuntime.commitSha; } catch { /* Later selector. */ }
  const ownsPausedRuntime = s.pins.exists && same(s.pins.data(), paused(attempt)), ownsClosedFence = ownsFences(s, attempt);
  return { ownsPausedRuntime, ownsClosedFence, currentReady: pointerMatches && ownsPausedRuntime && ownsClosedFence };
}
function requireOld(s, attempt) {
  const pointer = deployment.assertPublicDeploymentPointer(s.pointer.data());
  if (s.head.exists || s.enrollment.exists || s.producer.exists || pointer.state !== "idle" || pointer.activeGeneration < 1 ||
      pointer.activeCommitSha !== attempt.oldRuntime.commitSha || pointer.mediaLifecycleReady !== true ||
      pointer.lastReservedGeneration !== pointer.activeGeneration || pointer.newestEligibleGeneration !== pointer.activeGeneration ||
      adoption.legacyBootstrapPointerDigest(pointer) !== attempt.legacyPointerDigest) refuse();
}
/** Runtime admission pauses preserve the exact accepted-work owner. Neither
 * pin SHA nor serializer changes; a saved original can never re-pause a later
 * runtime. Admission/writer fences are owned by the existing close owner. */
async function pause(firestore, attempt) {
  return firestore.runTransaction(async transaction => {
    const s = await state(firestore, transaction, attempt);
    if (s.saved.exists) { readOriginalPause(s, attempt); return readOriginalFailure(s, attempt); }
    requireOld(s, attempt);
    if (s.failed.exists || s.drained.exists || s.writerRow.exists || s.bootstrap.exists || !same(s.pins.data(), attempt.oldRuntime) ||
        s.fence.exists && admission.parseBootstrapAdmissionFence(s.fence.data()).status !== "open") refuse();
    if (s.fence.exists) {
      const previous = s.fence.data();
      const abandoned = (await transaction.get(firestore.doc(`system/publicReleaseAdmissions/bootstrapAbandons/${previous.operationId}`))).data();
      if (abandoned?.kind !== "bootstrap-admission-abandoned" || abandoned.operationId !== previous.operationId ||
          abandoned.attemptDigest !== previous.attemptDigest || p.publicReleaseDigest(abandoned) !== previous.resumeReceiptDigest) refuse();
    }
    // Refuse permanent/malformed/oversized drain blockers before stopping
    // admission. Only original cloud build-free queues may remain; build
    // reservations/deployments would invalidate this attempt's frozen pointer.
    await drain(firestore, transaction, attempt, true);
    const oldOwner = { owner: "cloudflare", release: attempt.oldRuntime.commitSha };
    const initialQueueFailures = (await rows(firestore, transaction, "cmsPublishQueue"))
      .filter(row => originalBuildFreeQueue(row.data(), oldOwner) && ["failed", "public_unconfirmed"].includes(row.data().status))
      .map(row => ({ operationId: row.id, status: row.data().status }));
    transaction.update(firestore.doc(runtime.RUNTIME_DOCUMENT_PATH), { phase: "paused", ...(attempt.oldRuntime.cloud ? { "cloud.phase": "paused" } : {}) });
    transaction.create(firestore.doc(`${publicReleasePauseRoot(attempt)}/attempts/${attempt.operationId}`), pauseReceipt(attempt, initialQueueFailures));
    transaction.create(firestore.collection("admin_logs").doc(), require("./audit").adminLogEntry({
      actorUid: `system:${kind(attempt, "public-release-pause")}`,
      action: isDevelopment(attempt) ? "public-release.dev-runtime-pause" : "public-release.production-runtime-pause", target: attempt.operationId,
      before: attempt.oldRuntime, after: paused(attempt) }));
  });
}
async function rows(firestore, transaction, path) {
  // Refuse oversized history rather than silently truncating the drain.
  const result = await transaction.get(firestore.collection(path).limit(1001));
  if (result.size > 1000) refuse();
  return result.docs;
}
function originalBuildFreeQueue(value, oldOwner) {
  return ["post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1"].includes(value.transport) &&
    value.backgroundRuntime && same(value.backgroundRuntime, oldOwner) && value.artifactBuild === undefined && value.homeFullBuild === undefined;
}
function queueFailedAfterPause(row, oldOwner, initialFailures) {
  if (!initialFailures) return false;
  const value = row.data();
  return originalBuildFreeQueue(value, oldOwner) && value.claim == null && value.nextAttemptAt == null &&
    (["failed", "public_unconfirmed"].includes(value.status) && initialFailures.get(row.id) !== value.status ||
      exhaustedPostProof(value) && value.postProof.claim == null);
}
function postProofComplete(queue) {
  if (queue.transport !== "post-no-build-v1" || queue.status !== "success" || queue.postProof == null) return true;
  const proof = queue.postProof;
  return ["verified", "superseded"].includes(proof.status) && proof.claim == null && proof.nextAttemptAt === null &&
    Number.isSafeInteger(proof.attempts) && proof.attempts >= 0 && proof.attempts <= 4;
}
function postProofRetryable(proof) {
  return ["pending", "failed"].includes(proof?.status) && Number.isSafeInteger(proof.attempts) && proof.attempts >= 0 && proof.attempts <= 4 &&
    (proof.attempts < 4 || proof.status === "pending" && claimed(proof) && proof.nextAttemptAt > Date.now()) &&
    Number.isFinite(proof.nextAttemptAt) && proof.nextAttemptAt >= 0 && (proof.claim == null || claimed(proof));
}
function preparationOwned(value, oldOwner, contextDigest) {
  return value?.schemaVersion === 1 && value.contextDigest === contextDigest && value.runtime && same(value.runtime, oldOwner);
}
function preparationRetryable(value, oldOwner, contextDigest) {
  return preparationOwned(value, oldOwner, contextDigest) && ["pending", "failed", "building"].includes(value.status) &&
    Number.isSafeInteger(value.attempts) && value.attempts >= 0 && value.attempts <= 4 &&
    (value.attempts < 4 || value.status === "building" && claimed(value) && value.nextAttemptAt > Date.now()) &&
    Number.isFinite(value.nextAttemptAt) && value.nextAttemptAt >= 0 && (value.claim == null || claimed(value)) &&
    value.reservation?.commitSha === oldOwner.release && deployment.isPublicDeploymentIdentifier(value.reservation.buildBatchId) &&
    p.positive(value.reservation.generation) && Number.isSafeInteger(value.reservation.cutoffAt?.toMillis?.()) &&
    value.reservation.cutoffAt.toMillis() > 0 && (value.admissionRevision === null || p.positive(value.admissionRevision));
}
async function currentQueueIds(firestore, transaction) {
  const ids = new Set(), add = value => {
    if (value == null) return;
    if (!deployment.isPublicDeploymentIdentifier(value)) refuse();
    ids.add(value);
  };
  for (const path of ["system/publicDeployment/noBuildPostOwners", "system/publicDeployment/noBuildPageOwners"]) {
    for (const row of await rows(firestore, transaction, path)) {
      const owner = row.data();
      if (path.endsWith("noBuildPostOwners") && owner.mode === "static") continue;
      add(owner.operationId);
    }
  }
  const [legacy, aggregate] = await transaction.getAll(firestore.doc("system/publicDeployment/noBuildPosts/current"),
    firestore.doc("system/publicDeployment/aggregateContexts/current"));
  if (legacy.data()?.mode !== "static") add(legacy.data()?.operationId);
  const context = aggregate.data();
  if (context) {
    for (const key of ["operationId", "namespaceOperationId", "preparationOperationId"]) add(context[key]);
    if (context.operationIds !== undefined) {
      if (!Array.isArray(context.operationIds) || context.operationIds.length > 100) refuse();
      context.operationIds.forEach(add);
    }
  }
  return ids;
}
/** Retained C2's public-work surfaces plus the native nested Post public proof:
 * queues, batches, journals/releases, external refresh and outputs/Home. Reads
 * share the completion transaction. No accepted document is written. */
async function drain(firestore, transaction, attempt, beforePause = false, initialQueueFailures = null, recoveredFailures = null) {
  const recovered = (code, path) => recoveredFailures?.has(`${code}:${path}`) === true;
  const counts = { queues: 0, batches: 0, retiredBatches: 0, releases: 0, outputs: 0, externalRefresh: 0 };
  const originalQueues = new Set(), oldOwner = { owner: "cloudflare", release: attempt.oldRuntime.commitSha };
  const initialFailures = initialQueueFailures && new Map(initialQueueFailures.map(row => [row.operationId, row.status]));
  let currentIds, preparationDigest;
  const unclaimed = value => value.claim == null;
  for (const [path, terminal, key] of [
    // Canonical retained-owner terminal labels, including historical results
    // whose public proof failed. Drain never relabels them as public success.
    ["cmsPublishQueue", ["success", "failure", "failed", "public_unconfirmed", "cancelled", "superseded", "deployed"], "queues"],
    ["system/publicDeployment/buildBatches", ["deployed", "failed", "superseded", "cancelled", "retired"], "batches"],
  ]) {
    for (const row of await rows(firestore, transaction, path)) {
      const value = row.data(); counts[key]++;
      // Native staff retry can re-arm a current failed operation without a new
      // ID. Resolve it while ready; only inactive failed history may be sealed.
      if (beforePause && key === "queues" && ["failed", "public_unconfirmed"].includes(value.status) &&
          ["post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1"].includes(value.transport)) {
        currentIds ??= await currentQueueIds(firestore, transaction);
        if (currentIds.has(row.id)) refuse();
      }
      if (key === "queues" && queueFailedAfterPause(row, oldOwner, initialFailures) && !recovered("queue-failed", row.ref.path)) refuse();
      const originalQueue = key === "queues" && ["pending", "publishing", "success"].includes(value.status) &&
        originalBuildFreeQueue(value, oldOwner);
      if (originalQueue) {
        originalQueues.add(row.id);
        preparationDigest ??= await readPublicContextInTransaction(transaction, firestore);
        const preparation = (await transaction.get(row.ref.collection("backgroundPreparation").doc(preparationDigest))).data();
        if (preparation && !(verifiedPreparation(preparation, oldOwner, preparationDigest) && unclaimed(preparation) &&
            preparation.nextAttemptAt == null) && !(beforePause && preparationRetryable(preparation, oldOwner, preparationDigest)) &&
            !recovered("background-preparation-exhausted", `${row.ref.path}/backgroundPreparation/${preparationDigest}`)) refuse();
      }
      if (!postProofComplete(value) && !recovered("queue-failed", row.ref.path)) {
        if (!beforePause || !originalQueue || !postProofRetryable(value.postProof)) refuse();
        // Recovery follows the current owner of this Post, never aggregate or
        // other-family aliases of an older queue. Superseded success queues
        // can retain retryable proofs that the native owner no longer visits.
        const { state: owner } = await require("./no-build-post-ownership").readNoBuildPostOwner({
          firestore, transaction, postId: value.noBuildPost?.postId });
        if (!owner || owner.mode === "static" || owner.operationId !== row.id) refuse();
      }
      if (beforePause && originalQueue && value.status !== "success") continue;
      if (!terminal.includes(value.status) || !unclaimed(value) || value.status === "failed" && value.nextAttemptAt != null) refuse();
      if (key === "batches" && value.status === "retired") {
        const validators = require("./public-deployment");
        const validate = value.retirementReceipt?.reason === "dev_historical_reservation_below_active" && firestore.projectId === "njpbs-site-dev"
          ? require("./dev-publication-history").assertDevHistoricalRetiredBatch
          : value.retirementReceipt?.reason === "dev_publish_failed_before_upload"
          ? require("./dev-publication-preupload").assertDevPreuploadRetiredBatch
          : value.retirementReceipt?.reason === "cloud_release_not_staged" ? validators.assertPublicDeploymentRetiredCloudReleaseBatch
            : validators.assertPublicDeploymentRetiredBatch;
        validate(value, row.id);
        counts.retiredBatches++;
      }
    }
  }
  const retryableTask = task => {
    // The Home owner omits retry fields only on its pristine pending signal.
    // Background tasks always require the fields their executor reads.
    const pristineHome = task?.owner === "page-no-build-v1" && task.status === "pending" &&
      task.attempts === undefined && task.nextAttemptAt === undefined && task.claim == null;
    const attempts = pristineHome ? 0 : task?.attempts, nextAttemptAt = pristineHome ? 0 : task?.nextAttemptAt;
    return task?.schemaVersion === 1 && task.runtime && same(task.runtime, oldOwner) &&
      ["pending", "failed"].includes(task.status) && Number.isSafeInteger(attempts) && attempts >= 0 && attempts <= 4 &&
      (attempts < 4 || task.status === "pending" && claimed(task) && nextAttemptAt > Date.now()) &&
      Number.isFinite(nextAttemptAt) && nextAttemptAt >= 0 && (task.claim == null || claimed(task));
  };
  for (const owner of new Set([attempt.oldRuntime.serializerId, attempt.oldRuntime.cloud?.serializerId ?? attempt.oldRuntime.serializerId])) {
    const path = `cmsPublicationSerializerJournals/${owner}`;
    const journal = (await transaction.get(firestore.doc(path))).data();
    if (journal?.job != null) refuse();
    for (const row of await rows(firestore, transaction, `${path}/releases`)) {
      const value = row.data(); counts.releases++;
      if (!["deployed", "failed", "superseded", "cancelled"].includes(value.status) || value.nextAttemptAt != null || !unclaimed(value)) refuse();
    }
  }
  const refresh = (await transaction.get(firestore.doc("system/publicDeployment/externalRefresh/current"))).data();
  if (refresh) {
    if (refresh.schemaVersion !== 1 || !["failed", "verified"].includes(refresh.status) || !unclaimed(refresh) ||
        refresh.runtime?.owner !== "cloudflare" || refresh.runtime.release !== attempt.oldRuntime.commitSha ||
        !Number.isSafeInteger(refresh.nextAttemptAt) || refresh.nextAttemptAt < 0 || !/^[A-Za-z0-9]{20}$/.test(refresh.operationId ?? "")) refuse();
    counts.externalRefresh++;
  }
  for (const row of await rows(firestore, transaction, "cmsBackgroundOutputs")) {
    const value = row.data(); counts.outputs++;
    if (row.id === "home" && value.owner === "page-no-build-v1") {
      const home = (await transaction.get(firestore.doc("system/publicDeployment/noBuildPageOwners/home"))).data();
      if (value.schemaVersion !== 1 || value.output !== "home" || value.pageId !== "home" ||
          value.ownerPath !== "system/publicDeployment/noBuildPageOwners/home" || !/^[A-Za-z0-9]{20}$/.test(value.operationId ?? "") ||
          !unclaimed(value) || value.taskPath != null || home?.schemaVersion !== 1 || home.pageId !== "home" ||
          home.operationId !== value.operationId || home.runtime?.owner !== "cloudflare" ||
          home.runtime.release !== attempt.oldRuntime.commitSha) refuse();
      const queue = (await transaction.get(firestore.doc(`cmsPublishQueue/${home.operationId}`))).data();
      if (!queue || !["success", "cancelled", "superseded"].includes(queue.status) &&
          !recovered("queue-failed", `cmsPublishQueue/${home.operationId}`) && !(beforePause && originalQueues.has(home.operationId)) ||
          !unclaimed(queue) && !(beforePause && originalQueues.has(home.operationId))) refuse();
      const refresh = home.homeRefresh;
      if (refresh != null && !["verified", "superseded"].includes(refresh.status) &&
          !recovered("home-refresh-exhausted", refresh.taskPath)) {
        if (!beforePause || refresh.status !== "pending" || refresh.schemaVersion !== 1 || !p.positive(refresh.revision) ||
            !originalQueues.has(refresh.sourceOperationId) ||
            refresh.taskPath !== `cmsPublishQueue/${refresh.sourceOperationId}/homePageRefresh/home`) refuse();
        const task = (await transaction.get(firestore.doc(refresh.taskPath))).data();
        if (!retryableTask(task) || task.owner !== "page-no-build-v1" || task.revision !== refresh.revision ||
            task.input?.homeOperationId !== home.operationId || task.input.homeSourceVersion !== home.sourceVersion ||
            task.input.sourceOperationId !== refresh.sourceOperationId) refuse();
      }
    } else if (recovered("background-exhausted", value.taskPath)) {
      // The separate development recovery owner has validated this exact
      // exhausted task/output pair. It remains failed, never a verified output.
      const task = (await transaction.get(firestore.doc(value.taskPath))).data();
      if (value.schemaVersion !== 1 || value.owner !== "post-background-v1" || value.status !== "failed" ||
          value.output !== row.id || !unclaimed(value) || !value.runtime || !same(value.runtime, oldOwner) ||
          task?.output !== row.id || task.revision !== value.revision) refuse();
    } else if (beforePause && value.status === "pending") {
      const path = /^cmsPublishQueue\/([A-Za-z0-9_-]{1,200})\/backgroundOutputs\/[A-Za-z0-9_-]+$/.exec(value.taskPath ?? "");
      if (!path || !originalQueues.has(path[1]) || value.schemaVersion !== 1 || value.owner !== "post-background-v1" ||
          value.output !== row.id || !p.positive(value.revision) || !value.runtime || !same(value.runtime, oldOwner) || !unclaimed(value)) refuse();
      const task = (await transaction.get(firestore.doc(value.taskPath))).data();
      if (!retryableTask(task) || task.owner !== value.owner || task.output !== row.id || task.revision !== value.revision) refuse();
    } else if (!["verified", "superseded", "cancelled"].includes(value.status) || !unclaimed(value)) refuse();
  }
  return counts;
}
function drainReceipt(attempt, counts, source) {
  return { schemaVersion: 1, kind: kind(attempt, "public-release-paused-and-drained"), operationId: attempt.operationId,
    projectId: attempt.projectId, attemptDigest: p.publicReleaseDigest(attempt), pauseReceiptDigest: p.publicReleaseDigest(source),
    bootstrapAttemptDigest: p.publicReleaseDigest(bootstrapAttempt(attempt)), counts, acceptedWorkChanged: 0 };
}
function readOriginalDrain(s, attempt) {
  if (!s.drained.exists) return null;
  const value = s.drained.data();
  p.exact(value.counts, ["queues", "batches", "retiredBatches", "releases", "outputs", "externalRefresh"]);
  if (!Object.values(value.counts).every(count => Number.isSafeInteger(count) && count >= 0)) refuse();
  return original(s.drained, drainReceipt(attempt, value.counts, readOriginalPause(s, attempt)));
}
function failureReceipt(attempt, blockers, source) {
  return { schemaVersion: 1, kind: kind(attempt, "public-release-pause-failed"), operationId: attempt.operationId,
    projectId: attempt.projectId, attemptDigest: p.publicReleaseDigest(attempt), pauseReceiptDigest: p.publicReleaseDigest(source),
    recoveryIssue: recoveryIssue(attempt), operations: [...new Set(blockers.map(row => row.operationId))].sort(),
    blockers, acceptedWorkChanged: 0 };
}
function readOriginalFailure(s, attempt) {
  if (!s.failed.exists) return null;
  if (s.drained.exists) refuse();
  const value = s.failed.data();
  if (!Array.isArray(value.blockers) || !value.blockers.length || value.blockers.length > 3002) refuse();
  for (const row of value.blockers) {
    p.exact(row, ["code", "operationId", "path"]);
    if (!deployment.isPublicDeploymentIdentifier(row.operationId) || !(
      row.code === "queue-failed" && row.path === `cmsPublishQueue/${row.operationId}` ||
      row.code === "background-exhausted" && typeof row.path === "string" && row.path.startsWith(`cmsPublishQueue/${row.operationId}/backgroundOutputs/`) &&
        /^cmsPublishQueue\/[A-Za-z0-9._:-]{1,128}\/backgroundOutputs\/[A-Za-z0-9_-]+$/.test(row.path) ||
      row.code === "background-preparation-exhausted" && typeof row.path === "string" &&
        row.path.startsWith(`cmsPublishQueue/${row.operationId}/backgroundPreparation/`) &&
        /^cmsPublishQueue\/[A-Za-z0-9._:-]{1,128}\/backgroundPreparation\/[a-f0-9]{64}$/.test(row.path) ||
      row.code === "home-refresh-exhausted" && row.path === `cmsPublishQueue/${row.operationId}/homePageRefresh/home` ||
      row.code === "home-owner-failed" && row.path === "system/publicDeployment/noBuildPageOwners/home")) refuse();
  }
  return original(s.failed, failureReceipt(attempt, value.blockers, readOriginalPause(s, attempt)));
}
/** An exhausted original is an immutable STOP, never a retry/resume grant.
 * The coordinator owns the separate pre-enrollment recovery gap (#4471). */
async function recordFailedPause(firestore, attempt) {
  return firestore.runTransaction(async transaction => {
    const s = await state(firestore, transaction, attempt);
    const source = readOriginalPause(s, attempt);
    const before = readOriginalFailure(s, attempt);
    if (before) return { idempotent: true, receipt: before };
    if (s.drained.exists) return null;
    requireOld(s, attempt);
    if (!current(s, attempt).ownsPausedRuntime) return null;
    const oldOwner = { owner: "cloudflare", release: attempt.oldRuntime.commitSha }, queues = new Map(), blockers = [];
    const initialFailures = new Map(source.initialQueueFailures.map(row => [row.operationId, row.status]));
    let preparationDigest;
    const add = (code, operationId, path) => blockers.push({ code, operationId, path });
    const exhausted = task => task?.schemaVersion === 1 && task.status === "failed" && task.claim == null &&
      Number.isSafeInteger(task.attempts) && task.attempts >= 4 && task.nextAttemptAt === null && task.runtime && same(task.runtime, oldOwner);
    for (const row of await rows(firestore, transaction, "cmsPublishQueue")) {
      const queue = row.data();
      if (!originalBuildFreeQueue(queue, oldOwner)) continue;
      queues.set(row.id, queue);
      if (queueFailedAfterPause(row, oldOwner, initialFailures))
        add("queue-failed", row.id, row.ref.path);
      if (["pending", "publishing", "success"].includes(queue.status) || queueFailedAfterPause(row, oldOwner, initialFailures)) {
        preparationDigest ??= await readPublicContextInTransaction(transaction, firestore);
        const ref = row.ref.collection("backgroundPreparation").doc(preparationDigest), preparation = (await transaction.get(ref)).data();
        if (preparationOwned(preparation, oldOwner, preparationDigest) && retryExhausted(preparation))
          add("background-preparation-exhausted", row.id, ref.path);
      }
    }
    for (const row of await rows(firestore, transaction, "cmsBackgroundOutputs")) {
      const value = row.data();
      if (value.owner === "post-background-v1") {
        const match = /^cmsPublishQueue\/([A-Za-z0-9._:-]{1,128})\/backgroundOutputs\/[A-Za-z0-9_-]+$/.exec(value.taskPath ?? "");
        if (!match || !queues.has(match[1]) || !value.runtime || !same(value.runtime, oldOwner)) continue;
        const task = (await transaction.get(firestore.doc(value.taskPath))).data();
        if (exhausted(task) && task.owner === value.owner && task.output === row.id && task.revision === value.revision)
          add("background-exhausted", match[1], value.taskPath);
      } else if (row.id === "home" && value.owner === "page-no-build-v1") {
        const home = (await transaction.get(firestore.doc("system/publicDeployment/noBuildPageOwners/home"))).data(), refresh = home?.homeRefresh;
        if (!home?.runtime || !same(home.runtime, oldOwner) || home.operationId !== value.operationId || !refresh ||
            !queues.has(refresh.sourceOperationId) || refresh.taskPath !== `cmsPublishQueue/${refresh.sourceOperationId}/homePageRefresh/home`) continue;
        const task = (await transaction.get(firestore.doc(refresh.taskPath))).data();
        if (exhausted(task) && task.owner === value.owner && task.revision === refresh.revision &&
            task.input?.homeOperationId === home.operationId && task.input.homeSourceVersion === home.sourceVersion) {
          add("home-refresh-exhausted", refresh.sourceOperationId, refresh.taskPath);
          add("home-owner-failed", home.operationId, "system/publicDeployment/noBuildPageOwners/home");
        }
      }
    }
    if (!blockers.length) return null;
    blockers.sort((a, b) => `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`, "en"));
    const receipt = failureReceipt(attempt, blockers, source);
    transaction.create(firestore.doc(`${publicReleasePauseRoot(attempt)}/failures/${attempt.operationId}`), receipt);
    transaction.create(firestore.collection("admin_logs").doc(), require("./audit").adminLogEntry({ actorUid: `system:${kind(attempt, "public-release-pause")}`,
      action: isDevelopment(attempt) ? "public-release.dev-pause-failed" : "public-release.production-pause-failed", target: attempt.operationId, before: null,
      after: { failureReceiptDigest: p.publicReleaseDigest(receipt), recoveryIssue: recoveryIssue(attempt) } }));
    return { idempotent: false, receipt };
  });
}
async function readPublicReleasePause({ firestore, attempt: raw }) {
  const attempt = parsePublicReleasePauseAttempt(raw); database(firestore, attempt);
  return firestore.runTransaction(async transaction => {
    const s = await state(firestore, transaction, attempt);
    if (s.saved.exists) readOriginalPause(s, attempt);
    if ((s.drained.exists || s.failed.exists) && !s.saved.exists) refuse();
    const receipt = readOriginalDrain(s, attempt), failure = readOriginalFailure(s, attempt), guards = current(s, attempt);
    return { pauseCommitted: s.saved.exists, drainCommitted: Boolean(receipt), ...guards, currentReady: !failure && guards.currentReady,
      stop: Boolean(failure), outcome: failure ? "paused-failed" : receipt ? "drained" : s.saved.exists ? "paused-awaiting-drain" : "not-started",
      recoveryIssue: failure ? recoveryIssue(attempt) : null, failureReceipt: failure,
      failureReceiptDigest: failure ? p.publicReleaseDigest(failure) : null,
      pauseReceipt: s.saved.exists ? s.saved.data() : null, receipt, receiptDigest: receipt ? p.publicReleaseDigest(receipt) : null };
  }, { readOnly: true });
}
async function pausePublicRelease({ firestore, attempt: raw }) {
  const attempt = parsePublicReleasePauseAttempt(raw); database(firestore, attempt);
  if (await pause(firestore, attempt)) return { idempotent: true, ...await readPublicReleasePause({ firestore, attempt }) };
  try {
    // Check accepted work before acquiring fences: pending original work must
    // finish through its original owner, with no writer fence stranding it.
    await firestore.runTransaction(async transaction => {
      const s = await state(firestore, transaction, attempt);
      const source = readOriginalPause(s, attempt); requireOld(s, attempt);
      if (!current(s, attempt).ownsPausedRuntime) refuse();
      await drain(firestore, transaction, attempt, false, source.initialQueueFailures);
    }, { readOnly: true });
    await adoption.closePublicReleaseBootstrapAdmission({ firestore, attempt: bootstrapAttempt(attempt) });
    return await firestore.runTransaction(async transaction => {
      const s = await state(firestore, transaction, attempt);
      const source = readOriginalPause(s, attempt); requireOld(s, attempt);
      if (s.failed.exists || !current(s, attempt).currentReady) refuse();
      const counts = await drain(firestore, transaction, attempt, false, source.initialQueueFailures), before = readOriginalDrain(s, attempt);
      const receipt = before ?? drainReceipt(attempt, counts, source);
      if (!before) transaction.create(firestore.doc(`${publicReleasePauseRoot(attempt)}/drains/${attempt.operationId}`), receipt);
      return { idempotent: Boolean(before), pauseCommitted: true, drainCommitted: true, ...current(s, attempt), stop: false, outcome: "drained",
        pauseReceipt: source, receipt, receiptDigest: p.publicReleaseDigest(receipt) };
    });
  } catch (error) {
    const failed = await recordFailedPause(firestore, attempt);
    if (!failed) throw error;
    return { idempotent: failed.idempotent, ...await readPublicReleasePause({ firestore, attempt }) };
  }
}
async function readPublicReleaseRuntimeRestore({ firestore, attempt: raw }) {
  const attempt = parsePublicReleasePauseAttempt(raw); database(firestore, attempt);
  return firestore.runTransaction(async transaction => {
    const saved = await transaction.get(firestore.doc(`${publicReleasePauseRoot(attempt)}/restores/${attempt.operationId}`));
    const receipt = saved.exists ? original(saved, { schemaVersion: 1, kind: kind(attempt, "public-release-runtime-restored"),
      attemptDigest: p.publicReleaseDigest(attempt), runtime: attempt.oldRuntime }) : null;
    const s = await state(firestore, transaction, attempt);
    let legacy = false;
    try { if (s.pointer.data()?.schemaVersion === 1) { requireOld(s, attempt); legacy = true; } } catch (error) { if (!(error instanceof p.PublicReleaseProtocolError)) throw error; }
    const ownsReadyRuntime = s.pins.exists && same(s.pins.data(), attempt.oldRuntime), ownsClosedFence = ownsFences(s, attempt);
    const drainReady = attempt.environment !== "production" || !s.failed.exists && Boolean(readOriginalDrain(s, attempt));
    const previewReadyForAbandon = attempt.environment !== "production" || await adoption.readProductionBootstrapPreviewReturnInTransaction({
      firestore, transaction, attempt: bootstrapAttempt(attempt), rendererSha: attempt.oldRuntime.commitSha });
    return { restoreCommitted: Boolean(receipt), receipt, ownsReadyRuntime, ownsClosedFence, drainReady, previewReadyForAbandon,
      canAbandon: Boolean(receipt) && legacy && ownsReadyRuntime && ownsClosedFence && drainReady && previewReadyForAbandon };
  }, { readOnly: true });
}
/** Exact original pins may return only before enrollment while the original
 * independent fences stay closed. The existing abandon owner opens them later.
 * An unknown reply reads the immutable restore receipt; it never replays a
 * legacy resume against enrolled controls. */
async function restorePublicReleasePausedRuntime({ firestore, attempt: raw }) {
  const attempt = parsePublicReleasePauseAttempt(raw); database(firestore, attempt);
  const ref = firestore.doc(`${publicReleasePauseRoot(attempt)}/restores/${attempt.operationId}`);
  const receipt = { schemaVersion: 1, kind: kind(attempt, "public-release-runtime-restored"),
    attemptDigest: p.publicReleaseDigest(attempt), runtime: attempt.oldRuntime };
  return firestore.runTransaction(async transaction => {
    const saved = await transaction.get(ref);
    if (saved.exists) return { idempotent: true, receipt: original(saved, receipt) };
    const s = await state(firestore, transaction, attempt);
    readOriginalPause(s, attempt); requireOld(s, attempt);
    if (attempt.environment === "production" && s.failed.exists) productionFailedPauseRefused();
    if (attempt.environment === "production" && !readOriginalDrain(s, attempt)) refuse();
    if (!current(s, attempt).currentReady) refuse();
    transaction.set(firestore.doc(runtime.RUNTIME_DOCUMENT_PATH), attempt.oldRuntime);
    transaction.create(ref, receipt);
    transaction.create(firestore.collection("admin_logs").doc(), require("./audit").adminLogEntry({
      actorUid: `system:${kind(attempt, "public-release-pause")}`,
      action: isDevelopment(attempt) ? "public-release.dev-runtime-restored" : "public-release.production-runtime-restored",
      target: attempt.operationId, before: paused(attempt), after: attempt.oldRuntime }));
    return { idempotent: false, receipt };
  });
}
/** The native abandon transaction shares this owner's immutable original
 * drain validation. A close-only abandon needs no drain only while both
 * controls are ready; a foreign pause cannot authorize enrollment. */
async function assertProductionPublicReleaseDrainInTransaction({ firestore, transaction, attempt }) {
  const saved = await transaction.get(firestore.doc(`system/productionPublicReleasePause/attempts/${attempt.operationId}`));
  if (!saved.exists) {
    const pins = runtime.parseCmsPublicationRuntimeControl((await transaction.get(firestore.doc(runtime.RUNTIME_DOCUMENT_PATH))).data());
    if (pins.phase !== "ready" || runtime.cloudCmsPublicationRuntimeControl(pins).phase !== "ready") refuse();
    return;
  }
  const originalAttempt = parsePublicReleasePauseAttempt(saved.data().attempt);
  if (originalAttempt.environment !== "production" || !same(bootstrapAttempt(originalAttempt), attempt)) refuse();
  const s = await state(firestore, transaction, originalAttempt);
  if (s.failed.exists) productionFailedPauseRefused();
  if (!readOriginalDrain(s, originalAttempt)) refuse();
}
/** A development renderer bootstrap must retain the original successful pause
 * and both closed fences; a failed or close-only attempt is not a drain. */
async function assertDevPublicReleaseDrainInTransaction({ firestore, transaction, operationId }) {
  database(firestore, { environment: "development" });
  const saved = await transaction.get(firestore.doc(`system/devPublicReleasePause/attempts/${operationId}`));
  if (!saved.exists) refuse();
  const attempt = parseDevPublicReleasePauseAttempt(saved.data().attempt);
  if (attempt.operationId !== operationId) refuse();
  const s = await state(firestore, transaction, attempt);
  if (s.failed.exists || !current(s, attempt).currentReady) refuse();
  const receipt = readOriginalDrain(s, attempt);
  if (!receipt) refuse();
  return receipt;
}
const development = run => options => { parseDevPublicReleasePauseAttempt(options.attempt); return run(options); };
module.exports = { recoveryInternals: { state, current, requireOld, readOriginalPause, readOriginalFailure, drain, bootstrapAttempt },
  assertProductionPublicReleaseDrainInTransaction, assertDevPublicReleaseDrainInTransaction, PRODUCTION_FAILED_PAUSE_GAP, productionFailedPauseRefused, publicReleasePauseRoot, parsePublicReleasePauseAttempt, pausePublicRelease, readPublicReleasePause, restorePublicReleasePausedRuntime, readPublicReleaseRuntimeRestore,
  DEV_PUBLIC_PAUSE_RECOVERY_ISSUE, parseDevPublicReleasePauseAttempt,
  pauseDevPublicRelease: development(pausePublicRelease), readDevPublicReleasePause: development(readPublicReleasePause) };
