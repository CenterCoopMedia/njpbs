import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { refusedOperatorPrelaunch } from '../helpers/operator-prelaunch.mjs';
import deployment from '../../functions/lib/public-deployment.js';
import adoption from '../../functions/lib/public-release-bootstrap-adoption.js';
import admission from '../../functions/lib/public-release-bootstrap-admission.js';
import p from '../../functions/lib/public-release-pair.js';
import pause from '../../functions/lib/dev-public-release-pause.js';
import recovery from '../../functions/lib/dev-public-release-pause-recovery.js';
import context from '../../functions/lib/public-context-publication.js';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import baseline from '../../functions/lib/public-release-change-baseline.js';
import { publicContextDigest } from '../../functions/lib/public-context-revision.js';
import { publicReleaseBaselineCodeFixture } from '../helpers/public-release-baseline-code';
import { confirmPreviewRuntimeReady } from '../../site/scripts/cms-preview-cloud-control';
import { runBootstrapFenceOperator } from '../../scripts/lib/public-release-bootstrap-fence-operator.mjs';
import { parseProductionPublicReleasePacket, runProductionPublicReleaseOperator, productionCanonicalRequest } from '../../scripts/lib/production-public-release-operator.mjs';

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Isolated emulator required');
const app = initializeApp({ projectId: 'njpbs-site' }, 'production-bootstrap-operator-test'), db = getFirestore(app);
afterAll(() => deleteApp(app));
const sha = 'a'.repeat(40), operationId = 'original-production-bootstrap';
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: sha,
  activeDeploymentId: 'original-old', lastReservedGeneration: 1, newestEligibleGeneration: 1,
  newestEligibleBuildBatchId: 'original-build', mediaLifecycleReady: true };
const oldRuntime = { schemaVersion: 1, phase: 'ready', commitSha: sha, serializerId: 'cloudflare-publisher' };
const attempt = { schemaVersion: 1, operationId, environment: 'production', projectId: 'njpbs-site', oldRuntime,
  legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) };
const identity = { projectId: 'njpbs-site', clientEmail: 'fixture-operator@njpbs-site.iam.gserviceaccount.com',
  privateKeyId: 'b'.repeat(40), secretRef: 'pass://synthetic/production-operator' };
const packet = (step = 'pause', value: any = attempt) => ({ schemaVersion: 1, kind: 'production-public-release-adoption',
  operatorCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), credentialIdentity: identity, step, attempt: value });
