import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseR2Fixture } from '../helpers/public-release-r2-fixture';
import { guardedPublicReleaseSwitchFixture } from '../helpers/guarded-public-release-switch';
import { createRehearsalQualificationProcess, readRehearsalQualificationInterruption } from '../../scripts/lib/rehearsal-qualification-process.mjs';
import { qualificationReceiptPath } from '../../site/scripts/public-release-pair-qualification-receipt';
import protocol from '../../functions/lib/public-release-pair.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import { FieldValue } from 'firebase-admin/firestore';
import { createRehearsalPublicOwners } from '../../scripts/lib/rehearsal-public-owners.mjs';
import { rehearsalOperationId } from '../../scripts/lib/public-release-rehearsal.mjs';
import { waitForRehearsalReplay } from '../../scripts/lib/rehearsal-replay-catch-up.mjs';

// Actual native qualifier/SDK/private-reader HTTP and R2 in a real child.
// The small sealed renderer and HTTP auth are external fixture boundaries.
describe.sequential('rehearsal native qualifier process interruption', () => {
  const firestore = isolatedFirestore('rehearsal-qualifier-process');
  let r2: Awaited<ReturnType<typeof publicReleaseR2Fixture>>, source: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
  let qualifier: ReturnType<typeof createRehearsalQualificationProcess>, packet: any, interrupted: any;
  let reads = 0, writes = 0;
  const ref = firestore.doc('publicReleaseRehearsalRuns/qualifier-process/qualifications/new');
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
    r2 = await publicReleaseR2Fixture('rehearsal-qualifier-process');
    source = await guardedPublicReleaseSwitchFixture(firestore, r2.store);
    packet = { schemaVersion: 1, runId: 'qualifier-process', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: source.selected.pair, newPair: source.pair,
      previewPairs: { old: { pairId: 'preview-old', rendererSha: source.selected.pair.commitSha, serializerId: 'preview-old' },
        new: { pairId: 'preview-new', rendererSha: source.pair.commitSha, serializerId: 'preview-new' } } };
    qualifier = createRehearsalQualificationProcess({ firestore, packet, credentials: source.transport.credentials,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), authorized: true,
      store: { get: async key => { reads++; return r2.store.get(key); },
        put: async (...args) => { writes++; return r2.store.put(...args); } } });
  }, 120_000);
  afterAll(async () => { try { await source?.close(); await r2?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });
  it('waits for real retained-pair replay after an OLD admission before a qualifier may seal NEW', async () => {
    const operationId = rehearsalOperationId(packet, 'during-preparation');
    const story = (await firestore.doc('cmsPosts/story').get()).data()!;
    const owners = createRehearsalPublicOwners({ firestore, packet, store: r2.store, credentials: source.transport.credentials,
      ingress: { prove: async () => { throw new Error('No terminal shortcut'); } }, fieldValues: FieldValue, authorized: true });
    await owners.acceptPost({ operationId, documentId: 'story', nextDocument: { ...story, version: story.version + 1,
      published: { ...story.published, sourceVersion: story.version + 1,
        metadata: { ...story.published.metadata, title: 'Real OLD source before retained replay' } } } });
    await expect(replay.sealPublicReleasePairReplayWitness({ firestore, pair: packet.newPair })).rejects.toMatchObject({ code: 'replay-not-caught-up' });
    const controller = new AbortController(); let progress: Promise<void> | undefined;
    await waitForRehearsalReplay({ firestore, packet, authorized: true, signal: controller.signal,
      wake: async () => { progress = source.replayOperation(operationId); progress.catch(error => controller.abort(error)); } });
    await progress;
    const fresh = await replay.sealPublicReleasePairReplayWitness({ firestore, pair: packet.newPair });
    expect(fresh.witness.headCursor).toEqual((await replay.sealPublicReleasePairReplayWitness({ firestore, pair: packet.oldPair })).witness.headCursor);
  });
  it('actually exits the native qualifier after its first storage read with no qualification success', async () => {
    expect(await qualifier.interrupt()).toEqual({ interrupted: true });
    interrupted = await qualifier.inspect();
    expect(interrupted).toEqual({ attemptId: 'qualifier-process-qualification-new',
      checkpointDigest: expect.stringMatching(/^[a-f0-9]{64}$/), status: 'interrupted' });
    expect(reads).toBe(1); expect(writes).toBe(0);
    const original = (await ref.get()).data()!;
    expect((await firestore.doc(qualificationReceiptPath(packet.newPair, original.qualificationId)).get()).exists).toBe(false);
  });
  it('resumes the original witness and native qualification ID without rewriting the checkpoint', async () => {
    const before = await ref.get(), witness = await firestore.doc(`${ref.path}/receipts/interrupted`).get();
    expect(await qualifier.resume()).toEqual({ ...interrupted, status: 'complete' });
    expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
    expect((await firestore.doc(`${ref.path}/receipts/interrupted`).get()).updateTime!.isEqual(witness.updateTime!)).toBe(true);
    const receipt = (await firestore.doc(qualificationReceiptPath(packet.newPair, before.data()!.qualificationId)).get()).data()!;
    expect(receipt.witnessDigest).toBe(before.data()!.witnessDigest); expect(writes).toBeGreaterThan(0);
  });
  it('reuses the original exit checkpoint and completed qualification on retry', async () => {
    const before = reads;
    expect(await qualifier.interrupt()).toEqual({ interrupted: true });
    expect(reads).toBe(before);
    expect(await qualifier.inspect()).toEqual({ ...interrupted, status: 'complete' });
  });
  it('independently reads the original interruption and native completed receipt without storage or credential authority', async () => {
    const before = { reads, writes }, original = await ref.get();
    const evidence = await readRehearsalQualificationInterruption({ firestore, packet,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), authorized: true });
    expect(evidence.plan).toEqual(original.data());
    expect(protocol.publicReleaseDigest(evidence.checkpoint)).toBe(interrupted.checkpointDigest);
    expect(evidence.qualification.qualificationId).toBe(original.data()!.qualificationId);
    expect(evidence.qualification.witnessDigest).toBe(original.data()!.witnessDigest);
    expect({ reads, writes }).toEqual(before);
    expect((await ref.get()).updateTime!.isEqual(original.updateTime!)).toBe(true);
  });
  it('acknowledges an already completed native resume without relaunching or refreshing it', async () => {
    const before = { reads, writes }, plan = (await ref.get()).data()!;
    const original = await firestore.doc(qualificationReceiptPath(packet.newPair, plan.qualificationId)).get();
    expect(await qualifier.resume()).toEqual({ ...interrupted, status: 'complete' });
    expect({ reads, writes }).toEqual(before);
    expect((await original.ref.get()).updateTime!.isEqual(original.updateTime!)).toBe(true);
  });
  it('refuses a rewritten-and-restored original checkpoint instead of minting a new attempt', async () => {
    const checkpoint = firestore.doc(`${ref.path}/receipts/interrupted`), before = await checkpoint.get();
    const value = before.data()!;
    await checkpoint.set({ ...value, bytes: value.bytes + 1 }); await checkpoint.set(value);
    expect(protocol.publicReleaseDigest((await checkpoint.get()).data())).toBe(protocol.publicReleaseDigest(value));
    expect((await checkpoint.get()).updateTime!.isEqual(before.updateTime!)).toBe(false);
    await expect(qualifier.resume()).rejects.toThrow('qualifier process refused');
  });
});
