import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import deployment from '../../functions/lib/public-deployment.js';
import adoption from '../../functions/lib/public-release-bootstrap-adoption.js';
import admission from '../../functions/lib/public-release-bootstrap-admission.js';
import p from '../../functions/lib/public-release-pair.js';
import pause from '../../functions/lib/dev-public-release-pause.js';
import recovery from '../../functions/lib/dev-public-release-pause-recovery.js';
import context from '../../functions/lib/public-context-publication.js';
import home from '../../functions/lib/no-build-home-ownership.js';
import baseline from '../../functions/lib/public-release-change-baseline.js';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import source from '../../functions/lib/public-release-source-body.js';
import { publicContextDigest } from '../../functions/lib/public-context-revision.js';
import { projectPublicReleasePairSourceCensusDocuments } from '../../site/scripts/public-release-pair-source-census';
import postConfirmation from '../../functions/lib/no-build-post-recovery.js';
import pageConfirmation from '../../functions/lib/no-build-page-recovery.js';
import pageOwnership from '../../functions/lib/no-build-page-ownership.js';

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Isolated emulator required');
const app = initializeApp({ projectId: 'njpbs-site' }, 'production-failed-pause'), db = getFirestore(app);
afterAll(() => deleteApp(app));
const sha = 'a'.repeat(40), operationId = 'original-production-failed-pause', queueId = 'P'.repeat(20);
const runtime = { owner: 'cloudflare', release: sha };
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: sha,
  activeDeploymentId: 'original-old', lastReservedGeneration: 1, newestEligibleGeneration: 1,
  newestEligibleBuildBatchId: 'original-build', mediaLifecycleReady: true };
const oldRuntime = { schemaVersion: 1, phase: 'ready', commitSha: sha, serializerId: 'cloudflare-publisher' };
const attempt = { schemaVersion: 1, operationId, environment: 'production', projectId: 'njpbs-site', oldRuntime,
  legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) };
