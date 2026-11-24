"use strict";

const { postRoutePath } = require("./post-slug-contract");
const { createHash, randomUUID } = require("node:crypto");
const { contentLink } = require("./content-link");
const { setTimeout: delay } = require("node:timers/promises");
const { FieldValue } = require("firebase-admin/firestore");
const { TRANSPORT, readNoBuildPostDecisionInTransaction } = require("./no-build-post-publication");
const { readNoBuildPostOwner, listNoBuildPostOwners, readNoBuildPostCapability, effectiveNoBuildPostState } = require("./no-build-post-ownership");
const { settleBuildQueue, settleBuildQueueInTransaction } = require("./publish-build-state");
const { publishedBlockResourceError } = require("./published-resource-check");
const { postProofDue } = require("./no-build-post-proof-state");
const { publicationAttempt, publicationClaim, publicationFailure, publicationRetry } = require("./background-output-attempt");
const { readNoBuildFamilyAdmission } = require("./no-build-family-admission");
const { publicationTarget, assertPublicationTarget, assertPublicationDatabase, publicationPostCacheTag } = require("./publication-target");
const { readPublicContextInTransaction } = require("./public-context-revision");
const DUE_QUEUE_LIMIT = 32;

function assertReadbackTarget(firestore, target) {
  const expected = assertPublicationTarget(target);
  const emulator = /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") && /^demo-[a-z0-9-]+$/.test(firestore.projectId ?? "");
  if (!emulator) assertPublicationDatabase(firestore, expected);
  return expected;
}

function publicReadbackHeaders(target, value) {
  const headers = new Headers(value);
  const id = headers.get("cf-access-client-id");
  const secret = headers.get("cf-access-client-secret");
  if (target.environment === "development" ? !id?.trim() || !secret?.trim() : id !== null || secret !== null) {
    throw new Error("Public Post readback credentials do not match its target");
  }
  for (const name of headers.keys()) {
    if (!["cf-access-client-id", "cf-access-client-secret", "cache-control"].includes(name)) throw new Error("Invalid public Post readback headers");
  }
  return headers;
}

// Bound headers AND body consumption. Aborting alone need not settle a stalled
// stream; the deadline also prevents any late result from reaching settlement.
async function withinDeadline(milliseconds, work) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Public Post confirmation timed out"));
    }, milliseconds);
  });
  try { return await Promise.race([work(controller.signal), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

const PUBLIC_READ_STALL_MS = 10_000;
const PUBLIC_READ_BUDGET_MS = 45_000;
const REFRESH_PENDING = "public_refresh_pending";
const refreshProgress = new WeakMap();

// One public read. Each GET has ten seconds for its headers and body. A valid
// refresh-pending answer is progress: it restarts that limit until the caller's
// deadline. A route still refreshing at the deadline is distinct from a stall.
async function withinPublicRead(milliseconds, work, { onSlowRefresh = undefined, stop = undefined } = {}) {
  const controller = new AbortController();
  let stall, end, refreshing = false;
  const slowAt = Date.now() + PUBLIC_READ_STALL_MS;
  let cancel;
  const limit = new Promise((resolve, reject) => {
    const fail = code => {
      controller.abort();
      reject(Object.assign(new Error("Public Post confirmation timed out"), code ? { code } : {}));
    };
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => fail(), PUBLIC_READ_STALL_MS); };
    refreshProgress.set(controller.signal, () => {
      refreshing = true;
      arm();
      if (Date.now() >= slowAt) onSlowRefresh?.();
    });
    cancel = () => fail();
    stop?.addEventListener("abort", cancel, { once: true });
    end = setTimeout(() => fail(refreshing ? REFRESH_PENDING : null), milliseconds);
    arm();
  });
  try { return await Promise.race([work(controller.signal), limit]); }
  finally { clearTimeout(stall); clearTimeout(end); stop?.removeEventListener("abort", cancel); controller.abort(); }
}

async function purgePostRoutes(state, config, fetchImpl, target) {
  const routes = [...new Set(state.ownedSlugs.map(slug => publicationPostCacheTag(target, slug)))];
  if (!routes.length || routes.length > 100 || !state.ownedSlugs.includes(state.slug)) throw new Error("Invalid Post purge routes");
  const tags = [...routes, publicationPostCacheTag(target, "background")];
  await purgePublicCacheTags(tags, config, fetchImpl);
  return { operationId: state.operationId, tags, acknowledged: true };
}

async function purgePublicCacheTags(tags, config, fetchImpl) {
  if (!/^[a-f0-9]{32}$/.test(config?.zoneId ?? "") || !config?.token) throw new Error("Public purge configuration is unavailable");
  return withinDeadline(5_000, async signal => {
    for (let offset = 0; offset < tags.length; offset += 100) {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tags: tags.slice(offset, offset + 100) }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Post purge failed"); }
      const result = await response.json();
      if (result?.success !== true) throw new Error("Post purge failed");
    }
  });
}

