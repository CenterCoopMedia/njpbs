import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import jobs from '../../functions/lib/video-transcript-job.js';
import worker from '../../functions/lib/video-transcript-worker.js';
import paid from '../../functions/lib/video-transcript-paid-budget.js';
import fallback from '../../functions/lib/video-transcript-paid-fallback.js';
import byok from '../../functions/video-transcript-byok.js';
import credentials from '../../functions/lib/video-transcription-credentials.js';
import contract from '../../functions/lib/video-transcript-contract.js';
import renditions from '../../functions/lib/source-media-rendition.js';

const firestore = isolatedFirestore('transcript-local-queue');
const source = { id: 'video-library', bucket: 'originals', prefix: '', writable: true, access: 'active_staff' };
const now = Date.parse('2026-10-20T12:00:00Z');
const actor = { uid: 'staff', authTime: 100 };
const queueRef = firestore.collection(jobs.TRANSCRIPT_LIMITS).doc('local-outstanding');
const audit = value => value;
function asset(id, durationSeconds = 60) {
  const video = { id, sourceId: source.id, objectKey: `objects/${id}.mxf`, objectVersionId: 'original-v1', sizeBytes: 100,
    lifecycle: 'active', name: 'Video', originalName: `${id}.mxf`, nameSort: 'video', updatedAtSort: new Date(now).toISOString(),
    mimeType: 'application/mxf', kind: 'video', version: 1, preview: 'download_only', rightsStatus: 'complete', tags: [] };
  const prefix = `outputs/${renditions.sourceMediaRenditionId(video)}/attempt/`;
  video.rendition = { schemaVersion: 1, state: 'ready', sourceObjectKey: video.objectKey, sourceObjectVersionId: 'original-v1',
    sourceSizeBytes: 100, attemptId: 'attempt', updatedAt: new Date(now).toISOString(),
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: 'web-v1', sizeBytes: 50, mimeType: 'video/mp4', durationSeconds },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: 'poster-v1', sizeBytes: 5, mimeType: 'image/jpeg' } };
  return video;
}
async function seed(id, durationSeconds = 60) {
  await firestore.collection('mediaSourceAssets').doc(id).set(asset(id, durationSeconds));
}
const request = assetId => ({ sourceId: source.id, assetId, languageCode: 'en-US', maxSpeakers: 10 });
const enqueue = (id, extra = {}) => jobs.requestTranscript({ firestore, source, actor, audit, request: request(id), now, localEnabled: true, ...extra });
const jobRef = id => firestore.collection(jobs.TRANSCRIPT_JOBS).doc(id);
async function amazon(id, at = now + 300000) {
  await worker.routeLocalFallback({ firestore, source, ref: jobRef(id), fallbackEnabled: true, now: at });
  return jobs.claimTranscript(firestore, jobRef(id), source, at);
}

