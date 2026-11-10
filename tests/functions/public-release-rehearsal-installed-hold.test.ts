import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseR2Fixture } from '../helpers/public-release-r2-fixture';
import { guardedPublicReleaseSwitchFixture } from '../helpers/guarded-public-release-switch';
import { createRehearsalPublicOwners } from '../../scripts/lib/rehearsal-public-owners.mjs';
import { createRehearsalHoldActions } from '../../scripts/lib/rehearsal-installed-hold.mjs';
import { REHEARSAL_HOLD_OWNER_BLOBS } from '../../scripts/lib/rehearsal-hold-owner-blobs.mjs';
import { rehearsalOperationId } from '../../scripts/lib/public-release-rehearsal.mjs';
import admission from '../../functions/lib/public-release-admission.js';
import nativeHolds from '../../functions/lib/public-release-rehearsal-hold.js';
import { createPublicReleaseRouter } from '../../workers/src/public-release-router';
import { createPublicReleaseSlot } from '../../workers/src/public-release-slot';
import serving from '../../functions/lib/public-release-serving.js';
import { openRehearsalJournal } from '../../scripts/lib/rehearsal-installed-journal.mjs';
import { rehearsalSourceCommit } from '../../scripts/lib/public-release-rehearsal.mjs';
import { prepareRehearsalAcceptedRecovery, advanceRehearsalAcceptedRecovery } from '../../scripts/lib/rehearsal-accepted-recovery.mjs';
import { readRehearsalControlEvidence } from '../../scripts/lib/rehearsal-installed-controls.mjs';

