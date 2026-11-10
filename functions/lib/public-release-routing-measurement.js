"use strict";
const { parseStoredPublicReleaseSelector, PublicReleaseProtocolError } = require("./public-release-pair");
const { assertPublicationDatabase, publicationTarget } = require("./publication-target");
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const ROOT = "system/publicReleaseRoutingMeasurements";
const validId = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? "");
const refuse = () => { throw new PublicReleaseProtocolError(); };
/** Private M28 bridge only: a real, strongly consistent single-document read
 * with the production parser. Never shares or mutates the dev live selector.
 * No route, transport, credential, provisioning or enablement is provided. */
async function readPrivateRoutingMeasurementSelector({ firestore, measurementId, now = Date.now }) {
  assertPublicationDatabase(firestore, publicationTarget("development"));
  if (!validId(measurementId)) refuse();
  const readStartedAt = now();
  const selector = parseStoredPublicReleaseSelector((await firestore.doc(`system/publicReleaseRoutingMeasurements/selectors/${measurementId}`).get()).data());
  // Pair references carry no environment; the real router matches them to
  // its fixed development slot identities before using any response.
  return { environment: "development", selector, readStartedAt };
}
/** Create-only isolated copy of an ACTUAL accepted development root, with its
 * actual retained pair registry and source receipt in the same transaction.
 * This never fabricates a pair or converts/enables the shared selector. */
async function createPrivateRoutingMeasurementSelector({ firestore, measurementId, expectedSourceDigest, dryRun = true }) {
  assertPublicationDatabase(firestore, publicationTarget("development"));
  if (!validId(measurementId) || !p.digest(expectedSourceDigest) || typeof dryRun !== "boolean") refuse();
  const selectorRef = firestore.doc(`${ROOT}/selectors/${measurementId}`), receiptRef = firestore.doc(`${ROOT}/receipts/${measurementId}`);
  return firestore.runTransaction(async transaction => {
    const [root, stored, receiptRow] = await transaction.getAll(firestore.doc("system/publicDeployment"), selectorRef, receiptRef);
    if (stored.exists || receiptRow.exists) {
      const receipt = receiptRow.data();
      if (!stored.exists || !receipt || receipt.schemaVersion !== 1 || receipt.kind !== "routing-measurement-source" ||
          receipt.measurementId !== measurementId || receipt.sourceDigest !== expectedSourceDigest ||
          receipt.selectorDigest !== p.publicReleaseDigest(parseStoredPublicReleaseSelector(stored.data())) ||
          receipt.selectorDigest !== p.publicReleaseDigest(receipt.selector)) refuse();
      return { dryRun, idempotent: true, measurementId, receipt };
    }
    const selector = parseStoredPublicReleaseSelector(root.data());
    if (selector.state !== "idle" || p.publicReleaseDigest(root.data()) !== expectedSourceDigest) refuse();
    const refs = [selector.selectedPair, selector.recoveryPair];
    const rows = await transaction.getAll(...refs.flatMap(ref => { const path = work.publicReleasePairPath(ref.pairId);
      return [firestore.doc(path), firestore.doc(`${path}/controls/runtime`), firestore.doc(`${path}/heads/current`)]; }));
    const pairs = refs.map((ref, index) => {
      const [pairRow, control, head] = rows.slice(index * 3, index * 3 + 3).map(row => row.data());
      const pair = p.parsePublicReleasePair(pairRow); work.assertPrivatePairResources(pair);
      if (pair.environment !== "development" || p.publicReleaseDigest(p.publicReleasePairReference(pair)) !== p.publicReleaseDigest(ref) ||
          control?.schemaVersion !== 2 || control.pairId !== pair.pairId || control.status !== "retained" ||
          head?.schemaVersion !== 2 || head.pairDigest !== p.publicReleaseDigest(pair) || head.contentHead?.pairId !== pair.pairId ||
          index === 0 && p.publicReleaseDigest(head.contentHead) !== p.publicReleaseDigest(selector.contentHead)) refuse();
      return { pair, control, head };
    });
    const receipt = { schemaVersion: 1, kind: "routing-measurement-source", measurementId, sourceDigest: expectedSourceDigest,
      selectorDigest: p.publicReleaseDigest(selector), selector, pairs };
    if (!dryRun) { transaction.create(selectorRef, selector); transaction.create(receiptRef, receipt); }
    return { dryRun, idempotent: false, measurementId, receipt };
  }, dryRun ? { readOnly: true } : undefined);
}
module.exports = { readPrivateRoutingMeasurementSelector, createPrivateRoutingMeasurementSelector };
