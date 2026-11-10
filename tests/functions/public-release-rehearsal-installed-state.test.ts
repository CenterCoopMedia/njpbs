import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FieldValue } from 'firebase-admin/firestore';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseR2Fixture } from '../helpers/public-release-r2-fixture';
import { guardedPublicReleaseSwitchFixture } from '../helpers/guarded-public-release-switch';
import { pair, receipt, selector } from '../helpers/cms-preview-pairs.js';
import preview from '../../functions/lib/cms-preview-pair.js';
import protocol from '../../functions/lib/public-release-pair.js';
import admission from '../../functions/lib/public-release-admission.js';
import { readRehearsalInstalledState } from '../../scripts/lib/rehearsal-installed-state.mjs';
import { createInstalledRehearsalPreflights } from '../../scripts/lib/rehearsal-installed-preflights.mjs';
import { createRehearsalPublicOwners } from '../../scripts/lib/rehearsal-public-owners.mjs';
import { InstalledRehearsalStop } from '../../scripts/lib/rehearsal-installed-stop.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { openRehearsalJournal } from '../../scripts/lib/rehearsal-installed-journal.mjs';
import { openRehearsalControlObserver, readRehearsalControlEvidence } from '../../scripts/lib/rehearsal-installed-controls.mjs';

// Real SDK and native admission preparation. Preview source records and small
// rendered packs are fixtures; no deployed reader/provider claim is made.
describe.sequential('installed rehearsal current SDK authority', () => {
  const firestore = isolatedFirestore('rehearsal-installed-state');
  let r2: Awaited<ReturnType<typeof publicReleaseR2Fixture>>, source: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
  let packet: any;
  const observe = (extra = {}) => readRehearsalInstalledState({ firestore, packet, probeDocumentId: 'story', authorized: true, ...extra });
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
    r2 = await publicReleaseR2Fixture('rehearsal-installed-state');
    source = await guardedPublicReleaseSwitchFixture(firestore, r2.store);
    // The switch fixture retains its earlier third pair A. This observation
    // starts at the installed B/C boundary, so supply that source precondition.
    const publicRoot = firestore.doc('system/publicDeployment');
    await publicRoot.update({ recoveryPair: protocol.publicReleasePairReference(source.pair) });
    const old = pair('old'), next = pair('new', 'b'), root = selector(old, next);
    packet = { schemaVersion: 1, runId: 'installed-readonly-state', projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397',
      adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'), oldPair: source.selected.pair, newPair: source.pair,
      previewPairs: Object.fromEntries([['old', old], ['new', next]].map(([side, value]: any) => [side,
        { pairId: value.pairId, rendererSha: value.rendererSha, serializerId: value.serializerId }])) };
    await preview.registerPair(firestore, old); await preview.registerPair(firestore, next);
    await firestore.doc(preview.SELECTOR_PATH).set(root);
    await firestore.doc(preview.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, state: 'complete', pairId: old.pairId,
      selectorDigest: preview.digest(root), lastComplete: { sourceSha: old.rendererSha } });
    await firestore.doc('cmsDeploymentReceipts/adminManifest').set({ state: 'complete', lastComplete: { manifestDigest: 'c'.repeat(64) } });
    for (const component of ['functions', 'cmsApi']) {
      const value = receipt(component);
      value.lastComplete.supported.adminSession = [1, 2];
      await firestore.doc(`${preview.READER_RECEIPTS}/${component}`).set(value);
    }
  }, 120_000);
  afterAll(async () => { try { await source?.close(); await r2?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });

  it('proves actual current admission without creating an operation or touching the source', async () => {
    const path = firestore.doc('cmsPosts/story'), before = await path.get();
    const head = firestore.doc(admission.ADMISSIONS), original = await head.get();
    const state = await observe();
    expect(state.admission).toBe(true); expect(state.previewReady).toBe(true); expect(state.providerAttempts).toBe(0);
    expect(state.selector.selectedPair.pairId).toBe(packet.oldPair.pairId);
    expect((await path.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
    expect((await head.get()).updateTime!.isEqual(original.updateTime!)).toBe(true);
  });
  it('refuses a real disabled admission control even with otherwise ready runtime pins', async () => {
    const ref = firestore.doc(`${admission.ADMISSIONS}/controls/adoption`), before = (await ref.get()).data()!;
    await ref.set({ ...before, enabled: false });
    try { await expect(observe()).rejects.toThrow(); } finally { await ref.set(before); }
  });
  it('refuses current billing disable through the real native admission preparation', async () => {
    const ref = firestore.doc('system/billing'), before = await ref.get();
    await ref.set({ disabled: true });
    try { await expect(observe()).rejects.toThrow(); }
    finally { if (before.exists) await ref.set(before.data()!); else await ref.delete(); }
  });
  it('refuses incompatible live reader sessions and does not invent preview readiness', async () => {
    const ref = firestore.doc(`${preview.READER_RECEIPTS}/functions`), before = (await ref.get()).data()!;
    await ref.set({ ...before, lastComplete: { ...before.lastComplete,
      supported: { ...before.lastComplete.supported, adminSession: [2] } } });
    try { await expect(observe()).rejects.toThrow(); } finally { await ref.set(before); }
  });
  it('refuses default-off invocation and already cancelled observation before reads', async () => {
    await expect(observe({ authorized: false })).rejects.toThrow();
    await expect(observe({ signal: AbortSignal.abort() })).rejects.toThrow();
  });
  const preflights = (qualifications?: any[]) => createInstalledRehearsalPreflights({ firestore, packet,
    probeDocumentId: 'story', sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    adapterDigest: createHash('sha256').update(readFileSync(packet.adapter)).digest('hex'),
    // Unreached provider configuration boundaries only. These references
    // cannot satisfy layer2's actual install owners or opaque census.
    installed: { publishers: [packet.oldPair, packet.newPair].map(pair => ({
      plan: { accountId: 'a'.repeat(32), pairTemplate: pair }, prepared: {} })),
      workers: Array.from({ length: 4 }, () => ({ config: {}, source: new Uint8Array([1]) })) },
    store: r2.store, readToken: async () => { throw new Error('No provider call in these checks'); },
    readerCredentials: [source.transport.credentials, source.transport.credentials], qualifications,
    admin: { target: { environment: 'development', projectId: 'njpbs-site-dev' } }, authorized: true });
  it('runs the original enrollment reader and refuses source-only ready flags without its original capture', async () => {
    await expect(preflights()[1]()).rejects.toThrow('enrollment-head-exists');
  });
  it('cannot substitute the launcher hold API for an older installed runtime source', async () => {
    await expect(preflights()[5]()).rejects.toThrow(InstalledRehearsalStop);
  });
  it('uses the real full-byte/current-source qualification reader for both exact original receipts', async () => {
    const owners = createRehearsalPublicOwners({ firestore, packet, store: r2.store, credentials: source.transport.credentials,
      ingress: { prove: async () => { throw new Error('No canonical writer in preflight'); } }, fieldValues: FieldValue, authorized: true });
    const qualifications = [];
    for (const [index, side] of ['old', 'new'].entries()) {
      const qualified = await owners.qualify(side, `${index + 1}`.repeat(20));
      qualifications.push({ qualificationId: qualified.receipt.qualificationId,
        receiptDigest: protocol.publicReleaseDigest(qualified.receipt) });
    }
    const checks = preflights(qualifications), before = await firestore.doc(admission.ADMISSIONS).get();
    expect(await checks[3]()).toEqual({ receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await firestore.doc(admission.ADMISSIONS).get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
    await expect(preflights([{ ...qualifications[0], receiptDigest: '0'.repeat(64) }, qualifications[1]])[3]()).rejects.toThrow();
    await expect(checks[2]()).rejects.toThrow(); // Typed JSON install references do not replace native evidence.
  });
  async function monitor(runId: string, action: (observer: any, options: any) => Promise<void>) {
    const options = { firestore, packet: { ...packet, runId }, probeDocumentId: 'story', authorized: true };
    await openRehearsalJournal({ ...options, sourceSha: 'a'.repeat(40), adapterDigest: 'd'.repeat(64),
      censusDigest: 'e'.repeat(64), executionDigest: 'f'.repeat(64), initialState: await readRehearsalInstalledState(options) });
    const observer = await openRehearsalControlObserver(options);
    try { await action(observer, options); } finally { observer.stop(); }
  }
  it('records real timed native readiness observations and independently verifies an audit prefix', async () => {
    await monitor('native-control-positive', async (observer, options) => {
      // Each real timer sample includes native observation and commit time.
      // Wait for committed rows; sampler failures must still fail immediately.
      await vi.waitUntil(async () => {
        observer.assertHealthy();
        const samples = await firestore.collection(`publicReleaseRehearsalRuns/${options.packet.runId}/controlSamples`).limit(3).get();
        return samples.size >= 3;
      }, { timeout: 5000, interval: 50 });
      const { states, ...prefix } = await readRehearsalControlEvidence(options);
      expect(prefix.count).toBeGreaterThanOrEqual(3); expect(prefix.controlsContinuous).toBe(true);
      expect(states.every((state: any) => state.admission && state.previewReady)).toBe(true);
      await observer.sampleNow();
      const fresh = await readRehearsalControlEvidence({ ...options, prefix });
      expect(fresh.prefixStates).toEqual(states); expect(fresh.count).toBeGreaterThan(prefix.count);
      await expect(readRehearsalControlEvidence({ ...options, prefix: { ...prefix, digest: '0'.repeat(64) } })).rejects.toThrow();
    });
  });
  it('latches an actual admission-control failure even after the control is restored', async () => {
    await monitor('native-control-failure', async (observer, options) => {
      const ref = firestore.doc('system/billing'), before = await ref.get();
      await ref.set({ disabled: true });
      try { await expect(observer.sampleNow()).rejects.toThrow(); }
      finally { if (before.exists) await ref.set(before.data()!); else await ref.delete(); }
      expect(() => observer.assertHealthy()).toThrow();
      await expect(readRehearsalControlEvidence(options)).rejects.toThrow();
      await expect(openRehearsalControlObserver(options)).rejects.toThrow();
    });
  });
  it('refuses an unobserved gap and cannot start a new parent across that gap', async () => {
    await monitor('native-control-gap', async (observer, options) => {
      await observer.sampleNow(); await observer.sampleNow(); observer.stop();
      await delay(5100);
      await expect(readRehearsalControlEvidence(options)).rejects.toThrow();
      await expect(openRehearsalControlObserver(options)).rejects.toThrow();
    });
  });
  it('detects a disabled then restored admission gate between readiness samples by native version', async () => {
    await monitor('native-control-between-samples', async (observer, options) => {
      const ref = firestore.doc(`${admission.ADMISSIONS}/controls/adoption`), before = (await ref.get()).data()!;
      await ref.set({ ...before, enabled: false }); await ref.set(before);
      await expect(observer.sampleNow()).rejects.toThrow();
      await expect(readRehearsalControlEvidence(options)).rejects.toThrow();
    });
  });
  it('refuses rewritten and restored native observations', async () => {
    await monitor('native-control-rewrite', async (observer, options) => {
      await observer.sampleNow(); await observer.sampleNow(); observer.stop();
      const ref = firestore.doc(`publicReleaseRehearsalRuns/${options.packet.runId}/controlSamples/000001`);
      const before = (await ref.get()).data()!;
      await ref.set({ ...before, readAt: before.readAt + 1 }); await ref.set(before);
      await expect(readRehearsalControlEvidence(options)).rejects.toThrow();
    });
  });
});
