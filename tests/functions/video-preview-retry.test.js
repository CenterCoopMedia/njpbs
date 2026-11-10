import { describe, expect, it, vi } from 'vitest';
import { parseArguments, retryFailedPreview } from '../../scripts/backfill-video-previews.mjs';
import previews from '../../functions/lib/video-preview-job.js';
import processor from '../../functions/lib/video-preview-processor.js';

// The script reads its configured workflow at import; supply a synthetic one first.
const workflowArn = vi.hoisted(() => {
  const arn = 'arn:aws:states:us-east-2:123456789012:stateMachine:njpbs-boardwalk-video-previews-workflow';
  process.env.BOARDWALK_VIDEO_PREVIEW_WORKFLOW_ARN = arn;
  return arn;
});
const assetId = '30cba8ee-6579-4cff-a7e5-2fd6b434d395';

// Firestore boundary fake with buffered writes and optimistic document conflicts.
function database() {
  const asset = { sourceId: 'video-library', lifecycle: 'active', name: 'Fixture', originalName: 'fixture.mov',
    nameSort: 'fixture', updatedAtSort: '2026-10-13T18:00:00Z', mimeType: 'video/quicktime', kind: 'video',
    sizeBytes: 23880721110, preview: 'download_only', rightsStatus: 'pending', tags: ['campus'], version: 4,
    objectKey: 'objects/fixture.mov', objectVersionId: 'original-v1' };
  const job = { ...previews.pendingPreview({ id: assetId, ...asset }), actorUid: 'staff/fixture',
    phase: 'failed', active: false, failures: 4, leaseOwner: 'old-owner', leaseUntil: 99 };
  job.executionArn = processor.executionArn(workflowArn, job);
  asset.rendition = previews.renditionState(job, 'failed');
  const records = new Map([[`mediaSourceAssets/${assetId}`, asset], [`mediaSourcePreviewJobs/${job.id}`, job],
    ['mediaSourcePreviewAdmissionLocks/global', { revision: 7 }],
    ['mediaSourcePreviewAdmissionLocks/actor-staff%2Ffixture', { revision: 3 }]]);
  const versions = new Map();
  let sequence = 0;
  const snapshot = (key, id) => ({ id, exists: records.has(key), data: () => structuredClone(records.get(key)) });
  function query(collection, filters = [], count = Infinity) {
    return {
      collection,
      doc(id = `audit-${++sequence}`) {
        const key = `${collection}/${id}`;
        return { key, id, get: async () => snapshot(key, id) };
      },
      where(field, operator, value) {
        if (operator !== '==') throw Error('Unsupported boundary query');
        return query(collection, [...filters, [field, value]], count);
      },
      limit(value) { return query(collection, filters, value); },
      async get() {
        const docs = [...records].filter(([key, value]) => key.startsWith(`${collection}/`) &&
          filters.every(([field, expected]) => value[field] === expected)).slice(0, count)
          .map(([key]) => snapshot(key, key.split('/').at(-1)));
        return { docs, size: docs.length };
      },
    };
  }
  const firestore = { records, collection: query, async runTransaction(run) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reads = new Map();
      const writes = [];
      const result = await run({
        async get(ref) {
          if (ref.key) reads.set(ref.key, versions.get(ref.key) ?? 0);
          return ref.get();
        },
        set: (ref, value) => writes.push([ref.key, value]),
        update: (ref, patch) => writes.push([ref.key, { ...records.get(ref.key), ...patch }]),
        create: (ref, value) => writes.push([ref.key, value]),
      });
      if ([...reads].some(([key, version]) => (versions.get(key) ?? 0) !== version)) continue;
      for (const [key, value] of writes) { records.set(key, value); versions.set(key, (versions.get(key) ?? 0) + 1); }
      return result;
    }
    throw Error('Transaction conflict');
  } };
  return { firestore, job, asset };
}

function failedExecution(job, status = 'FAILED') {
  return { executionArn: job.executionArn, stateMachineArn: workflowArn, status,
    input: JSON.stringify(processor.workflowInput(job)) };
}

