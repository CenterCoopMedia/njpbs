import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { releasePair } from './helpers/private-public-release-pair.js';
import { readRehearsalPairQualifications } from '../scripts/lib/rehearsal-public-qualification.mjs';

let packet, firestore, store;
beforeEach(() => {
  for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS',
    'FIREBASE_CONFIG', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(name, undefined);
  packet = { schemaVersion: 2, mode: 'development', runId: 'installed-qualification', projectId: 'njpbs-site-dev',
    emulatorHost: null, ingressOrigin: 'http://127.0.0.1:18482', proofOrigin: 'http://127.0.0.1:18483',
    adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: releasePair(), newPair: releasePair('b', 'b'.repeat(40)),
    previewPairs: { old: { pairId: 'preview-old', rendererSha: 'a'.repeat(40), serializerId: 'preview-old' },
      new: { pairId: 'preview-new', rendererSha: 'b'.repeat(40), serializerId: 'preview-new' } } };
  firestore = { projectId: 'njpbs-site-dev', doc: vi.fn(() => { throw new Error('No SDK read is authorized by a refusal test'); }) };
  store = { get: vi.fn() };
});
afterEach(() => vi.unstubAllEnvs());
const read = options => readRehearsalPairQualifications({ packet, firestore, store,
  qualifications: ['a', 'b'].map(value => ({ qualificationId: value, receiptDigest: value.repeat(64) })), ...options });
const noReads = () => { expect(firestore.doc).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled(); };

it('requires explicit installed-development authorization before SDK or storage reads', async () => {
  await expect(read()).rejects.toThrow('qualification preflight refused'); noReads();
});
it('reaches the native authority reader for the explicit closed development target without certifying a receipt', async () => {
  await expect(read({ authorized: true })).rejects.toThrow('No SDK read is authorized by a refusal test');
  expect(firestore.doc).toHaveBeenCalledExactlyOnceWith('system/publicReleaseChanges');
  expect(store.get).not.toHaveBeenCalled();
});
it.each([
  ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:18481'], ['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:18480'],
  ['GOOGLE_APPLICATION_CREDENTIALS', '/unopened/adc.json'], ['FIREBASE_CONFIG', '{}'],
  ['GCLOUD_PROJECT', 'njpbs-site'], ['GOOGLE_CLOUD_PROJECT', 'njpbs-site'], ['CMS_DEPLOYMENT_ENVIRONMENT', 'production'],
])('refuses conflicting %s before SDK or storage reads', async (name, value) => {
  vi.stubEnv(name, value); await expect(read({ authorized: true })).rejects.toThrow(); noReads();
});
it('refuses a different actual SDK identity even with the explicit authorization flag', async () => {
  firestore.projectId = 'njpbs-site';
  await expect(read({ authorized: true })).rejects.toThrow('qualification preflight refused'); noReads();
});
it('refuses a production packet before SDK or storage reads', async () => {
  packet.projectId = 'njpbs-site';
  await expect(read({ authorized: true })).rejects.toThrow(); noReads();
});
