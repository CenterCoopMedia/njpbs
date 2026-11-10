"use strict";

const { randomUUID } = require("node:crypto");
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const inputs = require("./public-release-pair-input");
const same = (left, right) => p.publicReleaseDigest(left) === p.publicReleaseDigest(right);
const count = value => Number.isSafeInteger(value) && value >= 0;
function refuse() { throw new p.PublicReleaseProtocolError(); }
const coveragePath = pair => `${work.publicReleasePairPath(pair.pairId)}/mediaRetention/current`;
function markerPath(pair, digest) {
  if (!p.digest(digest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/mediaRetentionInputs/${digest}`;
}
function parseCoverage(value, pair) {
  p.exact(value, ["schemaVersion", "kind", "pairDigest", "ledgerId", "phase", "totalInputs", "pinnedInputs", "pendingInputs", "revision"]);
  if (value.schemaVersion !== 2 || value.kind !== "pair-media-input-coverage" || value.pairDigest !== p.publicReleaseDigest(pair) ||
      !p.digest(value.ledgerId) || !["tracking", "needs-migration"].includes(value.phase) ||
      ![value.totalInputs, value.pinnedInputs, value.pendingInputs, value.revision].every(count) ||
      value.pinnedInputs + value.pendingInputs !== value.totalInputs) refuse();
  return p.freeze(value);
}
function initialCoverage(pair, phase) {
  return parseCoverage({ schemaVersion: 2, kind: "pair-media-input-coverage", pairDigest: p.publicReleaseDigest(pair),
    ledgerId: p.publicReleaseDigest({ kind: "pair-media-ledger", pairDigest: p.publicReleaseDigest(pair), nonce: randomUUID() }),
    phase, totalInputs: 0, pinnedInputs: 0, pendingInputs: 0, revision: 0 }, pair);
}
function parseMarker(value, pair, receipt) {
  p.exact(value, ["schemaVersion", "kind", "pairDigest", "ledgerId", "inputManifestDigest", "inputReceiptDigest", "status", "pinDigest"]);
  if (value.schemaVersion !== 2 || value.kind !== "pair-media-input-coverage-member" || value.pairDigest !== p.publicReleaseDigest(pair) ||
      !p.digest(value.ledgerId) || value.inputManifestDigest !== receipt.inputManifestDigest || value.inputReceiptDigest !== p.publicReleaseDigest(receipt) ||
      !["pending", "pinned"].includes(value.status) ||
      (value.status === "pending" ? value.pinDigest !== null : !p.digest(value.pinDigest))) refuse();
  return p.freeze(value);
}
function markerFor(pair, receipt, ledgerId, pinDigest = null) {
  return parseMarker({ schemaVersion: 2, kind: "pair-media-input-coverage-member", pairDigest: p.publicReleaseDigest(pair),
    ledgerId, inputManifestDigest: receipt.inputManifestDigest, inputReceiptDigest: p.publicReleaseDigest(receipt),
    status: pinDigest === null ? "pending" : "pinned", pinDigest }, pair, receipt);
}
function checked(pair, firestore, receipt) {
  pair = p.parsePublicReleasePair(pair); work.assertPublicReleasePairDatabase(firestore, pair);
  return { pair, receipt: inputs.parsePublicReleasePairInputReceipt(receipt, pair, receipt.scope, receipt.inputManifestDigest) };
}
function writeState(transaction, row, state) {
  if (row.exists) transaction.set(row.ref, state); else transaction.create(row.ref, state);
}
function validateMemberCount(state, marker) {
  if (marker.status === "pending" ? state.pendingInputs < 1 : state.pinnedInputs < 1) refuse();
}

/** H's SDK owner calls this before writing its create-only input receipt. A
 * pending marker and counter commit with that exact receipt, never later. */
async function preparePairMediaInputCoverageInTransaction({ firestore, transaction, pair: rawPair, receipt: rawReceipt }) {
  const { pair, receipt } = checked(rawPair, firestore, rawReceipt);
  const [stateRow, markerRow, inputRow] = await transaction.getAll(firestore.doc(coveragePath(pair)),
    firestore.doc(markerPath(pair, receipt.inputManifestDigest)),
    firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputs/${receipt.inputManifestDigest}`));
  if (inputRow.exists && !same(inputRow.data(), receipt)) refuse();
  let state = stateRow.exists ? parseCoverage(stateRow.data(), pair) : null;
  const marker = markerRow.exists ? parseMarker(markerRow.data(), pair, receipt) : null;
  if (state && marker?.ledgerId === state.ledgerId) {
    // The original scope may restore a lost receipt. This ledger already
    // accounts for its exact H, so restoration must never count it twice.
    validateMemberCount(state, marker);
    return () => {};
  }
  if (!state) {
    const existing = await transaction.get(firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/inputs`).limit(1));
    state = initialCoverage(pair, existing.empty && !marker ? "tracking" : "needs-migration");
  }
  const pinned = marker?.status === "pinned";
  const next = parseCoverage({ ...state, phase: inputRow.exists || marker ? "needs-migration" : state.phase,
    totalInputs: state.totalInputs + 1, pinnedInputs: state.pinnedInputs + (pinned ? 1 : 0),
    pendingInputs: state.pendingInputs + (pinned ? 0 : 1), revision: state.revision + 1 }, pair);
  const enrolled = markerFor(pair, receipt, state.ledgerId, pinned ? marker.pinDigest : null);
  return () => { if (markerRow.exists) transaction.set(markerRow.ref, enrolled); else transaction.create(markerRow.ref, enrolled);
    writeState(transaction, stateRow, next); };
}

/** Called only by the actual H pin issuer, inside the pin/chunk transaction.
 * This accounting is not a substitute for that issuer's immutable byte proof. */
async function preparePairMediaPinCoverageInTransaction({ firestore, transaction, pair: rawPair, receipt: rawReceipt, pinDigest }) {
  const { pair, receipt } = checked(rawPair, firestore, rawReceipt);
  if (!p.digest(pinDigest)) refuse();
  const [stateRow, markerRow, inputRow] = await transaction.getAll(firestore.doc(coveragePath(pair)),
    firestore.doc(markerPath(pair, receipt.inputManifestDigest)),
    firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputs/${receipt.inputManifestDigest}`));
  if (!inputRow.exists || !same(inputRow.data(), receipt)) refuse();
  const state = stateRow.exists ? parseCoverage(stateRow.data(), pair) : initialCoverage(pair, "needs-migration");
  const marker = markerRow.exists ? parseMarker(markerRow.data(), pair, receipt) : null;
  const accounted = marker?.ledgerId === state.ledgerId;
  if (accounted) validateMemberCount(state, marker);
  if (accounted && marker.status === "pinned") {
    if (marker.pinDigest !== pinDigest) refuse();
    return () => {};
  }
  if (marker?.status === "pinned" && marker.pinDigest !== pinDigest) refuse();
  const next = parseCoverage({ ...state, phase: accounted ? state.phase : "needs-migration",
    totalInputs: state.totalInputs + (accounted ? 0 : 1), pinnedInputs: state.pinnedInputs + 1,
    pendingInputs: state.pendingInputs - (accounted ? 1 : 0), revision: state.revision + 1 }, pair);
  const pinned = markerFor(pair, receipt, state.ledgerId, pinDigest);
  return () => { if (markerRow.exists) transaction.set(markerRow.ref, pinned); else transaction.create(markerRow.ref, pinned);
    writeState(transaction, stateRow, next); };
}

