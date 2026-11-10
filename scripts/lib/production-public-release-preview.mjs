import { createRequire } from 'node:module';
import protocol from '../../functions/lib/public-release-pair.js';
import adoption from '../../functions/lib/public-release-bootstrap-adoption.js';
import pause from '../../functions/lib/dev-public-release-pause.js';
import { operatorRefused as refuse } from './public-release-operator-io.mjs';
const { require: native } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const preview = native('../../site/scripts/cms-preview-cloud-control.ts', import.meta.url);
const hash = protocol.publicReleaseDigest, same = (a, b) => a !== undefined && b !== undefined && hash(a) === hash(b);
const root = 'system/productionPublicReleasePause';
const paused = original => ({ ...original, phase: 'paused' });

export function parseProductionPreviewAttempt(attempt) {
  protocol.exact(attempt, ['operationId', 'rendererSha', 'expectedRuntimeDigest', 'legacyPointerDigest']);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attempt.operationId ?? '') ||
      !/^[a-f0-9]{40}$/.test(attempt.rendererSha ?? '') || !protocol.digest(attempt.expectedRuntimeDigest) ||
      !protocol.digest(attempt.legacyPointerDigest)) refuse();
  return protocol.freeze(structuredClone(attempt));
}
function receiptFor(attempt, original) {
  const control = preview.parsePreviewRuntimeControl(original);
  if (control.phase !== 'ready' || control.rendererSha !== attempt.rendererSha || control.serializerId !== 'cloudflare-preview' ||
      hash(original) !== attempt.expectedRuntimeDigest) refuse();
  return { schemaVersion: 1, kind: 'production-preview-bootstrap-pause', attemptDigest: hash(attempt), original };
}
function immutable(row, expected) {
  if (!row.exists || !row.createTime.isEqual(row.updateTime) || !same(row.data(), expected)) refuse();
  return row.data();
}
async function beforeEnrollment(firestore, transaction, attempt) {
  const [pointer, head, enrolled, producer] = await transaction.getAll(...['system/publicDeployment', 'system/publicReleaseChanges',
    'system/publicReleaseChanges/enrollment/initial', 'system/publicReleaseChangeLog'].map(path => firestore.doc(path)));
  if (head.exists || enrolled.exists || producer.exists || pointer.data()?.schemaVersion !== 1 ||
      pointer.data()?.activeCommitSha !== attempt.rendererSha || adoption.legacyBootstrapPointerDigest(pointer.data()) !== attempt.legacyPointerDigest) refuse();
  await adoption.assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment: 'production',
    before: pointer.data(), operationId: attempt.operationId });
}
/** Preserve the existing preview pause writer in its original transaction.
 * Restoring uses only that immutable original, before enrollment under fences. */
export async function runProductionPreview({ firestore, attempt: raw, mode, restore = false, signal }) {
  const attempt = parseProductionPreviewAttempt(raw);
  if (firestore.projectId !== 'njpbs-site') refuse();
  const ref = firestore.doc(`${root}/previewPauses/${attempt.operationId}`), restored = firestore.doc(`${root}/previewRestores/${attempt.operationId}`);
  if (mode === 'readback') {
    const result = await firestore.runTransaction(async transaction => {
      const [saved, returned, current] = await transaction.getAll(ref, restored, firestore.doc(preview.PREVIEW_RUNTIME_DOCUMENT));
      if (!saved.exists) return { pauseCommitted: false, restoreCommitted: false };
      const receipt = immutable(saved, receiptFor(attempt, saved.data().original));
      if (returned.exists) immutable(returned, { schemaVersion: 1, kind: 'production-preview-bootstrap-restored', pauseReceiptDigest: hash(receipt) });
      return { pauseCommitted: true, receipt, restoreCommitted: returned.exists,
        ownsPausedPreview: same(current.data(), paused(receipt.original)), ownsReadyPreview: adoption.sameBootstrapPreviewIdentity(current.data(), receipt.original) };
    }, { readOnly: true });
    return { ...result, drained: result.ownsPausedPreview ? await preview.previewRuntimeDrained(firestore) : false };
  }
  if (restore) {
    return firestore.runTransaction(async transaction => {
      signal?.throwIfAborted();
      const [saved, returned, current] = await transaction.getAll(ref, restored, firestore.doc(preview.PREVIEW_RUNTIME_DOCUMENT));
      const receipt = immutable(saved, receiptFor(attempt, saved.data()?.original));
      const result = { schemaVersion: 1, kind: 'production-preview-bootstrap-restored', pauseReceiptDigest: hash(receipt) };
      if (returned.exists) return { idempotent: true, receipt: immutable(returned, result) };
      await beforeEnrollment(firestore, transaction, attempt);
      if ((await transaction.get(firestore.doc(`${root}/failures/${attempt.operationId}`))).exists) pause.productionFailedPauseRefused();
      if (!same(current.data(), paused(receipt.original))) refuse();
      transaction.set(firestore.doc(preview.PREVIEW_RUNTIME_DOCUMENT), receipt.original);
      transaction.create(restored, result);
      return { idempotent: false, receipt: result };
    });
  }
  let result;
  const guarded = { doc: path => firestore.doc(path), runTransaction: run => firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const [saved, current] = await transaction.getAll(ref, firestore.doc(preview.PREVIEW_RUNTIME_DOCUMENT));
    if (saved.exists) {
      result = { idempotent: true, receipt: immutable(saved, receiptFor(attempt, saved.data().original)) }; return;
    }
    await beforeEnrollment(firestore, transaction, attempt);
    const receipt = receiptFor(attempt, current.data());
    await run(transaction);
    transaction.create(ref, receipt);
    result = { idempotent: false, receipt };
  }) };
  await preview.pausePreviewRuntime(guarded, attempt.rendererSha);
  return result;
}
