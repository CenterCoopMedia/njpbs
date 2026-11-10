"use strict";

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

async function readPublicPostAfterRefresh(url, fetchPublic, signal, headers) {
  headers = new Headers(headers);
  while (!signal.aborted) {
    const response = await fetchPublic(url, {
      method: "GET", redirect: "manual", signal, ...(headers.keys().next().done ? {} : { headers }),
    });
    if (response.headers.get("x-njpbs-publication-refresh") !== "pending" || response.headers.get("retry-after") !== "1") return response;
    await response.body?.cancel();
    // Public reads return Assets while their edge refresh runs. This polling is
    // inside the existing ten-second deadline and retains the same operation.
    await delay(1_000, undefined, { signal });
  }
  throw new Error("Public Post confirmation timed out");
}

async function readPublicPostReceipt(state, fetchPublic, signal, target, headers) {
  const response = await readPublicPostAfterRefresh(`${target.origin}/posts/${state.slug}/`, fetchPublic, signal, headers);
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
          path: `/posts/${state.slug}/`, rendererSha: serving?.rendererSha });
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

async function verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now }) {
  const queueRef = firestore.doc(`cmsPublishQueue/${state.operationId}`);
  const postRef = firestore.doc(`cmsPosts/${state.postId}`);
  try {
    const receipt = await withinDeadline(10_000, signal => readPublicPostReceipt(state, fetchPublic, signal, target, readHeaders));
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
  } catch { /* Preserve successful publication while retrying its separate proof. */ }
  await firestore.runTransaction(async transaction => {
    const queue = (await transaction.get(queueRef)).data();
    const document = (await transaction.get(postRef)).data();
    if (queue?.status !== "success" || queue.postProof?.claim !== claim) return;
    const failure = publicationFailure(queue.postProof, "postProof", now());
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
  operationId, now = Date.now, target = publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production"), headers = {} }) {
  target = assertReadbackTarget(firestore, target);
  const readHeaders = publicReadbackHeaders(target, headers);
  if (!operationId) {
    // Reserve time for the last bounded purge/readback before the scheduler's
    // sixty-second limit. Old completed owners do not consume retry positions.
    const deadline = now() + 45_000;
    const owners = (await listNoBuildPostOwners({ firestore })).filter(owner => owner.state.operationId && owner.state.mode !== "static");
    const due = [];
    for (let offset = 0; offset < owners.length && now() < deadline; offset += 100) {
      const rows = await firestore.getAll(...owners.slice(offset, offset + 100).map(owner => firestore.doc(`cmsPublishQueue/${owner.state.operationId}`)));
      for (const row of rows) {
        const queue = row.data();
        if (queue?.transport === TRANSPORT && (publicationAttempt(queue, "post", now()) || postProofDue(queue, now()))) {
          due.push({ operationId: row.id, nextAttemptAt: queue.status === "success" ? queue.postProof.nextAttemptAt : queue.nextAttemptAt });
        }
      }
    }
    due.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.operationId.localeCompare(right.operationId));
    for (let offset = 0; offset < due.length && now() < deadline; offset += 4) {
      await Promise.all(due.slice(offset, offset + 4).map(work => recoverNoBuildPostDetail({ firestore, fetchPublic, fetchPurge, purgeConfig,
        operationId: work.operationId, now, target, headers: readHeaders })));
    }
    for (const { state } of owners) {
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
  if (acquired === "proof") return verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now });
  let receipt = null;
  try {
    const purgeReceipt = await purgePostRoutes(state, purgeConfig, fetchPurge, target);
    if (state.visible) {
      if (await settleServedPost({ firestore, state, claim, purgeReceipt, now })) {
        await verifyServedPost({ firestore, state, claim, fetchPublic, target, readHeaders, now });
      }
      return;
    }
    receipt = await withinDeadline(10_000, signal => readPublicPostReceipt(state, fetchPublic, signal, target, readHeaders));
    await settleBuildQueue(firestore, { queueId: state.operationId, status: "success",
      acceptQueue: queue => queue.transport === TRANSPORT && queue.claim === claim,
      preflight: ({ transaction }) => assertCurrentPostReceipt(firestore, transaction, state, receipt),
      queueUpdate: { status: "success", completedAt: FieldValue.serverTimestamp(), error: null,
        claim: null, nextAttemptAt: null, publicReceipt: receipt, purgeReceipt },
    });
    return;
  } catch { /* A fixed durable refusal retains the exact operation. */ }
  await firestore.runTransaction(async transaction => {
    const queue = (await transaction.get(queueRef)).data();
    if (queue?.claim !== claim || queue.status === "success") return;
    transaction.update(queueRef, publicationFailure(queue, "post", now()));
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
async function verifyOwnedPostRoutes({ state, staticProof, contentRedirectUrl, candidate, admission, fetchPublic, target, headers }) {
  const slugs = staticProof?.ownedSlugs ?? state.ownedSlugs;
  for (const slug of slugs) {
    // Read the body inside the deadline; the deadline aborts the request when it settles.
    await withinDeadline(10_000, async signal => {
    const response = await readPublicPostAfterRefresh(
      `${target.origin}/posts/${slug}/?cms-code=${candidate.workerVersionId}`, fetchPublic, signal, new Headers(headers));
    // New-admission selection cannot discard an already accepted route.
    // Invalid metadata still refuses visible proof; retained withdrawals stay absent.
    const enabled = !!staticProof || !state.visible || (candidate.noBuildPost.enabled &&
      admission.valid);
    const expected = !enabled ? 503 : !(staticProof?.visible ?? state.visible) ? 410 : slug === (staticProof?.slug ?? state.slug) ? contentRedirectUrl ? 302 : 200 : 308;
    if (response.status !== expected || response.headers.get("cache-control") !== "no-store" ||
        (enabled && (response.headers.get("x-njpbs-content-source") !== (staticProof ? "cms-static-return" : "cms-no-build") ||
          response.headers.get("x-njpbs-publication-operation") !== state.operationId ||
          response.headers.get("x-njpbs-source-version") !== String(staticProof?.sourceVersion ?? state.sourceVersion) ||
          response.headers.get("x-njpbs-renderer-sha") !== candidate.commitSha)) ||
        (enabled && !staticProof && response.headers.get("x-njpbs-admission-revision") !== String(admission.admissionRevision ?? "unavailable")) ||
        (expected === 308 && response.headers.get("location") !== `/posts/${staticProof?.slug ?? state.slug}/`) ||
        (expected === 302 && (response.headers.get("location") !== contentRedirectUrl || response.headers.get("x-robots-tag") !== "noindex, nofollow"))) {
      await response.body?.cancel();
      throw new Error("The public candidate did not preserve its instant Post routes");
    }
    if (expected === 200) await verifyPublicHtml(response);
    else await response.body?.cancel();
    });
  }
}

async function verifyStaticPostOutputs({ staticProof, candidate, fetchPublic, target, headers }) {
  const proof = require("./no-build-post-static-return").projectStaticProof(staticProof);
  const paths = ["/_publication.json", "/_content-status.json", "/posts/", "/feeds/news.xml", "/api/v1/content.json",
    "/pagefind/pagefind.js", "/search/meaning-index.json",
    proof.files.find(file => /^\/sitemap(?:-index)?\.xml$/.test(file.path))?.path,
    proof.files.find(file => file.path.startsWith("/authors/"))?.path ?? "/authors/"];
  for (const path of paths) {
    const file = proof.files.find(file => file.path === path);
    await withinDeadline(10_000, async signal => {
    const response = await readPublicPostAfterRefresh(
      `${target.origin}${path}?cms-code=${candidate.workerVersionId}`, fetchPublic, signal, new Headers(headers));
    if (response.status !== (file ? 200 : 404) || response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-njpbs-content-source") !== "cms-static-return" ||
        response.headers.get("x-njpbs-renderer-sha") !== candidate.commitSha ||
        response.headers.get("x-njpbs-source-version") !== String(proof.sourceVersion)) {
      await response.body?.cancel();
      throw new Error("The static Post candidate did not prove its complete public outputs");
    }
    if (file) {
      if (await verifyPublicHtml(response, file.bytes) !== file.digest) throw new Error("The static Post candidate bytes changed");
    } else await response.body?.cancel();
    });
  }
}

async function verifyNoBuildPostPublicRoute({ firestore, candidate, fetchPublic = fetch,
  target, headers = {} }) {
  if (!candidate.noBuildPost) return;
  target = assertReadbackTarget(firestore, target ?? publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production"));
  const readHeaders = publicReadbackHeaders(target, headers);
  const owners = (await listNoBuildPostOwners({ firestore })).filter(owner => owner.state.operationId);
  if (!owners.length) return;
  const admission = await readNoBuildFamilyAdmission({ firestore });
  const options = { candidate, admission, fetchPublic, target,
    headers: { ...Object.fromEntries(readHeaders), "cache-control": "no-cache" } };
  for (const { state } of owners) {
    const staticProof = candidate.noBuildStatic?.postId === state.postId ? candidate.noBuildStatic
      : state.mode === "static" ? state.staticProof : null;
    let contentRedirectUrl = state.contentRedirectUrl;
    if (staticProof) {
      const link = staticProof.visible ? contentLink((await firestore.doc(`cmsPosts/${state.postId}`).get()).data()?.published?.metadata ?? {}, `/posts/${staticProof.slug}/`) : null;
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
  withinDeadline, verifyPublicHtml };