describe('failed viewing-copy recovery', () => {
  it.each(['FAILED', 'TIMED_OUT', 'ABORTED'])('checks %s without writing in the default dry run', async status => {
    const { firestore, job } = database();
    const before = structuredClone([...firestore.records]);
    const result = await retryFailedPreview({ firestore, assetId, describeExecution: async arn => {
      expect(arn).toBe(job.executionArn);
      return failedExecution(job, status);
    } });
    expect(result).toMatchObject({ apply: false, state: 'eligible', executionStatus: status });
    expect([...firestore.records]).toEqual(before);
  });

  it.each(['RUNNING', 'SUCCEEDED', 'PENDING_REDRIVE', undefined, 'UNKNOWN'])('refuses provider status %s', async status => {
    const { firestore, job } = database();
    const before = structuredClone([...firestore.records]);
    const result = await retryFailedPreview({ firestore, assetId, apply: true,
      describeExecution: async () => ({ ...failedExecution(job), status }) });
    expect(result).toMatchObject({ state: 'refused', reason: 'execution_not_failed' });
    expect([...firestore.records]).toEqual(before);
  });

  it('refuses an unavailable execution or an uncertain start', async () => {
    const { firestore, job } = database();
    const args = { firestore, assetId, apply: true, describeExecution: async () => { throw Error('Provider unavailable'); } };
    expect(await retryFailedPreview(args)).toMatchObject({ reason: 'execution_status_unavailable' });
    delete job.executionArn;
    job.phase = 'needs_reconciliation';
    expect(await retryFailedPreview(args)).toMatchObject({ reason: 'execution_identity_unconfirmed' });
    expect(firestore.records.get(`mediaSourcePreviewJobs/${job.id}`).attemptId).toBe(job.attemptId);
  });

  it.each(['objectVersionId', 'sizeBytes'])('refuses a changed source %s before admission', async field => {
    const { firestore, job, asset } = database();
    asset[field] = field === 'sizeBytes' ? asset.sizeBytes + 1 : 'original-v2';
    const before = structuredClone([...firestore.records]);
    expect(await retryFailedPreview({ firestore, assetId, apply: true,
      describeExecution: async () => failedExecution(job) })).toMatchObject({ state: 'refused' });
    expect([...firestore.records]).toEqual(before);
  });

  it.each(['executionArn', 'stateMachineArn', 'input'])('refuses a mismatched provider %s', async field => {
    const { firestore, job } = database();
    expect(await retryFailedPreview({ firestore, assetId, apply: true,
      describeExecution: async () => ({ ...failedExecution(job), [field]: 'wrong' }) })).toMatchObject({ state: 'refused' });
    expect(firestore.records.get(`mediaSourcePreviewJobs/${job.id}`).phase).toBe('failed');
  });

  it.each(['staff', 'shared'])('respects %s capacity including upload reservations', async kind => {
    const { firestore, job } = database();
    const count = kind === 'staff' ? 2 : 20;
    for (let index = 0; index < count; index++) {
      firestore.records.set(`mediaSourcePreviewJobs/hold-${index}`, { active: true, phase: 'reserved',
        actorUid: kind === 'staff' ? job.actorUid : `other-${index}` });
    }
    for (const apply of [false, true]) {
      const before = structuredClone([...firestore.records]);
      expect(await retryFailedPreview({ firestore, assetId, apply,
        describeExecution: async () => failedExecution(job) })).toMatchObject({ reason: `${kind}_capacity` });
      expect([...firestore.records]).toEqual(before);
    }
  });

  it('queues one fresh attempt, uses both locks, and preserves staff metadata and the original', async () => {
    const { firestore, job, asset } = database();
    const before = structuredClone(asset);
    const result = await retryFailedPreview({ firestore, assetId, apply: true, describeExecution: async () => failedExecution(job) });
    expect(result).toMatchObject({ state: 'queued', previousAttemptId: job.attemptId });
    const next = firestore.records.get(`mediaSourcePreviewJobs/${job.id}`);
    expect(next).toMatchObject({ id: job.id, phase: 'pending', active: true, actorUid: job.actorUid, leaseUntil: 0,
      sourceObjectVersionId: 'original-v1', sourceSizeBytes: 23880721110 });
    expect(next.attemptId).not.toBe(job.attemptId);
    for (const field of ['executionArn', 'leaseOwner', 'failures']) expect(next).not.toHaveProperty(field);
    const current = firestore.records.get(`mediaSourceAssets/${assetId}`);
    expect(current.rendition).toMatchObject({ state: 'processing', attemptId: next.attemptId });
    expect({ ...current, rendition: before.rendition }).toEqual(before);
    expect(firestore.records.get('mediaSourcePreviewAdmissionLocks/global')).toEqual({ revision: 8 });
    expect(firestore.records.get('mediaSourcePreviewAdmissionLocks/actor-staff%2Ffixture')).toEqual({ revision: 4 });
    expect([...firestore.records].find(([key]) => key.startsWith('admin_logs/'))[1]).toMatchObject({
      action: 'media.source.preview.retry', before: { attemptId: job.attemptId }, after: { attemptId: next.attemptId } });
    expect(await retryFailedPreview({ firestore, assetId, apply: true,
      describeExecution: async () => failedExecution(job) })).toMatchObject({ reason: 'job_not_failed' });
  });

  it.each(['source', 'attempt'])('refuses a concurrent %s change after DescribeExecution', async kind => {
    const { firestore, job, asset } = database();
    const result = await retryFailedPreview({ firestore, assetId, apply: true, describeExecution: async () => {
      const execution = failedExecution(job);
      if (kind === 'source') asset.sizeBytes++;
      else job.attemptId = '11111111-1111-1111-1111-111111111111';
      return execution;
    } });
    expect(result).toMatchObject({ state: 'refused', reason: 'source_or_job_changed' });
    expect(firestore.records.get('mediaSourcePreviewAdmissionLocks/global').revision).toBe(7);
  });

  it('admits only one attempt when two operators race', async () => {
    const { firestore, job } = database();
    const args = { firestore, assetId, apply: true, describeExecution: async () => failedExecution(job) };
    const results = await Promise.all([retryFailedPreview(args), retryFailedPreview(args)]);
    expect(results.map(result => result.state).sort()).toEqual(['queued', 'refused']);
    expect(firestore.records.get('mediaSourcePreviewAdmissionLocks/global').revision).toBe(8);
  });

  it.each(['staff', 'shared'])('serializes competing assets for the last %s slot', async kind => {
    const { firestore, job, asset } = database();
    const secondAssetId = 'fixture-two';
    const secondAsset = { ...asset, objectKey: 'objects/fixture-two.mov' };
    const secondJob = { ...previews.pendingPreview({ id: secondAssetId, ...secondAsset }), actorUid: job.actorUid,
      active: false, phase: 'failed' };
    secondJob.executionArn = processor.executionArn(workflowArn, secondJob);
    secondAsset.rendition = previews.renditionState(secondJob, 'failed');
    firestore.records.set(`mediaSourceAssets/${secondAssetId}`, secondAsset);
    firestore.records.set(`mediaSourcePreviewJobs/${secondJob.id}`, secondJob);
    for (let index = 0; index < (kind === 'staff' ? 1 : 19); index++) {
      firestore.records.set(`mediaSourcePreviewJobs/hold-${index}`, { active: true, phase: 'reserved',
        actorUid: kind === 'staff' ? job.actorUid : `other-${index}` });
    }
    const results = await Promise.all([job, secondJob].map(current => retryFailedPreview({ firestore,
      assetId: current.assetId, apply: true, describeExecution: async () => failedExecution(current) })));
    expect(results.map(result => result.state).sort()).toEqual(['queued', 'refused']);
    expect(results.find(result => result.state === 'refused').reason).toBe(`${kind}_capacity`);
    expect(firestore.records.get('mediaSourcePreviewAdmissionLocks/global').revision).toBe(8);
  });
});

describe('preview backfill arguments', () => {
  it('keeps retry explicit and dry by default', () => {
    expect(parseArguments([])).toEqual({ apply: false, cursor: '', retryAssetId: '' });
    expect(parseArguments(['--retry-failed', assetId])).toEqual({ apply: false, cursor: '', retryAssetId: assetId });
    expect(parseArguments(['--apply', '--after', 'cursor'])).toEqual({ apply: true, cursor: 'cursor', retryAssetId: '' });
  });
  it.each([['--retry-failed'], ['--retry-failed', 'bad/id'], ['--retry-failed', assetId, '--after', 'cursor'],
    ['--apply', '--apply'], ['--unknown']])('refuses ambiguous arguments %j', (...args) => {
    expect(() => parseArguments(args)).toThrow();
  });
});
