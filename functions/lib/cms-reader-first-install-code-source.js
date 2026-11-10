"use strict";

const p = require("./public-release-pair");
const preview = require("./cms-preview-pair-candidate");
const cms = require("./cms-preview-pair");
const { readPairCodeReplaySource, readPairCodeAuthority } = require("./pair-current-code-source");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new Error("First-install preview CODE source is unavailable"); }

/** The existing preview consumer's legacy-root binding, not a NEW public
 * source or a saved-preview queue. The original runtime owner checks candidate
 * freshness/identity and retention; the original pointer selects bootstrap CODE. */
async function readBinding({ firestore, transaction, consumer, now }) {
  const read = async path => (await transaction.get(firestore.doc(path))).data();
  const authority = await preview.readPreviewPairRuntimeAuthority({ read,
    pairId: consumer.previewPairId, rendererSha: consumer.rendererSha, workerVersion: consumer.workerVersion, now });
  const root = p.parseVersionedPublicDeployment(await read("system/publicDeployment"));
  if (root.schemaVersion !== 1 || root.state !== "idle") refuse();
  // As in readPreviewPairContextAuthority, retention outlives the candidate's
  // health lease but preserves its original public OLD bootstrap pointer.
  const pointer = await read(`${preview.POINTERS}/${authority.pair.pairId}`);
  if (pointer?.schemaVersion !== 1 || pointer.pairId !== authority.pair.pairId ||
      pointer.pairDigest !== cms.digest(authority.pair)) refuse();
  const source = p.parsePublicReleasePairReference(pointer.bootstrapPublicPair);
  if (source.commitSha !== root.activeCommitSha || authority.mode === "candidate" && !same(source, authority.bootstrapPublicPair)) refuse();
  return { authority, pointer, request: { schemaVersion: 2, mode: "current-code-v2", rendererSha: consumer.rendererSha,
    selection: { pair: source, expectedPublicSelectorDigest: p.publicReleaseDigest(root),
      previewPairId: authority.pair.pairId, previewCandidateReceiptId: authority.candidateReceiptId } } };
}

/** Read-only CODE prerequisite for first installation. No cases/expected hashes
 * come from the operator. The returned late guard uses the caller's original
 * SDK transaction; it cannot install readers, select a pair or attest the
 * missing Post/settings/capability/status sources for the full installer. */
async function prepareFirstInstallPreviewCodeSource({ firestore, consumer: rawConsumer, deployedReaders: rawReaders, now = Date.now }) {
  p.exact(rawConsumer, ["previewPairId", "rendererSha", "workerVersion"]);
  p.exact(rawReaders, ["functions", "cmsApi"]);
  const consumer = structuredClone(rawConsumer), deployedReaders = structuredClone(rawReaders);
  const bindingOptions = { firestore, consumer };
  const before = await firestore.runTransaction(transaction => readBinding({ ...bindingOptions, transaction, now: now() }), { readOnly: true });
  const code = await readPairCodeReplaySource({ firestore, request: before.request, deployedReaders, now });
  if (!same(code.source.pair, before.request.selection.pair) || code.consumer.previewPairDigest !== cms.digest(before.authority.pair)) refuse();
  const evidence = { schemaVersion: 2, kind: "first-install-preview-code-source", bindingDigest: p.publicReleaseDigest(before), code };
  const digest = p.publicReleaseDigest(evidence);
  const assertCurrentInTransaction = async ({ transaction }) => {
    const current = await readBinding({ ...bindingOptions, transaction, now: now() });
    if (!same(current, before)) refuse();
    const originalCode = await readPairCodeAuthority({ firestore, transaction, request: before.request, deployedReaders, now: now() });
    if (p.publicReleaseDigest(originalCode) !== code.authorityDigest) refuse();
    return digest;
  };
  // The bootstrap pointer can change during chunk reads independently of the
  // CODE endpoint's own source/reader/selector authority, so recheck both here.
  await firestore.runTransaction(transaction => assertCurrentInTransaction({ transaction }), { readOnly: true });
  return { evidence: p.freeze(evidence), digest, assertCurrentInTransaction };
}

module.exports = { prepareFirstInstallPreviewCodeSource, readFirstInstallPreviewCodeBinding: readBinding };
