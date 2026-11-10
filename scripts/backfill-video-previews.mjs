#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import searchOutbox from "../functions/lib/video-search-outbox.js";
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, cert, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldPath, FieldValue } = require('firebase-admin/firestore');
const { SFNClient, DescribeExecutionCommand } = require('@aws-sdk/client-sfn');
const { fromIni } = require('@aws-sdk/credential-providers');
const { parseSourceMediaAsset, ID_PATTERN } = require('./lib/source-media-contract');
const { PREVIEW_JOBS, pendingPreview, previewIdentity, sameOriginal, renditionState } = require('./lib/video-preview-job');
const { executionArn, samePreviewExecution } = require('./lib/video-preview-processor');

export const WORKFLOW_ARN = (process.env.BOARDWALK_VIDEO_PREVIEW_WORKFLOW_ARN ?? "");

function previewAsset(snapshot) {
  const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
  // The parser requires active lifecycle but omits it from its returned asset.
  return asset ? { ...asset, lifecycle: 'active' } : null;
}

export function parseArguments(args) {
  const options = { apply: false, cursor: '', retryAssetId: '' };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--apply', '--after', '--retry-failed'].includes(flag) || seen.has(flag)) throw Error('Invalid arguments');
    seen.add(flag);
    if (flag === '--apply') { options.apply = true; continue; }
    const value = args[++index];
    if (!value || !ID_PATTERN.test(value) || value.startsWith('--')) throw Error('Invalid arguments');
    options[flag === '--after' ? 'cursor' : 'retryAssetId'] = value;
  }
  if (options.cursor && options.retryAssetId) throw Error('Retry cannot use a backfill cursor');
  return options;
}

// Use the same global/staff locks and active-job queries as upload admission.
// An execution whose start or outcome is uncertain must keep its current attempt.
export async function retryFailedPreview({ firestore, assetId, describeExecution, apply = false }) {
  if (!ID_PATTERN.test(assetId)) throw Error('Invalid asset ID');
  const refused = reason => ({ assetId, apply, state: 'refused', reason });
  const assetRef = firestore.collection('mediaSourceAssets').doc(assetId);
  const snapshot = await assetRef.get();
  const asset = previewAsset(snapshot);
  if (!asset || asset.sourceId !== 'video-library' || !asset.objectKey.startsWith('objects/') || asset.sizeBytes <= 0) {
    return refused('source_invalid');
  }
  const jobs = firestore.collection(PREVIEW_JOBS);
  const ref = jobs.doc(previewIdentity(asset));
  const job = (await ref.get()).data();
  if (!job || job.id !== ref.id || job.assetId !== assetId || !sameOriginal(asset, job)) return refused('job_source_mismatch');
  if (typeof job.actorUid !== 'string' || !job.actorUid.trim() || job.actorUid.length > 128) return refused('staff_account_missing');
  if (job.active !== false || !['failed', 'needs_reconciliation'].includes(job.phase)) return refused('job_not_failed');
  if (typeof job.attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(job.attemptId) ||
      job.executionArn !== executionArn(WORKFLOW_ARN, job)) return refused('execution_identity_unconfirmed');

  let execution;
  try { execution = await describeExecution(job.executionArn); }
  catch { return refused('execution_status_unavailable'); }
  if (execution?.executionArn !== job.executionArn || execution.stateMachineArn !== WORKFLOW_ARN) {
    return refused('execution_identity_unconfirmed');
  }
  if (!['FAILED', 'TIMED_OUT', 'ABORTED'].includes(execution.status)) return refused('execution_not_failed');
  if (!samePreviewExecution(job, execution, WORKFLOW_ARN)) return refused('execution_input_mismatch');

  const locks = firestore.collection('mediaSourcePreviewAdmissionLocks');
  const lockRefs = [locks.doc('global'), locks.doc(`actor-${encodeURIComponent(job.actorUid)}`)];
  return firestore.runTransaction(async tx => {
    const [current, existing, actorPreviews, globalPreviews, ...lockSnapshots] = await Promise.all([
      tx.get(assetRef), tx.get(ref),
      tx.get(jobs.where('actorUid', '==', job.actorUid).where('active', '==', true).limit(2)),
      tx.get(jobs.where('active', '==', true).limit(20)),
      ...lockRefs.map(lock => tx.get(lock)),
    ]);
    const fresh = previewAsset(current);
    if (!sameOriginal(fresh, job) || !isDeepStrictEqual(existing.data(), job)) return refused('source_or_job_changed');
    if (actorPreviews.size >= 2) return refused('staff_capacity');
    if (globalPreviews.size >= 20) return refused('shared_capacity');
    if (!apply) return { assetId, apply, state: 'eligible', previousAttemptId: job.attemptId, executionStatus: execution.status };

    const next = { ...pendingPreview(fresh), actorUid: job.actorUid };
    lockRefs.forEach((lock, index) => tx.set(lock, { revision: (lockSnapshots[index].data()?.revision ?? 0) + 1 }));
    tx.set(ref, next);
    tx.update(assetRef, { rendition: renditionState(next, 'processing') });
    searchOutbox.enqueueVideoSearchShard(tx, firestore, assetId);
    tx.create(firestore.collection('admin_logs').doc(), {
      actorUid: 'system:video-preview-retry', actorEmail: null, action: 'media.source.preview.retry',
      target: `mediaSourceAssets/${assetId}`, before: { attemptId: job.attemptId, executionArn: job.executionArn },
      after: { attemptId: next.attemptId, sourceObjectVersionId: next.sourceObjectVersionId, actorUid: next.actorUid },
      source: null, timestamp: FieldValue.serverTimestamp(), at: new Date().toISOString(),
    });
    return { assetId, apply, state: 'queued', previousAttemptId: job.attemptId, attemptId: next.attemptId };
  });
}

