"use strict";

// Operator-only retirement of an unused development enrollment. No provider IO.
const p = require("../../functions/lib/public-release-pair");
const enrollment = require("../../functions/lib/public-release-change-enrollment");
const adoption = require("../../functions/lib/public-release-bootstrap-adoption");
const pause = require("../../functions/lib/dev-public-release-pause");
const pointerOwner = require("../../functions/lib/public-deployment-pointer");
const runtimeOwner = require("../../functions/lib/cms-publication-runtime-control");
const ROOT = "system/devInactiveBootstraps/retirements";
const SLOTS = Object.freeze([
  "system/publicReleaseChanges", enrollment.ENROLLMENT_PATH,
  "system/publicReleaseAdmissions/controls/bootstrapFence", "system/publicDeployment/releaseWriter/fence",
  "system/cmsPublicationRuntime", "system/devPublicPredecessor/initializations/runtime", "system/devPreviewRendererBootstrap",
].sort());
const ABSENT = ["system/publicReleaseChangeLog", "system/publicReleasePairs", "system/publicReleasePairUploads",
  "system/publicReleaseAdmissions", "system/publicReleaseAdmissions/controls/adoption",
  "system/publicReleasePrivateInstalls", "system/devPublication", "system/publicDeployment/pairMedia/current",
  "system/devPublicReleasePauseRecovery"];
const EMPTY = ["system/publicReleaseChanges/entries", "system/publicReleaseChanges/operations",
  "system/publicReleaseChanges/captures", "system/publicReleaseAdmissions/bootstrapControls", "system/publicDeployment/bootstrapSelectors",
  "system/publicReleaseAdmissions/operations", "system/publicReleaseAdmissions/pending",
  "system/publicReleaseAdmissions/bootstrapPairRetentions", "system/publicReleaseAdmissions/bootstrapResumes",
  "system/publicReleasePairs/entries", "system/publicReleasePrivateInstalls/plans", "system/publicReleasePrivateInstalls/workers",
  "cmsPreviewPairs", "cmsPreviewPrivateInstalls", "cmsPreviewPairRollouts", "cmsPreviewPairSwitches", "cmsPreviewBootstrapReceipts"];
const GROUPS = { rollouts: "system/publicReleasePairs/entries/", steps: "system/publicReleasePrivateInstalls/",
  readbacks: "system/publicReleasePrivateInstalls/", operations: "system/publicReleasePairs/entries/",
  completions: "system/publicReleasePairs/entries/" };
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const refuse = () => { throw new Error("Development inactive bootstrap retirement refused"); };
const database = db => { if (db?.projectId !== "njpbs-site-dev") refuse(); };
const stamp = value => ({ seconds: value.seconds, nanoseconds: value.nanoseconds });

