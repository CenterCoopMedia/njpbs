import { PrivateProviderNotSent } from "./public-release-private-provider.mjs";
import protocol from "../../functions/lib/public-release-pair.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
const refuse = () => { throw new Error("Private provider attempt requires original-attempt reconciliation"); };
/** Firestore reservations cannot make a provider POST atomic. Immutable claims
 * prevent a second send after a lost reply, cancellation or process crash. */
export function privateInstallLedger(firestore) {
  return { assertPublisherUpload: input => rollout.assertPublicReleasePairFirstInstallSlot({ firestore, ...input }),
    async bindAttempt(attemptId, planDigest) {
    const ref = firestore.doc(`system/publicReleasePrivateInstalls/plans/${attemptId}`), value = { schemaVersion: 1, attemptId, planDigest };
    await firestore.runTransaction(async tx => { const prior = await tx.get(ref);
      if (prior.exists) { if (protocol.publicReleaseDigest(prior.data()) !== protocol.publicReleaseDigest(value)) refuse(); }
      else tx.create(ref, value);
    });
  }, async once({ attemptId, worker, planDigest, action, effect, observe }) {
    const namespace = "system/publicReleasePrivateInstalls", workerKey = protocol.publicReleaseDigest({ worker });
    const ownerRef = firestore.doc(`${namespace}/workers/${workerKey}`);
    const stepRef = firestore.doc(`${namespace}/attempts/${attemptId}/steps/${workerKey}-${action}`);
    const seal = { schemaVersion: 1, attemptId, worker, planDigest };
    const fresh = await firestore.runTransaction(async tx => {
      const [owner, step] = await tx.getAll(ownerRef, stepRef);
      if (owner.exists && protocol.publicReleaseDigest(owner.data()) !== protocol.publicReleaseDigest(seal)) refuse();
      if (step.exists) {
        if (protocol.publicReleaseDigest(step.data()) !== protocol.publicReleaseDigest({ ...seal, action }) &&
            protocol.publicReleaseDigest(step.data()) !== protocol.publicReleaseDigest({ ...seal, action, notSent: true })) refuse();
        if (step.data().notSent === true) { tx.set(stepRef, { ...seal, action }); return true; }
        return false;
      }
      if (!owner.exists) tx.create(ownerRef, seal);
      tx.create(stepRef, { ...seal, action }); return true;
    });
    // Never repeat an effect for a prior durable claim, even when observation
    // currently finds no result. Operators must investigate that same attempt.
    if (fresh) {
      try { await effect(); }
      catch (error) {
        if (error instanceof PrivateProviderNotSent) {
          // Only transport-confirmed pre-send failures can release a claim for
          // the same original attempt. An invoked fetch is always ambiguous.
          await firestore.runTransaction(async tx => { const row = await tx.get(stepRef);
            if (protocol.publicReleaseDigest(row.data()) !== protocol.publicReleaseDigest({ ...seal, action })) refuse();
            tx.set(stepRef, { ...seal, action, notSent: true });
          });
          refuse();
        }
        // Network/provider failures retain the immutable claim; observe only.
      }
    }
    const result = await observe();
    const receiptRef = firestore.doc(`${namespace}/attempts/${attemptId}/readbacks/${workerKey}-${action}`);
    await firestore.runTransaction(async tx => {
      const prior = await tx.get(receiptRef), receipt = { ...seal, action, result };
      if (prior.exists) {
        if (protocol.publicReleaseDigest(prior.data()) !== protocol.publicReleaseDigest(receipt)) refuse();
      } else tx.create(receiptRef, receipt);
    });
    return result;
  } };
}