// Home uses the existing Post background tag and purge transport. Fetch the
// already-bound secret only when publication confirmation needs invalidation.
async function purgePublicHome({ target, fetchPurge = fetch, purgeConfig } = {}) {
  if (assertPublicationTarget(target).environment !== "production") return;
  const config = purgeConfig ?? { zoneId: process.env.CMS_MEDIA_CLOUDFLARE_ZONE_ID,
    token: process.env.CMS_MEDIA_CACHE_PURGE_TOKEN };
  await purgePublicCacheTags([publicationPostCacheTag(target, "background")], config, fetchPurge);
}

function pauseUnlessAborted(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(undefined); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

// The Post reader's own "retry in one second" answer while its authority
// refreshes. It carries no receipt, unlike a withdrawal or renderer refusal.
function isUpdatingAnswer(response) {
  return response.status === 503 && response.headers.get("retry-after") === "1" &&
    ![...response.headers.keys()].some(name => name.startsWith("x-njpbs-"));
}

async function readPublicPostAfterRefresh(url, fetchPublic, signal, headers, { updatingIsPending = true } = {}) {
  headers = new Headers(headers);
  while (!signal.aborted) {
    const response = await fetchPublic(url, {
      method: "GET", redirect: "manual", signal, ...(headers.keys().next().done ? {} : { headers }),
    });
    const pending = response.headers.get("x-njpbs-publication-refresh") === "pending" && response.headers.get("retry-after") === "1";
    if (!pending && !(updatingIsPending && isUpdatingAnswer(response))) return response;
    await response.body?.cancel();
    // Public reads return Assets while their edge refresh runs. Each pending
    // answer restarts the caller's stall limit and retains the same operation.
    refreshProgress.get(signal)?.();
    await pauseUnlessAborted(1_000, signal);
  }
  throw new Error("Public Post confirmation timed out");
}

async function readPublicPostReceipt(state, fetchPublic, signal, target, headers) {
  const response = await readPublicPostAfterRefresh(`${target.origin}${postRoutePath(state.slug)}`, fetchPublic, signal, headers);
  const snapshotDigest = response.headers.get("x-njpbs-snapshot-sha256");
  const datasetFiguresDigest = response.headers.get("x-njpbs-dataset-figures-sha256");
  if (response.status !== (state.visible ? state.contentRedirectUrl ? 302 : 200 : 410) ||
      state.visible && state.contentRedirectUrl && (response.headers.get("location") !== state.contentRedirectUrl || response.headers.get("x-robots-tag") !== "noindex, nofollow") ||
      response.headers.get("cache-control") !== "no-store" ||
      response.headers.get("x-njpbs-content-source") !== "cms-no-build" ||
      response.headers.get("x-njpbs-publication-operation") !== state.operationId ||
      response.headers.get("x-njpbs-source-version") !== String(state.sourceVersion) ||
      snapshotDigest !== (state.snapshotDigest ?? null) ||
      datasetFiguresDigest !== (state.datasetFiguresDigest ?? null)) {
    await response.body?.cancel();
    throw new Error("Public Post receipt is unavailable");
  }
  const revisionHeader = response.headers.get("x-njpbs-admission-revision");
  const admissionRevision = /^[1-9][0-9]*$/.test(revisionHeader ?? "") ? Number(revisionHeader) : null;
  if ((admissionRevision === null && (state.visible || revisionHeader !== "unavailable")) ||
      (admissionRevision !== null && !Number.isSafeInteger(admissionRevision))) {
    await response.body?.cancel();
    throw new Error("Public admission receipt is unavailable");
  }
  const htmlDigest = state.visible && !state.contentRedirectUrl ? await verifyPublicHtml(response) : null;
  if (!state.visible || state.contentRedirectUrl) await response.body?.cancel();
  return { operationId: state.operationId, sourceVersion: state.sourceVersion, visible: state.visible, htmlDigest,
    ...(state.visible && state.contentRedirectUrl ? { contentRedirectUrl: response.headers.get("location") } : {}),
    admissionRevision,
    rendererSha: response.headers.get("x-njpbs-renderer-sha"), contextDigest: response.headers.get("x-njpbs-context-sha256"),
    ...(state.snapshotDigest ? { snapshotDigest: state.snapshotDigest } : {}),
    ...(state.datasetFiguresDigest ? { datasetFiguresDigest: state.datasetFiguresDigest } : {}) };
}

async function verifyPublicHtml(response, maxBytes = 2 * 1024 * 1024, fullDocument = false, onChunk) {
  if (!response.body || !/^[a-f0-9]{64}$/.test(response.headers.get("x-njpbs-html-sha256") ?? "") ||
      Number(response.headers.get("content-length")) > maxBytes) throw new Error("Public Post bytes are unavailable");
  const reader = response.body.getReader();
  let size = 0;
  const digest = createHash("sha256");
  let prefix = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("Public Post bytes exceed their bound");
      if (onChunk) onChunk(chunk.value);
      digest.update(chunk.value);
      if (fullDocument) {
        if (prefix.length < 1024) prefix = Buffer.concat([prefix, Buffer.from(chunk.value)]).subarray(0, 1024);
        tail = Buffer.concat([tail, Buffer.from(chunk.value)]).subarray(-1024);
      }
    }
  } finally { await reader.cancel(); }
  const htmlDigest = digest.digest("hex");
  if (htmlDigest !== response.headers.get("x-njpbs-html-sha256")) throw new Error("Public Post bytes changed");
  if (fullDocument && (!/^\s*<!doctype html>/i.test(prefix.toString("utf8")) || !/<\/html\s*>/i.test(tail.toString("utf8")))) {
    throw new Error("Public Page document is incomplete");
  }
  return htmlDigest;
}

