"use strict";

// Candidate startup authority is separate from editorial admission. Only the
// existing selector admits queue work; recording this pointer selects nothing.
const pairs = require("./cms-preview-pair");
const publicPairs = require("./public-release-pair");
const POINTERS = "cmsPreviewPairCandidatePointers";
const RECEIPTS = "cmsPreviewPairCandidatePointerReceipts";
const ID = /^preview-[a-z0-9][a-z0-9-]{0,31}$/;
const RECEIPT_ID = /^renderer-[0-9]{1,20}-[0-9]{1,4}$/;
const HEX = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
function refuse() { throw new Error("Private preview candidate authority is unavailable"); }
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) refuse();
}
function runtimeIdentity(value) {
  if (value?.schemaVersion === 2) return pairs.parseSelector(value);
  if (value?.schemaVersion !== 1 || !["ready", "starting", "paused"].includes(value.phase) ||
      !matches(SHA, value.rendererSha) || typeof value.serializerId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.serializerId) || matches(ID, value.serializerId)) refuse();
  const result = { schemaVersion: 1, phase: value.phase, rendererSha: value.rendererSha, serializerId: value.serializerId };
  for (const key of ["dataHubCompositionVersion", "liveBlogVersion", "electionResultsVersion"]) {
    if (value[key] !== undefined) { if (key === "electionResultsVersion" ? ![1, 2].includes(value[key]) : value[key] !== 1) refuse(); result[key] = value[key]; }
  }
  return result;
}
function candidate(value, pair, candidateId, now) {
  const mutation = value?.mutation;
  if (value?.schemaVersion !== 2 || value.component !== "renderer" || value.state !== "verified" ||
      mutation?.sourceSha !== pair.rendererSha || `renderer-${mutation.runId}-${mutation.runAttempt}` !== candidateId ||
      typeof mutation.completedAt !== "string" || !Number.isFinite(Date.parse(mutation.completedAt)) ||
      Date.parse(mutation.completedAt) > now || now - Date.parse(mutation.completedAt) > 300_000 ||
      !matches(SHA, mutation.trustedWorkflowSha) || !matches(HEX, mutation.inputFingerprint) || !matches(HEX, mutation.configurationFingerprint) ||
      ["pairId", "rendererSha", "serializerId", "workerName", "applicationName", "workerVersion", "imageDigest"]
        .some(key => mutation.providerIdentities?.[key] !== pair[key]) ||
      ["applicationId", "workerDeploymentId"].some(key => typeof mutation.providerIdentities?.[key] !== "string" ||
        !/^[A-Za-z0-9._:-]{1,100}$/.test(mutation.providerIdentities[key]))) refuse();
  return value;
}
function pointer(value, pair) {
  exact(value, ["schemaVersion", "pairId", "pairDigest", "candidateReceiptId", "candidateDigest", "runtimeDigest", "bootstrapPublicPair"]);
  if (value.schemaVersion !== 1 || value.pairId !== pair.pairId || value.pairDigest !== pairs.digest(pair) ||
      !matches(RECEIPT_ID, value.candidateReceiptId) || !matches(HEX, value.candidateDigest) || !matches(HEX, value.runtimeDigest)) refuse();
  publicPairs.parsePublicReleasePairReference(value.bootstrapPublicPair);
  return value;
}
function clock(now) { if (!Number.isSafeInteger(now) || now < 0) refuse(); }
/** Read adapter also works with the Worker's bounded Firestore REST reader.
 * A candidate can be healthy in standby while OLD still owns admission.
 */
async function readPreviewPairRuntimeAuthority({ read, pairId, rendererSha, workerVersion, now = Date.now() }) {
  clock(now);
  if (!matches(ID, pairId) || !matches(SHA, rendererSha) || typeof read !== "function") refuse();
  if ((await read("system/billing"))?.disabled === true) refuse();
  const pair = pairs.parsePair(await read(`${pairs.PAIRS}/${pairId}`));
  if (pair.pairId !== pairId || pair.rendererSha !== rendererSha || pair.workerVersion !== workerVersion) refuse();
  const runtime = runtimeIdentity(await read(pairs.SELECTOR_PATH));
  if (runtime.schemaVersion === 2 && [runtime.selectedPairId, runtime.recoveryPairId].includes(pairId)) {
    if (runtime.selectedPairId === pairId) pairs.assertProjection(runtime, pair);
    return { mode: "retained", pair, runtimeDigest: pairs.digest(runtime), candidateReceiptId: null };
  }
  const active = pointer(await read(`${POINTERS}/${pairId}`), pair);
  if (active.runtimeDigest !== pairs.digest(runtime)) refuse();
  const observed = candidate(await read(`cmsDeploymentCandidates/${active.candidateReceiptId}`), pair, active.candidateReceiptId, now);
  if (pairs.digest(observed) !== active.candidateDigest) refuse();
  return { mode: "candidate", pair, runtimeDigest: active.runtimeDigest,
    candidateReceiptId: active.candidateReceiptId, bootstrapPublicPair: active.bootstrapPublicPair };
}
/** Work permission needs retention, never a candidate's expiring health proof.
 * Missing/new/expired candidate pointers are therefore ordinary no-work states;
 * actual SDK, registry or credential failures still reject observably. */
