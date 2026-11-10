import { beforeEach, expect, it } from 'vitest';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { developmentInstallFixture } from '../helpers/development-install';
import { configurePublicReleaseIngress } from '../../scripts/configure-public-release-ingress.mjs';
import { assertOriginalProofIngress } from '../../scripts/lib/public-release-private-bridge-operator.mjs';
import p from '../../functions/lib/public-release-pair.js';
const rawDb = isolatedFirestore('development-proof-bridge-ingress.test.ts');
const db = new Proxy(rawDb, { get(target, key) { if (key === 'projectId') return 'njpbs-site-dev';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
beforeEach(async () => { await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, rawDb); });
async function fixture() {
  const f = await developmentInstallFixture(db), packet: any = { pairs: [f.packet.bootstrapAttempt.currentPair, f.packet.bootstrapAttempt.recoveryPair],
    ingressName: f.packet.installPlan.ingressName };
  // The unchanged bridge caller supplies its default reconstruction. The guard
  // must select explicit development mode solely from the actual original seal.
  const config = configurePublicReleaseIngress({ oldPair: packet.pairs[0], newPair: packet.pairs[1],
    accountId: f.packet.installPlan.accountId, ingressName: packet.ingressName });
  return { ...f, input: { firestore: db, packet, config, source: f.source, provider: f.provider } };
}
it('opens the original enabled/recovery dev ingress for proof-operator install/readback', async () => {
  const f = await fixture(); expect(f.input.config.vars.PUBLIC_PAIR_INGRESS_ENABLED).toBe('false');
  await expect(assertOriginalProofIngress(f.input)).resolves.toBeUndefined();
  await expect(assertOriginalProofIngress(f.input)).resolves.toBeUndefined();
  expect((await db.doc('system/publicReleaseChangeLog').get()).data()?.enabled).toBe(false);
});
it.each(['original-owner', 'provider-flags', 'pair', 'production'])('refuses mismatched %s instead of accepting mutable enablement', async fault => {
  const f = await fixture(), key = p.publicReleaseDigest({ worker: f.packet.installPlan.ingressName });
  if (fault === 'original-owner') await db.doc(`system/publicReleasePrivateInstalls/workers/${key}`).update({ planDigest: '0'.repeat(64) });
  if (fault === 'provider-flags') f.records.get(f.packet.installPlan.ingressName).version.resources.bindings
    .find((row: any) => row.name === 'PUBLIC_PAIR_INGRESS_ENABLED').text = 'false';
  if (fault === 'pair') f.input.packet.pairs = [f.input.packet.pairs[1], f.input.packet.pairs[0]];
  if (fault === 'production') f.input.packet = { ...f.input.packet, pairs: f.input.packet.pairs.map((pair: any) => ({ ...pair, environment: 'production' })) };
  await expect(assertOriginalProofIngress(f.input)).rejects.toThrow();
});
