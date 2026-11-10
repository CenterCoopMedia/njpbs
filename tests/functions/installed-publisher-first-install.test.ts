import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { firstInstallScenario, compile, slotSource } from '../helpers/private-pair-first-install.mjs';
import { installPrivatePublicRelease } from '../../scripts/install-private-public-release.mjs';
import { installPrivatePairPublisher } from '../../scripts/lib/private-pair-publisher-install.mjs';
import { completePrivatePairPublisherInstall } from '../../scripts/lib/private-pair-first-install-completion.mjs';
import { privateInstallLedger } from '../../scripts/lib/public-release-private-install-ledger.mjs';
import { installPrivateWorker } from '../../scripts/lib/public-release-private-provider.mjs';
import { captureRehearsalInstalledCensus, bindRehearsalInstalledCensus, readRehearsalInstalledCensus } from '../../scripts/lib/rehearsal-installed-census.mjs';
import { matchesInstalledPublisherIntent, readInstalledPublisherCompletion } from '../../scripts/lib/installed-publisher-pair.mjs';
import { inspectPrivatePairPublisherTarget } from '../../scripts/lib/private-pair-publisher-target.mjs';
import protocol from '../../functions/lib/public-release-pair.js';
import rollout from '../../functions/lib/public-release-pair-rollout.js';

let firestore: ReturnType<typeof isolatedFirestore>;
beforeAll(() => { firestore = isolatedFirestore('installed-publisher-first-install'); });
beforeEach(async () => {
  for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, firestore);
});
afterEach(() => vi.unstubAllEnvs());

async function installed() {
  const current = await firstInstallScenario({ continuationEnabled: true });
  for (let index = 0; index < 2; index++) await installPrivatePairPublisher({ ...current.publisherInput(firestore, index), uploadOnly: true });
  const plan = current.slotPlan(), ledger = privateInstallLedger(firestore);
  const slots = await installPrivatePublicRelease({ plan, ledger, provider: current.provider, compile, dryRun: false });
  for (let index = 0; index < 2; index++) {
    await completePrivatePairPublisherInstall({ firestore, plan: current.intents[index].plan, installPlan: plan,
      readToken: current.readToken, fetchImpl: current.fetchImpl, compile, authorized: true });
    await installPrivatePairPublisher(current.publisherInput(firestore, index));
  }
  const workers = slots.readbacks.map((row: any, index: number) => ({ role: ['slot-old', 'slot-new', 'ingress'][index],
    attemptId: plan.operationId, attemptPlanDigest: protocol.publicReleaseDigest(plan), workerName: row.worker,
    workerPlanDigest: row.planDigest, versionId: row.versionId }));
  const config = { name: 'njpbs-private-operator-first-install', main: '/fixture/operator.ts', account_id: plan.accountId,
    compatibility_date: '2026-07-09', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false,
    routes: [], r2_buckets: [], services: [], vars: { FIXTURE: 'operator' } };
  const attemptId = 'first-install-operator', { main, ...portable } = config;
  const workerPlanDigest = protocol.publicReleaseDigest({ config: portable, sourceDigest: createHash('sha256').update(slotSource).digest('hex') });
  const attemptPlanDigest = protocol.publicReleaseDigest({ attemptId, workerPlanDigest });
  await ledger.bindAttempt(attemptId, attemptPlanDigest);
  const operator = await installPrivateWorker({ ledger, provider: current.provider, attemptId, config, source: slotSource, dryRun: false });
  workers.push({ role: 'operator', attemptId, attemptPlanDigest, workerName: config.name, workerPlanDigest, versionId: operator.versionId });
  const packet = { schemaVersion: 1, projectId: firestore.projectId, emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    runId: 'first-install-census', oldPair: slots.pairs[0], newPair: slots.pairs[1] };
  const options = { firestore, packet, publishers: current.intents.map((value: any) => value.plan), workers,
    sourceSha: 'a'.repeat(40), authorized: true };
  return { ...current, pairs: slots.pairs, options };
}