/** Explicit private initialization. An existing history is always unknown
 * until the separate migration owner proves every original input and pin. */
async function initializePublicReleasePairMediaCoverage({ firestore, pair: rawPair }) {
  const pair = p.parsePublicReleasePair(rawPair); work.assertPublicReleasePairDatabase(firestore, pair);
  return firestore.runTransaction(async transaction => {
    const [registered, row] = await transaction.getAll(firestore.doc(work.publicReleasePairPath(pair.pairId)), firestore.doc(coveragePath(pair)));
    if (!same(p.parsePublicReleasePair(registered.data()), pair)) refuse();
    if (row.exists) return parseCoverage(row.data(), pair);
    const existing = await transaction.get(firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/inputs`).limit(1));
    const state = initialCoverage(pair, existing.empty ? "tracking" : "needs-migration");
    transaction.create(row.ref, state); return state;
  });
}
async function assertPairMediaCoverageInTransaction({ firestore, transaction, pair }) {
  const state = parseCoverage((await transaction.get(firestore.doc(coveragePath(pair)))).data(), pair);
  if (state.phase !== "tracking" || state.pendingInputs !== 0) refuse();
  return state;
}
module.exports = { coveragePath, markerPath, parseCoverage, parseMarker, preparePairMediaInputCoverageInTransaction,
  preparePairMediaPinCoverageInTransaction, initializePublicReleasePairMediaCoverage, assertPairMediaCoverageInTransaction };
