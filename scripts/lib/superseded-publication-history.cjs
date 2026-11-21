"use strict";

const protocol = require("../../functions/lib/public-release-pair");
const { assertPublicationDatabase, assertPublicationTarget } = require("../../functions/lib/publication-target");
const { isCommitSha, isPublicDeploymentIdentifier } = require("../../functions/lib/public-deployment-pointer");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("../../functions/lib/public-context-revision");
const { isNoBuildPostId, readNoBuildPostOwner } = require("../../functions/lib/no-build-post-ownership");
const { readHomePageAuthorityInTransaction } = require("../../functions/lib/no-build-home-ownership");
const { assertHomeRefreshInput } = require("../../functions/lib/no-build-home-confirmation");
const { CURRENT_PATH, TRANSPORT, retainedPublicContextQueueIdsInTransaction } = require("../../functions/lib/public-context-publication");
const { OUTPUTS } = require("../../functions/lib/post-background-paths");
const { RECORD_FAMILIES } = require("../../functions/lib/no-build-record-namespace");
const { publicationRuntime } = require("../../functions/lib/publication-runtime-owner");
const { publicationIdentity, proofKey, staleProof } = require("../../functions/lib/page-consumer-proof");

const ROOT = "system/supersededPublicationHistory/retirements";
const QUEUE = "cmsPublishQueue";
const POST = "post-no-build-v1";
const PATH = /^cmsPublishQueue\/([a-zA-Z0-9]{20})(?:\/(backgroundPreparation|backgroundOutputs|homePageRefresh|confirmation)\/([a-zA-Z0-9_-]{1,80}))?$/;
const FAMILIES = new Set([...OUTPUTS, ...RECORD_FAMILIES]);
const { positive, digest, publicReleaseDigest } = protocol;
const refuse = () => { throw new Error("Superseded publication history was refused"); };
const version = row => [row.updateTime.seconds, row.updateTime.nanoseconds];
const operationId = value => typeof value === "string" && /^[A-Za-z0-9]{20}$/.test(value);

function parseRequest(request) {
  protocol.exact(request, ["schemaVersion", "operationId", "operatorCommitSha", "target", "paths"]);
  assertPublicationTarget(request.target);
  if (request.schemaVersion !== 1 || !isPublicDeploymentIdentifier(request.operationId) || !isCommitSha(request.operatorCommitSha) ||
      !Array.isArray(request.paths) || request.paths.length < 1 || request.paths.length > 100 ||
      !request.paths.every(path => typeof path === "string" && PATH.test(path)) ||
      new Set(request.paths).size !== request.paths.length) refuse();
}

function parseListing(request, approved) {
  protocol.exact(approved, ["schemaVersion", "requestDigest", "rows", "listingDigest"]);
  const { listingDigest, ...listing } = approved;
  if (listing.schemaVersion !== 1 || listing.requestDigest !== publicReleaseDigest(request) ||
      !Array.isArray(listing.rows) || !listing.rows.length || listing.rows.length > request.paths.length ||
      listingDigest !== publicReleaseDigest(listing)) refuse();
}

const settled = value => ["success", "cancelled", "failed", "superseded"].includes(value?.status) &&
  value.claim == null && value.claimPresent !== true && value.leaseUntil == null && value.nextAttemptAt == null;
const knownAttempts = value => Number.isSafeInteger(value) && value >= 0 && value <= 4;
const dueOrAbsent = (value, now) => value == null || Number.isSafeInteger(value) && value >= 0 && value <= now;

function idleTask(value, now) {
  return value?.claim == null && value?.leaseUntil == null && value?.claimPresent !== true &&
    dueOrAbsent(value?.nextAttemptAt, now) && dueOrAbsent(value?.slowRetryAt, now) && !value?.retirementReceiptPath;
}

async function retiredPostProof({ queue, id, get, owner, now }) {
  const post = queue.noBuildPost, proof = queue.postProof;
  if (queue.transport !== POST || queue.status !== "success" || post?.operationId !== id || !isNoBuildPostId(post.postId) ||
      !positive(post.sourceVersion) || !["pending", "failed"].includes(proof?.status) || !knownAttempts(proof.attempts) ||
      !idleTask(proof, now) || proof.status === "failed" && proof.nextAttemptAt == null) return null;
  const [current, document] = await Promise.all([owner(post.postId), get(`cmsPosts/${post.postId}`)]);
  const data = document.data();
  if (!current?.operationId || current.operationId === id || current.sourceVersion <= post.sourceVersion ||
      data?.published?.sourceVersion !== current.sourceVersion || data.publicPostProof?.operationId === id ||
      data.publishBuildQueueId === id || data.publishBuildSettlement?.queueId === id) return null;
  return { ...proof, status: "failed", claim: null, nextAttemptAt: null };
}

