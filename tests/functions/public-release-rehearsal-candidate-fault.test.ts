import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseR2Fixture } from '../helpers/public-release-r2-fixture';
import { guardedPublicReleaseSwitchFixture } from '../helpers/guarded-public-release-switch';
import { createRehearsalCandidateFault, readRehearsalCandidateFaultHistory } from '../../scripts/lib/rehearsal-candidate-fault.mjs';
import { createRehearsalPublicOwners } from '../../scripts/lib/rehearsal-public-owners.mjs';
import { qualificationReceiptPath } from '../../site/scripts/public-release-pair-qualification-receipt';

// Actual frozen native CODE/qualifiers/SDK/R2/private HTTP. Corruption occurs
// only at the named read boundary; no stored object or provider is changed.
describe.sequential('rehearsal exact NEW candidate byte boundary', () => {
  const firestore = isolatedFirestore('rehearsal-candidate-fault');
  let r2: Awaited<ReturnType<typeof publicReleaseR2Fixture>>, source: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
  let packet: any, fault: ReturnType<typeof createRehearsalCandidateFault>, owners: ReturnType<typeof createRehearsalPublicOwners>;
  let writes = 0, originalDigest: string, originalMetadata: any, key: string, witness: any;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  beforeAll(async () => {
    for (const env of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(env, undefined);
    r2 = await publicReleaseR2Fixture('rehearsal-candidate-fault');
    source = await guardedPublicReleaseSwitchFixture(firestore, r2.store);
    packet = { schemaVersion: 1, runId: 'candidate-byte-fault', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: source.selected.pair, newPair: source.pair,
      previewPairs: { old: { pairId: 'preview-old', rendererSha: source.selected.pair.commitSha, serializerId: 'preview-old' },
        new: { pairId: 'preview-new', rendererSha: source.pair.commitSha, serializerId: 'preview-new' } } };
    fault = createRehearsalCandidateFault({ firestore, packet, credentials: source.transport.credentials,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), authorized: true,
      store: { get: key => r2.store.get(key), put: (...args) => { writes++; return r2.store.put(...args); } } });
    owners = createRehearsalPublicOwners({ firestore, packet, store: fault.store, credentials: source.transport.credentials,
      ingress: { prove: async () => { throw new Error('No canonical writer in this component'); } }, fieldValues: FieldValue, authorized: true });
  }, 120_000);
  afterAll(async () => { try { await source?.close(); await r2?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });
  it('arms only the original NEW manifest read and retains its real stored bytes and metadata', async () => {
    expect((await fault.arm(`${packet.runId}-corrupt`)).state).toBe('armed');
    const intent = (await firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/faults/candidate`).get()).data()!;
    key = intent.objectKey;
    const actual = await r2.store.get(key); originalMetadata = actual!.customMetadata;
    const bytes = await actual!.arrayBuffer(); originalDigest = hash(Buffer.from(bytes));
    expect(originalDigest).toBe(intent.bodyDigest);
    const observed = await fault.store.get(key);
    expect(hash(Buffer.from(await new Response(observed!.body).arrayBuffer()))).not.toBe(originalDigest);
    expect(observed!.customMetadata).toEqual(originalMetadata); expect(writes).toBe(0);
  });
  it('requires an actual native qualifier refusal after the real target read and creates no success receipt', async () => {
    witness = await fault.qualifyCorrupt();
    expect(witness).toMatchObject({ dispatched: true, nativeRefusal: 'input-unavailable', reason: 'byte-mismatch' });
    expect((await firestore.doc(qualificationReceiptPath(packet.newPair, witness.qualificationId)).get()).exists).toBe(false);
    expect(await fault.qualifyCorrupt()).toEqual(witness); expect(writes).toBe(0);
  });
  it('keeps actual OLD full qualification available while NEW reads are corrupt', async () => {
    expect((await owners.qualify('old', '44444444444444444444')).receipt.pairDigest).toBeDefined();
    expect((await fault.inspect())!.state).toBe('armed');
  });
  it('restores the original read boundary and qualifies NEW with unchanged stored bytes', async () => {
    expect((await fault.restore(`${packet.runId}-repair`)).state).toBe('restored');
    expect((await owners.qualify('new', '55555555555555555555')).receipt.pairDigest).toBeDefined();
    const actual = await r2.store.get(key);
    expect(hash(Buffer.from(await actual!.arrayBuffer()))).toBe(originalDigest);
    expect(actual!.customMetadata).toEqual(originalMetadata);
    expect(await fault.qualifyCorrupt()).toEqual(witness); // Historical refusal never becomes qualification success.
  });
  it('independently verifies original dispatched refusal and restoration with no storage boundary', async () => {
    expect(await readRehearsalCandidateFaultHistory({ firestore, packet,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), authorized: true }))
      .toEqual({ receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('refuses a rewritten and restored refusal witness even when its original values return', async () => {
    const ref = firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/faults/candidate/receipts/refused`), before = (await ref.get()).data()!;
    await ref.set({ ...before, dispatched: false }); await ref.set(before);
    await expect(readRehearsalCandidateFaultHistory({ firestore, packet,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), authorized: true })).rejects.toThrow();
  });
});