// Tagged values keep maps distinct from SDK types and preserve nanoseconds,
// byte strings, references, special numbers and every original field.
function encoded(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (Array.isArray(value)) return ["array", value.map(encoded)];
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return ["bytes", Buffer.from(value).toString("base64")];
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return ["map", Object.keys(value).sort().map(key => [key, encoded(value[key])])];
  if (value?.constructor?.name === "Timestamp") return ["timestamp", stamp(value)];
  if (value?.constructor?.name === "GeoPoint") return ["geopoint", value.latitude, value.longitude];
  if (value?.constructor?.name === "DocumentReference") return ["reference", value.formattedName];
  refuse();
}
function metadata(row) {
  return row.exists ? { path: row.ref.path, exists: true, createTime: stamp(row.createTime),
    updateTime: stamp(row.updateTime), dataDigest: p.publicReleaseDigest(encoded(row.data())) }
    : { path: row.ref.path, exists: false };
}
function tracked(transaction) {
  const rows = new Map();
  const remember = row => { rows.set(row.ref.path, row); return row; };
  const tx = new Proxy(transaction, { get(target, key) {
    if (key === "getAll") return async (...refs) => (await target.getAll(...refs)).map(remember);
    if (key === "get") return async ref => {
      const result = await target.get(ref);
      if (Array.isArray(result.docs)) result.docs.forEach(remember); else remember(result);
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { tx, rows };
}
async function retainedContext(raw) {
  if (raw == null) return null;
  return (await import("./dev-retained-private-access.mjs")).parseRetainedPrivateAccess(raw);
}
function assertRetainedRequest(request, retained) {
  if (request.retainedAccessDigest !== retained?.digest) refuse();
  for (const [path, data] of retained?.documents ?? []) {
    const row = request.observations.find(row => row.path === path);
    if (!row?.exists || row.dataDigest !== p.publicReleaseDigest(encoded(data))) refuse();
  }
}
async function emptyCollections(db, tx, stage, retained = null) {
  const matches = (docs, paths) => same(docs.map(row => row.ref.path).sort(), paths) &&
    docs.every(row => same(row.data(), retained.documents.get(row.ref.path)));
  for (const path of EMPTY) {
    const allowed = retained?.collections.get(path);
    stage("inspect-empty-collections-read");
    const result = await tx.get(db.collection(path).limit(allowed ? allowed.length + 1 : 1));
    stage("inspect-empty-collections-guard");
    if (allowed ? !matches(result.docs, allowed) : !result.empty) return false;
  }
  for (const [name, prefix] of Object.entries(GROUPS)) {
    stage("inspect-empty-groups-read");
    const result = await tx.get(db.collectionGroup(name).limit(1001));
    stage("inspect-empty-groups-guard");
    if (result.size > 1000) return false;
    const protectedRows = result.docs.filter(row => row.ref.path.startsWith(prefix)), allowed = retained?.groups.get(name);
    if (allowed ? !matches(protectedRows, [...allowed].sort()) : protectedRows.length) return false;
  }
  return true;
}
function renderer(row, preview, component, receipt) {
  const value = row.data(), attempt = value?.attempt, proof = value?.receipt;
  if (value?.status !== "committed-paused" || value.kind !== "development-preview-renderer-bootstrap" ||
      value.attemptDigest !== p.publicReleaseDigest(attempt) || attempt.rendererSha !== receipt.request.expected.liveReleaseSha ||
      attempt.bootstrapOperationId !== receipt.request.operationId || proof?.projectId !== "njpbs-site-dev" ||
      proof.environment !== "development" || proof.state !== "bootstrap-paused" || proof.sourceSha !== attempt.rendererSha ||
      proof.provider?.enabled !== false || proof.provider?.imageState !== "configured" ||
      proof.provider?.worker !== "template-dev-cms-preview-renderer" || proof.provider?.operationId !== attempt.operationId ||
      !same(component.data(), proof) || !same(preview.data(), { schemaVersion: 1, phase: "paused",
        rendererSha: attempt.rendererSha, serializerId: "cloudflare-preview" })) refuse();
}
async function previewDrained(db, tx, stage) {
  stage("inspect-preview-journal-read");
  const journal = await tx.get(db.doc("cmsPreviewSerializerJournals/cloudflare-preview"));
  stage("inspect-preview-journal-guard");
  const value = journal.data();
  if (journal.exists) {
    p.exact(value, ["schemaVersion", "serializerId", "job"]);
    if (value.schemaVersion !== 1 || value.serializerId !== "cloudflare-preview" || value.job !== null) refuse();
  }
  stage("inspect-preview-queues-read");
  const queues = await tx.get(db.collection("cmsPreviewQueue").limit(1001));
  stage("inspect-preview-queues-guard");
  if (queues.size > 1000) refuse();
  for (const row of queues.docs) {
    const value = row.data();
    if (!["ready", "failed", "expired"].includes(value.status) || value.nextAttemptAt != null) refuse();
    // Native completion retains serializerClaim as immutable history. The idle
    // token journal and terminal status establish that it is no longer active.
    if (value.serializerClaim !== undefined) {
      stage("inspect-preview-claim-guard");
      const claim = require("../../functions/lib/cms-preview-serializer").projectClaim(value.serializerClaim);
      if (claim.rendererSha !== value.rendererSha) refuse();
    }
    stage("inspect-preview-queues-guard");
  }
}
async function collectionCensuses(db, tx, oldRuntime, stage) {
  const owners = new Set([oldRuntime.serializerId, oldRuntime.cloud.serializerId]);
  const paths = ["cmsPublishQueue", "system/publicDeployment/buildBatches", "cmsBackgroundOutputs", "cmsPreviewQueue",
    ...[...owners].map(owner => `cmsPublicationSerializerJournals/${owner}/releases`)].sort();
  const result = [];
  for (const path of paths) {
    stage("inspect-census-read");
    const rows = await tx.get(db.collection(path).limit(1001));
    stage("inspect-census-guard");
    if (rows.size > 1000) refuse();
    result.push({ path, documents: rows.docs.map(row => row.ref.path).sort() });
  }
  return result;
}
function predecessor(rows, receipt, pointer) {
  const pins = runtimeOwner.parseCmsPublicationRuntimeControl(rows.get("system/cmsPublicationRuntime").data());
  const cloud = runtimeOwner.cloudCmsPublicationRuntimeControl(pins);
  if (pins.phase !== "paused" || cloud.phase !== "paused" || pins.commitSha !== pointer.activeCommitSha ||
      cloud.commitSha !== pointer.activeCommitSha || cloud.serializerId !== "cloudflare-dev-publisher" || !pins.cloud ||
      p.publicReleaseDigest(pins) !== receipt.request.expected.runtimeDigest) refuse();
  for (const step of ["runtime", "media-lifecycle"]) {
    const row = rows.get(`system/devPublicPredecessor/initializations/${step}`), value = row.data();
    require("./dev-public-predecessor.cjs").parseRequest(value?.request);
    if (!row.createTime.isEqual(row.updateTime) || value?.kind !== `dev-public-predecessor-${step}` ||
        value.request?.projectId !== "njpbs-site-dev" || value.request.environment !== "development" ||
        value.request.oldRuntime?.commitSha !== pointer.activeCommitSha ||
        value.requestDigest !== p.publicReleaseDigest(value.request)) refuse();
  }
}
async function inspectState(db, transaction, operationId, stage = () => {}, retained = null) {
  const { tx, rows } = tracked(transaction);
  const paths = [...SLOTS, ...ABSENT, "system/publicDeployment", "system/cmsPreviewRuntime",
    "cmsDeploymentReceipts/renderer", "system/publicDeployment/contexts/public", "system/devPublicPredecessor/initializations/media-lifecycle"];
  stage("inspect-state-read");
  await tx.getAll(...paths.map(path => db.doc(path)));
  stage("inspect-state-guard");
  if (SLOTS.some(path => !rows.get(path).exists) || ABSENT.some(path => rows.get(path).exists)) refuse();
  if (!await emptyCollections(db, tx, stage, retained)) refuse();
  stage("inspect-enrollment-read");
  const enrolled = await enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({ firestore: db, transaction: tx });
  stage("inspect-enrollment-guard");
  const receipt = enrolled.receipt;
  if (receipt.request.expected.projectId !== "njpbs-site-dev" || !same(enrolled.head, receipt.initialHead) || enrolled.head.sequence !== 0) refuse();
  stage("inspect-pointer-guard");
  const pointer = pointerOwner.assertPublicDeploymentPointer(rows.get("system/publicDeployment").data());
  if (pointer.schemaVersion !== 1 || pointer.state !== "idle" || pointer.activeCommitSha !== receipt.request.expected.liveReleaseSha ||
      pointer.activeGeneration < 1 || pointer.lastReservedGeneration !== pointer.activeGeneration ||
      pointer.newestEligibleGeneration !== pointer.activeGeneration || pointer.mediaLifecycleReady !== true ||
      p.publicReleaseDigest(pointer) !== receipt.request.expected.pointerDigest) refuse();
  stage("inspect-predecessor-guard");
  predecessor(rows, receipt, pointer);
  stage("inspect-context-guard");
  const context = rows.get("system/publicDeployment/contexts/public").data();
  if (context?.schemaVersion !== 1 || context.revision !== receipt.request.expected.contextRevision) refuse();
  const priorPaths = ["system/devPublicReleasePause/failures", "system/devPublicReleasePause/recoveries", "system/devPublicReleasePause/restores",
    "system/publicReleaseAdmissions/bootstrapAbandons"].map(path => `${path}/${receipt.request.operationId}`);
  stage("inspect-prior-attempts-read");
  const prior = await tx.getAll(...priorPaths.map(path => db.doc(path)));
  stage("inspect-prior-attempts-guard");
  if (prior.some(row => row.exists)) refuse();
  stage("inspect-fence-read");
  const fence = await adoption.assertClosedBootstrapFenceInTransaction({ firestore: db, transaction: tx,
    environment: "development", before: pointer, operationId: receipt.request.operationId });
  stage("inspect-original-drain-read");
  await pause.assertDevPublicReleaseDrainInTransaction({ firestore: db, transaction: tx, operationId: fence.operationId });
  // Re-run the native complete drain, rather than trusting only its old receipt.
  stage("inspect-current-drain-read");
  const saved = rows.get(`system/devPublicReleasePause/attempts/${fence.operationId}`).data();
  await pause.recoveryInternals.drain(db, tx, saved.attempt, false, saved.initialQueueFailures);
  stage("inspect-initializer-runtime-guard");
  for (const step of ["runtime", "media-lifecycle"]) if (!same(
    rows.get(`system/devPublicPredecessor/initializations/${step}`).data().request.oldRuntime, saved.attempt.oldRuntime)) refuse();
  await previewDrained(db, tx, stage);
  const censuses = await collectionCensuses(db, tx, saved.attempt.oldRuntime, stage);
  stage("inspect-renderer-guard");
  renderer(rows.get("system/devPreviewRendererBootstrap"), rows.get("system/cmsPreviewRuntime"),
    rows.get("cmsDeploymentReceipts/renderer"), receipt);
  stage("inspect-observations-encode");
  const observations = [...rows.values()].map(metadata).sort((a, b) => a.path.localeCompare(b.path));
  stage("inspect-observations-guard");
  if (observations.length > 1000) refuse();
  const request = { schemaVersion: 1, environment: "development", projectId: "njpbs-site-dev", operationId,
    enrollmentRequestDigest: receipt.requestDigest, observations, censuses, emptyCollections: EMPTY, emptyGroups: GROUPS,
    ...(retained ? { retainedAccessDigest: retained.digest } : {}) };
  stage("inspect-request-size-guard");
  if (Buffer.byteLength(JSON.stringify(request)) > 192 * 1024) refuse();
  return { request, rows };
}
function parseRequest(value) {
  p.exact(value, ["schemaVersion", "environment", "projectId", "operationId", "enrollmentRequestDigest", "observations", "censuses", "emptyCollections", "emptyGroups",
    ...(Object.hasOwn(value ?? {}, "retainedAccessDigest") ? ["retainedAccessDigest"] : [])]);
  if (Object.hasOwn(value, "retainedAccessDigest") && !p.digest(value.retainedAccessDigest)) refuse();
  if (value.schemaVersion !== 1 || value.environment !== "development" || value.projectId !== "njpbs-site-dev" ||
      !pointerOwner.isPublicDeploymentIdentifier(value.operationId) || !p.digest(value.enrollmentRequestDigest) ||
      !Array.isArray(value.observations) || !value.observations.length || value.observations.length > 1000 ||
      !same(value.emptyCollections, EMPTY) || !same(value.emptyGroups, GROUPS)) refuse();
  // Every field is re-derived from native snapshots before any deletion.
  for (const row of value.observations) {
    p.exact(row, row.exists ? ["path", "exists", "createTime", "updateTime", "dataDigest"] : ["path", "exists"]);
    if (typeof row.path !== "string" || row.path.length > 1500 || typeof row.exists !== "boolean") refuse();
    if (row.exists && (!p.digest(row.dataDigest) || !validStamp(row.createTime) || !validStamp(row.updateTime))) refuse();
  }
  if (!same(value.observations.map(row => row.path), [...new Set(value.observations.map(row => row.path))].sort((a, b) => a.localeCompare(b)))) refuse();
  if (SLOTS.some(path => !value.observations.some(row => row.path === path && row.exists))) refuse();
  if (!Array.isArray(value.censuses) || value.censuses.length < 5 || value.censuses.length > 6) refuse();
  for (const census of value.censuses) {
    p.exact(census, ["path", "documents"]);
    if (typeof census.path !== "string" || !Array.isArray(census.documents) || census.documents.length > 1000 ||
        !same(census.documents, [...new Set(census.documents)].sort()) || census.documents.some(path =>
          typeof path !== "string" || !path.startsWith(`${census.path}/`) || !value.observations.some(row => row.path === path && row.exists))) refuse();
  }
  return value;
}
function validStamp(value) {
  return value && Object.keys(value).length === 2 && Number.isSafeInteger(value.seconds) &&
    Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 && value.nanoseconds < 1e9;
}
const archivePath = request => `${ROOT}/${request.operationId}`;
const documentPath = (request, path) => `${archivePath(request)}/documents/${p.publicReleaseDigest(path)}`;
const indexPath = request => `system/devInactiveBootstraps/enrollments/${request.enrollmentRequestDigest}`;
function manifest(request) {
  const documents = request.observations.filter(row => SLOTS.includes(row.path));
  return { schemaVersion: 1, kind: "development-inactive-bootstrap-retired", request,
    requestDigest: p.publicReleaseDigest(request), documents, manifestDigest: p.publicReleaseDigest(documents) };
}
async function original(db, tx, request) {
  const expected = manifest(request), row = await tx.get(db.doc(archivePath(request)));
  const copies = (await tx.get(db.collection(`${archivePath(request)}/documents`).limit(SLOTS.length + 1))).docs;
  if (!row.exists) { if (copies.length) refuse(); return null; }
  if (!row.createTime.isEqual(row.updateTime) || !same(row.data(), expected)) refuse();
  if (copies.length !== SLOTS.length || copies.some(copy => !SLOTS.some(path => documentPath(request, path) === copy.ref.path))) refuse();
  const index = await tx.get(db.doc(indexPath(request)));
  if (!index.exists || !index.createTime.isEqual(index.updateTime) || !same(index.data(), {
    schemaVersion: 1, operationId: request.operationId, requestDigest: expected.requestDigest, manifestDigest: expected.manifestDigest })) refuse();
  copies.forEach(copy => {
    if (!copy.exists || !copy.createTime.isEqual(copy.updateTime)) refuse();
    const value = copy.data(), metadata = expected.documents.find(row => documentPath(request, row.path) === copy.ref.path);
    p.exact(value, ["metadata", "data"]);
    if (!same(value.metadata, metadata) || p.publicReleaseDigest(encoded(value.data)) !== metadata.dataDigest) refuse();
  });
  return expected;
}
async function inspectDevInactiveBootstrap({ firestore, operationId, retainedAccess = null, stage = () => {} }) {
  stage("inspect-input-guard");
  database(firestore);
  if (!pointerOwner.isPublicDeploymentIdentifier(operationId)) refuse();
  if (retainedAccess != null) stage("inspect-retained-access-guard");
  const retained = await retainedContext(retainedAccess);
  stage("inspect-transaction-open");
  return firestore.runTransaction(async tx => {
    stage("inspect-archive-read");
    const archive = await tx.get(firestore.doc(`${ROOT}/${operationId}`));
    stage("inspect-archive-guard");
    if (archive.exists) refuse();
    const result = await inspectState(firestore, tx, operationId, stage, retained);
    stage("inspect-transaction-complete");
    return result.request;
  }, { readOnly: true });
}
async function retireDevInactiveBootstrap({ firestore, request: raw, retainedAccess = null, dryRun = true }) {
  database(firestore); const request = parseRequest(raw), retained = await retainedContext(retainedAccess);
  assertRetainedRequest(request, retained);
  if (typeof dryRun !== "boolean") refuse();
  const result = await firestore.runTransaction(async tx => {
    const prior = await original(firestore, tx, request);
    if (prior) return { idempotent: true, receipt: prior };
    if ((await tx.get(firestore.doc(indexPath(request)))).exists) refuse();
    const current = await inspectState(firestore, tx, request.operationId, () => {}, retained);
    if (!same(current.request, request)) refuse();
    const receipt = manifest(request);
    if (!dryRun) {
      tx.create(firestore.doc(archivePath(request)), receipt);
      tx.create(firestore.doc(indexPath(request)), { schemaVersion: 1, operationId: request.operationId,
        requestDigest: receipt.requestDigest, manifestDigest: receipt.manifestDigest });
      for (const path of SLOTS) {
        tx.create(firestore.doc(documentPath(request, path)), { metadata: metadata(current.rows.get(path)), data: current.rows.get(path).data() });
        tx.delete(firestore.doc(path));
      }
    }
    return { idempotent: false, receipt };
  });
  if (dryRun) return { ...result, dryRun: true, request, slots: SLOTS };
  return { ...result, ...await readDevInactiveBootstrap({ firestore, request, retainedAccess: retained?.proof ?? null }), dryRun: false };
}
async function readDevInactiveBootstrap({ firestore, request: raw, retainedAccess = null }) {
  database(firestore); const request = parseRequest(raw), retained = await retainedContext(retainedAccess);
  assertRetainedRequest(request, retained);
  return firestore.runTransaction(async tx => {
    const receipt = await original(firestore, tx, request);
    if (!receipt) refuse();
    const current = await tx.getAll(...request.observations.map(row => firestore.doc(row.path)));
    const slotsAbsent = current.filter(row => SLOTS.includes(row.ref.path)).every(row => !row.exists);
    const preserved = current.filter(row => !SLOTS.includes(row.ref.path)).every(row =>
      same(metadata(row), request.observations.find(before => before.path === row.ref.path)));
    let collectionsEmpty = await emptyCollections(firestore, tx, () => {}, retained);
    for (const census of request.censuses) {
      const rows = await tx.get(firestore.collection(census.path).limit(1001));
      if (!same(rows.docs.map(row => row.ref.path).sort(), census.documents)) collectionsEmpty = false;
    }
    return { committed: true, archiveVerified: true, slotsAbsent, preserved,
      legacyCodeCycleOpen: slotsAbsent && preserved && collectionsEmpty, receipt };
  }, { readOnly: true });
}
module.exports = { SLOTS, EMPTY, GROUPS, ROOT, encoded, parseRequest, inspectDevInactiveBootstrap, retireDevInactiveBootstrap, readDevInactiveBootstrap };
