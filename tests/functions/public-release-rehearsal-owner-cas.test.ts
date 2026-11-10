import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseR2Fixture } from '../helpers/public-release-r2-fixture';
import { guardedPublicReleaseSwitchFixture } from '../helpers/guarded-public-release-switch';
import { createRehearsalPublicOwners } from '../../scripts/lib/rehearsal-public-owners.mjs';
import { readRehearsalOriginalOperation } from '../../scripts/lib/rehearsal-original-operation.mjs';
import { rehearsalOperationId } from '../../scripts/lib/public-release-rehearsal.mjs';
import protocol from '../../functions/lib/public-release-pair.js';

describe.sequential('rehearsal original source CAS and completed-claim read', () => {
  const firestore = isolatedFirestore('rehearsal-source-cas');
  let r2: Awaited<ReturnType<typeof publicReleaseR2Fixture>>, source: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
  let packet: any, owners: ReturnType<typeof createRehearsalPublicOwners>, nextDocument: any, beforeDocumentDigest: string, operationId: string, original: any;
  const credentialsSeen = new Set();
  const read = () => readRehearsalOriginalOperation({ firestore, packet, operationId });
  const accept = (digest = beforeDocumentDigest) => owners.acceptPost({ operationId, documentId: 'story', nextDocument, beforeDocumentDigest: digest });
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
    r2 = await publicReleaseR2Fixture('rehearsal-source-cas');
    source = await guardedPublicReleaseSwitchFixture(firestore, r2.store);
    packet = { schemaVersion: 1, runId: 'source-cas-proof', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: source.selected.pair, newPair: source.pair,
      previewPairs: { old: { pairId: 'preview-old', rendererSha: source.selected.pair.commitSha, serializerId: 'preview-old' },
        new: { pairId: 'preview-new', rendererSha: source.pair.commitSha, serializerId: 'preview-new' } } };
    operationId = rehearsalOperationId(packet, 'hold-old');
    const before = (await firestore.doc('cmsPosts/story').get()).data()!;
    beforeDocumentDigest = protocol.publicReleaseDigest(before);
    nextDocument = { ...before, version: before.version + 1,
      published: { ...before.published, sourceVersion: before.version + 1,
        metadata: { ...before.published.metadata, title: 'Native original CAS source' } } };
    owners = createRehearsalPublicOwners({ firestore, packet, store: r2.store, credentials: source.transport.credentials,
      credentialsForPair: async pair => { credentialsSeen.add(pair.pairId); return source.transport.credentials(); },
      ingress: { prove: async () => { throw new Error('No terminal writer in this test'); } }, fieldValues: FieldValue, authorized: true });
  }, 120_000);
  afterAll(async () => { try { await source?.close(); await r2?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });
  it('refuses an unaccepted source plan when the exact before-document digest differs', async () => {
    const before = await firestore.doc('cmsPosts/story').get();
    await expect(accept('0'.repeat(64))).rejects.toThrow();
    expect((await before.ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
    expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).exists).toBe(false);
  });
  it('accepts through the native family CAS but never treats a pending marker as completed work', async () => {
    original = await accept();
    expect(original.operationId).toBe(operationId); expect(await read()).toBe(null);
  });
  it('reads the actual completed original claim without inventing a terminal acknowledgement', async () => {
    await source.replayOperation(operationId);
    const rendered = await owners.recover(operationId);
    expect(rendered.status).toBe('rendered');
    const observed = await read();
    expect(observed).toMatchObject({ operationId, originalPair: 'old', sourceVersion: nextDocument.published.sourceVersion,
      acceptedCount: 1, terminalCount: 0, terminalReceiptDigest: null, claimDigest: rendered.execution.claimDigest });
  });
  it('uses credentials for each exact physical pair in the actual native qualifiers', async () => {
    await owners.qualify('old', '66666666666666666666');
    await owners.qualify('new', '77777777777777777777');
    expect([...credentialsSeen].sort()).toEqual([packet.oldPair.pairId, packet.newPair.pairId].sort());
  });
  it('resolves original acceptance before the before-source check and preserves a later private edit', async () => {
    const ref = firestore.doc('cmsPosts/story'), current = (await ref.get()).data()!;
    const future = { ...current, version: current.version + 10, metadata: { ...current.metadata, title: 'Private future edit' } };
    await ref.set(future); const before = await ref.get();
    expect(await accept()).toEqual(original);
    expect((await ref.get()).data()).toEqual(future);
    expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  });
});
