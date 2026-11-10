import { setTimeout as delay } from 'node:timers/promises';
import protocol from '../../functions/lib/public-release-pair.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import changes from '../../functions/lib/public-release-change-log.js';
import { assertRehearsalAuditScope } from './rehearsal-installed-audit.mjs';
import { assertNativeRehearsalDatabase } from './rehearsal-sdk-identity.mjs';

/** Wake the existing sealed continuation, then observe both exact native
 * cursors at one SDK snapshot before an owner seals a new replay witness.
 * A selected-pair terminal fact alone does not prove retained-pair catch-up. */
export async function waitForRehearsalReplay(options) {
  const packet = assertRehearsalAuditScope(options), { firestore, wake, signal } = options;
  assertNativeRehearsalDatabase(firestore, packet.projectId);
  if (typeof wake !== 'function') throw new Error('Rehearsal replay catch-up refused');
  signal?.throwIfAborted(); await wake();
  const deadline = Date.now() + 120_000;
  while (true) {
    signal?.throwIfAborted();
    const caughtUp = await firestore.runTransaction(async transaction => {
      const rows = await transaction.getAll(firestore.doc(changes.PUBLIC_RELEASE_CHANGES_PATH),
        ...[packet.oldPair, packet.newPair].map(pair => firestore.doc(replay.checkpointPath(pair))));
      const head = changes.parsePublicReleaseChangeHead(rows[0].data());
      const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
      return [packet.oldPair, packet.newPair].every((pair, index) =>
        protocol.publicReleaseDigest(replay.parseReplayCheckpoint(rows[index + 1].data(), pair).cursor) === protocol.publicReleaseDigest(cursor));
    }, { readOnly: true });
    if (caughtUp) return;
    if (Date.now() >= deadline) throw new Error('Rehearsal replay catch-up refused');
    await delay(500, undefined, { signal });
  }
}
