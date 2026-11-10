"use strict";

// Schema two is an adoption boundary. No caller creates the first selector.
// Candidate work never writes the selected runtime or a public release record.
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const SELECTOR_PATH = "system/cmsPreviewRuntime";
const RENDERER_RECEIPT_PATH = "cmsPreviewSelectedReceipts/renderer";
const READER_RECEIPTS = "cmsReaderCompatibilityReceipts";
const PAIRS = "cmsPreviewPairs";
const PROOFS = "cmsPreviewPairProofs";
const SWITCHES = "cmsPreviewPairSwitches";
const CONTRACT_KEYS = Object.freeze(["previewRequest", "postChrome", "settings", "capabilities", "adminSession"]);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^preview-[a-z0-9][a-z0-9-]{0,31}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = () => { throw new Error("CMS preview pair contract is invalid"); };
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const object = value => value && typeof value === "object" && !Array.isArray(value);
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) {
  return createHash("sha256").update("njpbs-cms-preview-pair-v2\n").update(JSON.stringify(canonical(value))).digest("hex");
}
function contracts(value, reader = false) {
  exact(value, CONTRACT_KEYS);
  for (const key of CONTRACT_KEYS) {
    const versions = reader ? value[key] : [value[key]];
    if (!Array.isArray(versions) || versions.length < 1 || versions.length > 4 ||
        versions.some((v, i) => !Number.isSafeInteger(v) || v < 1 || v > 100 || (i && v <= versions[i - 1]))) fail();
  }
  return value;
}
function parsePair(value) {
  exact(value, ["schemaVersion", "pairId", "rendererSha", "serializerId", "workerName", "applicationName",
    "workerVersion", "imageDigest", "requirements", "capabilities"]);
  const name = `njpbs-${value.pairId}`;
  if (value.schemaVersion !== 2 || !matches(ID, value.pairId) || !matches(SHA, value.rendererSha) ||
      value.serializerId !== value.pairId || value.workerName !== name || value.applicationName !== name ||
      !matches(UUID, value.workerVersion) || !(typeof value.imageDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.imageDigest))) fail();
  contracts(value.requirements);
  exact(value.capabilities, ["dataHubCompositionVersion", "liveBlogVersion", "electionResultsVersion"]);
  if (Object.entries(value.capabilities).some(([key, v]) => key === "electionResultsVersion" ? ![1, 2].includes(v) : v !== 1)) fail();
  return value;
}
function parseSelector(value) {
  exact(value, ["schemaVersion", "phase", "epoch", "selectedPairId", "recoveryPairId", "rendererSha", "serializerId"]);
  if (value.schemaVersion !== 2 || value.phase !== "ready" || !Number.isSafeInteger(value.epoch) || value.epoch < 1 ||
      !matches(ID, value.selectedPairId) || !matches(ID, value.recoveryPairId) || value.selectedPairId === value.recoveryPairId ||
      !matches(SHA, value.rendererSha) || value.serializerId !== value.selectedPairId) fail();
  return value;
}
function assertProjection(selector, pair) {
  parseSelector(selector); parsePair(pair);
  if (selector.selectedPairId !== pair.pairId || selector.rendererSha !== pair.rendererSha || selector.serializerId !== pair.serializerId) fail();
}
function parseReader(value) {
  exact(value, ["schemaVersion", "component", "sourceSha", "inputFingerprint", "configurationFingerprint",
    "providerIdentities", "supported", "verifiedAt"]);
  if (value.schemaVersion !== 2 || !["functions", "cmsApi"].includes(value.component) || !matches(SHA, value.sourceSha) ||
      !matches(DIGEST, value.inputFingerprint) || !matches(DIGEST, value.configurationFingerprint) ||
      !object(value.providerIdentities) || Object.keys(value.providerIdentities).length < 1 ||
      Object.keys(value.providerIdentities).length > 20 ||
      Object.entries(value.providerIdentities).some(([k, v]) => !/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k) ||
        typeof v !== "string" || !/^[A-Za-z0-9._:/@-]{1,300}$/.test(v)) ||
      !instant(value.verifiedAt)) fail();
  contracts(value.supported, true);
  return value;
}
function assertReaderSupports(reader, pairs) {
  parseReader(reader);
  for (const pair of pairs) {
    parsePair(pair);
    if (CONTRACT_KEYS.some(key => !reader.supported[key].includes(pair.requirements[key]))) {
      throw new Error("Deployed CMS reader does not support both retained preview contracts");
    }
  }
}
function currentReader(receipt, component) {
  // An unfinished candidate cannot replace the last verified live reader.
  if (receipt?.schemaVersion !== 2 || receipt.component !== component || receipt.state !== "complete") fail();
  const reader = parseReader(receipt.lastComplete);
  if (reader.component !== component) fail();
  return reader;
}
async function registerPair(firestore, input) {
  const pair = parsePair(input);
  const ref = firestore.collection(PAIRS).doc(pair.pairId);
  return firestore.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      if (!isDeepStrictEqual(existing.data(), pair)) fail();
      return { changed: false, pair };
    }
    tx.create(ref, pair);
    return { changed: true, pair };
  });
}
function parseProof(value) {
  exact(value, ["schemaVersion", "oldPairDigest", "newPairDigest", "readerDigests", "replays", "candidateReceiptId", "providerReadbackDigest", "savedInputsDigest", "verifiedAt"]);
  if (value.schemaVersion !== 2 || !matches(DIGEST, value.oldPairDigest) || !matches(DIGEST, value.newPairDigest) ||
      !(typeof value.candidateReceiptId === "string" && /^renderer-[0-9]{1,20}-[0-9]{1,4}$/.test(value.candidateReceiptId)) ||
      !matches(DIGEST, value.providerReadbackDigest) || !matches(DIGEST, value.savedInputsDigest) || !instant(value.verifiedAt)) fail();
  exact(value.readerDigests, ["functions", "cmsApi"]);
  exact(value.replays, ["functionsOld", "functionsNew", "cmsApiOld", "cmsApiNew"]);
  if ([...Object.values(value.readerDigests), ...Object.values(value.replays)].some(v => !matches(DIGEST, v))) fail();
  return value;
}
async function recordProof(firestore, value) {
  const proof = parseProof(value);
  const proofDigest = digest(proof);
  const ref = firestore.collection(PROOFS).doc(proofDigest);
  await firestore.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) {
      if (!isDeepStrictEqual(snapshot.data(), proof)) fail();
    } else tx.create(ref, proof);
  });
  return proofDigest;
}
async function selectPair(firestore, { operationId, expectedSelectorDigest, newPairId, proofDigest, signal }, now, { assertCurrentInTransaction } = {}) {
  signal?.throwIfAborted();
  if (!matches(ID, operationId) || !matches(ID, newPairId) || !matches(DIGEST, expectedSelectorDigest) || !matches(DIGEST, proofDigest) ||
      now !== undefined && (!Number.isSafeInteger(now) || now < 0)) fail();
  if (assertCurrentInTransaction !== undefined && typeof assertCurrentInTransaction !== "function") fail();
  const selectorRef = firestore.doc(SELECTOR_PATH);
  const receiptRef = firestore.collection(SWITCHES).doc(operationId);
  const request = { operationId, expectedSelectorDigest, newPairId, proofDigest };
  return firestore.runTransaction(async tx => {
    const receipt = await tx.get(receiptRef);
    if (receipt.exists) {
      if (!isDeepStrictEqual(receipt.data().request, request)) fail();
      return receipt.data();
    }
    const selectorRow = await tx.get(selectorRef), selector = parseSelector(selectorRow.data());
    // The real operator uses the database's observation time. Only explicit
    // SDK/test callers supply a clock, never a JSON request field.
    const at = now ?? selectorRow.readTime.toMillis();
    if (digest(selector) !== expectedSelectorDigest || selector.selectedPairId === newPairId) {
      throw new Error("CMS preview selector changed before selection");
    }
    const replacingRecovery = selector.recoveryPairId !== newPairId;
    const [oldRow, newRow, proofRow, functionsRow, apiRow, rendererRow] = await tx.getAll(
      firestore.collection(PAIRS).doc(selector.selectedPairId), firestore.collection(PAIRS).doc(newPairId),
      firestore.collection(PROOFS).doc(proofDigest), firestore.collection(READER_RECEIPTS).doc("functions"),
      firestore.collection(READER_RECEIPTS).doc("cmsApi"), firestore.doc(RENDERER_RECEIPT_PATH));
    const oldPair = parsePair(oldRow.data()), newPair = parsePair(newRow.data());
    const closures = require("./cms-preview-pair-reader-closure");
    const closedTarget = await tx.get(firestore.collection(closures.COLLECTION).doc(newPairId));
    if (closedTarget.exists) { closures.parseClosure(closedTarget.data(), newPair); throw new Error("Closed preview incarnation cannot be selected again"); }
    assertProjection(selector, oldPair);
    // The selected receipt has its own namespace. Legacy component receipts
    // remain unchanged; only the explicit schema-two operator reads this one.
    const renderer = rendererRow.data();
    if (!renderer || renderer.schemaVersion !== 2 || renderer.state !== "complete" ||
        renderer.lastComplete?.sourceSha !== oldPair.rendererSha ||
        renderer.pairId !== oldPair.pairId || renderer.selectorDigest !== digest(selector)) fail();
    const proof = parseProof(proofRow.data());
    if (digest(proof) !== proofDigest || proof.oldPairDigest !== digest(oldPair) || proof.newPairDigest !== digest(newPair) ||
        at < Date.parse(proof.verifiedAt) || at - Date.parse(proof.verifiedAt) > 5 * 60_000) fail();
    const candidate = (await tx.get(firestore.collection("cmsDeploymentCandidates").doc(proof.candidateReceiptId))).data();
    if (candidate?.schemaVersion !== 2 || candidate.component !== "renderer" || candidate.state !== "verified" ||
        candidate.mutation?.sourceSha !== newPair.rendererSha ||
        !instant(candidate.mutation.completedAt) || at < Date.parse(candidate.mutation.completedAt) ||
        at - Date.parse(candidate.mutation.completedAt) > 5 * 60_000 ||
        digest(candidate.mutation.providerIdentities) !== proof.providerReadbackDigest ||
        ["pairId", "rendererSha", "serializerId", "workerName", "applicationName", "workerVersion", "imageDigest"]
          .some(key => candidate.mutation.providerIdentities[key] !== newPair[key])) fail();
    for (const [component, row] of [["functions", functionsRow], ["cmsApi", apiRow]]) {
      const reader = currentReader(row.data(), component);
      assertReaderSupports(reader, [oldPair, newPair]);
      if (proof.readerDigests[component] !== digest(reader) || at < Date.parse(reader.verifiedAt) ||
          at - Date.parse(reader.verifiedAt) > 5 * 60_000) fail();
    }
    const retirement = replacingRecovery ? await require("./cms-preview-pair-retirement").prepareRecoveryReplacementInTransaction({
      firestore, transaction: tx, selector, candidatePair: newPair, now: at }) : null;
    // The explicit paired operator binds its installed reader/source guard
    // to this same CAS; existing proof, retirement and abort guards still run.
    if (assertCurrentInTransaction) await assertCurrentInTransaction({ firestore, transaction: tx });
    const next = { ...selector, epoch: selector.epoch + 1, selectedPairId: newPairId,
      recoveryPairId: oldPair.pairId, rendererSha: newPair.rendererSha, serializerId: newPair.serializerId };
    parseSelector(next);
    const result = { schemaVersion: 2, request, selector: next, selectedAt: new Date(at).toISOString(), ...(retirement ? { retirement } : {}) };
    signal?.throwIfAborted();
    if (retirement) tx.set(firestore.collection("cmsPreviewSerializerJournals").doc(retirement.pairId), retirement.retiredJournal);
    tx.set(selectorRef, next);
    tx.set(firestore.doc(RENDERER_RECEIPT_PATH), {
      schemaVersion: 2, component: "renderer", state: "complete", pairId: newPairId,
      lastComplete: candidate.mutation, selectorDigest: digest(next), proofDigest,
    });
    tx.create(receiptRef, result);
    return result;
  });
}

module.exports = { SELECTOR_PATH, RENDERER_RECEIPT_PATH, READER_RECEIPTS, PAIRS, PROOFS, SWITCHES, CONTRACT_KEYS, digest, parsePair, parseSelector,
  assertProjection, parseReader, assertReaderSupports, currentReader, registerPair, parseProof, recordProof, selectPair };
