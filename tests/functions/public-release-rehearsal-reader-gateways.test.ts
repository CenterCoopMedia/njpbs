import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { rehearsalInstalledCensusFixture } from '../helpers/rehearsal-installed-census.mjs';
import { rehearsalReaderGatewaysFixture, gatewayFixtureAccount, gatewayFixtureOrigins } from '../helpers/rehearsal-reader-gateways.mjs';
import { captureRehearsalInstalledCensus, bindRehearsalInstalledCensus, readRehearsalInstalledCensus } from '../../scripts/lib/rehearsal-installed-census.mjs';
import { readRehearsalReaderGateways } from '../../scripts/lib/rehearsal-reader-gateways.mjs';
import protocol from '../../functions/lib/public-release-pair.js';

describe.sequential('native installed reader gateways and complete SDK census', () => {
  const firestore = isolatedFirestore('rehearsal-reader-gateways');
  let fixture: any, bridge: any, packet: any, census: any, sourceSha: string, writes: number;
  const capture = () => captureRehearsalInstalledCensus({ firestore, packet, sourceSha, publishers: fixture.publishers,
    workers: fixture.workers, gateways: bridge.packets, authorized: true });
  const readers = (extra = {}) => readRehearsalReaderGateways({ firestore, packet, sourceSha, gateways: bridge.packets,
    readToken: bridge.io.readToken, fetchImpl: bridge.io.fetchImpl, authorized: true, ...extra });
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
    sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fixture = await rehearsalInstalledCensusFixture(firestore, { accountId: gatewayFixtureAccount, readerOrigins: gatewayFixtureOrigins });
    bridge = await rehearsalReaderGatewaysFixture(firestore, fixture.pairs);
    packet = { schemaVersion: 1, runId: 'gateway-census-proof', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: fixture.pairs[0], newPair: fixture.pairs[1],
      previewPairs: { old: { pairId: 'preview-old', rendererSha: fixture.pairs[0].commitSha, serializerId: 'preview-old' },
        new: { pairId: 'preview-new', rendererSha: fixture.pairs[1].commitSha, serializerId: 'preview-new' } } };
    writes = bridge.providerWrites();
  }, 120_000);
  afterAll(() => vi.unstubAllEnvs());
  it('reads both actual compiled native gateway/Access originals without a provider or SDK install', async () => {
    expect(await readers()).toEqual({ receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    census = await capture(); await bindRehearsalInstalledCensus(census, census.receiptDigest);
    const saved = (await firestore.doc(`publicReleaseRehearsalInstalls/${packet.runId}`).get()).data()!;
    expect(saved.gateways).toEqual(bridge.packets.map(protocol.publicReleaseDigest));
    expect(saved.records.length).toBeGreaterThan(54);
    expect(bridge.providerWrites()).toBe(writes);
  });
  it('requires the same original gateway roles and stays default-off before credentials', async () => {
    const readToken = vi.fn();
    await expect(readers({ authorized: false, readToken })).rejects.toThrow();
    await expect(readers({ gateways: [...bridge.packets].reverse(), readToken })).rejects.toThrow();
    expect(readToken).not.toHaveBeenCalled(); expect(bridge.providerWrites()).toBe(writes);
  });
  it('refuses different actual compiled provider bytes without another upload or route change', async () => {
    const worker = bridge.workers.get(bridge.packets[0].workerName), original = worker.source;
    worker.source = new TextEncoder().encode('corrupt gateway response');
    try { await expect(readers()).rejects.toThrow(); } finally { worker.source = original; }
    expect(bridge.providerWrites()).toBe(writes);
  });
  it('refuses missing and recreated original domain receipts instead of adopting new SDK versions', async () => {
    const value = bridge.packets[0], key = protocol.publicReleaseDigest({ worker: value.workerName });
    const ref = firestore.doc(`system/publicReleasePrivateInstalls/attempts/${value.operationId}/readbacks/${key}-domain`);
    const before = await ref.get(); await ref.delete();
    await expect(capture()).rejects.toThrow();
    await ref.create(before.data()!);
    await expect(readRehearsalInstalledCensus(census, census.receiptDigest)).rejects.toThrow();
    expect(bridge.providerWrites()).toBe(writes);
  });
});
