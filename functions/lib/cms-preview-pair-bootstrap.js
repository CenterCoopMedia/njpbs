"use strict";

// Inert first install: no handler/workflow/provider caller imports this writer.
// #4189 must supply the real installed-consumer guard; there is no default pass.
const pairs = require("./cms-preview-pair");
const RECEIPTS = "cmsPreviewBootstrapReceipts";
const COMPONENTS = ["functions", "cmsApi", "renderer"];
const ID = /^preview-[a-z0-9][a-z0-9-]{0,31}$/;
const CANDIDATE = /^renderer-[0-9]{1,20}-[0-9]{1,4}$/;
const HEX = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const plain = value => value && typeof value === "object" && !Array.isArray(value);
class CmsPreviewBootstrapError extends Error {
  constructor(code) { super("CMS preview bootstrap refused"); this.name = "CmsPreviewBootstrapError"; this.code = code; }
}
function refuse(code) { throw new CmsPreviewBootstrapError(code); }
function exact(value, keys) {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuse("invalid-request");
}
function identities(value) {
  exact(value, ["operationId", "oldPairId", "newPairId", "oldCandidateReceiptId", "proofDigest"]);
  if (![value.operationId, value.oldPairId, value.newPairId].every(id => matches(ID, id)) ||
      value.oldPairId === value.newPairId || !matches(CANDIDATE, value.oldCandidateReceiptId) || !matches(HEX, value.proofDigest)) refuse("invalid-request");
  return Object.freeze({ ...value });
}
function request(value) {
  exact(value, ["operationId", "oldPairId", "newPairId", "oldCandidateReceiptId", "proofDigest", "expectedRuntimeDigest", "expectedLegacyReceipts", "installedConsumerDigest"]);
  const { operationId, oldPairId, newPairId, oldCandidateReceiptId, proofDigest } = value;
  identities({ operationId, oldPairId, newPairId, oldCandidateReceiptId, proofDigest });
  exact(value.expectedLegacyReceipts, COMPONENTS);
  if (![value.expectedRuntimeDigest, value.installedConsumerDigest, ...Object.values(value.expectedLegacyReceipts)].every(v => matches(HEX, v))) refuse("invalid-request");
  return Object.freeze({ ...value, expectedLegacyReceipts: Object.freeze({ ...value.expectedLegacyReceipts }) });
}
function receipt(value, expected) {
  exact(value, ["schemaVersion", "kind", "request", "requestDigest", "selector", "selectorDigest", "selectedReceiptDigest", "installedAt"]);
  const parsed = request(value.request);
  if (value.schemaVersion !== 1 || value.kind !== "cms-preview-bootstrap" || value.requestDigest !== pairs.digest(parsed) ||
      value.selectorDigest !== pairs.digest(pairs.parseSelector(value.selector)) || value.selector.epoch !== 1 ||
      value.selector.selectedPairId !== parsed.oldPairId || value.selector.recoveryPairId !== parsed.newPairId ||
      !matches(HEX, value.selectedReceiptDigest) || typeof value.installedAt !== "string" || !Number.isFinite(Date.parse(value.installedAt)) ||
      expected && value.requestDigest !== pairs.digest(expected)) refuse("receipt-conflict");
  return value;
}
function legacyRuntime(value) {
  if (!plain(value) || value.schemaVersion !== 1 || value.phase !== "paused" || !matches(SHA, value.rendererSha) ||
      typeof value.serializerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.serializerId) ||
      matches(ID, value.serializerId)) refuse("legacy-runtime-not-paused");
  return value;
}
function fresh(value, now) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now && now - Date.parse(value) <= 300_000;
}
function candidate(value, pair, id, now) {
  const mutation = value?.mutation;
  if (value?.schemaVersion !== 2 || value.component !== "renderer" || value.state !== "verified" ||
      mutation?.sourceSha !== pair.rendererSha || !fresh(mutation.completedAt, now) ||
      !matches(SHA, mutation.trustedWorkflowSha) || !matches(HEX, mutation.inputFingerprint) || !matches(HEX, mutation.configurationFingerprint) ||
      `renderer-${mutation.runId}-${mutation.runAttempt}` !== id ||
      ["pairId", "rendererSha", "serializerId", "workerName", "applicationName", "workerVersion", "imageDigest"]
        .some(key => mutation.providerIdentities?.[key] !== pair[key]) ||
      ["applicationId", "workerDeploymentId"].some(key => typeof mutation.providerIdentities?.[key] !== "string" ||
        !/^[A-Za-z0-9._:-]{1,100}$/.test(mutation.providerIdentities[key]))) refuse("candidate-not-current");
  return mutation;
}
function emptyJournal(row, serializerId) {
  if (!row.exists) return;
  const value = row.data();
  if (!plain(value) || Object.keys(value).length !== 3 || value.schemaVersion !== 1 ||
      value.serializerId !== serializerId || value.job !== null) refuse("legacy-journal-not-drained");
}
async function preparedGuard(firestore, input, prepareInstalledConsumers, signal) {
  if (typeof prepareInstalledConsumers !== "function") refuse("installed-consumer-guard-unbound");
  const base = { ...input }; delete base.installedConsumerDigest;
  const guard = await prepareInstalledConsumers({ firestore, request: Object.freeze(base), signal });
  if (!guard || !matches(HEX, guard.digest) || typeof guard.assertCurrentInTransaction !== "function") refuse("installed-consumer-guard-unbound");
  return guard;
}
async function inspect(firestore, tx, input, guard, clock, signal, write) {
  const opRef = firestore.collection(RECEIPTS).doc(input.operationId), runtimeRef = firestore.doc(pairs.SELECTOR_PATH);
  const [operation, runtimeRow] = await tx.getAll(opRef, runtimeRef);
  if (operation.exists) {
    const original = receipt(operation.data(), input);
    const current = pairs.parseSelector(runtimeRow.data());
    if (current.epoch < original.selector.epoch || current.epoch === 1 && pairs.digest(current) !== original.selectorDigest) refuse("installed-selector-disagrees");
    return { disposition: pairs.digest(current) === original.selectorDigest ? "already-installed" : "advanced", receipt: original };
  }
  const runtime = legacyRuntime(runtimeRow.data());
  if (pairs.digest(runtime) !== input.expectedRuntimeDigest) refuse("legacy-runtime-changed");
  const selectedRef = firestore.doc(pairs.RENDERER_RECEIPT_PATH);
  const [oldRow, nextRow, proofRow, oldCandidate, selectedRow, ...components] = await tx.getAll(
    firestore.collection(pairs.PAIRS).doc(input.oldPairId), firestore.collection(pairs.PAIRS).doc(input.newPairId),
    firestore.collection(pairs.PROOFS).doc(input.proofDigest), firestore.collection("cmsDeploymentCandidates").doc(input.oldCandidateReceiptId),
    selectedRef, ...COMPONENTS.map(component => firestore.doc(`cmsDeploymentReceipts/${component}`)));
  const old = pairs.parsePair(oldRow.data()), next = pairs.parsePair(nextRow.data());
  if (old.pairId !== input.oldPairId || next.pairId !== input.newPairId || runtime.rendererSha !== old.rendererSha) refuse("current-renderer-changed");
  if (selectedRow.exists) refuse("selected-receipt-already-exists");
  components.forEach((row, index) => {
    const component = COMPONENTS[index], value = row.data();
    if (pairs.digest(value ?? null) !== input.expectedLegacyReceipts[component] || value?.schemaVersion !== 1 ||
        value.component !== component || value.state !== "complete" || !matches(SHA, value.mutation?.sourceSha) ||
        component === "renderer" && value.mutation.sourceSha !== runtime.rendererSha) refuse("legacy-component-not-complete");
  });
  const proof = pairs.parseProof(proofRow.data());
  if (pairs.digest(proof) !== input.proofDigest || proof.oldPairDigest !== pairs.digest(old) || proof.newPairDigest !== pairs.digest(next)) refuse("pair-proof-changed");
  const [newCandidate, functionsRow, apiRow, legacyJournal, oldJournal, nextJournal] = await tx.getAll(
    firestore.collection("cmsDeploymentCandidates").doc(proof.candidateReceiptId),
    firestore.collection(pairs.READER_RECEIPTS).doc("functions"), firestore.collection(pairs.READER_RECEIPTS).doc("cmsApi"),
    firestore.doc(`cmsPreviewSerializerJournals/${runtime.serializerId}`), firestore.doc(`cmsPreviewSerializerJournals/${old.serializerId}`),
    firestore.doc(`cmsPreviewSerializerJournals/${next.serializerId}`));
  const queue = await tx.get(firestore.collection("cmsPreviewQueue").where("transport", "==", "serializer")
    .where("status", "in", ["pending", "building"]).limit(1));
  if (!queue.empty) refuse("legacy-queue-not-drained");
  emptyJournal(legacyJournal, runtime.serializerId); emptyJournal(oldJournal, old.serializerId); emptyJournal(nextJournal, next.serializerId);
  const observed = await guard.assertCurrentInTransaction({ firestore, transaction: tx, request: input });
  if (observed !== guard.digest || observed !== input.installedConsumerDigest) refuse("installed-consumer-proof-changed");
  const now = clock();
  if (!Number.isSafeInteger(now) || !fresh(proof.verifiedAt, now)) refuse("pair-proof-expired");
  const oldMutation = candidate(oldCandidate.data(), old, input.oldCandidateReceiptId, now);
  const newMutation = candidate(newCandidate.data(), next, proof.candidateReceiptId, now);
  if (pairs.digest(newMutation.providerIdentities) !== proof.providerReadbackDigest) refuse("candidate-not-current");
  for (const [component, row] of [["functions", functionsRow], ["cmsApi", apiRow]]) {
    const reader = pairs.currentReader(row.data(), component);
    pairs.assertReaderSupports(reader, [old, next]);
    if (pairs.digest(reader) !== proof.readerDigests[component] || !fresh(reader.verifiedAt, now)) refuse("reader-proof-changed");
  }
  const selector = pairs.parseSelector({ schemaVersion: 2, phase: "ready", epoch: 1, selectedPairId: old.pairId,
    recoveryPairId: next.pairId, rendererSha: old.rendererSha, serializerId: old.serializerId });
  const selected = { schemaVersion: 2, component: "renderer", state: "complete", pairId: old.pairId,
    lastComplete: oldMutation, selectorDigest: pairs.digest(selector), proofDigest: input.proofDigest };
  if (!write) return { disposition: "ready-to-install", request: input, selector, selectedReceiptDigest: pairs.digest(selected) };
  signal?.throwIfAborted();
  const installed = { schemaVersion: 1, kind: "cms-preview-bootstrap", request: input, requestDigest: pairs.digest(input),
    selector, selectorDigest: pairs.digest(selector), selectedReceiptDigest: pairs.digest(selected), installedAt: new Date(now).toISOString() };
  tx.set(runtimeRef, selector); tx.create(selectedRef, selected); tx.create(opRef, installed);
  return { disposition: "installed", receipt: installed };
}
async function dryRunCmsPreviewBootstrap({ firestore, request: raw, prepareInstalledConsumers, clock = Date.now, signal }) {
  const input = request(raw);
  const before = await firestore.collection(RECEIPTS).doc(input.operationId).get();
  const guard = before.exists ? null : await preparedGuard(firestore, input, prepareInstalledConsumers, signal);
  signal?.throwIfAborted();
  return firestore.runTransaction(tx => inspect(firestore, tx, input, guard, clock, signal, false), { readOnly: true });
}
async function applyCmsPreviewBootstrap({ firestore, request: raw, prepareInstalledConsumers, clock = Date.now, signal }) {
  const input = request(raw), ref = firestore.collection(RECEIPTS).doc(input.operationId);
  const before = await ref.get();
  if (before.exists) return receipt(before.data(), input);
  signal?.throwIfAborted();
  const guard = await preparedGuard(firestore, input, prepareInstalledConsumers, signal);
  const outcome = await firestore.runTransaction(tx => inspect(firestore, tx, input, guard, clock, signal, true));
  return outcome.receipt;
}
async function planCmsPreviewBootstrap({ firestore, identity: raw, prepareInstalledConsumers, clock = Date.now, signal }) {
  const identity = identities(raw), op = await firestore.collection(RECEIPTS).doc(identity.operationId).get();
  if (op.exists) {
    const prior = receipt(op.data());
    if (Object.keys(identity).some(key => identity[key] !== prior.request[key])) refuse("receipt-conflict");
    return dryRunCmsPreviewBootstrap({ firestore, request: prior.request, clock, signal });
  }
  const rows = await firestore.getAll(firestore.doc(pairs.SELECTOR_PATH), ...COMPONENTS.map(component => firestore.doc(`cmsDeploymentReceipts/${component}`)));
  const base = { ...identity, expectedRuntimeDigest: pairs.digest(rows[0].data() ?? null),
    expectedLegacyReceipts: Object.fromEntries(COMPONENTS.map((key, i) => [key, pairs.digest(rows[i + 1].data() ?? null)])) };
  const guard = await preparedGuard(firestore, base, prepareInstalledConsumers, signal);
  const input = request({ ...base, installedConsumerDigest: guard.digest });
  signal?.throwIfAborted();
  return firestore.runTransaction(tx => inspect(firestore, tx, input, guard, clock, signal, false), { readOnly: true });
}
module.exports = { RECEIPTS, CmsPreviewBootstrapError, parseCmsPreviewBootstrapRequest: request,
  planCmsPreviewBootstrap, dryRunCmsPreviewBootstrap, applyCmsPreviewBootstrap };
