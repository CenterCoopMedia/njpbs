import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { rehearsalInstalledCensusFixture } from '../helpers/rehearsal-installed-census.mjs';
import { captureRehearsalInstalledCensus, bindRehearsalInstalledCensus, readRehearsalInstalledCensus } from '../../scripts/lib/rehearsal-installed-census.mjs';
import rollout from '../../functions/lib/public-release-pair-rollout.js';
import protocol from '../../functions/lib/public-release-pair.js';

describe.sequential('preinstalled native install census', () => {
  const firestore = isolatedFirestore('rehearsal-install-census');
  let fixture: Awaited<ReturnType<typeof rehearsalInstalledCensusFixture>>, packet: any;
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
    fixture = await rehearsalInstalledCensusFixture(firestore);
    packet = { schemaVersion: 1, projectId: firestore.projectId, emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
      runId: 'native-install-census', oldPair: fixture.pairs[0], newPair: fixture.pairs[1] };
  }, 120_000);
  afterAll(() => vi.unstubAllEnvs());
  const capture = (runId = packet.runId, extra = {}) => captureRehearsalInstalledCensus({ firestore, packet: { ...packet, runId },
    sourceSha: 'a'.repeat(40), publishers: fixture.publishers, workers: fixture.workers, authorized: true, ...extra });

  it('binds all actual original owners with zero provider attempts and creates only its own census seal', async () => {
    const writes = fixture.providerWrites(), census = await capture();
    const result = await bindRehearsalInstalledCensus(census, census.receiptDigest);
    expect(result).toEqual({ receiptDigest: census.receiptDigest, providerAttempts: 0 });
    const row = await firestore.doc(`publicReleaseRehearsalInstalls/${packet.runId}`).get();
    expect(row.data()!.workers).toHaveLength(4); expect(row.data()!.plans).toHaveLength(2);
    expect(row.data()!.records.length).toBeGreaterThanOrEqual(50);
    expect(fixture.providerWrites()).toBe(writes);
    expect((await firestore.doc('system/publicDeployment').get()).exists).toBe(false);
  });
  it('reuses the exact original census receipt without a same-content rewrite', async () => {
    const census = await capture(), ref = firestore.doc(`publicReleaseRehearsalInstalls/${packet.runId}`), before = await ref.get();
    await expect(readRehearsalInstalledCensus(census, census.receiptDigest)).resolves.toMatchObject({ providerAttempts: 0 });
    await bindRehearsalInstalledCensus(census, census.receiptDigest);
    expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  });
  it('refuses a serialized handle or an unrelated expected digest', async () => {
    const census = await capture();
    await expect(bindRehearsalInstalledCensus(JSON.parse(JSON.stringify(census)), census.receiptDigest)).rejects.toThrow();
    await expect(bindRehearsalInstalledCensus(census, 'f'.repeat(64))).rejects.toThrow();
  });
  it('refuses a dropped original worker or publisher before making a census claim', async () => {
    await expect(capture('incomplete-census', { workers: fixture.workers.slice(0, 3) })).rejects.toThrow();
    await expect(capture('incomplete-census', { publishers: fixture.publishers.slice(0, 1) })).rejects.toThrow();
    expect((await firestore.doc('publicReleaseRehearsalInstalls/incomplete-census').get()).exists).toBe(false);
  });
  it('keeps the installer operator namespace separate from ingress and slot owners', async () => {
    const transactions = vi.spyOn(firestore, 'runTransaction');
    try {
      for (const [index, workerName] of [[3, 'njpbs-private-ingress-op-census'], [2, 'njpbs-private-operator-wrong-role']] as const) {
        const workers = fixture.workers.map((row: any, i: number) => i === index ? { ...row, workerName } : row);
        await expect(capture('wrong-role-census', { workers })).rejects.toThrow();
        expect(transactions).not.toHaveBeenCalled();
      }
    } finally { transactions.mockRestore(); }
    expect((await firestore.doc('publicReleaseRehearsalInstalls/wrong-role-census').get()).exists).toBe(false);
  });
  it('refuses a same-content rewrite of its create-only census receipt', async () => {
    const census = await capture('rewritten-census'); await bindRehearsalInstalledCensus(census, census.receiptDigest);
    const ref = firestore.doc('publicReleaseRehearsalInstalls/rewritten-census'), before = await ref.get(), original = before.data()!;
    // A no-op SET can preserve the emulator's version. Make a real mutation,
    // then restore exact bytes and prove the version changed before reading.
    await ref.set({ ...original, censusFixtureFault: true });
    await ref.set(original);
    expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(false);
    await expect(readRehearsalInstalledCensus(census, census.receiptDigest)).rejects.toThrow();
  });
  it('refuses an original publisher receipt rewrite even when its bytes are unchanged', async () => {
    const census = await capture('changed-native-receipt'); await bindRehearsalInstalledCensus(census, census.receiptDigest);
    const ref = firestore.doc(`${rollout.publicReleasePairUploadPath(fixture.pairs[0].pairId)}/operations/version`);
    const before = await ref.get(), original = before.data()!;
    await ref.set({ ...original, censusFixtureFault: true }); await ref.set(original);
    expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(false);
    await expect(readRehearsalInstalledCensus(census, census.receiptDigest)).rejects.toThrow();
  });
  it('refuses a missing original immutable worker receipt rather than dropping that target', async () => {
    const target = fixture.workers[3], key = protocol.publicReleaseDigest({ worker: target.workerName });
    await firestore.doc(`system/publicReleasePrivateInstalls/attempts/${target.attemptId}/readbacks/${key}-upload`).delete();
    await expect(capture('missing-native-receipt')).rejects.toThrow();
  });
});
