import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import admin from '../helpers/firebase-admin.js';
import previews from '../../functions/video-previews.js';
import jobs from '../../functions/lib/video-preview-job.js';
import processors from '../../functions/lib/video-preview-processor.js';

const PROJECT = 'demo-njpbs';
const config = { source: { prefix: '' }, workflowArn: 'arn:aws:states:us-east-2:123456789012:stateMachine:preview' };
let db;

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("video-preview-tick.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }, db);
});
afterAll(async () => {
  await Promise.all(admin.apps.map(app => app.delete()));
});

async function seed(count = 2) {
  const entries = Array.from({ length: count }, (_, index) => {
    const asset = { id: `asset-${index}`, sourceId: 'video-library', objectKey: `objects/${index}.mov`,
      objectVersionId: 'original-v1', sizeBytes: 123, lifecycle: 'active' };
    const job = { ...jobs.pendingPreview(asset), phase: 'running' };
    job.executionArn = processors.executionArn(config.workflowArn, job);
    return { asset, job };
  }).sort((a, b) => a.job.id.localeCompare(b.job.id));
  await Promise.all(entries.flatMap(({ asset, job }) => [
    db.collection('mediaSourceAssets').doc(asset.id).set(asset),
    db.collection(jobs.PREVIEW_JOBS).doc(job.id).set(job),
  ]));
  return entries;
}

function succeeded(job) {
  const prefix = `outputs/${job.id}/${job.attemptId}/`;
  return { status: 'SUCCEEDED', output: JSON.stringify({ id: job.id, attemptId: job.attemptId,
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: 'web-v1', sizeBytes: 50, mimeType: 'video/mp4' },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: 'poster-v1', sizeBytes: 5, mimeType: 'image/jpeg' } }) };
}

it('finalizes a finished job behind a still-running job in the same tick', async () => {
  const [running, finished] = await seed();
  const processor = processors.createVideoPreviewProcessor(config, { client: { send: async command =>
    command.input.executionArn === running.job.executionArn ? { status: 'RUNNING' } : succeeded(finished.job) } });
  await previews.processPreviewTick({ firestore: db, config, processor });
  expect((await db.collection(jobs.PREVIEW_JOBS).doc(running.job.id).get()).data()).toMatchObject({ active: true, phase: 'running', leaseUntil: 0 });
  expect((await db.collection(jobs.PREVIEW_JOBS).doc(finished.job.id).get()).data()).toMatchObject({ active: false, phase: 'ready' });
  expect((await db.collection('mediaSourceAssets').doc(finished.asset.id).get()).data().rendition).toMatchObject({ state: 'ready', attemptId: finished.job.attemptId });
});

it('continues to the next job after a provider failure', async () => {
  const [failed, finished] = await seed();
  const processor = processors.createVideoPreviewProcessor(config, { client: { send: async command => {
    if (command.input.executionArn === failed.job.executionArn) throw Error('Provider unavailable');
    return succeeded(finished.job);
  } } });
  await previews.processPreviewTick({ firestore: db, config, processor });
  expect((await db.collection(jobs.PREVIEW_JOBS).doc(failed.job.id).get()).data()).toMatchObject({ active: true, failures: 1, leaseUntil: 0 });
  expect((await db.collection('mediaSourceAssets').doc(finished.asset.id).get()).data().rendition.state).toBe('ready');
});

it('keeps the five-job query bound and skips an existing lease', async () => {
  const entries = await seed(6);
  await db.collection(jobs.PREVIEW_JOBS).doc(entries[0].job.id).update({ leaseUntil: Date.now() + 300_000 });
  const checked = [];
  await previews.processPreviewTick({ firestore: db, config, processor: async job => { checked.push(job.id); } });
  expect(checked).toEqual(entries.slice(1, 5).map(({ job }) => job.id));
});

it('leaves upload admission holds untouched while checking active jobs', async () => {
  const entries = await seed();
  const hold = { active: true, phase: 'reserved', actorUid: 'uploading-editor' };
  const holdRef = db.collection(jobs.PREVIEW_JOBS).doc('hold-upload-session');
  await holdRef.set(hold);
  const processor = processors.createVideoPreviewProcessor(config, { client: { send: async () => ({ status: 'RUNNING' }) } });
  const result = await previews.processPreviewTick({ firestore: db, config, processor });
  expect(result.jobs.map(job => job.jobId)).toEqual(entries.map(({ job }) => job.id));
  expect((await holdRef.get()).data()).toEqual(hold);
});