async function assertCurrentPostReceipt(firestore, transaction, state, receipt) {
  const current = (await readNoBuildPostOwner({ firestore, transaction, postId: state.postId })).state;
  const pointer = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
  const contextDigest = await readPublicContextInTransaction(transaction, firestore);
  const admission = await readNoBuildFamilyAdmission({ firestore, transaction });
  const serving = effectiveNoBuildPostState(current, await readNoBuildPostCapability({ firestore, transaction }));
  if (admission.admissionRevision !== receipt.admissionRevision) throw new Error("Public admission changed");
  if (pointer?.state !== "idle" || current?.operationId !== receipt.operationId ||
      current.sourceVersion !== receipt.sourceVersion || current.visible !== receipt.visible ||
      current.snapshotDigest !== receipt.snapshotDigest || current.datasetFiguresDigest !== receipt.datasetFiguresDigest ||
      serving?.rendererSha !== receipt.rendererSha || serving.rendererSha !== pointer.activeCommitSha ||
      receipt.contextDigest !== contextDigest) throw new Error("Public Post receipt changed");
}

// Requires the #3208 public Worker: after a successful purge its next request
// awaits current authority and renders this snapshot, without an Assets fallback.
async function settleServedPost({ firestore, state, claim, purgeReceipt, now }) {
  return firestore.runTransaction(async transaction => {
    let servingReceipt;
    const settled = await settleBuildQueueInTransaction(firestore, transaction, {
      queueId: state.operationId, status: "success",
      acceptQueue: queue => queue.transport === TRANSPORT && queue.claim === claim,
      preflight: async () => {
        const owner = (await readNoBuildPostOwner({ firestore, transaction, postId: state.postId })).state;
        const serving = effectiveNoBuildPostState(owner, await readNoBuildPostCapability({ firestore, transaction }));
        const reply = await readNoBuildPostDecisionInTransaction({ firestore, transaction,
          path: postRoutePath(state.slug), rendererSha: serving?.rendererSha });
        const document = (await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data();
        if (reply.kind !== "post" || reply.receipt.operationId !== state.operationId ||
            reply.receipt.sourceVersion !== state.sourceVersion || document?.publishBuildPending !== true ||
            document.publishBuildQueueId !== state.operationId) throw new Error("Public Post serving changed");
        servingReceipt = reply.receipt;
        await assertCurrentPostReceipt(firestore, transaction, state, servingReceipt);
      },
      queueUpdate: () => ({ status: "success", completedAt: FieldValue.serverTimestamp(), error: null,
        claim: null, nextAttemptAt: null, servingReceipt, purgeReceipt,
        postProof: { status: "pending", ...publicationClaim({}, claim, now()), error: null } }),
    });
    if (settled !== "settled") return false;
    transaction.update(firestore.doc(`cmsPosts/${state.postId}`), { publicPostProof: {
      operationId: state.operationId, sourceVersion: state.sourceVersion, status: "pending", retryPending: true } });
    return true;
  });
}

async function verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now, readDeadline }) {
  const queueRef = firestore.doc(`cmsPublishQueue/${state.operationId}`);
  const postRef = firestore.doc(`cmsPosts/${state.postId}`);
  let failed;
  try {
    const receipt = await withinPublicRead(readDeadline - now(), signal => readPublicPostReceipt(state, fetchPublic, signal, target, readHeaders));
    await firestore.runTransaction(async transaction => {
      const queue = (await transaction.get(queueRef)).data();
      const document = (await transaction.get(postRef)).data();
      if (queue?.status !== "success" || queue.postProof?.claim !== claim) return;
      await assertCurrentPostReceipt(firestore, transaction, state, receipt);
      transaction.update(queueRef, { publicReceipt: receipt, postProof: { ...queue.postProof,
        status: "verified", claim: null, nextAttemptAt: null, error: null, completedAt: FieldValue.serverTimestamp() } });
      if (document?.publicPostProof?.operationId === state.operationId && document.published?.sourceVersion === state.sourceVersion) {
        transaction.update(postRef, { "publicPostProof.status": "verified", "publicPostProof.retryPending": false });
      }
    });
    return;
  } catch (error) { failed = error; /* Preserve successful publication while retrying its separate proof. */ }
  await firestore.runTransaction(async transaction => {
    const queue = (await transaction.get(queueRef)).data();
    const document = (await transaction.get(postRef)).data();
    if (queue?.status !== "success" || queue.postProof?.claim !== claim) return;
    const failure = publicationFailure(queue.postProof, "postProof", now(), { error: failed, since: queue.completedAt });
    const resourceError = document?.published?.sourceVersion === state.sourceVersion
      ? publishedBlockResourceError(document.published.blocks ?? [], "/posts/") : null;
    if (resourceError) failure.error = resourceError;
    transaction.update(queueRef, { postProof: { ...queue.postProof, ...failure } });
    if (document?.publicPostProof?.operationId === state.operationId && document.published?.sourceVersion === state.sourceVersion) {
      transaction.update(postRef, { "publicPostProof.status": "failed", "publicPostProof.retryPending": failure.nextAttemptAt !== null });
    }
  });
}