async function retiredPreparation({ queue, row, value, id, owner, get, selected, now, context }) {
  if (![POST, TRANSPORT].includes(queue.transport) || !digest(row.id) || value.contextDigest !== row.id ||
      value.status !== "failed" || !knownAttempts(value.attempts) || !idleTask(value, now) ||
      row.id === publicContextDigest(context.revision) || selected.has(id) ||
      value.runtime.release !== (queue.backgroundRuntime ?? queue.runtime)?.release) return null;
  if (queue.transport === POST) {
    const post = queue.noBuildPost;
    if (post?.operationId !== id || !isNoBuildPostId(post.postId) || !positive(post.sourceVersion)) return null;
    const current = await owner(post.postId);
    if (!current?.operationId || current.operationId === id || current.sourceVersion <= post.sourceVersion) return null;
  } else if (queue.publicContext?.operationId !== id || !positive(queue.publicContext.contextRevision) ||
      queue.publicContext.contextRevision >= context.revision ||
      queue.publicContext.contextDigest !== row.id || row.id !== publicContextDigest(queue.publicContext.contextRevision)) return null;
  for (const family of FAMILIES) {
    const output = (await get(`cmsBackgroundOutputs/${family}`)).data();
    if (output?.operationId === id || output?.taskPath != null &&
        (typeof output.taskPath !== "string" || output.taskPath.startsWith(`${QUEUE}/${id}/`))) return null;
  }
  return { status: "cancelled", claim: null, nextAttemptAt: null };
}

async function supersededOutput({ queue, row, value, get, now }) {
  if (![POST, TRANSPORT].includes(queue.transport) || value.owner !== "post-background-v1" || !FAMILIES.has(value.output) ||
      ![value.output, `${value.output}-${value.revision}`].includes(row.id) || !positive(value.revision) ||
      !["pending", "failed"].includes(value.status) || !knownAttempts(value.attempts) || !idleTask(value, now)) return null;
  const output = (await get(`cmsBackgroundOutputs/${value.output}`)).data();
  if (output?.schemaVersion !== 1 || output.owner !== value.owner || output.output !== value.output ||
      !positive(output.revision) || output.revision <= value.revision || output.taskPath === row.ref.path ||
      typeof output.taskPath !== "string" || PATH.exec(output.taskPath)?.[2] !== "backgroundOutputs") return null;
  const replacement = (await get(output.taskPath)).data();
  if (replacement?.schemaVersion !== 1 || replacement.owner !== output.owner || replacement.output !== output.output ||
      replacement.revision !== output.revision) return null;
  return { status: "superseded", claim: null, nextAttemptAt: null };
}

async function supersededHome({ queue, row, value, id, home, get, now }) {
  if (row.id !== "home" || value.owner !== "page-no-build-v1" || value.pageId !== "home" || !positive(value.revision) ||
      value.rendererSha !== value.runtime.release || !["pending", "failed"].includes(value.status) || !idleTask(value, now)) return null;
  const input = value.input;
  if (input?.sourceOperationId !== id || !operationId(input.homeOperationId) || !positive(input.homeSourceVersion) ||
      (input.sourceTransport ?? POST) !== queue.transport) return null;
  assertHomeRefreshInput(input);
  const current = await home();
  const signal = current?.homeRefresh;
  if (!signal || signal.schemaVersion !== 1 || !operationId(signal.sourceOperationId) ||
      signal.taskPath !== `${QUEUE}/${signal.sourceOperationId}/homePageRefresh/home` || signal.taskPath === row.ref.path ||
      !positive(signal.revision) || signal.revision <= value.revision ||
      (current.operationId === input.homeOperationId ? current.sourceVersion !== input.homeSourceVersion :
        current.sourceVersion <= input.homeSourceVersion)) return null;
  const replacement = (await get(signal.taskPath)).data();
  if (replacement?.schemaVersion !== 1 || replacement.owner !== value.owner || replacement.pageId !== "home" ||
      replacement.revision !== signal.revision || replacement.input?.sourceOperationId !== signal.sourceOperationId ||
      replacement.input.homeOperationId !== current.operationId || replacement.input.homeSourceVersion !== current.sourceVersion) return null;
  return { status: "superseded", claim: null, nextAttemptAt: null };
}

function retiredPageProof({ queue, row, value, id, selected, now, context }) {
  const identity = publicationIdentity(queue);
  if (row.id !== "page-consumers" || queue.transport !== TRANSPORT || selected.has(id) || !identity ||
      !isCommitSha(identity.rendererSha) || !positive(identity.contextRevision) || identity.contextRevision >= context.revision ||
      identity.contextDigest !== publicContextDigest(identity.contextRevision) || value.key !== proofKey(queue) ||
      !knownAttempts(value.attempts) || !dueOrAbsent(value.nextAttemptAt, now) || value.claimPresent === true ||
      value.retirementReceiptPath) return null;
  if (value.status === "running") {
    if (typeof value.claim !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.claim) ||
        !positive(value.leaseUntil) || value.leaseUntil > now) return null;
  } else if (!["stale", "failed"].includes(value.status) || value.claim != null || value.leaseUntil != null ||
      value.status === "stale" && value.nextAttemptAt != null) return null;
  return staleProof(value.key, value.attempts);
}

