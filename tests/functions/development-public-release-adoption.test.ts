import { beforeEach, expect, it } from 'vitest';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { initialPublicReleaseControlsFixture } from '../helpers/initial-public-release-controls';
import { credentialIdentity } from '../helpers/development-install';
import { parseDevelopmentAdoptionPacket, runDevelopmentAdoption } from '../../scripts/lib/development-public-release-adoption.mjs';
import { BOOTSTRAP_CONTROL_RECEIPTS } from '../../site/scripts/public-release-bootstrap-controls';
const rawDb = isolatedFirestore('development-public-release-adoption.test.ts');
const db = new Proxy(rawDb, { get(target, key) { if (key === 'projectId') return 'njpbs-site-dev';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
beforeEach(async () => { await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, rawDb); });
it('binds native OLD controls and original initial-selector readback without bypassing their SDK owners', async () => {
  const f = await initialPublicReleaseControlsFixture(db);
  const before = (await db.doc(`${BOOTSTRAP_CONTROL_RECEIPTS}/${f.attempt.operationId}`).get()).data()!;
  const packet = { schemaVersion: 1, kind: 'development-public-release-adoption', operatorCommitSha: 'a'.repeat(40), credentialIdentity,
    step: 'controls', attempt: before.attempt };
  const { provider, ...evidence } = f.options;
  const result = await runDevelopmentAdoption({ firestore: db, packet, provider, evidence, mode: 'apply' });
  expect(result).toMatchObject({ idempotent: true, receipt: before });
  expect((await db.doc('system/publicReleaseChangeLog').get()).data()?.enabled).toBe(false);
  await f.convert();
  expect(await runDevelopmentAdoption({ firestore: db, packet: { ...packet, step: 'initial', attempt: f.attempt }, mode: 'readback' }))
    .toMatchObject({ receipt: { kind: 'public-release-bootstrap', operationId: f.attempt.operationId } });
  expect(await runDevelopmentAdoption({ packet })).toEqual({ step: 'controls', mode: 'plan', authorityReads: 0, authorityWrites: 0 });
  const wrong = structuredClone(packet); wrong.attempt.pair.environment = 'production'; expect(() => parseDevelopmentAdoptionPacket(wrong)).toThrow();
});
it('uses the native legacy preview pause owner with an exact guard inside its transaction', async () => {
  const p = (await import('../../functions/lib/public-release-pair.js')).default;
  const runtime = { schemaVersion: 1, phase: 'ready', rendererSha: 'a'.repeat(40), serializerId: 'cloudflare-preview' };
  await db.doc('system/cmsPreviewRuntime').set(runtime);
  const packet = { schemaVersion: 1, kind: 'development-public-release-adoption', operatorCommitSha: 'a'.repeat(40), credentialIdentity,
    step: 'preview-pause', attempt: { rendererSha: runtime.rendererSha, expectedRuntimeDigest: p.publicReleaseDigest(runtime) } };
  expect(await runDevelopmentAdoption({ firestore: db, packet, mode: 'apply' })).toMatchObject({ kind: 'preview-pause-applied' });
  expect(await runDevelopmentAdoption({ firestore: db, packet, mode: 'readback' })).toMatchObject({ kind: 'preview-pause-current-state' });
  await expect(runDevelopmentAdoption({ firestore: db, packet, mode: 'apply' })).rejects.toThrow();
  expect((await db.doc('system/cmsPreviewRuntime').get()).data()).toEqual({ ...runtime, phase: 'paused' });
});
