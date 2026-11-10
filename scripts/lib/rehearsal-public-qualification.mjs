import { createRequire } from 'node:module';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import changes from '../../functions/lib/public-release-change-log.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import { parseRehearsalPacket } from './public-release-rehearsal.mjs';
import { assertDemoRehearsalEnvironment, assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const require = path => typedRequire(path, import.meta.url);
const { openStagedPublicReleasePairCodePack } = require('../../site/scripts/public-release-pair-code-pack-executor.ts');
const { openStagedPublicReleasePairComposite } = require('../../site/scripts/public-release-pair-composite-storage.ts');
const { parseQualificationReceipt, qualificationReceiptPath } = require('../../site/scripts/public-release-pair-qualification-receipt.ts');
const { verifyStoredQualificationEvidence, assertPublicReleasePairQualificationCurrentInTransaction,
  trackQualificationTransactionReads, assertQualificationTransactionReadBudget } = require('../../site/scripts/public-release-pair-qualification.ts');

const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Rehearsal qualification preflight refused'); };
const cursorFor = head => ({ baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest });

/** Read-only layer three. Serialized references select original receipts;
 * only the real source owner can prepare their opaque current-source guards.
 * Byte reads finish before the final shared-budget SDK transaction. */
export async function readRehearsalPairQualifications({ firestore, packet: raw, qualifications, store,
  signal = AbortSignal.timeout(30_000), authorized = false }) {
  const packet = parseRehearsalPacket(raw);
  if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
  else {
    if (authorized !== true || ![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT)) refuse();
    assertDevelopmentRehearsalEnvironment();
  }
  if (firestore.projectId !== packet.projectId || !Array.isArray(qualifications) || qualifications.length !== 2) refuse();
  const pairs = [packet.oldPair, packet.newPair];
  const references = qualifications.map(value => {
    protocol.exact(value, ['qualificationId', 'receiptDigest']);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.qualificationId) || !protocol.digest(value.receiptDigest)) refuse();
    return { ...value };
  });
  const before = changes.parsePublicReleaseChangeHead((await firestore.doc(changes.PUBLIC_RELEASE_CHANGES_PATH).get()).data());
  const prepared = [];
  for (const [index, pair] of pairs.entries()) {
    signal.throwIfAborted();
    work.assertPrivatePairResources(pair); work.assertPublicReleasePairDatabase(firestore, pair);
    const receipt = parseQualificationReceipt((await firestore.doc(qualificationReceiptPath(pair, references[index].qualificationId)).get()).data(), pair);
    if (protocol.publicReleaseDigest(receipt) !== references[index].receiptDigest) refuse();
    const code = await openStagedPublicReleasePairCodePack({ firestore, store, pair, signal });
    await code.verifyAll();
    const expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair,
      headCursor: cursorFor(before), witnessDigest: receipt.witnessDigest });
    if (!same(expanded.witness.headCursor, cursorFor(before))) refuse();
    const evidence = await verifyStoredQualificationEvidence({ firestore, store, pair, receipt,
      witness: expanded.witness, namespaces: expanded.namespaces, signal });
    for (const composite of evidence.composites) {
      const view = composite.view;
      const opened = await openStagedPublicReleasePairComposite({ firestore, store, pair, identity: view.identity,
        claimDigest: view.claimDigest, viewManifestDigest: view.manifestDigest, signal });
      await opened.verifyAll();
    }
    prepared.push(evidence);
  }
  return firestore.runTransaction(async original => {
    const tracker = trackQualificationTransactionReads(original), transaction = tracker.transaction;
    signal.throwIfAborted();
    const head = changes.parsePublicReleaseChangeHead((await transaction.get(firestore.doc(changes.PUBLIC_RELEASE_CHANGES_PATH))).data());
    if (!same(head, before)) refuse();
    const receipts = [];
    for (const [index, pair] of pairs.entries()) {
      const current = await assertPublicReleasePairQualificationCurrentInTransaction({ firestore, transaction, pair,
        ...references[index], ...prepared[index], readTracker: tracker });
      if (!same(current.witness.headCursor, cursorFor(head))) refuse();
      receipts.push(current.receipt);
    }
    assertQualificationTransactionReadBudget(tracker);
    signal.throwIfAborted();
    return Object.freeze({ receiptDigest: protocol.publicReleaseDigest({ kind: 'rehearsal-current-pair-qualifications',
      projectId: packet.projectId, pairDigests: pairs.map(protocol.publicReleaseDigest), head, receipts }) });
  }, { readOnly: true });
}
