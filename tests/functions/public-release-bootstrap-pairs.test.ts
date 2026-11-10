import { beforeEach, expect, it } from 'vitest';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { initialPublicReleaseControlsFixture } from '../helpers/initial-public-release-controls';
import p from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import retention from '../../functions/lib/public-release-bootstrap-pairs.js';
import { capturedPairInput } from '../helpers/captured-public-release-pair-input.js';
const raw = isolatedFirestore('first-install-pair-retention');
const firestore = new Proxy(raw, { get(target, key) { if (key === 'projectId') return 'njpbs-site-dev';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
let f: Awaited<ReturnType<typeof initialPublicReleaseControlsFixture>>, attempt: any, proofs: any[];
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, raw);
  f = await initialPublicReleaseControlsFixture(firestore);
  for (const pair of [f.pair, f.recoveryPair]) await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`).update({ status: 'candidate' });
  const originalEnrollment = (await firestore.doc(enrollment.ENROLLMENT_PATH).get()).data()!;
  attempt = { schemaVersion: 2, operationId: f.attempt.operationId, environment: 'development', expectedSourceDigest: f.attempt.expectedSourceDigest,
    enrollmentRequestDigest: (await firestore.doc(enrollment.ENROLLMENT_PATH).get()).data()!.requestDigest,
    currentPair: f.pair, recoveryPair: f.recoveryPair, views: [f.pair, f.recoveryPair].map(pair => {
      const input = capturedPairInput(pair, { contextSequence: 0, sourceOperationId: `baseline-${originalEnrollment.baseline.logBaselineDigest}` });
      const identity = { schemaVersion: 2, pair: p.publicReleasePairReference(pair), ...input.scope, inputManifestDigest: input.inputManifestDigest };
      const view = { identity, claimDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), manifestBytes: 1 };
      return { codePackView: { ...view, identity: { ...identity, sourceOperationId: `baseline-codepack-${originalEnrollment.baseline.logBaselineDigest}` } }, contentView: { ...view, manifestDigest: 'c'.repeat(64) } };
    }) };
  const head = (await firestore.doc('system/publicReleaseChanges').get()).data()!;
  proofs = [f.pair, f.recoveryPair].map((pair, index) => ({ pairDigest: p.publicReleaseDigest(pair), views: attempt.views[index],
    cursor: { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest },
    codeProofDigest: 'd'.repeat(64), contentProofDigest: 'e'.repeat(64), sourceCensusDigest: 'f'.repeat(64) }));
});
// This fixture isolates the native lifecycle transaction with the same explicit
// H/G guard seam used by bootstrap controls. Actual H/G/HTTP evidence is
// exercised in development-initial-pairs.test.ts, not fabricated by this test.
const guard = () => ({ begin(transaction: any) { return { transaction, verify: async () => proofs, finish() {} }; } });
const apply = (options = {}) => retention.retainInitialPublicReleasePairs({ firestore, attempt, retentionGuard: guard(), dryRun: false, ...options });
const status = async () => Promise.all([f.pair, f.recoveryPair].map(async pair =>
  (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`).get()).data()!.status));
it('requires both H/G guards and changes only the two lifecycle controls plus its immutable receipt', async () => {
  await expect(apply({ retentionGuard: undefined })).rejects.toThrow(); expect(await status()).toEqual(['candidate', 'candidate']);
  expect((await apply({ dryRun: true })).dryRun).toBe(true); expect(await status()).toEqual(['candidate', 'candidate']);
  const root = (await firestore.doc('system/publicDeployment').get()).data(), head = (await firestore.doc('system/publicReleaseChanges').get()).data();
  const result = await apply(); expect(result.idempotent).toBe(false); expect(await status()).toEqual(['retained', 'retained']);
  expect((await firestore.doc('system/publicDeployment').get()).data()).toEqual(root);
  expect((await firestore.doc('system/publicReleaseChanges').get()).data()).toEqual(head);
  expect(await retention.readInitialPairRetentionReceipt({ firestore, attempt })).toEqual(result.receipt);
  expect((await apply({ retentionGuard: undefined })).receipt).toEqual(result.receipt);
});
it('refuses a changed original attempt and reads the original outcome after an ambiguous write', async () => {
  const original = await apply();
  const changed = structuredClone(attempt); changed.views[1].contentView.manifestDigest = 'f'.repeat(64);
  await expect(retention.readInitialPairRetentionReceipt({ firestore, attempt: changed })).rejects.toThrow();
  expect((await retention.readInitialPairRetentionReceipt({ firestore, attempt })).attemptDigest).toBe(p.publicReleaseDigest(attempt));
  const enrolled = (await firestore.doc(enrollment.ENROLLMENT_PATH).get()).data();
  expect(original.receipt.enrollmentReceiptDigest).toBe(p.publicReleaseDigest(enrolled));
});
it('refuses after schema-two conversion while original-outcome readback remains available', async () => {
  await apply(); await f.convert();
  await expect(apply()).rejects.toThrow(); expect(await retention.readInitialPairRetentionReceipt({ firestore, attempt })).not.toBeNull();
});
it('refuses any later enrolled head and a different project before writing', async () => {
  await firestore.doc('system/publicReleaseChanges').update({ sequence: 1, lastDigest: 'e'.repeat(64) });
  await expect(apply()).rejects.toThrow(); expect(await status()).toEqual(['candidate', 'candidate']);
  await expect(apply({ firestore: { projectId: 'njpbs-site', runTransaction() { throw new Error('Must refuse before SDK'); } } })).rejects.toThrow('mixed publication database');
});
it('refuses changed fence ownership and a partial pair proof', async () => {
  await expect(apply({ retentionGuard: { begin(transaction: any) { return { transaction, verify: async () => proofs.slice(0, 1), finish() {} }; } } })).rejects.toThrow();
  expect(await status()).toEqual(['candidate', 'candidate']);
  await firestore.doc('system/publicReleaseAdmissions/controls/bootstrapFence').update({ operationId: 'foreign-bootstrap' });
  await expect(apply()).rejects.toThrow(); expect(await status()).toEqual(['candidate', 'candidate']);
});
