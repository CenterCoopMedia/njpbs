"use strict";

const { postRoutePath } = require("./post-slug-contract");
const { createHash, randomUUID } = require("node:crypto");
const { contentLink } = require("./content-link");
const { callOutside, waitFor } = require("./release-wait");
const { FieldValue } = require("firebase-admin/firestore");
const { TRANSPORT, readNoBuildPostDecisionInTransaction } = require("./no-build-post-publication");
const { readNoBuildPostOwner, listNoBuildPostOwners, readNoBuildPostCapability, effectiveNoBuildPostState } = require("./no-build-post-ownership");
const { settleBuildQueue, settleBuildQueueInTransaction } = require("./publish-build-state");
const { publishedBlockResourceError } = require("./published-resource-check");
const { postProofDue } = require("./no-build-post-proof-state");
const { publicAnswerOrigin, publicationAttempt, publicationClaim, publicationFailure, publicationRetry } = require("./background-output-attempt");
const { readNoBuildFamilyAdmission } = require("./no-build-family-admission");
const { publicationTarget, assertPublicationTarget, assertPublicationDatabase, publicationPostCacheTag } = require("./publication-target");
const { PUBLIC_CONTEXT_PATH, publicContextDigest, readPublicContextInTransaction } = require("./public-context-revision");
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

const REFRESH_PENDING = "public_refresh_pending";
const refreshPending = new WeakMap();

/** One public read, headers and body. A dropped connection reads again; an
 * answer is judged once. `onPending` runs when the route reports its refresh. */
async function readPublicAnswer(what, work, { onPending = undefined, stop = undefined } = {}) {
  const controller = new AbortController();
  const signal = stop ? AbortSignal.any([controller.signal, stop]) : controller.signal;
  if (onPending) refreshPending.set(signal, onPending);
  try { return await callOutside(what, () => work(signal), { signal }); }
  finally { controller.abort(); }
}

// A real answer that carries the wrong receipt is the public route's own
// failure report. Only pending, updating and missing answers are waited for.
const refusedAnswer = (code, message, response = undefined) => Object.assign(new Error(message), { code,
  ...(response ? { origin: publicAnswerOrigin(response) } : {}) });

/** The renderer and context whose wrong receipt is final. None while a public
 * deployment is under way. */
async function readServingIdentity(transaction, firestore) {
  const [deployment, context] = await transaction.getAll(firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
  const pointer = deployment.data(), revision = context.data()?.revision;
  if (pointer?.state !== "idle" || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { rendererSha: pointer.activeCommitSha, contextDigest: publicContextDigest(revision) };
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
  for (let offset = 0; offset < tags.length; offset += 100) {
    const response = await callOutside("Cloudflare cache purge", async () => {
      const answer = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tags: tags.slice(offset, offset + 100) }),
      });
      // The API had no answer yet; a purge of the same tags can repeat. Every
      // other status is Cloudflare's own refusal.
      if (answer.status >= 500 || [408, 425, 429].includes(answer.status)) {
        await answer.body?.cancel();
        throw Object.assign(new Error(`Post purge answered ${answer.status}`), { retry: true });
      }
      return answer;
    });
    if (!response.ok) { await response.body?.cancel(); throw refusedAnswer("public_purge_refused", "Post purge failed"); }
    const result = await response.json();
    if (result?.success !== true) throw refusedAnswer("public_purge_refused", "Post purge failed");
  }
}

// Home uses the existing Post background tag and purge transport. Fetch the
// already-bound secret only when publication confirmation needs invalidation.
async function purgePublicHome({ target, fetchPurge = fetch, purgeConfig } = {}) {
  if (assertPublicationTarget(target).environment !== "production") return;
  const config = purgeConfig ?? { zoneId: process.env.CMS_MEDIA_CLOUDFLARE_ZONE_ID,
    token: process.env.CMS_MEDIA_CACHE_PURGE_TOKEN };
  await purgePublicCacheTags([publicationPostCacheTag(target, "background")], config, fetchPurge);
}

// The public Worker's "content is being updated" answer, or an edge or Worker
// error (500, 1101, 52x) that has no answer yet. It carries no receipt, unlike a
// withdrawal or renderer refusal.
function isUpdatingAnswer(response) {
  return (response.status === 429 || response.status >= 500) &&
    ![...response.headers.keys()].some(name => name.startsWith("x-njpbs-"));
}

/** Read until the route answers with something other than its own refresh.
 * `once` reports a refresh to the caller instead, for a check a person awaits
 * and for the minute recovery, whose next wake reads again. */
