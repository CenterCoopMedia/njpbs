import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { bridgeFixture } from '../helpers/cms-reader-bridge.js';
import { releasePair, releaseSelector } from '../helpers/private-public-release-pair.js';
import { selector as previewSelector } from '../helpers/cms-preview-pairs.js';
import protocol from '../../functions/lib/public-release-pair.js';
import preview from '../../functions/lib/cms-preview-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import sessions from '../../functions/lib/cms-reader-session.js';
import { readRehearsalBridgeState, deriveRehearsalReaderCases } from '../../scripts/lib/rehearsal-reader-cases.mjs';

// Historical proof/source metadata are SDK fixtures, not deployed replay or
// current readiness. The producer must still read native CODE/leaf sources.
describe.sequential('rehearsal historical bridge contract source', () => {
  const firestore = isolatedFirestore('rehearsal-reader-state');
  const fixture = bridgeFixture(), pairs = [releasePair(), releasePair('b', 'b'.repeat(40))];
  let packet: any, baseline: any, original: any;
  const proof = firestore.doc('cmsReaderBridgeInstalledProofs/reader-historical-source');
  const read = (input = baseline) => readRehearsalBridgeState({ firestore, packet, baseline: input });
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
    const selector = releaseSelector();
    fixture.state.publicSelectorDigest = protocol.publicReleaseDigest(selector);
    fixture.state.publicPairs.forEach((value, index) => { value.pairDigest = protocol.publicReleaseDigest(pairs[index]); });
    const digests = { publicOld: fixture.state.publicPairs[0].pairDigest, publicNew: fixture.state.publicPairs[1].pairDigest,
      previewOld: preview.digest(fixture.state.previewPairs[0]), previewNew: preview.digest(fixture.state.previewPairs[1]) };
    original = { schemaVersion: 2, proof: { schemaVersion: 2, operationId: 'reader-historical-source',
      requestDigest: 'd'.repeat(64), stateDigest: preview.digest(fixture.state), readers: fixture.request.readers,
      readerIdentities: Object.fromEntries(Object.entries(fixture.request.readers).map(([key, reader]) => [key, sessions.readerSessionDigest(reader)])),
      verifiedAt: '2025-01-01T00:00:00.000Z', results: ['functions', 'cmsApi'].flatMap(component => fixture.request.cases.map(value => ({
        component, scope: value.scope, feature: value.feature, version: value.version, pairDigest: digests[value.scope], ...value.expected }))) },
      readerDigests: Object.fromEntries(Object.entries(fixture.request.readers).map(([key, value]) => [key, preview.digest(value)])) };
    await proof.create(original); await firestore.doc('system/publicDeployment').set(selector);
    for (const pair of pairs) await work.registerPublicReleasePair({ firestore, pair });
    for (const pair of fixture.state.previewPairs) await preview.registerPair(firestore, pair);
    await firestore.doc(preview.SELECTOR_PATH).set(previewSelector(...fixture.state.previewPairs));
    for (const [component, reader] of Object.entries(fixture.request.readers))
      await firestore.doc(`${preview.READER_RECEIPTS}/${component}`).set({ schemaVersion: 2, component, state: 'complete', lastComplete: reader });
    packet = { schemaVersion: 1, runId: 'reader-state-source', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: pairs[0], newPair: pairs[1],
      previewPairs: Object.fromEntries(fixture.state.previewPairs.map((value, index) => [index ? 'new' : 'old',
        { pairId: value.pairId, rendererSha: value.rendererSha, serializerId: value.serializerId }])) };
    baseline = { bridgeOperationId: 'reader-historical-source', retainedState: fixture.state };
  });
  afterAll(() => vi.unstubAllEnvs());
  it('keeps historical requirements unchanged while observing the real current selector without retagging the old proof', async () => {
    const before = await proof.get(), root = firestore.doc('system/publicDeployment'), value = (await root.get()).data()!;
    await root.set({ ...value, contentHead: { ...value.contentHead, contextSequence: value.contentHead.contextSequence + 1, manifestDigest: 'f'.repeat(64) } });
    const observed = await read();
    expect(observed.state.publicPairs).toEqual(fixture.state.publicPairs);
    expect(observed.state.publicSelectorDigest).not.toBe(fixture.state.publicSelectorDigest);
    expect(observed).not.toHaveProperty('ready'); expect(observed).not.toHaveProperty('receiptDigest');
    expect((await proof.get()).data()).toEqual(original);
    expect((await proof.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  });
  it('refuses changed retained requirements instead of reusing the original expected hashes', async () => {
    const changed = structuredClone(baseline); changed.retainedState.publicPairs[0].requirements.settings = 2;
    await expect(read(changed)).rejects.toThrow();
  });
  it('refuses a different actual current reader identity', async () => {
    const ref = firestore.doc(`${preview.READER_RECEIPTS}/functions`), before = (await ref.get()).data()!;
    await ref.set({ ...before, lastComplete: { ...before.lastComplete, providerIdentities: { deploymentId: 'another-reader' } } });
    try { await expect(read()).rejects.toThrow(); } finally { await ref.set(before); }
  });
  const derive = (templates, readStaffToken = vi.fn()) => deriveRehearsalReaderCases({ firestore, packet, baseline, templates,
    readStaffToken, authenticate: async () => ({ uid: 'fixture', principal: { id: 'fixture', grants: [{ role: 'admin' }] } }), authorized: true });
  it('rejects supplied expected-response hashes at the request-template boundary', async () => {
    await expect(derive(fixture.request.cases)).rejects.toThrow();
  });
  it('fails closed on missing original native CODE before consuming a staff credential', async () => {
    const readStaffToken = vi.fn();
    const templates = fixture.request.cases.map(({ scope, feature, version, body }) => ({ scope, feature, version,
      body: feature === 'publicCode' ? {} : body }));
    await expect(derive(templates, readStaffToken)).rejects.toThrow();
    expect(readStaffToken).not.toHaveBeenCalled();
  });
  it('refuses a same-content restored historical proof after its SDK version changed', async () => {
    const before = await proof.get();
    await proof.set({ ...original, readerDigests: { ...original.readerDigests, functions: '0'.repeat(64) } }); await proof.set(original);
    expect((await proof.get()).updateTime!.isEqual(before.updateTime!)).toBe(false);
    await expect(read()).rejects.toThrow();
  });
});