const resetQueueDatabase = () => clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${firestore.projectId}/databases/(default)/documents`, { method: 'DELETE' }, firestore);
// Cold emulator project initialization is setup; case resets keep their normal bound.
beforeAll(resetQueueDatabase, 60_000);
beforeEach(resetQueueDatabase);

describe('free local transcript queue', () => {
  it('queues 30 videos for one person in a day and completes them in creation order', async () => {
    const batch = firestore.batch();
    for (let i = 0; i < 30; i++) batch.set(firestore.collection('mediaSourceAssets').doc(`video-${i}`), asset(`video-${i}`));
    // Old paid counters have no effect on free admission.
    batch.set(firestore.collection(jobs.TRANSCRIPT_LIMITS).doc('day-2026-10-20'), { count: 999 });
    await batch.commit();
    const queued = [];
    for (let i = 0; i < 30; i++) queued.push((await enqueue(`video-${i}`, { now: now + i })).job.id);
    expect((await queueRef.get()).data().activeIds).toEqual(queued);
    for (const id of queued) {
      const claimed = await worker.claimLocalJob({ firestore, source, now: now + 1000 });
      expect(claimed.id).toBe(id);
      await worker.completeLocalJob({ firestore, source, now: now + 1000, clock: () => now + 1001,
        request: { jobId: id, leaseToken: claimed.localLeaseToken, engineRevision: worker.LOCAL_ENGINE,
          segments: [{ startSeconds: 0, endSeconds: 1, speaker: 'spk_0', text: 'Test.' }] },
        assertBillingEnabled: async () => {}, writeExports: async () => ({ txt: 'output-v1' }) });
    }
    expect((await queueRef.get()).data().activeIds).toEqual([]);
    expect((await firestore.collection(jobs.TRANSCRIPT_JOBS).where('phase', '==', 'ready').get()).size).toBe(30);
  });

  it('captures a safe name from the authenticated actor, not request input', async () => {
    await seed('named');
    const { job } = await enqueue('named', { actor: { ...actor, displayName: '  Sam Editor  ' },
      request: { ...request('named'), requesterDisplayName: 'Other person' } });
    expect(job.requesterDisplayName).toBe('Sam Editor');
    expect(contract.transcriptSummary(job).processing.requestedByName).toBe('Sam Editor');
    await seed('email-name');
    expect((await enqueue('email-name', { actor: { ...actor, displayName: 'staff@example.test' } })).job.requesterDisplayName).toBeNull();
  });

  it('does not replace an old paid counter with an incomplete mixed daily sample', async () => {
    const batch = firestore.batch();
    for (let i = 0; i < 499; i++) batch.set(jobRef(`free-${i}`), { provider: 'local', active: false, createdAt: new Date(now - i).toISOString() });
    batch.set(jobRef('older-paid'), { provider: 'amazon-transcribe', active: false, requestedBy: actor.uid, createdAt: new Date(now - 1000).toISOString() });
    const day = firestore.collection(jobs.TRANSCRIPT_LIMITS).doc('day-2026-10-20');
    batch.set(day, { count: 5 });
    batch.set(firestore.collection(jobs.TRANSCRIPT_LIMITS).doc('outstanding'), { activeIds: ['free-0'] });
    await batch.commit(); await seed('new-paid');
    await expect(enqueue('new-paid', { localEnabled: false })).rejects.toMatchObject({ status: 429 });
    expect((await day.get()).data().count).toBe(5);
    expect((await enqueue('new-paid')).job.provider).toBe('local');
  });

  it('returns one job and slot for duplicate concurrent requests, even at the ceiling', async () => {
    await seed('same');
    const results = await Promise.all([enqueue('same'), enqueue('same')]);
    expect(results.filter(result => result.cached)).toHaveLength(1);
    const id = results[0].job.id;
    await queueRef.set({ initialized: true, activeIds: [id, ...Array.from({ length: 499 }, (_, i) => `older-${i}`)] });
    expect((await enqueue('same')).cached).toBe(true);
    expect((await queueRef.get()).data().activeIds).toHaveLength(500);
  });

  it('uses three document reads with a 499-job queue and rejects job 501 clearly', async () => {
    const ids = Array.from({ length: 499 }, (_, i) => `older-${i}`);
    const batch = firestore.batch();
    for (const id of ids) batch.set(jobRef(id), { id, active: true, provider: 'local' });
    batch.set(queueRef, { initialized: true, activeIds: ids });
    await batch.commit();
    await seed('last'); await seed('overflow');
    const reads = [];
    const measured = { collection: name => firestore.collection(name),
      runTransaction: fn => firestore.runTransaction(tx => fn({
        get: target => { reads.push(target.path ?? 'query'); return tx.get(target); },
        create: (...args) => tx.create(...args), set: (...args) => tx.set(...args),
      })) };
    await enqueue('last', { firestore: measured });
    expect(reads).toEqual(['mediaSourceAssets/last', `mediaSourceTranscriptJobs/${contract.transcriptId(asset('last'), source.bucket, request('last'))}`, queueRef.path]);
    await expect(enqueue('overflow')).rejects.toMatchObject({ status: 429, message: expect.stringContaining('500 queued or running local transcripts') });
  });

  it('counts legacy active jobs once and releases their slots on stale-source retirement', async () => {
    await seed('old'); await seed('new');
    const result = await enqueue('old');
    await queueRef.delete();
    await enqueue('new', { now: now + 1 });
    expect((await queueRef.get()).data().activeIds).toContain(result.job.id);
    await firestore.collection('mediaSourceAssets').doc('old').update({ lifecycle: 'deleted' });
    await worker.claimLocalJob({ firestore, source, now: now + 1000 });
    expect((await queueRef.get()).data().activeIds).not.toContain(result.job.id);
  });

  it('includes a legacy in-flight local fallback when the queue first initializes', async () => {
    await seed('legacy-fallback'); await seed('next-local');
    const old = (await enqueue('legacy-fallback')).job;
    delete old.localQueueSlot;
    await jobRef(old.id).set(old);
    await worker.routeLocalFallback({ firestore, source, ref: jobRef(old.id), fallbackEnabled: true, now: now + 300000 });
    await queueRef.delete();
    await enqueue('next-local', { now: now + 300001 });
    expect((await queueRef.get()).data().activeIds).toContain(old.id);
  });

  it('serializes concurrent admission at the 500-job safety ceiling', async () => {
    await seed('one'); await seed('two');
    await queueRef.set({ initialized: true, activeIds: Array.from({ length: 499 }, (_, i) => `older-${i}`) });
    const results = await Promise.allSettled([enqueue('one'), enqueue('two')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.status).toBe(429);
    expect((await queueRef.get()).data().activeIds).toHaveLength(500);
  });

  it('counts legacy policy migration against the same station safety ceiling', async () => {
    await seed('legacy');
    const job = (await enqueue('legacy')).job;
    delete job.provider; delete job.localQueueSlot;
    await jobRef(job.id).set(job);
    const full = Array.from({ length: 500 }, (_, i) => `older-${i}`);
    await queueRef.set({ initialized: true, activeIds: full });
    const args = { firestore, source, ref: jobRef(job.id), enabled: true, now, audit };
    await expect(jobs.migratePendingTranscriptToLocal(args)).rejects.toMatchObject({ status: 429 });
    expect((await jobRef(job.id).get()).data().provider).toBeUndefined();
    await queueRef.update({ activeIds: full.slice(1) });
    expect(await jobs.migratePendingTranscriptToLocal(args)).toBe(true);
    expect((await queueRef.get()).data().activeIds).toHaveLength(500);
    expect((await jobRef(job.id).get()).data()).toMatchObject({ provider: 'local', localQueueSlot: true });
  });

  it('releases a bootstrapped older local slot after paid completion', async () => {
    await seed('old-paid'); await seed('new-local');
    const old = (await enqueue('old-paid')).job;
    delete old.localQueueSlot;
    await jobRef(old.id).set(old);
    await queueRef.delete();
    await enqueue('new-local', { now: now + 1 });
    expect((await queueRef.get()).data().activeIds).toContain(old.id);
    const claimed = await amazon(old.id);
    expect(claimed).toBeTruthy();
    await jobs.saveTranscript(firestore, jobRef(old.id), claimed, { phase: 'ready', active: false });
    expect((await queueRef.get()).data().activeIds).not.toContain(old.id);
  });

  it('moves a failed local attempt behind fresh work when paid capacity is used', async () => {
    await seed('broken'); await seed('fresh');
    const broken = (await enqueue('broken')).job;
    const fresh = (await enqueue('fresh', { now: now + 1 })).job;
    const claimed = await worker.claimLocalJob({ firestore, source, now: now + 1000 });
    expect(claimed.id).toBe(broken.id);
    await worker.failLocalJob({ firestore, source, now: now + 1001, fallbackEnabled: true,
      request: { jobId: claimed.id, leaseToken: claimed.localLeaseToken, errorCode: 'local_input_failed' } });
    await paid.budgetRefs(firestore, actor.uid, '2026-10-20').requester.set({ consumedSubmissions: 5 });
    expect(await amazon(broken.id)).toBeNull();
    expect((await jobRef(broken.id).get()).data()).toMatchObject({ active: true, provider: 'local', phase: 'pending',
      requestedAt: broken.createdAt });
    expect((await worker.claimLocalJob({ firestore, source, now: now + 300001 })).id).toBe(fresh.id);
  });

  it.each([60, 7200])('requires attention after three actual local failures for %s-second audio', async duration => {
    await seed('broken', duration);
    const job = (await enqueue('broken')).job;
    await paid.budgetRefs(firestore, actor.uid, '2026-10-20').requester.set({ consumedSubmissions: 5 });
    for (let attempt = 0; attempt < 3; attempt++) {
      const at = now + 1000 + attempt * 600000;
      const claimed = await worker.claimLocalJob({ firestore, source, now: at });
      expect(claimed.id).toBe(job.id);
      const result = await worker.failLocalJob({ firestore, source, now: at + 1, fallbackEnabled: true,
        request: { jobId: job.id, leaseToken: claimed.localLeaseToken, errorCode: 'local_input_failed' } });
      if (attempt < 2) {
        expect(result.fallback).toBe(true);
        expect(await amazon(job.id, at + 2)).toBeNull();
        expect((await jobRef(job.id).get()).data()).toMatchObject({ active: true, phase: 'pending', provider: 'local' });
      } else expect(result.fallback).toBe(false);
    }
    expect((await jobRef(job.id).get()).data()).toMatchObject({ active: false, phase: 'needs_reconciliation',
      localFailureCount: 3, errorCode: 'local_input_failed' });
    expect((await queueRef.get()).data().activeIds).not.toContain(job.id);
  });

  it('waits for the oldest video audio before claiming a later ready video', async () => {
    await seed('first'); await seed('second');
    const first = (await enqueue('first')).job;
    const second = (await enqueue('second', { now: now + 1 })).job;
    await jobRef(second.id).update({ audioInput: { prepared: true } });
    expect(await worker.claimLocalJob({ firestore, source, now, audioRequired: true })).toBeNull();
    expect((await jobRef(first.id).get()).data().phase).toBe('pending');
  });
});

describe('paid fallback cannot spend a local batch past the existing caps', () => {
  it.each(['missing', 'old-local'])('ignores free work when %s legacy paid counters initialize', async mode => {
    const { createHash } = await import('node:crypto');
    const batch = firestore.batch();
    const ids = Array.from({ length: 30 }, (_, i) => `free-${i}`);
    for (const id of ids) batch.set(jobRef(id), { id, active: true, provider: 'local', phase: 'pending',
      requestedBy: actor.uid, createdAt: new Date(now).toISOString() });
    if (mode === 'old-local') {
      batch.set(firestore.collection(jobs.TRANSCRIPT_LIMITS).doc(createHash('sha256').update(actor.uid).digest('hex')),
        { day: '2026-10-20', count: 5, activeId: ids[0] });
      batch.set(firestore.collection(jobs.TRANSCRIPT_LIMITS).doc('day-2026-10-20'), { count: 20 });
      batch.set(firestore.collection(jobs.TRANSCRIPT_LIMITS).doc('outstanding'), { activeIds: ids.slice(0, 20) });
    }
    await batch.commit(); await seed('paid-after-free');
    const result = await enqueue('paid-after-free', { localEnabled: false });
    expect(result).toMatchObject({ cached: false, job: { provider: 'amazon-transcribe', active: true } });
    expect((await firestore.collection(jobs.TRANSCRIPT_LIMITS).doc('day-2026-10-20').get()).data().count).toBe(1);
  });

  it('keeps two-hour videos local and rejects an impossible paid-only request before taking a slot', async () => {
    await seed('long-local', 7200); await seed('long-paid', 7200);
    const local = (await enqueue('long-local')).job;
    expect(await amazon(local.id)).toBeNull();
    expect((await jobRef(local.id).get()).data()).toMatchObject({ provider: 'local', active: true, phase: 'pending' });
    await expect(enqueue('long-paid', { localEnabled: false })).rejects.toMatchObject({ status: 409,
      message: expect.stringContaining('one hour or less') });
    // A pre-deploy paid-only pending record must also stop holding the old active slot.
    await jobRef(local.id).update({ provider: 'amazon-transcribe', localQueueSlot: false, fallbackAt: null });
    expect(await jobs.claimTranscript(firestore, jobRef(local.id), source, now)).toBeNull();
    expect((await jobRef(local.id).get()).data()).toMatchObject({ active: false, phase: 'failed' });
  });

  it('keeps one outstanding paid request and at most five daily submissions per person', async () => {
    const ids = [];
    for (let i = 0; i < 7; i++) { await seed(`paid-${i}`); ids.push((await enqueue(`paid-${i}`)).job.id); }
    const first = await amazon(ids[0]);
    expect(first).toBeTruthy();
    expect(await amazon(ids[1])).toBeNull();
    expect((await jobRef(ids[1]).get()).data()).toMatchObject({ active: true, provider: 'local', phase: 'pending' });
    await jobs.saveTranscript(firestore, jobRef(first.id), first, { active: false, phase: 'ready' });
    for (let i = 1; i < 5; i++) {
      const claim = await amazon(ids[i]); expect(claim).toBeTruthy();
      await jobs.saveTranscript(firestore, jobRef(claim.id), claim, { active: false, phase: 'ready' });
    }
    expect(await amazon(ids[5])).toBeNull();
    expect(await amazon(ids[6])).toBeNull();
    expect((await jobRef(ids[5]).get()).data()).toMatchObject({ active: true, phase: 'pending', provider: 'local' });
    const refs = paid.budgetRefs(firestore, actor.uid, '2026-10-20');
    expect((await refs.requester.get()).data().consumedSubmissions).toBe(5);
  });

  it('enforces the station 20-submission budget across staff', async () => {
    for (let i = 0; i < 21; i++) {
      await seed(`station-${i}`);
      const job = (await enqueue(`station-${i}`, { actor: { uid: `staff-${Math.floor(i / 5)}` } })).job;
      const claimed = await amazon(job.id);
      if (i === 20) {
        expect(claimed).toBeNull();
        expect((await jobRef(job.id).get()).data()).toMatchObject({ active: true, provider: 'local', phase: 'pending' });
      } else {
        expect(claimed).toBeTruthy();
        await jobs.saveTranscript(firestore, jobRef(job.id), claimed, { active: false, phase: 'ready' });
      }
    }
    expect((await paid.budgetRefs(firestore, actor.uid, '2026-10-20').global.get()).data().consumedSubmissions).toBe(20);
  });

  it.each(['requester', 'global'])('keeps local work queued when the %s audio-second budget is used', async scope => {
    await seed('audio');
    const job = (await enqueue('audio')).job;
    const refs = paid.budgetRefs(firestore, actor.uid, '2026-10-20');
    await refs[scope].set({ consumedAudioSeconds: scope === 'requester' ? 3600 : 14400 });
    expect(await amazon(job.id)).toBeNull();
    expect((await jobRef(job.id).get()).data()).toMatchObject({ active: true, provider: 'local', phase: 'pending' });
  });

  it('allows recovery of an already submitted legacy Amazon job without another budget charge', async () => {
    await seed('legacy-paid');
    const job = (await enqueue('legacy-paid')).job;
    await jobRef(job.id).update({ provider: 'amazon-transcribe', localQueueSlot: false,
      phase: 'running', startIntentAt: new Date(now).toISOString() });
    const refs = paid.budgetRefs(firestore, actor.uid, '2026-10-20');
    await refs.requester.set({ consumedSubmissions: 5, consumedAudioSeconds: 3600 });
    expect(await jobs.claimTranscript(firestore, jobRef(job.id), source, now)).toMatchObject({
      phase: 'running', amazonBudgetReservation: { legacy: true } });
    expect((await refs.requester.get()).data()).toEqual({ consumedSubmissions: 5, consumedAudioSeconds: 3600 });
  });

  it('retires expired paid-only jobs before consuming a new daily budget', async () => {
    await seed('expired-paid');
    const job = (await enqueue('expired-paid', { localEnabled: false })).job;
    const at = now + 2 * 86400000;
    expect(await jobs.claimTranscript(firestore, jobRef(job.id), source, at)).toBeNull();
    expect((await jobRef(job.id).get()).data()).toMatchObject({ active: false, phase: 'needs_reconciliation', errorCode: 'processing_timeout' });
    expect((await paid.budgetRefs(firestore, actor.uid, '2026-10-22').global.get()).exists).toBe(false);
  });

  it('shows why paid-only work waits after the shared audio budget is used', async () => {
    await seed('paid-wait', 2400);
    const job = (await enqueue('paid-wait', { localEnabled: false })).job;
    const refs = paid.budgetRefs(firestore, actor.uid, '2026-10-20');
    await refs.requester.set({ consumedSubmissions: 1, consumedAudioSeconds: 2400 });
    expect(await jobs.claimTranscript(firestore, jobRef(job.id), source, now)).toBeNull();
    const saved = (await jobRef(job.id).get()).data();
    expect(saved).toMatchObject({ active: true, phase: 'pending', errorCode: 'paid_budget_unavailable' });
    expect(contract.transcriptSummary(saved).processing.statusCode).toBe('paid_budget_unavailable');
    expect((await refs.requester.get()).data().consumedAudioSeconds).toBe(2400);
  });

  it('shows the billing stop on paid-only work without consuming budget', async () => {
    await seed('paid-billing');
    const job = (await enqueue('paid-billing', { localEnabled: false })).job;
    await firestore.doc('system/billing').set({ disabled: true });
    expect(await jobs.claimTranscript(firestore, jobRef(job.id), source, now)).toBeNull();
    expect((await jobRef(job.id).get()).data()).toMatchObject({ active: true, phase: 'pending', errorCode: 'billing_unavailable' });
    expect((await paid.budgetRefs(firestore, actor.uid, '2026-10-20').global.get()).exists).toBe(false);
  });

  it('keeps the billing stop and does not spend or fail a local request', async () => {
    await seed('billing');
    const job = (await enqueue('billing')).job;
    await firestore.doc('system/billing').set({ disabled: true });
    expect(await amazon(job.id)).toBeNull();
    expect((await jobRef(job.id).get()).data()).toMatchObject({ active: true, provider: 'local', phase: 'pending' });
    expect((await paid.budgetRefs(firestore, actor.uid, '2026-10-20').global.get()).exists).toBe(false);
  });

  it.each(['budget', 'billing'])('returns an ElevenLabs fallback to the local queue when %s blocks it, even after a day', async reason => {
    await seed('elevenlabs');
    const job = (await enqueue('elevenlabs', { paidFallbackEnabled: true })).job;
    await firestore.collection('users').doc(actor.uid).set({ active: true });
    const identity = credentials.credentialIdentity(actor, { scope: 'organization', provider: 'elevenlabs' });
    await firestore.collection(credentials.CREDENTIAL_COLLECTION).doc(identity.id).set({ ...identity, enabled: true, revision: 1 });
    if (reason === 'budget') await paid.budgetRefs(firestore, actor.uid, '2026-10-22').requester.set({ consumedSubmissions: 5 });
    else await firestore.doc('system/billing').set({ disabled: true });
    await worker.routeLocalFallback({ firestore, source, ref: jobRef(job.id), fallbackEnabled: true, now: now + 2 * 86400000 });
    expect(await fallback.routePaidFallback({ firestore, source, ref: jobRef(job.id),
      settings: { enabled: true, amazonFallbackEnabled: true, bucket: 'renditions', accountId: '123456789012' },
      admit: byok.admit, now: now + 2 * 86400000 })).toBe(false);
    expect((await jobRef(job.id).get()).data()).toMatchObject({ active: true, provider: 'local', phase: 'pending' });
    expect((await firestore.collection(jobs.TRANSCRIPT_JOBS).where('provider', '==', 'elevenlabs').get()).size).toBe(0);
  });
});