// Publication and its later proof keep independent bounded retries under the
// same queue. A lost process after success cannot leave the proof unowned.
async function recoverNoBuildPostDetail({ firestore, fetchPublic = fetch, fetchPurge = fetch, purgeConfig,
  operationId, now = Date.now, target = publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production"), headers = {},
  readDeadline = now() + PUBLIC_READ_BUDGET_MS }) {
  target = assertReadbackTarget(firestore, target);
  const readHeaders = publicReadbackHeaders(target, headers);
  if (!operationId) {
    // Reserve time for the last bounded purge/readback before the scheduler's
    // sixty-second limit. A retry is discoverable through its existing due time.
    const startedAt = now();
    const deadline = startedAt + 45_000;
    const queues = firestore.collection("cmsPublishQueue");
    const [details, proofs, owners] = await Promise.all([
      queues.where("nextAttemptAt", "<=", startedAt).limit(DUE_QUEUE_LIMIT).get(),
      queues.where("postProof.nextAttemptAt", "<=", startedAt).limit(DUE_QUEUE_LIMIT).get(),
      listNoBuildPostOwners({ firestore }),
    ]);
    const activeOwners = owners.filter(owner => owner.state.operationId && owner.state.mode !== "static");
    const activeIds = new Set(activeOwners.map(owner => owner.state.operationId));
    const due = new Map();
    const addDue = row => {
      if (!activeIds.has(row.id)) return;
      const queue = row.data();
      if (queue?.transport !== TRANSPORT || (!publicationAttempt(queue, "post", now()) && !postProofDue(queue, now()))) return;
      due.set(row.id, queue.status === "success" ? queue.postProof.nextAttemptAt : queue.nextAttemptAt);
    };
    if (details.size < DUE_QUEUE_LIMIT && proofs.size < DUE_QUEUE_LIMIT) {
      details.docs.forEach(addDue);
      proofs.docs.forEach(addDue);
    } else {
      // Superseded proofs retain their retry time in history. If either query
      // fills, read the current owners' queues so old rows cannot hide due work.
      const ids = [...activeIds];
      for (let offset = 0; offset < ids.length && now() < deadline; offset += 100) {
        const rows = await firestore.getAll(...ids.slice(offset, offset + 100).map(id => queues.doc(id)));
        rows.forEach(addDue);
      }
    }
    const ordered = [...due].sort(([leftId, leftTime], [rightId, rightTime]) => leftTime - rightTime || leftId.localeCompare(rightId));
    for (let offset = 0; offset < ordered.length && now() < deadline; offset += 4) {
      await Promise.all(ordered.slice(offset, offset + 4).map(([operationId]) => recoverNoBuildPostDetail({ firestore, fetchPublic, fetchPurge, purgeConfig,
        operationId, now, target, headers: readHeaders, readDeadline: deadline + PUBLIC_READ_STALL_MS })));
    }
    for (const { state } of activeOwners) {
      if (now() >= deadline) break;
      if (state.visible !== false) continue;
      try { await require("./no-build-post-withdrawal").settlePostWithdrawalOutputs({ firestore, operationId: state.operationId }); }
      catch { /* Unknown output proof keeps removal feedback pending. */ }
    }
    return;
  }
  if (!/^[A-Za-z0-9]{20}$/.test(operationId)) throw new Error("Invalid Post confirmation operation");
  const accepted = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data();
  if (accepted?.transport !== TRANSPORT || typeof accepted.noBuildPost?.postId !== "string") return;
  const owner = await readNoBuildPostOwner({ firestore, postId: accepted.noBuildPost.postId });
  const state = owner.state;
  if (!state?.operationId || state.mode === "static" || state.operationId !== operationId) return;
  const queueRef = firestore.doc(`cmsPublishQueue/${state.operationId}`);
  const claim = randomUUID();
  const acquired = await firestore.runTransaction(async transaction => {
    const queue = (await transaction.get(queueRef)).data();
    const current = (await readNoBuildPostOwner({ firestore, transaction, postId: state.postId })).state;
    if (!queue || queue.transport !== TRANSPORT || current?.operationId !== state.operationId) return false;
    if (postProofDue(queue, now())) {
      if (publicationAttempt(queue.postProof, "postProof", now()) === "exhaust") {
        const postRef = firestore.doc(`cmsPosts/${state.postId}`);
        const document = (await transaction.get(postRef)).data();
        transaction.update(queueRef, { postProof: { ...queue.postProof, ...publicationFailure(queue.postProof, "postProof", now()) } });
        if (document?.publicPostProof?.operationId === state.operationId && document.published?.sourceVersion === state.sourceVersion) {
          transaction.update(postRef, { "publicPostProof.status": "failed", "publicPostProof.retryPending": false });
        }
        return "exhausted";
      }
      transaction.update(queueRef, { postProof: { ...queue.postProof,
        status: "pending", ...publicationClaim(queue.postProof, claim, now()) } });
      return "proof";
    }
    const attempt = publicationAttempt(queue, "post", now());
    if (!attempt) return false;
    if (attempt === "exhaust") {
      const { isDeepStrictEqual: same } = require("node:util");
      const operation = queue.noBuildPost;
      if (operation?.schemaVersion !== 1 || ["postId", "operationId", "sourceVersion", "visible", "rendererSha", "generation",
        "slug", "ownedSlugs", "snapshotDigest", "datasetFiguresDigest", "contentRedirectUrl"].some(key => !same(operation[key], current[key])) ||
          !same(current.runtime, queue.backgroundRuntime)) return false;
      transaction.update(queueRef, publicationFailure(queue, "post", now()));
      return "exhausted";
    }
    transaction.update(queueRef, publicationClaim(queue, claim, now()));
    return true;
  });
  if (!acquired) return;
  if (acquired === "exhausted") return;
  if (acquired === "proof") return verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now, readDeadline });
  let receipt = null, failed;
  try {
    const purgeReceipt = await purgePostRoutes(state, purgeConfig, fetchPurge, target);
    if (state.visible) {
      if (await settleServedPost({ firestore, state, claim, purgeReceipt, now })) {
        await verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now, readDeadline });
      }
      return;
    }
    receipt = await withinPublicRead(readDeadline - now(), signal => readPublicPostReceipt(state, fetchPublic, signal, target, readHeaders));
    await settleBuildQueue(firestore, { queueId: state.operationId, status: "success",
      acceptQueue: queue => queue.transport === TRANSPORT && queue.claim === claim,
      preflight: ({ transaction }) => assertCurrentPostReceipt(firestore, transaction, state, receipt),
      queueUpdate: { status: "success", completedAt: FieldValue.serverTimestamp(), error: null,
        claim: null, nextAttemptAt: null, publicReceipt: receipt, purgeReceipt },
    });
    return;
  } catch (error) { failed = error; /* A fixed durable refusal retains the exact operation. */ }
  await firestore.runTransaction(async transaction => {
    const queue = (await transaction.get(queueRef)).data();
    if (queue?.claim !== claim || queue.status === "success") return;
    transaction.update(queueRef, publicationFailure(queue, "post", now(), { error: failed, since: queue.createdAt }));
  });
}

