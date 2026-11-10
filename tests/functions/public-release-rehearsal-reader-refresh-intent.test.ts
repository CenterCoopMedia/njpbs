import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { bridgeFixture } from '../helpers/cms-reader-bridge.js';
import { releasePair } from '../helpers/private-public-release-pair.js';
import protocol from '../../functions/lib/public-release-pair.js';
import { originalRehearsalReaderRequest } from '../../scripts/lib/rehearsal-reader-refresh-intent.mjs';

// Metadata retention only. No installed bridge, transport or readiness exists
// in this fixture. Actual native replay/installation must consume the intent.
describe.sequential('original reader request survives native verification metadata refresh', () => {
  const firestore = isolatedFirestore('rehearsal-reader-refresh-intent'), fixture = bridgeFixture();
  let packet: any, observed: any, request: any, sourceSha: string, original: any;
  const ref = firestore.doc('publicReleaseRehearsalRuns/reader-request-proof/readerRefresh/original');
  const read = (extra = {}) => originalRehearsalReaderRequest({ firestore, packet, sourceSha,
    configurationDigest: 'a'.repeat(64), observed, authorized: true, ...extra });
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
    sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    packet = { schemaVersion: 1, runId: 'reader-request-proof', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: releasePair(), newPair: releasePair('b', 'b'.repeat(40)),
      previewPairs: Object.fromEntries(fixture.state.previewPairs.map((value, index) => [index ? 'new' : 'old',
        { pairId: value.pairId, rendererSha: value.rendererSha, serializerId: value.serializerId }])) };
    observed = { state: fixture.state, readers: fixture.request.readers, baselineDigest: 'b'.repeat(64),
      baselineVersion: { seconds: 1, nanoseconds: 0 } };
    request = { ...fixture.request, operationId: `reader-rnp-${protocol.publicReleaseDigest({ runId: packet.runId, state: observed.state }).slice(0, 32)}` };
    await firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}`).create({ schemaVersion: 1, sourceSha,
      packetDigest: protocol.publicReleaseDigest(packet) });
  });
  afterAll(() => vi.unstubAllEnvs());
  it('stays default-off and does not turn an absent intent into a bridge proof', async () => {
    await expect(read({ authorized: false, request })).rejects.toThrow();
    expect(await read()).toBe(null); expect((await ref.get()).exists).toBe(false);
  });
  it('retains exact original request bytes when the same deployed readers receive newer verifiedAt metadata', async () => {
    original = await read({ request }); const before = await ref.get();
    const newer = structuredClone(observed);
    for (const reader of Object.values(newer.readers) as any[]) reader.verifiedAt = new Date(Date.parse(reader.verifiedAt) + 1).toISOString();
    expect(await read({ observed: newer })).toEqual(original);
    expect((await read({ observed: newer })).request.readers).toEqual(request.readers);
    expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  });
  it('refuses changed source state/configuration instead of silently minting another bridge operation', async () => {
    await expect(read({ configurationDigest: 'c'.repeat(64) })).rejects.toThrow();
    const changed = structuredClone(observed); changed.state.publicSelectorDigest = 'd'.repeat(64);
    await expect(read({ observed: changed })).rejects.toThrow();
    expect(await read()).toEqual(original);
  });
  it('refuses a rewritten and restored original request', async () => {
    const before = (await ref.get()).data()!;
    await ref.set({ ...before, configurationDigest: 'e'.repeat(64) }); await ref.set(before);
    await expect(read()).rejects.toThrow();
  });
});