async function readPreviewPairWorkAuthority({ read, pairId, rendererSha, workerVersion, now = Date.now() }) {
  clock(now);
  if (!matches(ID, pairId) || !matches(SHA, rendererSha) || typeof read !== "function") refuse();
  if ((await read("system/billing"))?.disabled === true) return { mode: "disabled" };
  const runtime = runtimeIdentity(await read(pairs.SELECTOR_PATH));
  if (runtime.schemaVersion !== 2 || ![runtime.selectedPairId, runtime.recoveryPairId].includes(pairId)) return { mode: "unretained", runtimeDigest: pairs.digest(runtime) };
  const pair = pairs.parsePair(await read(`${pairs.PAIRS}/${pairId}`));
  if (pair.pairId !== pairId || pair.rendererSha !== rendererSha || pair.workerVersion !== workerVersion) refuse();
  if (runtime.selectedPairId === pairId) pairs.assertProjection(runtime, pair);
  return { mode: "retained", pair, runtimeDigest: pairs.digest(runtime) };
}
/** Inert operator writer, after actual provider verification created the
 * candidate receipt. Exact retry never rewinds a newer pointer or timestamp.
 */
async function recordPreviewPairCandidatePointer({ firestore, request: raw, clock: timestamp = Date.now, signal }) {
  exact(raw, ["operationId", "pairId", "candidateReceiptId", "expectedPointerDigest", "expectedRuntimeDigest", "bootstrapPublicPair"]);
  if (!matches(ID, raw.operationId) || !matches(ID, raw.pairId) || !matches(RECEIPT_ID, raw.candidateReceiptId) ||
      raw.expectedPointerDigest !== null && !matches(HEX, raw.expectedPointerDigest) || !matches(HEX, raw.expectedRuntimeDigest)) refuse();
  const request = Object.freeze({ ...raw, bootstrapPublicPair: publicPairs.parsePublicReleasePairReference(raw.bootstrapPublicPair) });
  const attempt = firestore.collection(RECEIPTS).doc(request.operationId), target = firestore.collection(POINTERS).doc(request.pairId);
  signal?.throwIfAborted();
  return firestore.runTransaction(async transaction => {
    const [existing, current] = await transaction.getAll(attempt, target);
    if (existing.exists) {
      const value = existing.data();
      if (value?.schemaVersion !== 1 || value.requestDigest !== pairs.digest(request) || pairs.digest(value.request) !== value.requestDigest) refuse();
      return value;
    }
    const [registered, runtimeRow, verified] = await transaction.getAll(firestore.collection(pairs.PAIRS).doc(request.pairId),
      firestore.doc(pairs.SELECTOR_PATH), firestore.doc(`cmsDeploymentCandidates/${request.candidateReceiptId}`));
    const pair = pairs.parsePair(registered.data()), runtime = runtimeIdentity(runtimeRow.data());
    if (pair.pairId !== request.pairId || pairs.digest(runtime) !== request.expectedRuntimeDigest ||
        (current.exists ? pairs.digest(current.data()) : null) !== request.expectedPointerDigest) refuse();
    const now = timestamp(); clock(now);
    const observed = candidate(verified.data(), pair, request.candidateReceiptId, now);
    const selected = pointer({ schemaVersion: 1, pairId: pair.pairId, pairDigest: pairs.digest(pair), candidateReceiptId: request.candidateReceiptId,
      candidateDigest: pairs.digest(observed), runtimeDigest: request.expectedRuntimeDigest, bootstrapPublicPair: request.bootstrapPublicPair }, pair);
    const result = { schemaVersion: 1, request, requestDigest: pairs.digest(request), pointer: selected, pointerDigest: pairs.digest(selected), recordedAt: new Date(now).toISOString() };
    signal?.throwIfAborted();
    transaction.set(target, selected); transaction.create(attempt, result);
    return result;
  });
}
module.exports = { POINTERS, RECEIPTS, previewRuntimeIdentity: runtimeIdentity, readPreviewPairRuntimeAuthority, readPreviewPairWorkAuthority, recordPreviewPairCandidatePointer };