async function readPublicPostAfterRefresh(url, fetchPublic, signal, headers, { updatingIsPending = true, once = false } = {}) {
  headers = new Headers(headers);
  return waitFor(`public route ${new URL(url).pathname}`, async () => {
    const response = await fetchPublic(url, {
      method: "GET", redirect: "manual", signal, ...(headers.keys().next().done ? {} : { headers }),
    });
    const pending = response.headers.get("x-njpbs-publication-refresh") === "pending" && response.headers.get("retry-after") === "1";
    const updating = updatingIsPending && isUpdatingAnswer(response);
    if (!pending && !updating) return { done: response };
    await response.body?.cancel();
    const state = pending ? "refresh pending" : `updating ${response.status}`;
    if (once) return { failed: Object.assign(new Error(`The public route reports ${state}`), { code: REFRESH_PENDING }) };
    refreshPending.get(signal)?.(state);
    return { pending: state };
  }, { signal });
}

async function readPublicPostReceipt(state, fetchPublic, signal, target, headers, options) {
  const response = await readPublicPostAfterRefresh(`${target.origin}${postRoutePath(state.slug)}`, fetchPublic, signal, headers, options);
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
    throw refusedAnswer("public_receipt_refused", "Public Post receipt is unavailable", response);
  }
  const revisionHeader = response.headers.get("x-njpbs-admission-revision");
  const admissionRevision = /^[1-9][0-9]*$/.test(revisionHeader ?? "") ? Number(revisionHeader) : null;
  if ((admissionRevision === null && (state.visible || revisionHeader !== "unavailable")) ||
      (admissionRevision !== null && !Number.isSafeInteger(admissionRevision))) {
    await response.body?.cancel();
    throw refusedAnswer("public_receipt_refused", "Public admission receipt is unavailable", response);
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
      Number(response.headers.get("content-length")) > maxBytes) throw refusedAnswer("public_bytes_refused", "Public Post bytes are unavailable", response);
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
      if (size > maxBytes) throw refusedAnswer("public_bytes_refused", "Public Post bytes exceed their bound", response);
      if (onChunk) onChunk(chunk.value);
      digest.update(chunk.value);
      if (fullDocument) {
        if (prefix.length < 1024) prefix = Buffer.concat([prefix, Buffer.from(chunk.value)]).subarray(0, 1024);
        tail = Buffer.concat([tail, Buffer.from(chunk.value)]).subarray(-1024);
      }
    }
  } finally { await reader.cancel(); }
  const htmlDigest = digest.digest("hex");
  if (htmlDigest !== response.headers.get("x-njpbs-html-sha256")) throw refusedAnswer("public_bytes_refused", "Public Post bytes changed", response);
  if (fullDocument && (!/^\s*<!doctype html>/i.test(prefix.toString("utf8")) || !/<\/html\s*>/i.test(tail.toString("utf8")))) {
    throw refusedAnswer("public_bytes_refused", "Public Page document is incomplete", response);
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

async function verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now, once }) {
  const queueRef = firestore.doc(`cmsPublishQueue/${state.operationId}`);
  const postRef = firestore.doc(`cmsPosts/${state.postId}`);
  let failed;
  try {
    const receipt = await readPublicAnswer("public Post receipt", signal => readPublicPostReceipt(state, fetchPublic, signal, target, readHeaders, { once }));
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
    const failure = publicationFailure(queue.postProof, "postProof", now(), failed, await readServingIdentity(transaction, firestore));
    const resourceError = document?.published?.sourceVersion === state.sourceVersion
      ? publishedBlockResourceError(document.published.blocks ?? [], "/posts/") : null;
    if (resourceError) failure.error = resourceError;
    transaction.update(queueRef, { postProof: { ...queue.postProof, ...failure } });
    if (document?.publicPostProof?.operationId === state.operationId && document.published?.sourceVersion === state.sourceVersion) {
      transaction.update(postRef, { "publicPostProof.status": "failed", "publicPostProof.retryPending": failure.nextAttemptAt !== null });
    }
  });
}