async function existingNoBuildPostPublication({ firestore, changes, retry = false, actor, baseVersion, buildDeps = {} }) {
  const result = await firestore.runTransaction(async transaction => {
    const postChanges = changes.filter(change => change.collection === "cmsPosts");
    if (!postChanges.length) return null;
    const states = await Promise.all(postChanges.map(change => readNoBuildPostOwner({ firestore, transaction, postId: change.id })));
    const state = states.find(owner => owner.state?.operationId && owner.state.mode !== "static")?.state;
    if (!state) return null;
    if (changes.length !== 1 || changes[0].sourceVersion !== state.sourceVersion ||
        (changes[0].operation === "withdraw") === state.visible) {
      throw Object.assign(new Error("This Post requires its existing instant publication operation."), { status: 409 });
    }
    const ref = firestore.doc(`cmsPublishQueue/${state.operationId}`);
    const queue = (await transaction.get(ref)).data();
    if (queue?.transport !== TRANSPORT) throw Object.assign(new Error("Instant publication ownership is unavailable."), { status: 409 });
    if (retry) await require("./public-release-legacy-queue-admission").assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
    if (retry && !state.visible && queue.homeFullBuild) {
      if (!/^[A-Za-z0-9]{20}$/.test(queue.homeFullBuild.queueId)) throw Object.assign(new Error("Home publication ownership is unavailable."), { status: 409 });
      const fullBuild = (await transaction.get(firestore.doc(`cmsPublishQueue/${queue.homeFullBuild.queueId}`))).data();
      if (fullBuild?.status !== "success") return { homeWithdrawalOperationId: state.operationId };
    }
    const writeOutputs = retry && !state.visible ? await require("./no-build-post-withdrawal").prepareWithdrawalOutputRetry({
      firestore, transaction, postId: state.postId, sourceVersion: state.sourceVersion, actor, baseVersion }) : null;
    const writeHome = retry ? await require("./no-build-home-confirmation").prepareNoBuildHomePostRefreshRetry({
      firestore, transaction, postId: state.postId, sourceOperationId: state.operationId, sourceVersion: state.sourceVersion }) : null;
    if (retry && publicationRetry(queue, "post")) transaction.update(ref,
      { status: "pending", attempts: 0, claim: null, nextAttemptAt: 0, error: null });
    if (writeOutputs) writeOutputs();
    if (writeHome) writeHome();
    return { success: true, queueId: state.operationId, dispatched: false,
      status: "pending", transport: TRANSPORT, existingBuild: true,
      message: "This publication retains its instant publication operation.", ...(queue.status === "success" && queue.publicReceipt ? { publicReceipt: { collection: "cmsPosts", id: state.postId,
        sourceVersion: state.sourceVersion, status: "confirmed", label: "Post" } } : {}) };
  });
  if (result?.homeWithdrawalOperationId) return require("./transitional-post-withdrawal").retryPostWithdrawalBuild({
    firestore, changes, actor, baseVersion, operationId: result.homeWithdrawalOperationId }, buildDeps);
  return result;
}
// A 100 percent version deployment reaches edges over seconds, and
// ?cms-code= selects no version. On dev run 45409644014 (Nov. 24, 2026) the
// switch landed at 14:07:16.9Z, edges still answered from the previous version
// 4 to 6 s later, and a single read at about 9.5 s failed a working deploy.
// A read answered by the previous renderer is read again; the first answer
// from any other renderer is judged once. The backstop ends only a rollout
// that never arrives, at ten times the longest skew observed.
const OWNED_ROUTE_ROLLOUT_BACKSTOP_MS = 60_000;
const OWNED_ROUTE_ROLLOUT_INTERVAL_MS = 1_000;
const CANDIDATE_ROLLOUT = Object.freeze({ backstopMs: OWNED_ROUTE_ROLLOUT_BACKSTOP_MS, now: Date.now,
  wait: () => delay(OWNED_ROUTE_ROLLOUT_INTERVAL_MS) });