async function withPacket(value: any, run: (args: string[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'production-bootstrap-'));
  try {
    const bytes = JSON.stringify(value), file = join(dir, 'packet.json'); await writeFile(file, bytes);
    await run(['--packet', file, '--packet-digest', createHash('sha256').update(bytes).digest('hex')]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const boundary = () => ({ environment: {}, openSdk: vi.fn(async () => ({ firestore: db, close: vi.fn(async () => {}) })),
  credential: vi.fn(() => { throw new Error('This operation needs no provider credential'); }) });
const closePacket = () => ({ schemaVersion: 1, kind: 'bootstrap-admission-close-operator',
  operatorCommitSha: packet().operatorCommitSha, credentialIdentity: identity,
  attempt: { schemaVersion: 2, operationId, environment: 'production', legacyPointerDigest: attempt.legacyPointerDigest } });
const closeBoundary = () => ({ readServiceAccount: async () => JSON.stringify({ type: 'service_account', project_id: identity.projectId,
  client_email: identity.clientEmail, private_key_id: identity.privateKeyId, private_key: 'synthetic-not-a-real-private-key-value' }),
  openDatabase: async () => ({ firestore: db, close: async () => {} }) });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site/databases/(default)/documents`, { method: 'DELETE' }, db);
  await db.doc('system/publicDeployment').set(pointer); await db.doc('system/cmsPublicationRuntime').set(oldRuntime);
  await db.doc('system/publicDeployment/contexts/public').set({ schemaVersion: 1, revision: 1 });
});
it('plans in the actual protected CLI without SDK credentials, and refuses mixed production targets before opening pipes', async () => {
  await withPacket(packet(), async args => {
    const io = boundary();
    expect(await runProductionPublicReleaseOperator(args, io)).toMatchObject({ mode: 'plan', authorityReads: 0, authorityWrites: 0 });
    expect(io.openSdk).not.toHaveBeenCalled(); expect(io.credential).not.toHaveBeenCalled();
    expect(JSON.parse(execFileSync(process.execPath, ['scripts/production-public-release-adoption.mjs', ...args], { encoding: 'utf8' }))).toMatchObject({ mode: 'plan' });
    await expect(runProductionPublicReleaseOperator([...args, '--apply'], { ...io, environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:18873' } })).rejects.toThrow();
    expect(io.openSdk).not.toHaveBeenCalled();
  });
  for (const change of [v => { v.attempt.projectId = 'njpbs-site-dev'; }, v => { v.attempt.environment = 'development'; },
    v => { v.attempt.oldRuntime.serializerId = 'cloudflare-dev-publisher'; }, v => { v.credentialIdentity.projectId = 'njpbs-site-dev'; }]) {
    const value = structuredClone(packet()); change(value); expect(() => parseProductionPublicReleasePacket(value)).toThrow();
  }
  expect(() => pause.parseDevPublicReleasePauseAttempt(attempt)).toThrow();
});
it('drains the flat production runtime once, recovers original outcome and restores exact pins before CLI abandon', async () => {
  const queue = { status: 'success', transport: 'post-no-build-v1', backgroundRuntime: { owner: 'cloudflare', release: sha } };
  await db.doc('cmsPublishQueue/original-accepted').set(queue);
  await withPacket(packet(), async args => {
    const io = boundary(); const first = await runProductionPublicReleaseOperator([...args, '--apply'], io);
    expect(first).toMatchObject({ outcome: 'drained', drainCommitted: true, acceptedWorkChanged: 0 });
    const row = await db.doc(`system/productionPublicReleasePause/drains/${operationId}`).get();
    expect(await runProductionPublicReleaseOperator([...args, '--apply'], io)).toMatchObject({ idempotent: true, outcome: 'drained' });
    expect((await db.doc(`system/productionPublicReleasePause/drains/${operationId}`).get()).updateTime).toEqual(row.updateTime);
    expect(await runProductionPublicReleaseOperator([...args, '--readback'], io)).toMatchObject({ ownsPausedRuntime: true, ownsClosedFence: true });
    expect((await db.doc('system/cmsPublicationRuntime').get()).data()).toEqual({ ...oldRuntime, phase: 'paused' });
    expect((await db.doc('cmsPublishQueue/original-accepted').get()).data()).toEqual(queue);
  });
  await withPacket(closePacket(), async args => {
    await expect(runBootstrapFenceOperator([...args, '--abandon'], closeBoundary())).rejects.toThrow();
  });
  await withPacket(packet('restore-legacy-runtime'), async args => {
    const io = boundary(); expect(await runProductionPublicReleaseOperator([...args, '--apply'], io)).toMatchObject({ idempotent: false });
    expect(await runProductionPublicReleaseOperator([...args, '--readback'], io)).toMatchObject({ restoreCommitted: true, canAbandon: true });
  });
  await withPacket(closePacket(), async args => {
    expect(await runBootstrapFenceOperator([...args, '--abandon'], closeBoundary())).toMatchObject({ mode: 'abandon', receipt: { kind: 'bootstrap-admission-abandoned' } });
    expect(await runBootstrapFenceOperator([...args, '--abandon'], closeBoundary())).toMatchObject({ idempotent: true });
    expect(await runBootstrapFenceOperator([...args, '--readback'], closeBoundary())).toMatchObject({ ownsClosedFence: false, abandonReceipt: { operationId } });
  });
  expect((await db.doc('system/cmsPublicationRuntime').get()).data()).toEqual(oldRuntime);
  expect((await db.doc('system/publicReleaseChanges').get()).exists).toBe(false);
});
it('keeps failed production originals at STOP before credentials, return or enrollment without writing a marker', async () => {
  const queueId = 'C'.repeat(20), runtime = { owner: 'cloudflare', release: sha };
  await db.doc('system/publicDeployment/contexts/public').set({ schemaVersion: 1, revision: 1 });
  await db.runTransaction(async transaction => { (await context.enqueuePublicContextInTransaction({ firestore: db, transaction,
    operationId: queueId, runtime, reason: 'settings', contextRevision: 1 })).write(); });
  await expect(pause.pausePublicRelease({ firestore: db, attempt })).rejects.toThrow();
  const batch = db.batch();
  for (const output of context.OUTPUTS) {
    batch.update(db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/${output}`), { status: 'verified', claim: null, nextAttemptAt: null });
    batch.update(db.doc(`cmsBackgroundOutputs/${output}`), { status: 'verified' });
  }
  await batch.commit();
  await db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/search`).update({ status: 'failed', attempts: 4, claim: null, nextAttemptAt: null });
  await db.doc('cmsBackgroundOutputs/search').update({ status: 'failed' });
  await db.doc(`cmsPublishQueue/${queueId}`).update({ status: 'failed', claim: null, nextAttemptAt: null });
  const failed = await pause.pausePublicRelease({ firestore: db, attempt });
  expect(failed).toMatchObject({ stop: true, outcome: 'paused-failed', drainCommitted: false, recoveryIssue: 4582, failureReceipt: { recoveryIssue: 4582 } });
  const original = await db.doc(`cmsPublishQueue/${queueId}`).get();
  const value = { schemaVersion: 1, pauseAttempt: attempt, pauseReceiptDigest: p.publicReleaseDigest(failed.pauseReceipt), failureReceiptDigest: failed.failureReceiptDigest };
  await withPacket(packet('pause-recovery', value), async args => {
    const io = boundary();
    for (const mode of ['', '--apply', '--readback']) expect(await runProductionPublicReleaseOperator([...args, ...(mode ? [mode] : [])], io))
      .toMatchObject({ stop: true, canContinue: false, reason: 'production-failed-pause-recovery-unavailable', recoveryCommitted: false, drainCommitted: false,
        acceptedWorkChanged: 0, authorityReads: 0, authorityWrites: 0 });
    expect(io.openSdk).not.toHaveBeenCalled(); expect(io.credential).not.toHaveBeenCalled();
    const cli = spawnSync(process.execPath, ['scripts/production-public-release-adoption.mjs', ...args, '--apply'], { encoding: 'utf8', timeout: 8000 });
    expect(cli.status, cli.stderr).toBe(2);
    expect(JSON.parse(cli.stdout)).toMatchObject({ mode: 'apply', stop: true, drainCommitted: false, authorityReads: 0, authorityWrites: 0 });
    await expect(recovery.recoverDevPublicReleasePause({ firestore: db, attempt: value })).rejects.toThrow();
  });
  expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).updateTime).toEqual(original.updateTime);
  expect(await pause.readPublicReleasePause({ firestore: db, attempt })).toMatchObject({ stop: true, outcome: 'paused-failed', drainCommitted: false });
  expect((await db.doc('system/productionPublicReleasePauseRecovery').get()).exists).toBe(false);
  const census = await db.runTransaction(transaction => baseline.readPublicReleaseSourceCensusInTransaction({ firestore: db, transaction }), { readOnly: true });
  const request = { schemaVersion: 1, operationId, logEpoch: 'failed-unclosed-epoch', baselineDigest: 'b'.repeat(64), expected: {
    projectId: 'njpbs-site', liveReleaseSha: sha, pointerDigest: p.publicReleaseDigest((await db.doc('system/publicDeployment').get()).data()),
    runtimeDigest: p.publicReleaseDigest((await db.doc('system/cmsPublicationRuntime').get()).data()), contextRevision: 1,
    contextDigest: publicContextDigest(1), publicSourceCensusDigest: census.sourceMemberCensusDigest,
  } };
  const readCode = vi.fn(async () => { throw new Error('No CODE read before the production fence'); });
  await expect(enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db })).rejects.toThrow('enrollment-production-fence-required');
  await expect(enrollment.enrollPublicReleaseChangeLog({ firestore: db, request, dryRun: false, currentCodeRequest: readCode }))
    .rejects.toThrow('enrollment-production-fence-required');
  expect(readCode).not.toHaveBeenCalled();
  // Even a separately closed original fence cannot turn the failed pause into
  // a baseline or authorize the newly added pre-enrollment return.
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt });
  await expect(pause.restorePublicReleasePausedRuntime({ firestore: db, attempt })).rejects.toThrow('#4582');
  await expect(enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db })).rejects.toThrow('enrollment-production-recovery-unreviewed');
  await expect(adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt })).rejects.toThrow();
  expect((await db.doc('system/publicReleaseChanges').get()).exists).toBe(false);

});
it.each(['system/publicReleaseChanges', 'system/publicReleaseChanges/enrollment/initial', 'system/publicReleaseChangeLog'])('refuses legacy restoration and abandon after %s exists', async path => {
  await pause.pausePublicRelease({ firestore: db, attempt }); await db.doc(path).set({ enrolled: true });
  await expect(pause.restorePublicReleasePausedRuntime({ firestore: db, attempt })).rejects.toThrow();
  await expect(adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt })).rejects.toThrow();
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.status).toBe('closed');
  expect((await db.doc('system/cmsPublicationRuntime').get()).data()?.phase).toBe('paused');
});
it('preserves original preview capabilities, drains accepted work, restores only before enrollment and never re-pauses later selection', async () => {
  await pause.pausePublicRelease({ firestore: db, attempt });
  const original = { schemaVersion: 1, phase: 'ready', rendererSha: sha, serializerId: 'cloudflare-preview', electionResultsVersion: 2,
    checkedAt: '2026-11-01T00:00:00.000Z' };
  await db.doc('system/cmsPreviewRuntime').set(original);
  const value = { operationId, rendererSha: sha, expectedRuntimeDigest: p.publicReleaseDigest(original), legacyPointerDigest: attempt.legacyPointerDigest };
  await withPacket(packet('preview-pause', value), async args => {
    expect(await runProductionPublicReleaseOperator([...args, '--apply'], boundary())).toMatchObject({ idempotent: false });
    expect(await runProductionPublicReleaseOperator([...args, '--readback'], boundary())).toMatchObject({ ownsPausedPreview: true, drained: true });
    await db.doc('cmsPreviewQueue/original').set({ transport: 'serializer', serializerId: 'cloudflare-preview', status: 'pending' });
    expect(await runProductionPublicReleaseOperator([...args, '--readback'], boundary())).toMatchObject({ drained: false });
    await db.doc('cmsPreviewQueue/original').update({ status: 'complete' });
  });
  await db.doc('system/publicReleaseChangeLog').set({ enrolled: true });
  await withPacket(packet('preview-restore', value), async args => {
    await expect(runProductionPublicReleaseOperator([...args, '--apply'], boundary())).rejects.toThrow();
    await db.doc('system/publicReleaseChangeLog').delete();
    expect(await runProductionPublicReleaseOperator([...args, '--apply'], boundary())).toMatchObject({ idempotent: false });
    expect(await runProductionPublicReleaseOperator([...args, '--readback'], boundary())).toMatchObject({ restoreCommitted: true, ownsReadyPreview: true });
  });
  expect((await db.doc('system/cmsPreviewRuntime').get()).data()).toEqual(original);
  await db.doc('system/cmsPreviewRuntime').set({ schemaVersion: 2, laterSelection: true });
  await withPacket(packet('preview-pause', value), async args => {
    expect(await runProductionPublicReleaseOperator([...args, '--apply'], boundary())).toMatchObject({ idempotent: true });
  });
  expect((await db.doc('system/cmsPreviewRuntime').get()).data()).toEqual({ schemaVersion: 2, laterSelection: true });
});
it('requires the original successful drain for restore, readback and native abandon even without a failure receipt', async () => {
  const queue = db.doc('cmsPublishQueue/original-unconfirmed');
  await queue.set({ status: 'pending', transport: 'post-no-build-v1', backgroundRuntime: { owner: 'cloudflare', release: sha } });
  await expect(pause.pausePublicRelease({ firestore: db, attempt })).rejects.toThrow();
  await queue.update({ status: 'success' });
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt });
  await queue.update({ status: 'failed' });
  expect((await db.doc(`system/productionPublicReleasePause/failures/${operationId}`).get()).exists).toBe(false);
  await expect(pause.restorePublicReleasePausedRuntime({ firestore: db, attempt })).rejects.toThrow();
  await expect(enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db })).rejects.toThrow();
  expect((await db.doc('system/cmsPublicationRuntime').get()).data()?.phase).toBe('paused');
  // Fault injection represents a restore receipt written by the earlier code.
  // Readback and the existing abandon transaction must still refuse reopening.
  await db.doc(`system/productionPublicReleasePause/restores/${operationId}`).create({ schemaVersion: 1,
    kind: 'production-public-release-runtime-restored', attemptDigest: p.publicReleaseDigest(attempt), runtime: oldRuntime });
  await db.doc('system/cmsPublicationRuntime').set(oldRuntime);
  expect(await pause.readPublicReleaseRuntimeRestore({ firestore: db, attempt })).toMatchObject({ restoreCommitted: true, drainReady: false, canAbandon: false });
  await expect(adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt })).rejects.toThrow();
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.status).toBe('closed');
});
it('keeps abandon closed until the original preview is restored with its immutable receipt and exact current identity', async () => {
  await pause.pausePublicRelease({ firestore: db, attempt });
  const original = { schemaVersion: 1, phase: 'ready', rendererSha: sha, serializerId: 'cloudflare-preview', dataHubCompositionVersion: 1, liveBlogVersion: 1, electionResultsVersion: 2 };
  await db.doc('system/cmsPreviewRuntime').set(original);
  const value = { operationId, rendererSha: sha, expectedRuntimeDigest: p.publicReleaseDigest(original), legacyPointerDigest: attempt.legacyPointerDigest };
  await withPacket(packet('preview-pause', value), async args => { await runProductionPublicReleaseOperator([...args, '--apply'], boundary()); });
  await pause.restorePublicReleasePausedRuntime({ firestore: db, attempt });
  expect(await pause.readPublicReleaseRuntimeRestore({ firestore: db, attempt })).toMatchObject({ drainReady: true, previewReadyForAbandon: false, canAbandon: false });
  await withPacket(closePacket(), async args => { await expect(runBootstrapFenceOperator([...args, '--abandon'], closeBoundary())).rejects.toThrow(); });
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.status).toBe('closed');
  await withPacket(packet('preview-restore', value), async args => { await runProductionPublicReleaseOperator([...args, '--apply'], boundary()); });
  expect(await pause.readPublicReleaseRuntimeRestore({ firestore: db, attempt })).toMatchObject({ previewReadyForAbandon: true, canAbandon: true });
  await confirmPreviewRuntimeReady(db, sha, 'cloudflare-preview', {});
  const healthy = (await db.doc('system/cmsPreviewRuntime').get()).data()!;
  expect(healthy.checkedAt).toEqual(expect.any(String));
  expect(await pause.readPublicReleaseRuntimeRestore({ firestore: db, attempt })).toMatchObject({ canAbandon: true });
  await withPacket(packet('preview-restore', value), async args => {
    expect(await runProductionPublicReleaseOperator([...args, '--readback'], boundary())).toMatchObject({ ownsReadyPreview: true });
  });
  await db.doc('system/cmsPreviewRuntime').update({ rendererSha: 'c'.repeat(40) });
  expect(await pause.readPublicReleaseRuntimeRestore({ firestore: db, attempt })).toMatchObject({ canAbandon: false });
  await expect(adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt })).rejects.toThrow();
  await db.doc('system/cmsPreviewRuntime').set(healthy);
  await withPacket(closePacket(), async args => { expect(await runBootstrapFenceOperator([...args, '--abandon'], closeBoundary())).toMatchObject({ receipt: { kind: 'bootstrap-admission-abandoned' } }); });
  expect((await db.doc('system/cmsPreviewRuntime').get()).data()).toEqual(healthy);
});
it.each(['open', 'other-operation'])('refuses enrollment against an earlier %s fence before preparing CODE', async mode => {
  await pause.pausePublicRelease({ firestore: db, attempt });
  const observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db });
  const nextOperation = 'next-production-bootstrap';
  if (mode === 'open') {
    await pause.restorePublicReleasePausedRuntime({ firestore: db, attempt });
    await adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt });
    await db.doc('cmsPublishQueue/next-original').set({ status: 'pending', transport: 'post-no-build-v1', backgroundRuntime: { owner: 'cloudflare', release: sha } });
    await expect(pause.pausePublicRelease({ firestore: db, attempt: { ...attempt, operationId: nextOperation } })).rejects.toThrow();
  }
  const readCode = vi.fn(async () => { throw new Error('No CODE read for an earlier fence'); });
  const request = { schemaVersion: 1, operationId: nextOperation, logEpoch: 'next-original-epoch', baselineDigest: 'b'.repeat(64), expected: observed.expected };
  await expect(enrollment.enrollPublicReleaseChangeLog({ firestore: db, request, dryRun: false, currentCodeRequest: readCode }))
    .rejects.toThrow('enrollment-production-fence-required');
  expect(readCode).not.toHaveBeenCalled();
  expect((await db.doc('system/publicReleaseChanges').get()).exists).toBe(false);
  expect((await db.doc(enrollment.ENROLLMENT_PATH).get()).exists).toBe(false);
});
it.each(['flat', 'dual'])('refuses %s foreign paused controls behind a closed fence without a native pause or drain', async shape => {
  const foreign = { ...oldRuntime, phase: 'paused', ...(shape === 'dual' ? {
    serializerId: 'foreign-primary', cloud: { phase: 'paused', commitSha: sha, serializerId: 'cloudflare-publisher' },
  } : {}) };
  await db.doc('system/cmsPublicationRuntime').set(foreign);
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt });
  const census = await db.runTransaction(transaction => baseline.readPublicReleaseSourceCensusInTransaction({ firestore: db, transaction }), { readOnly: true });
  const request = { schemaVersion: 1, operationId, logEpoch: 'foreign-pause-epoch', baselineDigest: 'b'.repeat(64), expected: {
    projectId: 'njpbs-site', liveReleaseSha: sha, pointerDigest: p.publicReleaseDigest(pointer), runtimeDigest: p.publicReleaseDigest(foreign),
    contextRevision: 1, contextDigest: publicContextDigest(1), publicSourceCensusDigest: census.sourceMemberCensusDigest,
  } };
  const readCode = vi.fn(async () => { throw new Error('Foreign pause must refuse before CODE access'); });
  const paths = ['system/publicDeployment', 'system/cmsPublicationRuntime', admission.BOOTSTRAP_ADMISSION_FENCE_PATH,
    'system/publicDeployment/releaseWriter/fence'];
  const before = await db.getAll(...paths.map(path => db.doc(path)));
  await expect(enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db })).rejects.toMatchObject({ name: 'PublicReleaseProtocolError' });
  for (const dryRun of [true, false]) await expect(enrollment.enrollPublicReleaseChangeLog({ firestore: db, request, dryRun, currentCodeRequest: readCode }))
    .rejects.toMatchObject({ name: 'PublicReleaseProtocolError' });
  expect(readCode).not.toHaveBeenCalled();
  const after = await db.getAll(...paths.map(path => db.doc(path)));
  expect(after.map(row => [row.data(), row.updateTime])).toEqual(before.map(row => [row.data(), row.updateTime]));
  for (const path of ['system/publicReleaseChanges', enrollment.ENROLLMENT_PATH,
    `system/productionPublicReleasePause/attempts/${operationId}`, `system/productionPublicReleasePause/drains/${operationId}`]) {
    expect((await db.doc(path).get()).exists).toBe(false);
  }
  for (const family of ['bodies', 'baselines', 'baselineDigests', 'codeChunks']) expect((await db.collection(`system/publicReleaseChanges/${family}`).get()).empty).toBe(true);
});
it('preserves ready close-only abandon without inventing a native pause or drain', async () => {
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt });
  expect(await adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt })).toMatchObject({ idempotent: false });
  expect((await db.doc('system/cmsPublicationRuntime').get()).data()).toEqual(oldRuntime);
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.status).toBe('open');
  expect((await db.doc(`system/productionPublicReleasePause/attempts/${operationId}`).get()).exists).toBe(false);
});
it.each(['paused', 'starting'])('refuses close-only abandon while a foreign primary remains %s with ready cloud controls', async phase => {
  const foreign = { ...oldRuntime, phase, serializerId: 'foreign-primary',
    cloud: { phase: 'ready', commitSha: sha, serializerId: 'cloudflare-publisher' } };
  await db.doc('system/cmsPublicationRuntime').set(foreign);
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt });
  await expect(adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closePacket().attempt })).rejects.toMatchObject({ name: 'PublicReleaseProtocolError' });
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.status).toBe('closed');
  expect((await db.doc(`system/publicReleaseAdmissions/bootstrapAbandons/${operationId}`).get()).exists).toBe(false);
  expect((await db.doc('system/cmsPublicationRuntime').get()).data()).toEqual(foreign);
});
it.each(['fence', 'pause-receipt'])('rechecks the original %s in the final enrollment transaction', async removed => {
  await pause.pausePublicRelease({ firestore: db, attempt });
  const observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db }), code = publicReleaseBaselineCodeFixture(db, sha);
  let reads = 0;
  const request = { schemaVersion: 1, operationId, logEpoch: 'raced-fence-epoch', baselineDigest: 'b'.repeat(64), expected: observed.expected };
  await expect(enrollment.enrollPublicReleaseChangeLog({ firestore: db, request, dryRun: false, currentCodeRequest: async (url, init) => {
    const response = await code.request(url, init);
    if (++reads === 1) await db.doc(removed === 'fence' ? 'system/publicDeployment/releaseWriter/fence'
      : `system/productionPublicReleasePause/attempts/${operationId}`).delete();
    return response;
  } })).rejects.toThrow(removed === 'fence' ? 'enrollment-production-fence-required' : 'The public release protocol record is invalid');
  expect(reads).toBeGreaterThan(0);
  expect((await db.doc('system/publicReleaseChanges').get()).exists).toBe(false);
  expect((await db.doc(enrollment.ENROLLMENT_PATH).get()).exists).toBe(false);
});
it('restricts canonical reads to the credential-free production apex and refuses redirects or credential forwarding', async () => {
  const fetchBoundary = vi.fn(async () => new Response('ok')), request = productionCanonicalRequest(fetchBoundary);
  expect(await (await request('https://njpbs.org/', { method: 'GET' })).text()).toBe('ok');
  for (const url of ['https://dev-public.example.org/', 'https://example.test/', 'https://njpbs.org/?q=1']) await expect(request(url)).rejects.toThrow();
  await expect(request('https://njpbs.org/', { redirect: 'follow' })).rejects.toThrow();
  await expect(request('https://njpbs.org/', { headers: { authorization: 'synthetic-test-value' } })).rejects.toThrow();
  expect(fetchBoundary).toHaveBeenCalledOnce();
});
it.each(['wrong-commit', 'dirty-tree'])('refuses %s before importing credential-capable repository code', async mode => {
  const result = await refusedOperatorPrelaunch({ filename: 'production-public-release-adoption.mjs', businessPath: 'scripts/lib/production-public-release-operator.mjs', mode });
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.evaluated).toBe(false);
});
