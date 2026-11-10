import protocol from '../../functions/lib/public-release-pair.js';
import admission from '../../functions/lib/public-release-admission.js';
import terminal from '../../functions/lib/public-release-terminal.js';
import work from '../../functions/lib/public-release-pair-work.js';
import { assertDemoRehearsalEnvironment, assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';

const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Rehearsal original operation read refused'); };

/** Read the exact original acceptance and completed claim. A pending queue or
 * marker cannot stand in for work completion, and a held operation receives
 * no invented terminal receipt. All transaction operations are reads.
 */
export async function readRehearsalOriginalOperation({ firestore, packet, operationId, signal }) {
  if (packet?.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
  else if (packet?.schemaVersion === 2 && packet.setupMode === 'preinstalled') assertDevelopmentRehearsalEnvironment();
  else refuse();
  if (firestore?.projectId !== packet.projectId || !/^[A-Za-z0-9]{20}$/.test(operationId ?? '')) refuse();
  return firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const [source, queued, fact, pending] = await transaction.getAll(firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`),
      firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`),
      firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`));
    if (!source.exists || !source.createTime.isEqual(source.updateTime)) refuse();
    const accepted = admission.parseAdmission(source.data()), digest = protocol.publicReleaseDigest(accepted), queue = queued.data();
    admission.assertQueue(queue, accepted);
    const side = ['old', 'new'].find(value => same(accepted.pair, protocol.publicReleasePairReference(packet[`${value}Pair`])) &&
      accepted.pairDigest === protocol.publicReleaseDigest(packet[`${value}Pair`]));
    if (accepted.operationId !== operationId || !side) refuse();
    if (!fact.exists && (queue.status !== 'pending' || queue.terminalReceipt !== null ||
        !same(pending.data(), { schemaVersion: 2, operationId, admissionDigest: digest }))) refuse();
    if (!queue.execution) { if (fact.exists) refuse(); return null; }
    const execution = terminal.parseCompletedPairPublicationExecution(queue.execution), identity = execution.identity;
    if (!same(execution.pair, accepted.pair) || execution.pairDigest !== accepted.pairDigest || identity.sourceOperationId !== operationId ||
        identity.sourceVersion !== accepted.source.sourceVersion || identity.snapshotDigest !== accepted.source.snapshotDigest ||
        identity.contextSequence !== accepted.changeSequence) refuse();
    const completed = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction,
      pair: packet[`${side}Pair`], taskId: execution.taskId, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest });
    if (!same(completed.identity, identity)) refuse();
    let receipt = null;
    if (fact.exists) {
      if (!fact.createTime.isEqual(fact.updateTime)) refuse();
      receipt = await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction, operationId, admissionDigest: digest });
      if (receipt.outcome !== 'success' || !same(receipt.originalExecution, execution)) refuse();
    }
    signal?.throwIfAborted();
    return protocol.freeze({ operationId, originalPair: side, snapshotDigest: accepted.source.snapshotDigest,
      sourceVersion: accepted.source.sourceVersion, claimDigest: execution.claimDigest,
      acceptedCount: 1, terminalCount: receipt ? 1 : 0, terminalReceiptDigest: receipt ? protocol.publicReleaseDigest(receipt) : null });
  }, { readOnly: true });
}
