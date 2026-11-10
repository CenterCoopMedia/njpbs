import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseR2Fixture } from '../helpers/public-release-r2-fixture';
import { guardedPublicReleaseSwitchFixture } from '../helpers/guarded-public-release-switch';
import { createRehearsalPublicOwners } from '../../scripts/lib/rehearsal-public-owners.mjs';
import { readRehearsalPairQualifications } from '../../scripts/lib/rehearsal-public-qualification.mjs';
import { readOnlyBootstrapFirestore } from '../../scripts/lib/public-release-bootstrap-preflight.mjs';
import protocol from '../../functions/lib/public-release-pair.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import { openStagedPublicReleasePairComposite } from '../../site/scripts/public-release-pair-composite-storage';
import { qualificationReceiptPath } from '../../site/scripts/public-release-pair-qualification-receipt';

// Small sealed renderer fixtures; actual SDK, R2 and qualification owners.
// This proves a read-only component, not the complete compiled rehearsal.
describe.sequential('rehearsal qualification read-only binding', () => {
  const firestore = isolatedFirestore('rehearsal-qualification');
  let binding: Awaited<ReturnType<typeof publicReleaseR2Fixture>>;
  let fixture: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
  let packet: any, qualifications: any[], compositeKey: string;
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
    binding = await publicReleaseR2Fixture('rehearsal-qualification');
    fixture = await guardedPublicReleaseSwitchFixture(firestore, binding.store);
    const oldPair = fixture.selected.pair, newPair = fixture.pair;
    packet = { schemaVersion: 1, runId: 'rehearsal-qualification', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair, newPair,
      previewPairs: { old: { pairId: 'preview-old', rendererSha: oldPair.commitSha, serializerId: 'preview-old' },
        new: { pairId: 'preview-new', rendererSha: newPair.commitSha, serializerId: 'preview-new' } } };
    const unavailable = async () => { throw new Error('No admission, ingress or terminal belongs to preflight'); };
    const owners = createRehearsalPublicOwners({ packet, firestore, store: binding.store,
      credentials: fixture.transport.credentials, ingress: { prove: unavailable }, fieldValues: FieldValue, authorized: true });
    qualifications = [];
    for (const side of ['old', 'new']) {
      const result = await owners.qualify(side, side === 'old' ? '11111111111111111111' : '22222222222222222222');
      qualifications.push({ qualificationId: result.receipt.qualificationId, receiptDigest: protocol.publicReleaseDigest(result.receipt) });
    }
    // Discover a real selected composite output through its original owner,
    // then target that exact R2 object for the corruption test.
    const head = (await firestore.doc('system/publicReleaseChanges').get()).data()!;
    const expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair: newPair,
      headCursor: { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest },
      witnessDigest: (await firestore.doc(qualificationReceiptPath(newPair, qualifications[1].qualificationId)).get()).data()!.witnessDigest });
    const value = expanded.headView;
    {
      const opened = await openStagedPublicReleasePairComposite({ firestore, store: binding.store, pair: newPair,
        identity: value.identity, claimDigest: value.claimDigest, viewManifestDigest: value.manifestDigest });
      const path = opened.manifest.members.find(member => member.status === 200)!.path;
      const seen: string[] = [];
      const observedStore = { ...binding.store, get: async (key: string) => { seen.push(key); return binding.store.get(key); } };
      const observed = await openStagedPublicReleasePairComposite({ firestore, store: observedStore, pair: newPair,
        identity: value.identity, claimDigest: value.claimDigest, viewManifestDigest: value.manifestDigest });
      seen.length = 0; await observed.readMember(path);
      compositeKey = seen.at(-1)!;
    }
    expect(compositeKey).toBeTruthy();
  }, 120_000);
  afterAll(async () => { try { await fixture?.close(); await binding?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });
  const read = (store = binding.store) => readRehearsalPairQualifications({ firestore: readOnlyBootstrapFirestore(firestore),
    packet, qualifications, store });

  it('verifies both complete actual closures without rewriting any owner receipt', async () => {
    const paths = ['system/publicDeployment', 'system/publicReleaseChanges',
      ...[packet.oldPair, packet.newPair].map((pair, index) => qualificationReceiptPath(pair, qualifications[index].qualificationId))];
    const before = await firestore.getAll(...paths.map(path => firestore.doc(path)));
    expect(await read()).toEqual({ receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const after = await firestore.getAll(...paths.map(path => firestore.doc(path)));
    expect(after.every((row, index) => row.updateTime!.isEqual(before[index].updateTime!))).toBe(true);
  });
  it('refuses an actual corrupt candidate composite output rather than accepting its retained receipt', async () => {
    const original = await binding.store.get(compositeKey);
    const bytes = await original!.arrayBuffer();
    try {
      await binding.store.put(compositeKey, new TextEncoder().encode('CORRUPT'), { customMetadata: original!.customMetadata });
      await expect(read()).rejects.toThrow();
    } finally { await binding.store.put(compositeKey, bytes, { customMetadata: original!.customMetadata }); }
  });
  it('refuses transport failure even though both qualifications still exist', async () => {
    await expect(read({ get: async () => { throw new Error('Local R2 read failed'); }, put: binding.store.put })).rejects.toThrow();
  });
  it('refuses a retained witness when the current log head differs', async () => {
    const ref = firestore.doc('system/publicReleaseChanges'), before = (await ref.get()).data()!;
    try {
      await ref.set({ ...before, sequence: before.sequence + 1, lastDigest: 'f'.repeat(64) });
      await expect(read()).rejects.toThrow();
    } finally { await ref.set(before); }
  });
});
