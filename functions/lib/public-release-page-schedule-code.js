"use strict";

const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const code = require("./public-release-pair-code-reference");
const historical = require("./public-release-historical-code");
const { parseStoredSelector } = require("./public-release-media-fence");
function refuse() { throw new p.PublicReleaseProtocolError(); }
const same = (left, right) => p.publicReleaseDigest(left) === p.publicReleaseDigest(right);

/** Actual selected-pair CODE authority. Its original legacy-qualified DTO is
 * retained byte-for-byte; the current selector is a separate authority seal. */
async function readPairScheduleCodeInTransaction({ firestore, transaction, selector: raw, rendererSha, reference, environment }) {
  const selector = parseStoredSelector(raw), base = work.publicReleasePairPath(selector.selectedPair.pairId);
  if (selector.activeCommitSha !== rendererSha) refuse();
  const [publicationRow, runtimeRow] = await transaction.getAll(firestore.doc(`${base}/codePacks/publication`),
    firestore.doc(`${base}/controls/runtime`));
  const resolved = await code.assertPairCodeReferenceInTransaction({ firestore, transaction, reference: publicationRow.data()?.reference });
  if (resolved.pair.environment !== environment || !same(selector.selectedPair, p.publicReleasePairReference(resolved.pair)) || runtimeRow.data()?.schemaVersion !== 2 ||
      runtimeRow.data().pairId !== resolved.pair.pairId || runtimeRow.data().status !== "retained" ||
      reference !== undefined && !same(reference, resolved.publication.historicalCode.reference)) refuse();
  return { selector, pairCodeReference: resolved.reference, descriptor: resolved.publication.historicalCode };
}

function createPairScheduleCodeContextReader({ firestore, rendererSha, releaseSelector, signal, environment }) {
  const expected = parseStoredSelector(releaseSelector);
  if (expected.activeCommitSha !== rendererSha) refuse();
  const authority = () => firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const actual = parseStoredSelector((await transaction.get(firestore.doc("system/publicDeployment"))).data());
    if (!same(actual, expected)) refuse();
    return readPairScheduleCodeInTransaction({ firestore, transaction, selector: actual, rendererSha, environment });
  }, { readOnly: true });
  const read = async () => {
    const before = await authority();
    const qualified = await historical.readRetainedPublicReleaseCode({ firestore, descriptor: before.descriptor });
    const after = await authority();
    if (!same(before, after) || !same(qualified.reference, after.descriptor.reference)) refuse();
    signal?.throwIfAborted();
    return qualified;
  };
  read.readHistoricalCodeContext = read;
  read.readReference = async () => { const selected = await authority(); return selected.descriptor.reference; };
  return read;
}
module.exports = { readPairScheduleCodeInTransaction, createPairScheduleCodeContextReader };
