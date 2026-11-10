import protocol from '../../functions/lib/public-release-pair.js';
import admission from '../../functions/lib/public-release-admission.js';
import { PUBLICATION_STEPS, rehearsalOperationId } from './public-release-rehearsal.mjs';
import { assertRehearsalAuditScope } from './rehearsal-installed-audit.mjs';
import { assertRehearsalPublicOwners } from './rehearsal-public-owners.mjs';
import { assertRehearsalHoldActions } from './rehearsal-installed-hold.mjs';
import { readRehearsalOriginalOperation } from './rehearsal-original-operation.mjs';
import { assertNativeRehearsalDatabase } from './rehearsal-sdk-identity.mjs';

const recoveries = new WeakMap();
const refuse = () => { throw new Error('Installed rehearsal accepted-effect recovery refused'); };
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const immutable = row => {
  if (!row.exists || !row.createTime.isEqual(row.updateTime)) refuse();
  return row.data();
};

/** Recovery permanently fails the observation window. It can cancel only the
 * original native hold plans and settle already accepted originals; it grants
 * no acceptance, switch, preview action, readiness or scenario PASS. */
export async function prepareRehearsalAcceptedRecovery(options) {
  const packet = assertRehearsalAuditScope(options), { firestore, owners, holds, sourceSha, signal } = options;
  if (options.recoveryOnly !== true) refuse();
  assertNativeRehearsalDatabase(firestore, packet.projectId);
  assertRehearsalPublicOwners(owners, firestore, packet); assertRehearsalHoldActions(holds, firestore, packet);
  signal?.throwIfAborted();
  const base = `publicReleaseRehearsalRuns/${packet.runId}`;
  await firestore.runTransaction(async transaction => {
    const [root, failure] = await transaction.getAll(firestore.doc(base), firestore.doc(`${base}/controls/failure`));
    const run = immutable(root), runDigest = protocol.publicReleaseDigest(run);
    if (run.sourceSha !== sourceSha || run.packetDigest !== protocol.publicReleaseDigest(packet)) refuse();
    if (failure.exists) { if (immutable(failure).runDigest !== runDigest) refuse(); }
    else transaction.create(failure.ref, { schemaVersion: 1, runDigest, code: 'recovery-only-window-abandoned' });
  });
  for (const side of ['old', 'new']) {
    const state = await holds.read(side);
    if (state && !['released', 'cancelled'].includes(state.status)) await holds.cancel(side, `${packet.runId}-cancel-${side}`);
  }
  const expected = PUBLICATION_STEPS.map(step => rehearsalOperationId(packet, step));
  const rows = await firestore.getAll(...expected.map(id => firestore.doc(`${admission.ADMISSIONS}/operations/${id}`)));
  const operationIds = rows.filter(row => row.exists).map(row => {
    const accepted = admission.parseAdmission(immutable(row));
    if (accepted.operationId !== row.id || ![packet.oldPair, packet.newPair].some(pair =>
      same(accepted.pair, protocol.publicReleasePairReference(pair)) && accepted.pairDigest === protocol.publicReleaseDigest(pair))) refuse();
    return row.id;
  });
  const handle = Object.freeze({ operationIds: Object.freeze(operationIds) });
  recoveries.set(handle, { firestore, packet, owners, signal });
  return handle;
}

export async function advanceRehearsalAcceptedRecovery(handle, operationId, phase) {
  const options = recoveries.get(handle);
  if (!options || !handle.operationIds.includes(operationId) || !['render', 'settle'].includes(phase)) refuse();
  options.signal?.throwIfAborted();
  const original = await readRehearsalOriginalOperation({ ...options, operationId });
  if (original?.terminalCount === 1) return original;
  // The actual sealed continuation owns capture/rendering. Its authenticated
  // wake happens in the session; this observer cannot fabricate completion or
  // start a host-side replacement capture while that worker is still running.
  if (phase === 'settle') { if (!original) refuse(); await options.owners.finish(operationId); }
  const observed = await readRehearsalOriginalOperation({ ...options, operationId });
  if (phase === 'settle' && observed?.terminalCount !== 1) refuse();
  return observed;
}
