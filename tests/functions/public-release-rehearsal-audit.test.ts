import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseR2Fixture } from '../helpers/public-release-r2-fixture';
import { guardedPublicReleaseSwitchFixture } from '../helpers/guarded-public-release-switch';
import { createRehearsalPublicOwners } from '../../scripts/lib/rehearsal-public-owners.mjs';
import { PUBLICATION_STEPS, rehearsalOperationId } from '../../scripts/lib/public-release-rehearsal.mjs';
import { captureRehearsalAuditBaseline, readRehearsalOperationAudit } from '../../scripts/lib/rehearsal-installed-audit.mjs';
import { createPublicReleaseRouter } from '../../workers/src/public-release-router';
import { createPublicReleaseSlot } from '../../workers/src/public-release-slot';
import serving from '../../functions/lib/public-release-serving.js';
import admission from '../../functions/lib/public-release-admission.js';
import { recoverOriginalPublicReleaseWork } from '../../site/scripts/public-release-original-work-recovery';
import { activateStagedPublicReleasePairPublication } from '../../site/scripts/public-release-pair-content-activation';
import { preparePublicReleasePublicationTerminal, settlePreparedPublicReleasePublication } from '../../site/scripts/public-release-publication-terminal';

// Genuine SDK and native family/completed-claim/activation/terminal owners.
// Small sealed renderer and HTTP fixtures; this tests the complete operation
// census, not scheduler composition, installed provider readiness or a PASS.
describe.sequential('native complete rehearsal operation audit', () => {
  const firestore = isolatedFirestore('rehearsal-operation-audit');
  let r2: any, source: any, owners: any, packet: any, baseline: any;
  const options = () => ({ firestore, packet, authorized: true });
  const audit = () => readRehearsalOperationAudit({ ...options(), baseline });
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
    r2 = await publicReleaseR2Fixture('rehearsal-operation-audit');
    source = await guardedPublicReleaseSwitchFixture(firestore, r2.store);
    const oldPair = source.selected.pair, newPair = source.pair;
    packet = { schemaVersion: 1, runId: 'complete-native-census', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair, newPair,
      previewPairs: { old: { pairId: 'preview-old', rendererSha: oldPair.commitSha, serializerId: 'preview-old' },
        new: { pairId: 'preview-new', rendererSha: newPair.commitSha, serializerId: 'preview-new' } } };
    const router = createPublicReleaseRouter({ environment: 'development',
      readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: 'development' }),
      slots: [oldPair, newPair].map(pair => createPublicReleaseSlot({ pair, workerVersionId: pair.publicWorker.versionId, store: r2.store,
        getDecision: (selection: any, path: string) => serving.readPublicReleaseDecision({ firestore, environment: 'development', pair, selection, path, composedReadersEnabled: true }) })) });
    const ingress = { prove: (request: Request, digest: string, expected: any) => router.prove(request, digest, expected) };
    owners = createRehearsalPublicOwners({ ...options(), store: r2.store, credentials: source.transport.credentials, ingress, fieldValues: FieldValue });
    // The real shared fixture accepts/replays its context operation but leaves
    // its queue unsettled. First prove baseline refuses it, then complete that
    // exact native operation before measuring this run. Never seed/reset a head.
    await expect(captureRehearsalAuditBaseline(options())).rejects.toThrow();
    const setupOperation = 'candidate-media-ready';
    const unavailable = async () => { throw new Error('No mutable fixture resource'); };
    const original = await recoverOriginalPublicReleaseWork({ firestore, store: r2.store, pair: oldPair, operationId: setupOperation,
      capture: { resourceRequest: unavailable, providerStore: { get: unavailable, put: unavailable } } });
    if (original.status !== 'rendered') throw new Error('Native fixture setup operation incomplete');
    const execution = original.execution;
    await activateStagedPublicReleasePairPublication({ firestore, store: r2.store, pair: oldPair,
      identity: execution.identity, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest });
    const proof = await preparePublicReleasePublicationTerminal({ firestore, store: r2.store, ingress,
      fieldValues: FieldValue, operationId: setupOperation });
    await settlePreparedPublicReleasePublication({ firestore, proof });
    baseline = await captureRehearsalAuditBaseline(options());
  }, 120_000);
  afterAll(async () => { try { await source?.close(); await r2?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });
  async function accept(operationId: string) {
    const story = (await firestore.doc('cmsPosts/story').get()).data()!;
    await owners.acceptPost({ operationId, documentId: 'story', nextDocument: { ...story, version: story.version + 1,
      publishBuildPending: true, publishBuildQueueId: operationId,
      published: { ...story.published, sourceVersion: story.version + 1, metadata: { ...story.published.metadata, title: operationId } } } });
  }
  for (const step of PUBLICATION_STEPS) {
    it(`renders the original native ${step} admission without fabricating a fact`, async () => {
      const operationId = rehearsalOperationId(packet, step);
      await accept(operationId); await source.replayOperation(operationId);
      expect((await owners.recover(operationId)).status).toBe('rendered');
    });
    it(`settles the exact original ${step} claim`, async () => {
      if (step === PUBLICATION_STEPS.at(-1)) await expect(audit()).rejects.toThrow();
      expect((await owners.finish(rehearsalOperationId(packet, step))).receipt.outcome).toBe('success');
    });
  }
  it('measures ten actual immutable admissions and native terminal facts with no pending work', async () => {
    expect(await audit()).toMatchObject({ accepted: 10, terminal: 10, duplicateOperations: 0, orphanedOperations: 0 });
  });
  it('refuses a stray queue outside the enumerated ten operations', async () => {
    const ref = firestore.doc('cmsPublishQueue/stray-native-audit');
    await ref.create({ status: 'pending' }); // Negative database corruption boundary only.
    try { await expect(audit()).rejects.toThrow(); } finally { await ref.delete(); }
  });
  it('refuses two original IDs claiming the same source identity', async () => {
    const first = firestore.doc(`${admission.ADMISSIONS}/operations/${rehearsalOperationId(packet, PUBLICATION_STEPS[0])}`);
    const second = firestore.doc(`${admission.ADMISSIONS}/operations/${rehearsalOperationId(packet, PUBLICATION_STEPS[1])}`);
    const original = (await second.get()).data()!, duplicate = (await first.get()).data()!;
    // Corrupt only the negative boundary; no synthetic row supplies success.
    await second.delete(); await second.create({ ...original, source: duplicate.source });
    try { await expect(audit()).rejects.toThrow(); }
    finally { await second.delete(); await second.create(original); }
  });
  it('refuses a real extra native acceptance that the session did not enumerate', async () => {
    await accept('12345678901234567890');
    await expect(audit()).rejects.toThrow();
  });
});