async function inspect(firestore, transaction, request) {
  const reads = new Map();
  function get(path) {
    if (!reads.has(path)) reads.set(path, transaction.get(firestore.doc(path)));
    return reads.get(path);
  }
  const [pointerRow, contextRow, aggregateRow] = await Promise.all([
    get("system/publicDeployment"), get(PUBLIC_CONTEXT_PATH), get(CURRENT_PATH),
  ]);
  const pointer = protocol.parseVersionedPublicDeployment(pointerRow.data());
  const context = contextRow.data(), now = pointerRow.readTime.toMillis();
  if (pointer.state !== "idle" || !positive(pointer.activeGeneration) || !positive(now) ||
      context?.schemaVersion !== 1 || !positive(context.revision)) refuse();
  const selected = await retainedPublicContextQueueIdsInTransaction({ firestore, transaction });
  const aggregate = aggregateRow.data();
  if (aggregate) {
    for (const id of [aggregate.namespaceOperationId, aggregate.preparationOperationId]) {
      if (!operationId(id)) refuse();
      selected.add(id);
    }
  }
  let homeRead;
  const home = () => homeRead ??= readHomePageAuthorityInTransaction({ firestore, transaction });
  const owners = new Map();
  async function owner(postId) {
    if (!owners.has(postId)) owners.set(postId, readNoBuildPostOwner({ firestore, transaction, postId }));
    return (await owners.get(postId)).state;
  }
  const rows = [], writes = [];
  for (const path of [...request.paths].sort()) {
    const [, id, family] = PATH.exec(path);
    const [row, parent] = await Promise.all([get(path), get(`${QUEUE}/${id}`)]);
    const queue = parent.data(), value = row.data();
    if (!row.exists || !settled(queue) || !value) continue;
    const input = { queue, row, value, id, get, owner, home, selected, context, now };
    let update;
    if (!family) update = await retiredPostProof(input);
    else if (family === "confirmation") update = retiredPageProof(input);
    else if (value.schemaVersion === 1 && value.runtime && publicationRuntime(value.runtime).owner === "cloudflare") {
      if (family === "backgroundPreparation") update = await retiredPreparation(input);
      else if (family === "backgroundOutputs") update = await supersededOutput(input);
      else if (family === "homePageRefresh") update = await supersededHome(input);
    }
    if (!update) continue;
    rows.push({ path, field: family ? null : "postProof", version: version(row), parentVersion: version(parent) });
    writes.push({ ref: row.ref, update, postProof: !family });
  }
  const listing = { schemaVersion: 1, requestDigest: publicReleaseDigest(request), rows };
  return { listing: { ...listing, listingDigest: publicReleaseDigest(listing) }, writes };
}

async function listSupersededPublicationHistory({ firestore, request }) {
  parseRequest(request);
  assertPublicationDatabase(firestore, request.target);
  return firestore.runTransaction(async transaction => (await inspect(firestore, transaction, request)).listing, { readOnly: true });
}

async function retireSupersededPublicationHistory({ firestore, request, approved }) {
  parseRequest(request);
  assertPublicationDatabase(firestore, request.target);
  parseListing(request, approved);
  const ref = firestore.doc(`${ROOT}/${request.operationId}`);
  return firestore.runTransaction(async transaction => {
    const prior = await transaction.get(ref);
    const receipt = { schemaVersion: 1, outcome: "superseded-history-retired", approved };
    if (prior.exists) {
      if (!prior.createTime.isEqual(prior.updateTime) || publicReleaseDigest(prior.data()) !== publicReleaseDigest(receipt)) refuse();
      return { idempotent: true, receipt };
    }
    const { listing, writes } = await inspect(firestore, transaction, request);
    if (listing.listingDigest !== approved.listingDigest) refuse();
    for (const { ref: row, postProof, update } of writes) {
      const retired = { ...update, retirementReceiptPath: ref.path };
      transaction.update(row, postProof ? { postProof: retired } : retired);
    }
    transaction.create(ref, receipt);
    transaction.create(firestore.collection("admin_logs").doc(), require("../../functions/lib/audit").adminLogEntry({
      actorUid: "system:superseded-publication-history", action: "public-release.superseded-publication-history-retired",
      target: request.operationId, before: null, after: { listingDigest: listing.listingDigest, rows: listing.rows.length },
    }));
    return { idempotent: false, receipt };
  });
}

module.exports = { parseRequest, parseListing, listSupersededPublicationHistory, retireSupersededPublicationHistory };