// The dev staff gateway in front of dev.njpbs.org rebuilds every answer with
// "private, no-store" (workers/src/staff-site-worker.ts:24,145); production
// njpbs.org has no gateway and answers "no-store". Both forbid storage. The
// rule still refuses an answer a cache may keep, such as the Assets fallback,
// which is what the exact "no-store" comparison was stopping.
function forbidsStorage(value) {
  return (value ?? "").split(",").some(part => part.split("=")[0].trim().toLowerCase() === "no-store");
}

// Refuses with the first compared field that differs, naming what was
// expected and what the answer carried.
async function refuseFirstMismatch(response, message, checks) {
  for (const [field, expected, found, ok = found === expected] of checks) {
    if (ok) continue;
    await response.body?.cancel();
    throw new Error(`${message}: ${field} expected ${expected}, found ${found ?? "absent"}`);
  }
}

// Reads one public path until an answer comes from a renderer other than the
// previous one, then lets judge decide that answer once.
async function judgeCandidateAnswer({ url, fetchPublic, headers, candidate, previousRendererSha, rollout = CANDIDATE_ROLLOUT }, judge) {
  const previous = previousRendererSha && previousRendererSha !== candidate.commitSha ? previousRendererSha : null;
  const backstop = rollout.now() + rollout.backstopMs;
  // Read the body inside the deadline; the deadline aborts the request when it settles.
  while (await withinPublicRead(backstop - rollout.now(), async signal => {
    // A disabled reader's 503 is an expected final answer here.
    const response = await readPublicPostAfterRefresh(url, fetchPublic, signal, new Headers(headers), { updatingIsPending: false });
    if (previous && response.headers.get("x-njpbs-renderer-sha") === previous) {
      await response.body?.cancel();
      return true;
    }
    await judge(response);
    return false;
  })) {
    if (rollout.now() >= backstop) throw new Error("The public route still answers from the previous renderer; the candidate version has not reached it");
    await rollout.wait();
  }
}