// Publication and its later proof keep independent retries under the
// same queue. A lost process after success cannot leave the proof unowned.
async function recoverNoBuildPostDetail({ firestore, fetchPublic = fetch, fetchPurge = fetch, purgeConfig,
  operationId = undefined, now = Date.now, target = publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production"), headers = {}, once = false }) {
  target = assertReadbackTarget(firestore, target);
  const readHeaders = publicReadbackHeaders(target, headers);
  if (!operationId) {
    const startedAt = now();
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
      for (let offset = 0; offset < ids.length; offset += 100) {
        const rows = await firestore.getAll(...ids.slice(offset, offset + 100).map(id => queues.doc(id)));
        rows.forEach(addDue);
      }
    }
    const ordered = [...due].sort(([leftId, leftTime], [rightId, rightTime]) => leftTime - rightTime || leftId.localeCompare(rightId));
    for (const { state } of activeOwners) {
      if (state.visible !== false) continue;
      try { await require("./no-build-post-withdrawal").settlePostWithdrawalOutputs({ firestore, operationId: state.operationId }); }
      catch { /* Unknown output proof keeps removal feedback pending. */ }
    }
    // The next minute wake is this pass's wait: a route that still refreshes
    // reports it and cannot hold another Post.
    const outcomes = await Promise.allSettled(ordered.map(([operationId]) => recoverNoBuildPostDetail({ firestore, fetchPublic, fetchPurge,
      purgeConfig, operationId, now, target, headers: readHeaders, once: true })));
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed) throw failed.reason;
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
      transaction.update(queueRef, { postProof: { ...queue.postProof,
        status: "pending", ...publicationClaim(queue.postProof, claim, now()) } });
      return "proof";
    }
    if (!publicationAttempt(queue, "post", now())) return false;
    transaction.update(queueRef, publicationClaim(queue, claim, now()));
    return true;
  });
  if (!acquired) return;
  if (acquired === "proof") return verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now, once });
  let receipt = null, failed;
  try {
    const purgeReceipt = await purgePostRoutes(state, purgeConfig, fetchPurge, target);
    if (state.visible) {
      if (await settleServedPost({ firestore, state, claim, purgeReceipt, now })) {
        await verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now, once });
      }
      return;
    }
    receipt = await readPublicAnswer("public Post receipt", signal => readPublicPostReceipt(state, fetchPublic, signal, target, readHeaders, { once }));
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
    transaction.update(queueRef, publicationFailure(queue, "post", now(), failed, await readServingIdentity(transaction, firestore)));
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
// from any other renderer is judged once.

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
async function judgeCandidateAnswer({ url, fetchPublic, headers, candidate, previousRendererSha }, judge) {
  const previous = previousRendererSha && previousRendererSha !== candidate.commitSha ? previousRendererSha : null;
  const path = new URL(url).pathname;
  await waitFor(`candidate route ${path}`, () => readPublicAnswer(`candidate read ${path}`, async signal => {
    // A disabled reader's 503 is an expected final answer here.
    const response = await readPublicPostAfterRefresh(url, fetchPublic, signal, new Headers(headers), { updatingIsPending: false });
    if (previous && response.headers.get("x-njpbs-renderer-sha") === previous) {
      await response.body?.cancel();
      return { pending: "the previous renderer answers" };
    }
    await judge(response);
    return { done: true };
  }));
}

async function verifyOwnedPostRoutes({ state, staticProof, contentRedirectUrl, candidate, admission, fetchPublic, target, headers,
  previousRendererSha }) {
  const slugs = staticProof?.ownedSlugs ?? state.ownedSlugs;
  for (const slug of slugs) {
    await judgeCandidateAnswer({ url: `${target.origin}${postRoutePath(slug)}?cms-code=${candidate.workerVersionId}`,
      fetchPublic, headers, candidate, previousRendererSha }, async response => {
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

async function verifyStaticPostOutputs({ staticProof, candidate, fetchPublic, target, headers, previousRendererSha }) {
  const proof = require("./no-build-post-static-return").projectStaticProof(staticProof);
  const paths = ["/_publication.json", "/_content-status.json", "/posts/", "/feeds/news.xml", "/api/v1/content.json",
    "/pagefind/pagefind.js", "/search/meaning-index.json",
    proof.files.find(file => /^\/sitemap(?:-index)?\.xml$/.test(file.path))?.path,
    proof.files.find(file => file.path.startsWith("/authors/"))?.path ?? "/authors/"];
  for (const path of paths) {
    const file = proof.files.find(file => file.path === path);
    await judgeCandidateAnswer({ url: `${target.origin}${path}?cms-code=${candidate.workerVersionId}`,
      fetchPublic, headers, candidate, previousRendererSha }, async response => {
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
  readPublicAnswer, readServingIdentity, refusedAnswer, REFRESH_PENDING, verifyPublicHtml, verifyOwnedPostRoutes };