// Native SDK/family/hold owners. Source-tree and small renderer/HTTP boundaries
// are fixtures; this is not an installed-image or full rehearsal certificate.
describe.sequential('installed rehearsal binding to the native operation hold', () => {
  const firestore = isolatedFirestore('installed-rehearsal-hold');
  let r2: Awaited<ReturnType<typeof publicReleaseR2Fixture>>, fixture: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
  let packet: any, owners: ReturnType<typeof createRehearsalPublicOwners>, actions: ReturnType<typeof createRehearsalHoldActions>, next: any, intent: any;
  let sourceSha: string, recovery: any, admissionVersion: any;
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
    r2 = await publicReleaseR2Fixture('installed-rehearsal-hold');
    fixture = await guardedPublicReleaseSwitchFixture(firestore, r2.store);
    packet = { schemaVersion: 1, runId: 'native-hold-action', projectId: firestore.projectId, emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
      ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397', adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'),
      oldPair: fixture.selected.pair, newPair: fixture.pair,
      previewPairs: { old: { pairId: 'preview-old', rendererSha: fixture.selected.pair.commitSha, serializerId: 'preview-old' },
        new: { pairId: 'preview-new', rendererSha: fixture.pair.commitSha, serializerId: 'preview-new' } } };
    const current = (await firestore.doc('cmsPosts/story').get()).data()!;
    next = { ...current, id: 'story', type: 'post', version: current.version + 1,
      publishBuildPending: true, publishBuildQueueId: rehearsalOperationId(packet, 'hold-old'), published: { ...current.published, sourceVersion: current.version + 1,
      metadata: { ...current.published.metadata, title: 'Native held source' } } };
    const router = createPublicReleaseRouter({ environment: 'development',
      readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: 'development' }),
      slots: [packet.oldPair, packet.newPair].map(pair => createPublicReleaseSlot({ pair, workerVersionId: pair.publicWorker.versionId, store: r2.store,
        getDecision: (selection: any, path: string) => serving.readPublicReleaseDecision({ firestore, environment: 'development', pair, selection, path, composedReadersEnabled: true }) })) });
    const ingress = { prove: (request: Request, digest: string, expected: any) => router.prove(request, digest, expected) };
    owners = createRehearsalPublicOwners({ firestore, packet, store: r2.store, credentials: fixture.transport.credentials, ingress, fieldValues: FieldValue, authorized: true });
    const initialEpoch = (await firestore.doc('system/publicDeployment').get()).data()!.epoch;
    actions = createRehearsalHoldActions({ firestore, packet, initialEpoch, durationMs: 60_000,
      cases: { old: { documentId: 'story', nextDocument: next }, new: { documentId: 'story', nextDocument: next } },
      store: r2.store, ingress, fieldValues: FieldValue, authorized: true,
      readSource: () => Object.fromEntries(Object.entries(REHEARSAL_HOLD_OWNER_BLOBS).map(([path, entries]) => [path, entries.at(-1)!.blob])) });
    sourceSha = rehearsalSourceCommit();
    // This is a failed-window recovery component, not a rehearsal certificate.
    // Bind the real initial selector; no fabricated readiness result is used.
    await openRehearsalJournal({ firestore, packet, sourceSha, adapterDigest: 'a'.repeat(64),
      censusDigest: 'b'.repeat(64), executionDigest: 'c'.repeat(64), authorized: true,
      initialState: { selector: (await firestore.doc('system/publicDeployment').get()).data() } });
  }, 120_000);
  afterAll(async () => { try { await fixture?.close(); await r2?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });
  it('reserves the exact original operation before acceptance and reuses its immutable original intent', async () => {
    intent = await actions.reserve('old');
    expect(intent.intent.plan.operationId).toBe(rehearsalOperationId(packet, 'hold-old'));
    expect((await actions.reserve('old')).intent).toEqual(intent.intent);
    expect((await actions.read('old'))?.status).toBe('reserved');
    expect((await firestore.doc(`cmsPublishQueue/${intent.intent.plan.operationId}`).get()).exists).toBe(false);
  });
  it('uses the actual family transaction to attach the original digest and preserves its pending debt', async () => {
    const original = await owners.acceptPost({ operationId: intent.intent.plan.operationId, documentId: 'story', nextDocument: next });
    const state = await actions.read('old');
    expect(state?.status).toBe('held'); expect(state?.binding?.admissionDigest).toBeDefined();
    expect(original.operationId).toBe(intent.intent.plan.operationId);
    admissionVersion = (await firestore.doc(`${admission.ADMISSIONS}/operations/${original.operationId}`).get()).updateTime;
    expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${original.operationId}`).get()).exists).toBe(true);
    expect((await firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${original.operationId}`).get()).exists).toBe(false);
  });
  it('refuses early or renamed release without a fabricated terminal or hold outcome', async () => {
    await expect(actions.release('old', 'different-action')).rejects.toThrow();
    await expect(actions.release('old', `${packet.runId}-settle-old`)).rejects.toThrow();
    expect((await actions.read('old'))?.status).toBe('held');
    expect((await firestore.doc(`${nativeHolds.path(intent.intent.plan.operationId)}/receipts/outcome`).get()).exists).toBe(false);
  });
  it('cancels through only the original owner and leaves terminal settlement to continuation', async () => {
    await expect(actions.cancel('old', 'different-action')).rejects.toThrow();
    const options = { firestore, packet, sourceSha, owners, holds: actions, recoveryOnly: true, authorized: true };
    await expect(prepareRehearsalAcceptedRecovery({ ...options, recoveryOnly: false })).rejects.toThrow();
    await expect(prepareRehearsalAcceptedRecovery({ ...options, owners: { ...owners } })).rejects.toThrow();
    await expect(prepareRehearsalAcceptedRecovery({ ...options, holds: { ...actions } })).rejects.toThrow();
    recovery = await prepareRehearsalAcceptedRecovery(options);
    expect(recovery.operationIds).toEqual([intent.intent.plan.operationId]);
    expect((await actions.read('old'))?.status).toBe('cancelled');
    expect((await firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${intent.intent.plan.operationId}`).get()).exists).toBe(false);
    expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${intent.intent.plan.operationId}`).get()).exists).toBe(true);
    expect((await firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/controls/failure`).get()).exists).toBe(true);
  });
  it('renders only that already accepted original after its native hold cancellation', async () => {
    await fixture.replayOperation(intent.intent.plan.operationId);
    expect((await owners.recover(intent.intent.plan.operationId)).status).toBe('rendered');
    const observed = await advanceRehearsalAcceptedRecovery(recovery, intent.intent.plan.operationId, 'render');
    expect(observed).toMatchObject({ operationId: intent.intent.plan.operationId, acceptedCount: 1, terminalCount: 0 });
  });
  it('settles the original claim through real activation and HTTP terminal proof while the window stays failed', async () => {
    const observed = await advanceRehearsalAcceptedRecovery(recovery, intent.intent.plan.operationId, 'settle');
    expect(observed).toMatchObject({ operationId: intent.intent.plan.operationId, terminalCount: 1 });
    expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${observed.operationId}`).get()).exists).toBe(false);
    expect((await firestore.doc(`${admission.ADMISSIONS}/operations/${observed.operationId}`).get()).updateTime!.isEqual(admissionVersion)).toBe(true);
    await expect(readRehearsalControlEvidence({ firestore, packet, authorized: true })).rejects.toThrow();
  });
  it('retries only the original terminal fact and cannot accept a missing or renamed operation', async () => {
    const first = await advanceRehearsalAcceptedRecovery(recovery, intent.intent.plan.operationId, 'settle');
    expect(await advanceRehearsalAcceptedRecovery(recovery, intent.intent.plan.operationId, 'render')).toEqual(first);
    await expect(advanceRehearsalAcceptedRecovery(recovery, '12345678901234567890', 'render')).rejects.toThrow();
    await expect(advanceRehearsalAcceptedRecovery(recovery, intent.intent.plan.operationId, 'accept')).rejects.toThrow();
    expect((await firestore.doc('cmsPublishQueue/12345678901234567890').get()).exists).toBe(false);
  });
});
