"use strict";
// Operator-only development repair. A standalone development site refresh moves the
// pointer and capabilities but not the publication runtime; this re-pins a ready
// development runtime to the live pointer commit. No HTTP, production or scheduled caller.
const p = require("../../functions/lib/public-release-pair");
const { assertPublicDeploymentPointer } = require("../../functions/lib/public-deployment-pointer");
const runtime = require("../../functions/lib/cms-publication-runtime-control");
const { adminLogEntry } = require("../../functions/lib/audit");
const { publicationTarget } = require("../../functions/lib/publication-target");
const target = publicationTarget("development");
const ROOT = "system/devRuntimeRepins/operations";
const POINTER = "system/publicDeployment";
const CAPABILITIES = ["Posts", "Pages", "Records"].map(family => `${POINTER}/noBuild${family}/capability`);
const SHA = /^[a-f0-9]{40}$/;
const refuse = () => { throw new p.PublicReleaseProtocolError(); };

function parseRequest(value) {
  p.exact(value, ["schemaVersion", "operationId", "environment", "projectId", "fromCommitSha", "toCommitSha"]);
  if (value.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(value.operationId ?? "") ||
      value.environment !== "development" || value.projectId !== target.projectId ||
      !SHA.test(value.fromCommitSha ?? "") || !SHA.test(value.toCommitSha ?? "") ||
      value.fromCommitSha === value.toCommitSha) refuse();
  return p.freeze(structuredClone(value));
}

function validate(firestore, request) {
  if (firestore?.projectId !== target.projectId) refuse();
  return parseRequest(request);
}

async function state(firestore, tx, request) {
  const [saved, pins, pointer, ...capabilities] = await tx.getAll(
    ...[`${ROOT}/${request.operationId}`, runtime.RUNTIME_DOCUMENT_PATH, POINTER, ...CAPABILITIES].map(path => firestore.doc(path)));
  const publishing = await tx.get(firestore.collection("cmsPublishQueue").where("status", "==", "publishing").limit(1));
  return { saved, pins, pointer, capabilities, publishing };
}

// The pointer and every capability must already name the target commit at one settled generation.
function assertBaseline(s, request) {
  const pointer = assertPublicDeploymentPointer(s.pointer.data());
  if (pointer.state !== "idle" || pointer.activeCommitSha !== request.toCommitSha ||
      pointer.lastReservedGeneration !== pointer.activeGeneration ||
      pointer.newestEligibleGeneration !== pointer.activeGeneration || !s.publishing.empty ||
      s.capabilities.some(row => !row.exists || row.data().rendererSha !== request.toCommitSha ||
        row.data().generation !== pointer.activeGeneration || row.data().servingEnabled !== true)) refuse();
  return pointer;
}

function repinned(pins, commitSha) {
  return { ...pins, commitSha, cloud: { ...pins.cloud, commitSha } };
}

function receipt(request, before) {
  return { schemaVersion: 1, kind: "dev-runtime-repin", request, requestDigest: p.publicReleaseDigest(request),
    before, after: repinned(before, request.toCommitSha) };
}

async function repinDevRuntime({ firestore, request: raw }) {
  const request = validate(firestore, raw);
  await firestore.runTransaction(async tx => {
    const s = await state(firestore, tx, request);
    if (s.saved.exists || !s.pins.exists) refuse();
    const pins = runtime.parseCmsPublicationRuntimeControl(s.pins.data());
    // Only a ready, consistent development runtime at the stated commit can move.
    if (pins.phase !== "ready" || pins.cloud?.phase !== "ready" || pins.cloud.serializerId !== target.serializerId ||
        pins.commitSha !== request.fromCommitSha || pins.cloud.commitSha !== request.fromCommitSha) refuse();
    assertBaseline(s, request);
    const saved = receipt(request, pins);
    tx.set(firestore.doc(runtime.RUNTIME_DOCUMENT_PATH), saved.after);
    tx.create(firestore.doc(`${ROOT}/${request.operationId}`), saved);
    tx.create(firestore.collection("admin_logs").doc(), adminLogEntry({
      actorUid: "system:dev-runtime-repin", action: "public-release.dev-runtime-repin",
      target: runtime.RUNTIME_DOCUMENT_PATH, before: pins,
      after: { operationId: request.operationId, requestDigest: saved.requestDigest, runtime: saved.after } }));
  });
  return readDevRuntimeRepin({ firestore, request });
}

async function readDevRuntimeRepin({ firestore, request: raw }) {
  const request = validate(firestore, raw);
  return firestore.runTransaction(async tx => {
    const s = await state(firestore, tx, request);
    if (!s.saved.exists || !s.saved.createTime.isEqual(s.saved.updateTime)) refuse();
    const saved = s.saved.data();
    if (saved.requestDigest !== p.publicReleaseDigest(request)) refuse();
    let currentAligned = false;
    try {
      // The original receipt stays readable after a later release moves the runtime.
      assertBaseline(s, request);
      currentAligned = s.pins.exists && p.publicReleaseDigest(runtime.parseCmsPublicationRuntimeControl(s.pins.data())) ===
        p.publicReleaseDigest(saved.after);
    } catch { /* Later progress is reported as not aligned. */ }
    return { committed: true, currentAligned, receipt: saved };
  }, { readOnly: true });
}

module.exports = { parseRequest, repinDevRuntime, readDevRuntimeRepin };