async function main() {
  const { apply, cursor, retryAssetId } = parseArguments(process.argv.slice(2));
  const credential = JSON.parse(readFileSync(0, 'utf8'));
  if (credential.project_id !== 'njpbs-site') throw Error('Wrong Firebase project');
  const app = initializeApp({ credential: cert(credential), projectId: credential.project_id });
  try {
    const db = getFirestore(app);
    if (retryAssetId) {
      const client = new SFNClient({ region: 'us-east-2',
        credentials: fromIni({ profile: process.env.AWS_PROFILE ?? 'njpbs' }), maxAttempts: 2 });
      try {
        const result = await retryFailedPreview({ firestore: db, assetId: retryAssetId, apply,
          describeExecution: arn => client.send(new DescribeExecutionCommand({ executionArn: arn })) });
        console.log(JSON.stringify(result));
        if (result.state === 'refused') process.exitCode = 1;
      } finally { client.destroy(); }
      return;
    }
    let query = db.collection('mediaSourceAssets').where('sourceId', '==', 'video-library')
      .orderBy(FieldPath.documentId()).limit(20);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    let eligible = 0, queued = 0;
    for (const snapshot of page.docs) {
      const asset = parseSourceMediaAsset(snapshot.id, snapshot.data());
      if (!asset || !asset.objectKey.startsWith('objects/') || asset.sizeBytes <= 0) continue;
      const job = pendingPreview(asset);
      const ref = db.collection(PREVIEW_JOBS).doc(job.id);
      if ((await ref.get()).exists) continue;
      eligible++;
      if (!apply) continue;
      const created = await db.runTransaction(async tx => {
        const [current, existing] = await Promise.all([tx.get(snapshot.ref), tx.get(ref)]);
        const fresh = parseSourceMediaAsset(current.id, current.data());
        if (existing.exists || !fresh || pendingPreview(fresh).id !== job.id) return false;
        tx.create(ref, job);
        tx.update(snapshot.ref, { rendition: renditionState(job, 'processing') });
        return true;
      });
      if (created) queued++;
    }
    console.log(JSON.stringify({ apply, scanned: page.size, eligible, queued,
      nextCursor: page.size === 20 ? page.docs.at(-1).id : null }));
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Preview backfill failed; no credential details logged'); process.exitCode = 1; });
}