async function verifyOwnedPostRoutes({ state, staticProof, contentRedirectUrl, candidate, admission, fetchPublic, target, headers,
  previousRendererSha, rollout = CANDIDATE_ROLLOUT }) {
  const slugs = staticProof?.ownedSlugs ?? state.ownedSlugs;
  for (const slug of slugs) {
    await judgeCandidateAnswer({ url: `${target.origin}${postRoutePath(slug)}?cms-code=${candidate.workerVersionId}`,
      fetchPublic, headers, candidate, previousRendererSha, rollout }, async response => {
    // New-admission selection cannot discard an already accepted route.
    // Invalid metadata still refuses visible proof; retained withdrawals stay absent.
    const enabled = !!staticProof || !state.visible || (candidate.noBuildPost.enabled &&
      admission.valid);
    const expected = !enabled ? 503 : !(staticProof?.visible ?? state.visible) ? 410 : slug === (staticProof?.slug ?? state.slug) ? contentRedirectUrl ? 302 : 200 : 308;
    const header = name => response.headers.get(name);
    await refuseFirstMismatch(response, `The public candidate did not preserve its instant Post routes (${postRoutePath(slug)})`, [
      ["status", expected, response.status],
      ["cache-control", "a no-store directive", header("cache-control"), forbidsStorage(header("cache-control"))],
      ...enabled ? [
        ["x-njpbs-content-source", staticProof ? "cms-static-return" : "cms-no-build", header("x-njpbs-content-source")],
        ["x-njpbs-publication-operation", state.operationId, header("x-njpbs-publication-operation")],
        ["x-njpbs-source-version", String(staticProof?.sourceVersion ?? state.sourceVersion), header("x-njpbs-source-version")],
        ["x-njpbs-renderer-sha", candidate.commitSha, header("x-njpbs-renderer-sha")],
      ] : [],
      ...enabled && !staticProof ? [["x-njpbs-admission-revision", String(admission.admissionRevision ?? "unavailable"), header("x-njpbs-admission-revision")]] : [],
      ...expected === 308 ? [["location", postRoutePath(staticProof?.slug ?? state.slug), header("location")]] : [],
      ...expected === 302 ? [["location", contentRedirectUrl, header("location")], ["x-robots-tag", "noindex, nofollow", header("x-robots-tag")]] : [],
    ]);
    if (expected === 200) await verifyPublicHtml(response);
    else await response.body?.cancel();
    });
  }
}

