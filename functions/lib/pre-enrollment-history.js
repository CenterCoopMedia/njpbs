"use strict";

const p = require("./public-release-pair");
const targets = require("./publication-target");
const deployment = require("./public-deployment-pointer");
const runtime = require("./cms-publication-runtime-control");
const context = require("./public-context-revision");
const ROOT = "system/preEnrollmentHistory/retirements";
const refuse = () => { throw new p.PublicReleaseProtocolError(); };
const same = (a, b) => p.publicReleaseDigest(a ?? null) === p.publicReleaseDigest(b ?? null);
const terminal = value => ["success", "failed", "failure", "public_unconfirmed", "cancelled", "superseded", "deployed"].includes(value.status) &&
  value.claim == null && value.nextAttemptAt == null;
function parseRequest(value) {
  p.exact(value, ["schemaVersion", "operationId", "target"]);
  if (value.schemaVersion !== 1 || !deployment.isPublicDeploymentIdentifier(value.operationId)) refuse();
  // assertPublicationTarget requires every field, including explicit environment
  // and project. Never use publicationTarget's production default here.
  targets.assertPublicationTarget(value.target);
  return value;
}
function parseReceipt(value, request) {
  p.exact(value, ["listing", "listingDigest"]);
  const listing = value.listing;
  p.exact(listing, ["schemaVersion", "kind", "request", "censusDigest", "records", "blocked"]);
  if (listing.schemaVersion !== 1 || listing.kind !== "pre-enrollment-history-listing" || !same(listing.request, request) ||
      !p.digest(listing.censusDigest) || !Array.isArray(listing.records) || !listing.records.length || listing.records.length > 200 ||
      !Array.isArray(listing.blocked) || listing.blocked.length || !p.digest(value.listingDigest) ||
      p.publicReleaseDigest(listing) !== value.listingDigest) refuse();
  for (const row of listing.records) {
    p.exact(row, ["path", "digest"]);
    if (!/^cmsPublishQueue\/[A-Za-z0-9._:-]{1,128}\/(?:backgroundPreparation\/[a-f0-9]{64}|backgroundOutputs\/_admission|homePageRefresh\/home)$/.test(row.path) ||
        !p.digest(row.digest)) refuse();
  }
  if (new Set(listing.records.map(row => row.path)).size !== listing.records.length) refuse();
  return value;
}
async function inspect(firestore, transaction, request) {
  const observed = new Map(), records = [], blocked = [];
  const remember = row => {
    observed.set(row.ref.path, row.exists ? { digest: p.publicReleaseDigest(row.data()),
      version: [row.updateTime.seconds, row.updateTime.nanoseconds] } : null);
    if (observed.size > 4000) refuse();
    return row;
  };
  const get = async path => remember(await transaction.get(firestore.doc(path)));
  const rows = async path => {
    const result = await transaction.get(firestore.collection(path).limit(1001));
    if (result.size > 1000) refuse();
    return result.docs.map(remember);
  };
  const pointer = deployment.assertPublicDeploymentPointer((await get("system/publicDeployment")).data());
  const pins = runtime.parseCmsPublicationRuntimeControl((await get(runtime.RUNTIME_DOCUMENT_PATH)).data());
  if (pointer.schemaVersion !== 1 || pointer.state !== "idle" || pointer.activeCommitSha !== pins.commitSha ||
      pointer.activeGeneration < 1 || pointer.lastReservedGeneration !== pointer.activeGeneration ||
      pointer.newestEligibleGeneration !== pointer.activeGeneration || pins.phase !== "paused" || pins.cloud?.phase !== "paused" ||
      pins.cloud.commitSha !== pins.commitSha || pins.cloud.serializerId !== request.target.serializerId) refuse();
  for (const path of ["system/publicReleaseChanges", "system/publicReleaseChanges/enrollment/initial", "system/publicReleaseChangeLog"]) {
    if ((await get(path)).exists) refuse();
  }
  const publicContext = (await get(context.PUBLIC_CONTEXT_PATH)).data();
  if (publicContext?.schemaVersion !== 1) refuse();
  const currentDigest = context.publicContextDigest(publicContext.revision), selected = new Set(), selectedTasks = new Set();
  const add = id => {
    if (id == null) return;
    if (!deployment.isPublicDeploymentIdentifier(id)) refuse();
    selected.add(id);
  };
  for (const path of ["system/publicDeployment/noBuildPostOwners", "system/publicDeployment/noBuildPageOwners"]) {
    for (const row of await rows(path)) if (row.data().mode !== "static") add(row.data().operationId);
  }
  const home = (await get("system/publicDeployment/noBuildPageOwners/home")).data();
  const legacy = (await get("system/publicDeployment/noBuildPosts/current")).data();
  if (legacy?.mode !== "static") add(legacy?.operationId);
  const aggregate = (await get("system/publicDeployment/aggregateContexts/current")).data();
  if (aggregate) {
    for (const key of ["operationId", "namespaceOperationId", "preparationOperationId"]) add(aggregate[key]);
    if (aggregate.operationIds !== undefined) {
      if (!Array.isArray(aggregate.operationIds) || aggregate.operationIds.length > 100) refuse();
      aggregate.operationIds.forEach(add);
    }
  }
  for (const row of await rows("cmsBackgroundOutputs")) {
    const output = row.data();
    if (output.taskPath != null) {
      if (!/^cmsPublishQueue\/[A-Za-z0-9._:-]{1,128}\/backgroundOutputs\/[A-Za-z0-9_-]+$/.test(output.taskPath)) refuse();
      selectedTasks.add(output.taskPath); add(output.taskPath.split("/")[1]);
    }
    add(output.operationId);
  }
  const oldRuntime = { owner: "cloudflare", release: pins.commitSha };
  const expired = task => (task.nextAttemptAt == null || Number.isFinite(task.nextAttemptAt) && task.nextAttemptAt >= 0 && task.nextAttemptAt <= Date.now()) &&
    (task.claim == null || /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(task.claim) && Number.isFinite(task.nextAttemptAt));
  for (const queue of await rows("cmsPublishQueue")) {
    const parent = queue.data();
    for (const family of ["backgroundPreparation", "backgroundOutputs", "homePageRefresh"]) {
      for (const row of await rows(`${queue.ref.path}/${family}`)) {
        const task = row.data();
        if (family === "backgroundOutputs" && row.id !== "_admission") continue;
        if (["verified", "superseded", "cancelled"].includes(task.status) && task.claim == null && task.nextAttemptAt == null) continue;
        let reason = null;
        if (task.schemaVersion !== 1 || !same(task.runtime, oldRuntime) || !terminal(parent) ||
            !same(parent.backgroundRuntime ?? parent.runtime, oldRuntime)) reason = "unknown-or-active-owner";
        else if (!expired(task)) reason = "live-or-uncertain-lease-or-retry";
        else if (family === "homePageRefresh") {
          require("./no-build-home-confirmation").assertHomeRefreshInput(task.input);
          if (row.id !== "home" || task.owner !== "page-no-build-v1" || task.pageId !== "home" || !p.positive(task.revision) ||
              task.rendererSha !== pins.commitSha || !["pending", "failed", "superseded"].includes(task.status) ||
              task.input.sourceOperationId !== queue.id || !p.positive(task.input.homeSourceVersion) ||
              !require("./no-build-home-ownership").isHomePageAuthority(home) || !same(home.runtime, oldRuntime) ||
              home.homeRefresh?.taskPath === row.ref.path ||
              !(home.operationId === task.input.homeOperationId && home.homeRefresh?.revision > task.revision ||
                home.operationId !== task.input.homeOperationId && home.sourceVersion > task.input.homeSourceVersion)) reason = "selected-or-unknown-home-history";
        } else if (selected.has(queue.id) || selectedTasks.has(row.ref.path)) reason = "selected-history";
        else if (family === "backgroundPreparation") {
          if (task.contextDigest !== row.id || !p.digest(row.id) || row.id === currentDigest ||
              !["pending", "building", "failed"].includes(task.status) || !Number.isSafeInteger(task.attempts) || task.attempts < 0 || task.attempts > 4 ||
              task.reservation?.commitSha !== pins.commitSha || !p.positive(task.reservation.generation) ||
              !deployment.isPublicDeploymentIdentifier(task.reservation.buildBatchId) ||
              !p.positive(task.reservation.cutoffAt?.toMillis?.())) reason = "current-or-unknown-preparation";
        } else if (task.owner !== "post-background-v1" || task.stage !== "preparation" || task.status !== "failed" ||
            task.error !== "background_preparation_failed" || parent.noBuildPost?.postId !== task.postId) reason = "unknown-admission-marker";
        const entry = { path: row.ref.path, digest: p.publicReleaseDigest(task) };
        if (reason) blocked.push({ ...entry, reason }); else records.push(entry);
      }
    }
  }
  if (records.length > 200) refuse();
  records.sort((a, b) => a.path.localeCompare(b.path, "en"));
  blocked.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { schemaVersion: 1, kind: "pre-enrollment-history-listing", request,
    censusDigest: p.publicReleaseDigest([...observed].sort(([a], [b]) => a.localeCompare(b, "en"))), records, blocked };
}
async function listPreEnrollmentHistory({ firestore, request }) {
  parseRequest(request); targets.assertPublicationDatabase(firestore, request.target);
  return firestore.runTransaction(async transaction => {
    const listing = await inspect(firestore, transaction, request);
    return { listing, listingDigest: p.publicReleaseDigest(listing) };
  }, { readOnly: true });
}
async function retirePreEnrollmentHistory({ firestore, request, operatorReceipt }) {
  parseRequest(request); targets.assertPublicationDatabase(firestore, request.target);
  parseReceipt(operatorReceipt, request);
  return firestore.runTransaction(async transaction => {
    const ref = firestore.doc(`${ROOT}/${request.operationId}`), saved = await transaction.get(ref);
    const receipt = { schemaVersion: 1, kind: "pre-enrollment-history-retired", operatorReceipt,
      outcome: "cancelled-not-published", queuesChanged: 0, providerWrites: 0 };
    if (saved.exists) {
      if (!saved.createTime.isEqual(saved.updateTime) || !same(saved.data(), receipt)) refuse();
      return { idempotent: true, receipt };
    }
    const listing = await inspect(firestore, transaction, request);
    if (!same(listing, operatorReceipt.listing)) refuse();
    for (const row of listing.records) transaction.update(firestore.doc(row.path),
      { status: "cancelled", claim: null, nextAttemptAt: null, retirementReceiptPath: ref.path });
    transaction.create(ref, receipt);
    transaction.create(firestore.collection("admin_logs").doc(), require("./audit").adminLogEntry({
      actorUid: "system:pre-enrollment-history", action: "public-release.pre-enrollment-history-retired", target: request.operationId,
      before: null, after: { listingDigest: operatorReceipt.listingDigest, records: listing.records.length, outcome: receipt.outcome } }));
    return { idempotent: false, receipt };
  });
}
module.exports = { parseRequest, parseReceipt, listPreEnrollmentHistory, retirePreEnrollmentHistory };