const closeAttempt = { schemaVersion: 2, operationId, environment: 'production', legacyPointerDigest: attempt.legacyPointerDigest };
const apply = () => pause.pausePublicRelease({ firestore: db, attempt });
const markerPath = 'system/productionPublicReleasePauseRecovery';
const root = 'system/productionPublicReleasePause';
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site/databases/(default)/documents`, { method: 'DELETE' }, db);
  await db.doc('system/publicDeployment').set(pointer);
  await db.doc('system/cmsPublicationRuntime').set(oldRuntime);
  await db.doc('system/publicDeployment/contexts/public').set({ schemaVersion: 1, revision: 1 });
});
async function failContext(kind: string) {
  await db.runTransaction(async transaction => { (await context.enqueuePublicContextInTransaction({ firestore: db, transaction,
    operationId: queueId, runtime, reason: 'settings', contextRevision: 1 })).write(); });
  await expect(apply()).rejects.toThrow();
  if (kind === 'preparation') {
    await db.doc(`cmsPublishQueue/${queueId}/backgroundPreparation/${publicContextDigest(1)}`).set({ schemaVersion: 1,
      status: 'failed', attempts: 4, claim: null, nextAttemptAt: null, runtime, contextDigest: publicContextDigest(1) });
    await context.failPublicContextPreparation({ firestore: db, operationId: queueId, runtime });
  } else {
    const batch = db.batch();
    for (const output of context.OUTPUTS) {
      batch.update(db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/${output}`), { status: 'verified', claim: null, nextAttemptAt: null });
      batch.update(db.doc(`cmsBackgroundOutputs/${output}`), { status: 'verified' });
    }
    await batch.commit();
    await db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/search`).update({ status: 'failed', attempts: 4, claim: null, nextAttemptAt: null });
    await db.doc('cmsBackgroundOutputs/search').update({ status: 'failed' });
    await db.doc(`cmsPublishQueue/${queueId}`).update({ status: 'failed', claim: null, nextAttemptAt: null });
  }
}
async function failHome() {
  const homeId = 'H'.repeat(20);
  const operation = { schemaVersion: 1, operationId: homeId, pageId: 'home', path: '/', ownedPaths: ['/', '/_home-sources.json'],
    rendererSha: sha, generation: 1, sourceVersion: 1, visible: true };
  const nextDocument = { status: 'published', publiclyVisible: true, published: { sourceVersion: 1, metadata: {}, blocks: [] } };
  await db.runTransaction(async transaction => {
    const plan = await home.prepareHomePlanInTransaction({ firestore: db, transaction, nextDocument, operation, runtime });
    transaction.set(db.doc('system/publicDeployment/noBuildPageOwners/home'), { ...operation, runtime });
    transaction.set(db.doc(`cmsPublishQueue/${homeId}`), { status: 'success', transport: 'page-no-build-v1', backgroundRuntime: runtime, noBuildPage: operation });
    transaction.set(db.doc('cmsPages/home'), nextDocument); plan!.write();
  });
  await db.doc(`cmsPublishQueue/${queueId}`).set({ status: 'pending', transport: 'post-no-build-v1', backgroundRuntime: runtime,
    noBuildPost: { operationId: queueId, postId: 'native-post', sourceVersion: 1, rendererSha: sha } });
  await db.runTransaction(async transaction => { (await home.prepareHomePostRefreshInTransaction({ firestore: db, transaction,
    postId: 'native-post', nextDocument, queueId, affectedSections: [] }))(); });
  await expect(apply()).rejects.toThrow();
  await db.doc(`cmsPublishQueue/${queueId}/homePageRefresh/home`).update({ status: 'failed', attempts: 4, claim: null, nextAttemptAt: null });
  await db.doc(`cmsPublishQueue/${queueId}`).update({ status: 'failed', claim: null, nextAttemptAt: null });
}
async function failPost(kind: string) {
  const post = { postId: 'proof-post', operationId: queueId, sourceVersion: 1, rendererSha: sha, generation: 2,
    visible: true, slug: 'proof-post', ownedSlugs: ['proof-post'] };
  await db.doc(`cmsPublishQueue/${queueId}`).set({ status: kind === 'proof' ? 'success' : 'pending',
    transport: 'post-no-build-v1', backgroundRuntime: runtime, noBuildPost: post, claim: null, nextAttemptAt: null,
    ...(kind === 'proof' ? { postProof: { status: 'pending', attempts: 1, claim: null, nextAttemptAt: Date.now() + 60000 } } : {}) });
  await db.doc('system/publicDeployment/noBuildPostOwners/proof-post').set({ schemaVersion: 1, servingEnabled: true, ...post, runtime });
  await expect(apply()).rejects.toThrow();
  await db.doc(`cmsPublishQueue/${queueId}`).update(kind === 'proof'
    ? { postProof: { status: 'failed', attempts: 4, claim: null, nextAttemptAt: null } } : { status: 'public_unconfirmed' });
}
async function snapshot() {
  const rows: any[] = [];
  for (const collection of ['cmsPublishQueue', 'cmsBackgroundOutputs', 'admin_logs', 'system/publicDeployment/noBuildPageOwners']) {
    for (const row of (await db.collection(collection).get()).docs) {
      rows.push(row);
      if (collection === 'cmsPublishQueue') for (const family of ['backgroundOutputs', 'backgroundPreparation', 'homePageRefresh']) {
        rows.push(...(await row.ref.collection(family).get()).docs);
      }
    }
  }
  rows.push(...await db.getAll(...['system/publicDeployment', 'system/cmsPublicationRuntime', markerPath,
    admission.BOOTSTRAP_ADMISSION_FENCE_PATH, 'system/publicDeployment/releaseWriter/fence',
    'system/publicReleaseChanges', enrollment.ENROLLMENT_PATH, 'system/publicReleaseChangeLog',
    ...['attempts', 'failures', 'drains', 'restores', 'recoveries'].map(family => `${root}/${family}/${operationId}`)]
    .map(path => db.doc(path))));
  return rows.map(row => [row.ref.path, row.data(), row.updateTime]).sort(([a], [b]) => a.localeCompare(b));
}
it.each(['post', 'page', 'home'])('records an expired final %s claim admitted before pause as a truthful production STOP', async family => {
  const due = Date.now() + 60_000, claim = '11111111-1111-4111-8111-111111111111';
  const post = { schemaVersion: 1, postId: 'interrupted-post', operationId: queueId, sourceVersion: 1, rendererSha: sha,
    generation: 2, visible: true, slug: 'interrupted-post', ownedSlugs: ['interrupted-post'] };
  const pageId = family === 'home' ? 'home' : 'about';
  const document = { publiclyVisible: true, published: { sourceVersion: 1, metadata: {}, blocks: [] } };
  const page = { schemaVersion: 1, operationId: family === 'home' ? 'H'.repeat(20) : queueId, pageId,
    path: family === 'home' ? '/' : '/about/', ownedPaths: family === 'home' ? ['/', '/_home-sources.json'] : ['/about/'],
    rendererSha: sha, generation: 2, sourceVersion: 1, visible: true, snapshotDigest: pageOwnership.digest(document.published) };
  if (family === 'post' || family === 'home') {
    await db.doc(`cmsPublishQueue/${queueId}`).set({ status: family === 'home' ? 'success' : 'pending', transport: 'post-no-build-v1',
      backgroundRuntime: runtime, noBuildPost: post, attempts: 4, claim: family === 'home' ? null : claim,
      nextAttemptAt: family === 'home' ? null : due });
    await db.doc('system/publicDeployment/noBuildPostOwners/interrupted-post').set({ ...post, servingEnabled: true, runtime });
    await db.doc('cmsPosts/interrupted-post').set(document);
  }
  if (family !== 'post') {
    await db.runTransaction(async transaction => {
      const plan = family === 'home' ? await home.prepareHomePlanInTransaction({ firestore: db, transaction,
        nextDocument: document, operation: page, runtime }) : null;
      transaction.set(db.doc(`system/publicDeployment/noBuildPageOwners/${pageId}`), { ...page, servingEnabled: true, runtime });
      transaction.set(db.doc(`cmsPages/${pageId}`), document);
      transaction.set(db.doc(`cmsPublishQueue/${page.operationId}`), { status: family === 'home' ? 'success' : 'pending',
        transport: 'page-no-build-v1', backgroundRuntime: runtime, noBuildPage: page,
        changes: [{ collection: 'cmsPages', id: pageId, sourceVersion: 1 }], attempts: 4,
        claim: family === 'home' ? null : claim, nextAttemptAt: family === 'home' ? null : due });
      plan?.write();
    });
  }
  const ref = family === 'home' ? db.doc(`cmsPublishQueue/${queueId}/homePageRefresh/home`) : db.doc(`cmsPublishQueue/${queueId}`);
  if (family === 'home') {
    await db.runTransaction(async transaction => { (await home.prepareHomePostRefreshInTransaction({ firestore: db, transaction,
      postId: post.postId, nextDocument: document, queueId, affectedSections: [] }))(); });
    await ref.update({ attempts: 4, claim, nextAttemptAt: due });
  }
  await expect(apply()).rejects.toThrow();
  expect(await pause.readPublicReleasePause({ firestore: db, attempt })).toMatchObject({ pauseCommitted: true, drainCommitted: false, stop: false });
  const fetchPublic = vi.fn(async () => { throw new Error('Expired claims must not perform public IO'); });
  const options = { firestore: db, operationId: queueId, now: () => due, fetchPublic };
  if (family === 'post') await postConfirmation.recoverNoBuildPostDetail(options);
  else if (family === 'page') await pageConfirmation.recoverNoBuildPageDetail(options);
  else await pageConfirmation.recoverNoBuildHomeRefresh(options);
  expect((await ref.get()).data()).toMatchObject({ status: 'failed', attempts: 4, claim: null, nextAttemptAt: null });
  expect(fetchPublic).not.toHaveBeenCalled();
  const failed = await apply();
  expect(failed).toMatchObject({ stop: true, drainCommitted: false, recoveryIssue: 4582 });
  expect(failed.failureReceipt.blockers).toContainEqual({ code: family === 'home' ? 'home-refresh-exhausted' : 'queue-failed',
    operationId: queueId, path: ref.path });
  expect((await db.doc(`${root}/drains/${operationId}`).get()).exists).toBe(false);
  await expect(pause.restorePublicReleasePausedRuntime({ firestore: db, attempt })).rejects.toThrow('#4582');
  expect(await apply()).toMatchObject({ idempotent: true, stop: true, drainCommitted: false });
});
it.each(['output', 'preparation', 'home', 'proof', 'unconfirmed'])('retains the original %s failure through retries, return and enrollment refusal', async shape => {
  if (shape === 'home') await failHome();
  else if (['proof', 'unconfirmed'].includes(shape)) await failPost(shape);
  else await failContext(shape);
  const failed = await apply();
  expect(failed).toMatchObject({ stop: true, outcome: 'paused-failed', drainCommitted: false, currentReady: false, recoveryIssue: 4582 });
  const codes = { output: 'background-exhausted', preparation: 'background-preparation-exhausted', home: 'home-refresh-exhausted',
    proof: 'queue-failed', unconfirmed: 'queue-failed' };
  expect(failed.failureReceipt.blockers).toContainEqual(expect.objectContaining({ code: codes[shape] }));
  if (shape === 'proof') expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).data()?.status).toBe('success');
  // A closed original fence is necessary for successful enrollment; it cannot
  // convert a failed original into that success or permit a legacy return.
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: closeAttempt });
  const census = await db.runTransaction(transaction => baseline.readPublicReleaseSourceCensusInTransaction({ firestore: db, transaction }), { readOnly: true });
  const request = { schemaVersion: 1, operationId, logEpoch: 'refused-failed-epoch', baselineDigest: 'b'.repeat(64), expected: {
    projectId: 'njpbs-site', liveReleaseSha: sha, pointerDigest: p.publicReleaseDigest(pointer),
    runtimeDigest: p.publicReleaseDigest((await db.doc('system/cmsPublicationRuntime').get()).data()),
    contextRevision: 1, contextDigest: publicContextDigest(1), publicSourceCensusDigest: census.sourceMemberCensusDigest } };
  const readCode = vi.fn(async () => { throw new Error('Failed original must refuse before CODE'); });
  const before = await snapshot();
  expect(await apply()).toEqual({ ...failed, ownsClosedFence: true, idempotent: true });
  expect(await pause.readPublicReleasePause({ firestore: db, attempt })).toMatchObject({ outcome: 'paused-failed', drainCommitted: false });
  const recoveryAttempt = { schemaVersion: 1, pauseAttempt: attempt, pauseReceiptDigest: p.publicReleaseDigest(failed.pauseReceipt), failureReceiptDigest: failed.failureReceiptDigest };
  await expect(recovery.recoverDevPublicReleasePause({ firestore: db, attempt: recoveryAttempt })).rejects.toThrow();
  await expect(pause.restorePublicReleasePausedRuntime({ firestore: db, attempt })).rejects.toThrow('#4582');
  await expect(adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: closeAttempt }))
    .rejects.toMatchObject({ name: 'PublicReleaseProtocolError' });
  expect(await pause.readPublicReleaseRuntimeRestore({ firestore: db, attempt })).toMatchObject({ restoreCommitted: false, drainReady: false, canAbandon: false });
  await expect(enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db })).rejects.toThrow('enrollment-production-recovery-unreviewed');
  for (const dryRun of [true, false]) await expect(enrollment.enrollPublicReleaseChangeLog({ firestore: db, request, dryRun, currentCodeRequest: readCode }))
    .rejects.toThrow('enrollment-production-recovery-unreviewed');
  await expect(pause.pausePublicRelease({ firestore: db, attempt: { ...attempt, operationId: 'later-original' } })).rejects.toThrow();
  expect(readCode).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
  expect((await db.doc(`${root}/attempts/later-original`).get()).exists).toBe(false);
  for (const family of ['bodies', 'baselines', 'baselineDigests', 'codeChunks']) expect((await db.collection(`system/publicReleaseChanges/${family}`).get()).empty).toBe(true);
  // Even if a queue later changes, its immutable failed-pause receipt cannot
  // become a drain, create a singleton marker or lose the original history.
  await db.doc(`cmsPublishQueue/${queueId}`).update({ status: 'success', ...(shape === 'proof'
    ? { postProof: { status: 'verified', attempts: 4, claim: null, nextAttemptAt: null } } : {}) });
  const afterQueueChange = await snapshot();
  expect(await apply()).toMatchObject({ idempotent: true, stop: true, outcome: 'paused-failed', drainCommitted: false, failureReceiptDigest: failed.failureReceiptDigest });
  expect(await snapshot()).toEqual(afterQueueChange);
});
it.each(['original', 'later-original'])('refuses an unsupported marker for %s in capture, projection and enrollment without deleting it', async markerOperation => {
  await apply();
  const marker = { schemaVersion: 1, kind: 'production-public-release-failed-not-published', projectId: 'njpbs-site', operationId: markerOperation,
    receiptDigest: 'c'.repeat(64), failureReceiptDigest: 'd'.repeat(64), remedy: 'logged-republish-after-resume',
    failedWork: [{ operationId: queueId, queuePath: `cmsPublishQueue/${queueId}`, outcome: 'failed-not-published', originalQueueStatus: 'failed',
      documents: ['cmsPosts/proof-post'], failureReceiptDigest: 'd'.repeat(64), records: [{ path: `cmsPublishQueue/${queueId}`, digest: 'e'.repeat(64) }] }] };
  await db.doc(markerPath).create(marker);
  const before = await snapshot();
  expect(() => source.publicReleaseAuthorityDocument(markerPath, marker)).toThrow();
  expect(() => source.publicReleaseAuthorityIdentityDocument(markerPath, marker)).toThrow();
  expect(() => projectPublicReleasePairSourceCensusDocuments(new Map([[markerPath, marker]]))).toThrow('source-census-projection-unsupported');
  await expect(db.runTransaction(transaction => baseline.readPublicReleaseSourceCensusInTransaction({ firestore: db, transaction }), { readOnly: true })).rejects.toThrow();
  await expect(enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db })).rejects.toThrow('enrollment-production-recovery-unreviewed');
  expect(await snapshot()).toEqual(before);
});