async function verifyStaticPostOutputs({ staticProof, candidate, fetchPublic, target, headers, previousRendererSha, rollout = CANDIDATE_ROLLOUT }) {
  const proof = require("./no-build-post-static-return").projectStaticProof(staticProof);
  const paths = ["/_publication.json", "/_content-status.json", "/posts/", "/feeds/news.xml", "/api/v1/content.json",
    "/pagefind/pagefind.js", "/search/meaning-index.json",
    proof.files.find(file => /^\/sitemap(?:-index)?\.xml$/.test(file.path))?.path,
    proof.files.find(file => file.path.startsWith("/authors/"))?.path ?? "/authors/"];
  for (const path of paths) {
    const file = proof.files.find(file => file.path === path);
    await judgeCandidateAnswer({ url: `${target.origin}${path}?cms-code=${candidate.workerVersionId}`,
      fetchPublic, headers, candidate, previousRendererSha, rollout }, async response => {
    const header = name => response.headers.get(name);
    await refuseFirstMismatch(response, `The static Post candidate did not prove its complete public outputs (${path})`, [
      ["status", file ? 200 : 404, response.status],
      ["cache-control", "a no-store directive", header("cache-control"), forbidsStorage(header("cache-control"))],
      ["x-njpbs-content-source", "cms-static-return", header("x-njpbs-content-source")],
      ["x-njpbs-renderer-sha", candidate.commitSha, header("x-njpbs-renderer-sha")],
      ["x-njpbs-source-version", String(proof.sourceVersion), header("x-njpbs-source-version")],
    ]);
    if (file) {
      if (await verifyPublicHtml(response, file.bytes) !== file.digest) throw new Error("The static Post candidate bytes changed");
    } else await response.body?.cancel();
    });
  }
}

// During the switch the pointer's active commit is the version being replaced.
async function readReplacedRendererSha(firestore) {
  return (await firestore.doc("system/publicDeployment").get()).data()?.activeCommitSha;
}

async function verifyNoBuildPostPublicRoute({ firestore, candidate, fetchPublic = fetch,
  target, headers = {} }) {
  if (!candidate.noBuildPost) return;
  target = assertReadbackTarget(firestore, target ?? publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production"));
  const readHeaders = publicReadbackHeaders(target, headers);
  const owners = (await listNoBuildPostOwners({ firestore })).filter(owner => owner.state.operationId);
  if (!owners.length) return;
  const previousRendererSha = await readReplacedRendererSha(firestore);
  const admission = await readNoBuildFamilyAdmission({ firestore });
  const options = { candidate, admission, fetchPublic, target, previousRendererSha,
    headers: { ...Object.fromEntries(readHeaders), "cache-control": "no-cache" } };
  for (const { state } of owners) {
    const staticProof = candidate.noBuildStatic?.postId === state.postId ? candidate.noBuildStatic
      : state.mode === "static" ? state.staticProof : null;
    let contentRedirectUrl = state.contentRedirectUrl;
    if (staticProof) {
      const link = staticProof.visible ? contentLink((await firestore.doc(`cmsPosts/${state.postId}`).get()).data()?.published?.metadata ?? {}, postRoutePath(staticProof.slug)) : null;
      contentRedirectUrl = link?.external ? link.href : undefined;
    }
    await verifyOwnedPostRoutes({ ...options, state, staticProof, contentRedirectUrl });
    if (staticProof) await verifyStaticPostOutputs({ ...options, staticProof });
  }
  if (JSON.stringify(await readNoBuildFamilyAdmission({ firestore })) !== JSON.stringify(admission)) {
    throw new Error("Public admission changed during code verification");
  }
}
module.exports = { purgePublicHome, recoverNoBuildPostDetail, existingNoBuildPostPublication, verifyNoBuildPostPublicRoute,
  assertCurrentPostReceipt, assertReadbackTarget, publicReadbackHeaders, readPublicPostAfterRefresh, readPublicPostReceipt,
  withinDeadline, withinPublicRead, PUBLIC_READ_BUDGET_MS, REFRESH_PENDING, verifyPublicHtml, verifyOwnedPostRoutes };