it('censuses both native first-install completions and their exact original slot/ingress receipts', async () => {
  const current = await installed(), writes = current.effects.length;
  const census = await captureRehearsalInstalledCensus(current.options);
  await bindRehearsalInstalledCensus(census, census.receiptDigest);
  await expect(readRehearsalInstalledCensus(census, census.receiptDigest)).resolves.toMatchObject({ providerAttempts: 0 });
  const stored = (await firestore.doc('publicReleaseRehearsalInstalls/first-install-census').get()).data()!;
  expect(stored.records.filter((row: any) => row.path.endsWith('/completions/pair'))).toHaveLength(2);
  for (let index = 0; index < 2; index++) {
    const plan = current.intents[index].plan, pair = current.pairs[index];
    expect(matchesInstalledPublisherIntent(plan, pair)).toBe(true);
    expect((await readInstalledPublisherCompletion({ firestore, plan, pair })).pair).toEqual(pair);
    const target = await inspectPrivatePairPublisherTarget({ firestore, plan, prepared: current.intents[index].prepared,
      readToken: current.readToken, fetchImpl: current.fetchImpl });
    expect(target.pair).toEqual(pair); expect(target.evidence.trigger).toBeDefined();
  }
  expect(current.effects).toHaveLength(writes);
});

it.each(['missing', 'different-pair', 'wrong-plan', 'wrong-owner', 'wrong-ledger', 'rewrite'])(
  'refuses a %s completion before capturing installed authority', async fault => {
    const current = await installed(), pair = current.pairs[0], plan = current.intents[0].plan;
    const ref = firestore.doc(rollout.publicReleasePairUploadCompletionPath(pair.pairId)), original = (await ref.get()).data()!;
    const census = await captureRehearsalInstalledCensus(current.options);
    await bindRehearsalInstalledCensus(census, census.receiptDigest);
    if (fault === 'missing') await ref.delete();
    let replacement;
    if (fault === 'different-pair') replacement = { ...original, pair: current.pairs[1] };
    if (fault === 'wrong-plan') replacement = { ...original, planDigest: 'f'.repeat(64) };
    if (fault === 'wrong-owner') replacement = { ...original, installation: { ...original.installation, operationId: 'another-original' } };
    if (fault === 'wrong-ledger') replacement = { ...original, installation: { ...original.installation,
      slot: { ...original.installation.slot, planDigest: 'f'.repeat(64) } } };
    if (replacement) { await ref.delete(); await ref.create(replacement); }
    if (fault === 'rewrite') { await ref.set({ ...original, fault: true }); await ref.set(original); }
    const before = current.effects.length;
    await expect(captureRehearsalInstalledCensus(current.options)).rejects.toThrow();
    await expect(readRehearsalInstalledCensus(census, census.receiptDigest)).rejects.toThrow();
    await expect(readInstalledPublisherCompletion({ firestore, plan, pair })).rejects.toThrow();
    expect(current.effects).toHaveLength(before);
  });

it('refuses a changed slot UUID or reader receipt in offline installed inputs', async () => {
  const current = await installed(), pair = current.pairs[0], plan = current.intents[0].plan;
  expect(matchesInstalledPublisherIntent(plan, { ...pair, readerReceiptDigest: 'f'.repeat(64) })).toBe(false);
  expect(matchesInstalledPublisherIntent(plan, { ...pair,
    publicWorker: { ...pair.publicWorker, versionId: current.pairs[1].publicWorker.versionId } })).toBe(false);
});

it.each(['workerId', 'deploymentId'])('rejects a self-consistent completion whose %s differs from the native ledger', async field => {
  const current = await installed(), pair = current.pairs[0], plan = current.intents[0].plan;
  const ref = firestore.doc(rollout.publicReleasePairUploadCompletionPath(pair.pairId));
  const original = (await ref.get()).data()!;
  const replacement = { ...original, installation: { ...original.installation,
    slot: { ...original.installation.slot, [field]: field === 'workerId' ? 'f'.repeat(32) : 'ffffffff-ffff-4fff-8fff-ffffffffffff' } } };
  await ref.delete(); await ref.create(replacement);
  // Its own shape, pair, origin and tag are valid. The census must compare it
  // to the independent create/deploy receipt rather than trusting that shape.
  await expect(readInstalledPublisherCompletion({ firestore, plan, pair })).resolves.toEqual(replacement);
  const before = current.effects.length;
  await expect(captureRehearsalInstalledCensus(current.options)).rejects.toThrow();
  expect((await firestore.doc('publicReleaseRehearsalInstalls/first-install-census').get()).exists).toBe(false);
  expect(current.effects).toHaveLength(before);
});
