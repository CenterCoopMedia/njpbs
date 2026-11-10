import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { releasePair, releaseSelector } from '../helpers/private-public-release-pair.js';
import { openRehearsalJournal } from '../../scripts/lib/rehearsal-installed-journal.mjs';
import protocol from '../../functions/lib/public-release-pair.js';

// This exercises durable history, not provider readiness or a rehearsal PASS.
// Actual native owner/HTTP verification belongs to the session and harness.
describe.sequential('original verified rehearsal SDK history', () => {
  const firestore = isolatedFirestore('rehearsal-native-journal');
  const state = { selector: releaseSelector(), primary: { phase: 'ready', release: 'a'.repeat(40) },
    cloud: { phase: 'ready', release: 'a'.repeat(40) }, admission: true, previewReady: true, providerAttempts: 0,
    preview: { selector: { schemaVersion: 2, phase: 'ready', epoch: 1, selectedPairId: 'preview-old', recoveryPairId: 'preview-new',
      rendererSha: 'a'.repeat(40), serializerId: 'preview-old' }, adminManifestDigest: 'b'.repeat(64), adminReceiptDigest: 'c'.repeat(64) } };
  let packet: any, journal: any, first: any;
  const options = () => ({ firestore, packet, sourceSha: 'a'.repeat(40), adapterDigest: 'd'.repeat(64),
    censusDigest: 'e'.repeat(64), executionDigest: '5'.repeat(64), initialState: state, authorized: true });
  const receipt = (step: string) => ({ step, actionId: `${packet.runId}-${step}`,
    result: { schemaVersion: 1, actionId: `${packet.runId}-${step}`, outcome: 'complete', state, receiptDigest: 'f'.repeat(64) },
    observed: { schemaVersion: 1, actionId: `${packet.runId}-${step}-inspect`, outcome: 'complete', state, receiptDigest: '1'.repeat(64) } });
  beforeAll(() => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
    packet = { schemaVersion: 1, runId: 'native-journal-proof', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: releasePair(), newPair: releasePair('b', 'b'.repeat(40)),
      previewPairs: { old: { pairId: 'preview-old', rendererSha: 'a'.repeat(40), serializerId: 'preview-old' },
        new: { pairId: 'preview-new', rendererSha: 'b'.repeat(40), serializerId: 'preview-new' } } };
  });
  afterAll(() => vi.unstubAllEnvs());
  it('stays default-off and refuses a real project before creating any run', async () => {
    await expect(openRehearsalJournal({ ...options(), authorized: false })).rejects.toThrow();
    await expect(openRehearsalJournal({ ...options(), packet: { ...packet, projectId: 'njpbs-site' } })).rejects.toThrow();
    expect((await firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}`).get()).exists).toBe(false);
  });
  it('binds the initial authority and census once, and refuses an out-of-order completion', async () => {
    journal = await openRehearsalJournal(options());
    expect(await journal.recover()).toEqual([]);
    await expect(journal.record(receipt('scheduled'))).rejects.toThrow();
    expect(await journal.recover()).toEqual([]);
  });
  it('keeps original full receipt bytes on an idempotent retry and restart', async () => {
    first = receipt('baseline'); await journal.record(first);
    const ref = firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/actions/${first.actionId}`), before = await ref.get();
    expect(await journal.record(first)).toEqual(first);
    expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
    const resumed = await openRehearsalJournal({ ...options(), initialState: { ...state, selector: { ...state.selector, epoch: 3 } } });
    expect(resumed.initialState).toEqual(state);
    expect(JSON.stringify(await resumed.recover())).toBe(JSON.stringify([first]));
    expect(await resumed.recoverBytes()).toEqual([{ receipt: first, bytes: JSON.stringify(first, null, 2) + '\n' }]);
    await expect(resumed.record({ ...first, result: { ...first.result, receiptDigest: '2'.repeat(64) } })).rejects.toThrow();
  });
  it('refuses a changed source or installed census without rebinding the original run', async () => {
    await expect(openRehearsalJournal({ ...options(), sourceSha: 'b'.repeat(40) })).rejects.toThrow();
    await expect(openRehearsalJournal({ ...options(), censusDigest: '3'.repeat(64) })).rejects.toThrow();
    await expect(openRehearsalJournal({ ...options(), executionDigest: '6'.repeat(64) })).rejects.toThrow();
    expect(await journal.recover()).toEqual([first]);
  });
  it('refuses a rewritten then restored journal even when its values and digest match', async () => {
    const ref = firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/actions/${first.actionId}`), before = (await ref.get()).data()!;
    await ref.set({ ...before, receiptDigest: '4'.repeat(64) }); await ref.set(before);
    expect(protocol.publicReleaseDigest((await ref.get()).data())).toBe(protocol.publicReleaseDigest(before));
    await expect(journal.recover()).rejects.toThrow();
  });
});
