"use strict";

const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const inputs = require("./public-release-pair-input");
const coverage = require("./public-release-media-coverage");
const replay = require("./public-release-pair-replay");
const capsules = require("./public-release-pair-replay-capsule");
const { parseContentHead } = require("./public-release-content-activation");
const { parsePairMedia } = require("./public-release-pair-media");
const { assertAssetId } = require("./media-contract");
const STATE = "pair-retained-v2", PIN_BYTES_LIMIT = 768 * 1024;
const MEDIA_RETENTION_READ_LIMIT = 500;
const same = (left, right) => p.publicReleaseDigest(left) === p.publicReleaseDigest(right);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function assetIds(raw, maximum) {
  if (!Array.isArray(raw) || raw.length > maximum) refuse();
  raw.forEach((id, index) => { assertAssetId(id); if (index && id <= raw[index - 1]) refuse(); });
  return raw;
}
function pinPath(pair, inputManifestDigest) {
  if (!p.digest(inputManifestDigest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/mediaUsage/pin-${inputManifestDigest}`;
}
function parsePairMediaChunk(value) {
  p.exact(value, ["schemaVersion", "kind", "state", "pairDigest", "inputManifestDigest", "sourceMetadataDigest", "assetIds"]);
  if (value.schemaVersion !== 2 || value.kind !== "pair-media-retention-chunk" || value.state !== STATE ||
      ![value.pairDigest, value.inputManifestDigest, value.sourceMetadataDigest].every(p.digest) || !value.assetIds?.length) refuse();
  assetIds(value.assetIds, 100); return p.freeze(value);
}
function chunksForPin(pin) {
  const chunks = [];
  for (let start = 0; start < pin.assetIds.length; start += 100) chunks.push(parsePairMediaChunk({ schemaVersion: 2,
    kind: "pair-media-retention-chunk", state: STATE, pairDigest: pin.pairDigest,
    inputManifestDigest: pin.inputManifestDigest, sourceMetadataDigest: pin.sourceMetadataDigest, assetIds: pin.assetIds.slice(start, start + 100) }));
  return chunks;
}
function parsePairMediaPin(value, pair) {
  p.exact(value, ["schemaVersion", "kind", "state", "pairDigest", "inputManifestDigest", "inputReceiptDigest", "scope",
    "sourceMetadataDigest", "assetIdsDigest", "assetIds", "chunks"]);
  if (value.schemaVersion !== 2 || value.kind !== "pair-media-retention" || value.state !== STATE ||
      value.pairDigest !== p.publicReleaseDigest(pair) ||
      ![value.inputManifestDigest, value.inputReceiptDigest, value.sourceMetadataDigest, value.assetIdsDigest].every(p.digest)) refuse();
  inputs.parsePublicReleasePairInputScope(value.scope);
  assetIds(value.assetIds, 5_000);
  if (value.assetIdsDigest !== p.publicReleaseDigest(value.assetIds) || !Array.isArray(value.chunks) ||
      !same(value.chunks, chunksForPin(value).map(chunk => p.publicReleaseDigest(chunk))) ||
      Buffer.byteLength(JSON.stringify(value)) > PIN_BYTES_LIMIT) refuse();
  return p.freeze(value);
}
function buildPairMediaPin({ pair, receipt, sourceMetadataDigest, assetIds: ids }) {
  const pin = { schemaVersion: 2, kind: "pair-media-retention", state: STATE, pairDigest: p.publicReleaseDigest(pair),
    inputManifestDigest: receipt.inputManifestDigest, inputReceiptDigest: p.publicReleaseDigest(receipt), scope: receipt.scope,
    sourceMetadataDigest, assetIdsDigest: p.publicReleaseDigest(ids), assetIds: [...ids] };
  return parsePairMediaPin({ ...pin, chunks: chunksForPin(pin).map(chunk => p.publicReleaseDigest(chunk)) }, pair);
}

function boundedReads(original) {
  let reads = 0;
  const charge = count => { reads += count; if (reads > MEDIA_RETENTION_READ_LIMIT) refuse(); };
  return { remaining: () => MEDIA_RETENTION_READ_LIMIT - reads, transaction: {
    async get(reference) {
      if (reads >= MEDIA_RETENTION_READ_LIMIT) refuse();
      const row = await original.get(reference);
      charge(Array.isArray(row.docs) ? Math.max(1, row.size) : 1); return row;
    },
    async getAll(...references) {
      charge(references.length); return original.getAll(...references);
    },
  } };
}

async function registeredInputPins({ firestore, transaction }) {
  const registry = (await transaction.get(firestore.doc(work.PAIRS))).data();
  p.exact(registry, ["schemaVersion", "pairIds"]);
  if (registry.schemaVersion !== 2 || !Array.isArray(registry.pairIds) || registry.pairIds.length > 8 ||
      new Set(registry.pairIds).size !== registry.pairIds.length) refuse();
  const registered = new Map();
  for (const pairId of registry.pairIds) {
    const pair = p.parsePublicReleasePair((await transaction.get(firestore.doc(work.publicReleasePairPath(pairId)))).data());
    if (pair.pairId !== pairId) refuse();
    work.assertPublicReleasePairDatabase(firestore, pair);
    registered.set(pairId, pair);
    const state = await coverage.assertPairMediaCoverageInTransaction({ firestore, transaction, pair });
    if (state.totalInputs) {
      // CODE H is a distinct retained input, even after later source H exists.
      const base = work.publicReleasePairPath(pairId), code = (await transaction.get(firestore.doc(`${base}/codePacks/baseline`))).data();
      if (code?.schemaVersion !== 1 || code.kind !== "pair-code-pack-baseline" || code.pairDigest !== p.publicReleaseDigest(pair) ||
          code.commitSha !== pair.commitSha || code.codeAssetManifestDigest !== pair.codeAssetManifestDigest || !p.digest(code.inputManifestDigest)) refuse();
      const [inputRow, pinRow] = await transaction.getAll(firestore.doc(`${base}/inputs/${code.inputManifestDigest}`),
        firestore.doc(pinPath(pair, code.inputManifestDigest)));
      const raw = inputRow.data(), receipt = inputs.parsePublicReleasePairInputReceipt(raw, pair, raw?.scope, code.inputManifestDigest);
      const pin = parsePairMediaPin(pinRow.data(), pair);
      if (pin.inputManifestDigest !== code.inputManifestDigest || pin.inputReceiptDigest !== p.publicReleaseDigest(receipt) || !same(pin.scope, receipt.scope)) refuse();
    }
  }
  return registered;
}

/** Bootstrap/repair readiness assertion, never a serialized GC permission.
 * Consumers call the actual owner in their SDK transaction. */
async function assertPublicReleasePairMediaPinsInTransaction({ firestore, transaction }) {
  const bounded = boundedReads(transaction);
  await registeredInputPins({ firestore, transaction: bounded.transaction });
}

/** Schema two only. A positive retained row protects even a no-longer-current
 * H. An absence is usable only with actual head pins and no capture gap. No
 * retirement or pruning is inferred from a changed generation. */
async function readRetainedPairMediaHoldInTransaction({ firestore, transaction, root, assetId }) {
  if (root == null || root.schemaVersion === 1) return null;
  if (root.schemaVersion !== 2) return "pair-retention-unproven";
  try {
    const bounded = boundedReads(transaction);
    transaction = bounded.transaction;
    const selector = p.parseStoredPublicReleaseSelector(root);
    const retained = await transaction.get(firestore.collectionGroup("mediaUsage").where("state", "==", STATE)
      .where("assetIds", "array-contains", assetId).limit(1));
    if (!retained.empty) {
      const row = retained.docs[0], value = row.data();
      if (value.kind === "pair-media-retention-chunk") parsePairMediaChunk(value);
      else {
        const parent = row.ref.parent.parent;
        const pair = p.parsePublicReleasePair((await transaction.get(parent)).data());
        parsePairMediaPin(value, pair);
      }
      return "pair-retained";
    }
    const gaps = await transaction.get(firestore.collection("system/publicReleaseChanges/captures")
      .where("status", "in", ["pending", "failed"]).limit(1));
    if (!gaps.empty) return "capture-gap";
    const media = parsePairMedia((await transaction.get(firestore.doc("system/publicDeployment/pairMedia/current"))).data(), selector);
    const registered = await registeredInputPins({ firestore, transaction });
    if (media.references.some(ref => !registered.has(ref.pairId))) refuse();
    for (const reference of media.references) {
      const base = work.publicReleasePairPath(reference.pairId), pair = registered.get(reference.pairId);
      for (const selected of [selector.selectedPair, selector.recoveryPair]) {
        if (selected.pairId === pair.pairId && !same(selected, p.publicReleasePairReference(pair))) refuse();
      }
      const head = parseContentHead((await transaction.get(firestore.doc(`${base}/heads/current`))).data(), pair);
      if (head.contentHead.manifestDigest !== reference.manifestDigest ||
          pair.pairId === selector.selectedPair.pairId && !same(head.contentHead, selector.contentHead)) refuse();
      const witness = replay.parseReplayWitness((await transaction.get(firestore.doc(`${base}/replayWitnesses/${head.contentHead.viewId}`))).data(), pair);
      if (p.publicReleaseDigest(witness) !== head.contentHead.viewId || witness.contentViewDigest !== head.contentHead.manifestDigest ||
          witness.headCursor.sequence !== head.contentHead.contextSequence) refuse();
      const certified = await capsules.readReplayCapsule({ firestore, transaction, pair, capsuleDigest: witness.capsuleDigest, accepted: true });
      const view = replay.parseReplayViewReference(certified.evidence.lastView, pair);
      if (!same(certified.evidence.state.cursor, witness.headCursor) || certified.evidence.state.contentViewDigest !== witness.contentViewDigest ||
          view.identity.contextSequence !== witness.headCursor.sequence) refuse();
      const [pinRow, inputRow] = await transaction.getAll(firestore.doc(pinPath(pair, view.identity.inputManifestDigest)),
        firestore.doc(`${base}/inputs/${view.identity.inputManifestDigest}`));
      const pin = parsePairMediaPin(pinRow.data(), pair), scope = inputs.parsePublicReleasePairInputScope({
        kind: view.identity.kind, sourceOperationId: view.identity.sourceOperationId, sourceVersion: view.identity.sourceVersion,
        snapshotDigest: view.identity.snapshotDigest, contextSequence: view.identity.contextSequence });
      const input = inputs.parsePublicReleasePairInputReceipt(inputRow.data(), pair, scope, view.identity.inputManifestDigest);
      if (pin.inputManifestDigest !== input.inputManifestDigest || pin.inputReceiptDigest !== p.publicReleaseDigest(input) || !same(pin.scope, scope)) refuse();
      if (pin.assetIds.includes(assetId)) return "pair-retained";
    }
    return null;
  } catch {
    // Missing/corrupt protocol evidence cannot turn a negative index lookup
    // into deletion permission. Transient SDK failures also leave work held.
    return "pair-retention-unproven";
  }
}
module.exports = { STATE, PIN_BYTES_LIMIT, MEDIA_RETENTION_READ_LIMIT, pinPath, parsePairMediaPin, parsePairMediaChunk,
  buildPairMediaPin, chunksForPin, assertPublicReleasePairMediaPinsInTransaction, readRetainedPairMediaHoldInTransaction };
