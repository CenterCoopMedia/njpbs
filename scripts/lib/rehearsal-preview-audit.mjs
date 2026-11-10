import { createRequire } from 'node:module';
import publicPairs from '../../functions/lib/public-release-pair.js';
import targets from '../../functions/lib/publication-target.js';
import { ADMIN_PROVIDER_OPERATIONS } from './paired-admin-provider-operation.mjs';

const require = createRequire(import.meta.url);
const { Timestamp } = require('firebase-admin/firestore');
const preview = require('../../functions/lib/cms-preview-pair.js');
const { parseCmsPublicationRuntimeControl } = require('../../functions/lib/cms-publication-runtime-control.js');
const fail = () => { throw new Error('Rehearsal preview audit refused'); };
const same = (a, b) => preview.digest(a) === preview.digest(b);
const originalId = value => typeof value === 'string' && /^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(value);

function projection(row) {
  if (!row.exists) return { exists: false, digest: null, updateTime: null };
  const stamp = row.updateTime;
  if (!stamp || !Number.isSafeInteger(stamp.seconds) || !Number.isSafeInteger(stamp.nanoseconds)) fail();
  return { exists: true, digest: preview.digest(row.data()), updateTime: `${stamp.seconds}:${stamp.nanoseconds}` };
}

/** Preserve the SDK timestamp without rounding it to wall-clock precision. */
export function rehearsalAuditVersion(row) {
  if (!row?.exists || !row.createTime?.isEqual(row.updateTime)) fail();
  return { seconds: row.updateTime.seconds, nanoseconds: row.updateTime.nanoseconds };
}

export function assertRehearsalAuditVersion(row, version) {
  if (!version || !Number.isSafeInteger(version.seconds) || !Number.isSafeInteger(version.nanoseconds)) fail();
  rehearsalAuditVersion(row);
  if (!row.updateTime.isEqual(new Timestamp(version.seconds, version.nanoseconds))) fail();
}

/** A completed boundary seals all three original SDK identities. This is
 * evidence only; an incomplete result cannot grant permission to retry. */
export function rehearsalAuditManifest(baseline, intent, result) {
  const value = { schemaVersion: 1, runId: intent.data().runId, boundary: intent.data().boundary,
    configurationDigest: intent.data().configurationDigest,
    baselineVersion: rehearsalAuditVersion(baseline), baselineDigest: preview.digest(baseline.data()),
    intentVersion: rehearsalAuditVersion(intent), intentDigest: preview.digest(intent.data()),
    resultVersion: rehearsalAuditVersion(result), resultDigest: preview.digest(result.data()) };
  if (!same(intent.data().baselineVersion, value.baselineVersion) ||
      !same(result.data().baselineVersion, value.baselineVersion) ||
      !same(result.data().intentVersion, value.intentVersion)) fail();
  return { ...value, digest: preview.digest(value) };
}

export function assertRehearsalAuditManifest(row, baseline, intent, result) {
  rehearsalAuditVersion(row);
  const { digest, ...value } = row.data();
  assertRehearsalAuditVersion(baseline, value.baselineVersion);
  assertRehearsalAuditVersion(intent, value.intentVersion);
  assertRehearsalAuditVersion(result, value.resultVersion);
  if (digest !== preview.digest(value) || !same(row.data(), rehearsalAuditManifest(baseline, intent, result))) fail();
}

function pathsFor({ pair, recoveryPair, resourceOperationId, healthOperationId, rolloutOperationId, selectionOperationId, adminOperationId, candidateReceiptId, readerPaths, readerDigests, actionOperations = [] }) {
  preview.parsePair(pair); preview.parsePair(recoveryPair);
  if (pair.pairId === recoveryPair.pairId ||
      ![resourceOperationId, healthOperationId, rolloutOperationId, selectionOperationId, adminOperationId].every(originalId) ||
      typeof candidateReceiptId !== 'string' || !/^renderer-[0-9]{1,20}-[0-9]{1,4}$/.test(candidateReceiptId)) fail();
  const workerKey = publicPairs.publicReleaseDigest({ worker: pair.applicationName });
  const resourceBase = `system/publicReleasePrivateInstalls/attempts/${resourceOperationId}`;
  const stable = ['system/publicDeployment', 'system/cmsPublicationRuntime', 'cmsDeploymentReceipts/adminManifest',
    ...['functions', 'cmsApi'].map(component => `${preview.READER_RECEIPTS}/${component}`),
    ...[pair, recoveryPair].map(value => `${preview.PAIRS}/${value.pairId}`),
    `cmsPreviewPrivateInstalls/${resourceOperationId}`, `system/publicReleasePrivateInstalls/workers/${workerKey}`,
    `system/publicReleasePrivateInstalls/plans/${resourceOperationId}`,
    ...['identity', 'version', 'deployment', 'container', 'schedule'].flatMap(action => [
      `${resourceBase}/steps/${workerKey}-${action}`, `${resourceBase}/readbacks/${workerKey}-${action}`])];
  if (!Array.isArray(readerPaths) || readerPaths.length < 1 || readerPaths.length > 100 ||
      readerPaths.some(path => typeof path !== 'string' || !path || path.length > 512) ||
      !Array.isArray(readerDigests) || readerDigests.length !== 2 || readerDigests.some(value => !publicPairs.digest(value))) fail();
  stable.push(...readerPaths.filter(path => path !== preview.SELECTOR_PATH));
  const required = [...new Set([...stable, ...readerPaths])];
  stable.push('system/billing', ...readerDigests.map(value => `cmsReaderSessionWindows/${value}`),
    ...[pair, recoveryPair].flatMap(value => [`cmsPreviewPairReaderWindows/${value.pairId}`,
      ...readerDigests.map(digest => `cmsPreviewPairReaderWindows/${value.pairId}/readers/${digest}`)]));
  if (actionOperations.length > 6 || actionOperations.some(ids => !originalId(ids.selection) || !originalId(ids.admin))) fail();
  const operations = [preview.SELECTOR_PATH, preview.RENDERER_RECEIPT_PATH,
    `cmsPreviewPrivateHealth/${healthOperationId}`, `cmsDeploymentCandidates/${candidateReceiptId}`,
    `privatePairPreflightAttempts/${healthOperationId}`, `cmsPreviewPairCandidatePointers/${pair.pairId}`,
    `cmsPreviewPairCandidatePointerReceipts/${healthOperationId}`,
    `cmsPreviewPairRollouts/${rolloutOperationId}`, `${preview.SWITCHES}/${selectionOperationId}`,
    `cmsAdminManifestAttempts/${adminOperationId}`, 'cmsAdminManifestState/writer', `${ADMIN_PROVIDER_OPERATIONS}/${adminOperationId}`,
    ...actionOperations.flatMap(ids => [`${preview.SWITCHES}/${ids.selection}`, `cmsAdminManifestAttempts/${ids.admin}`, `${ADMIN_PROVIDER_OPERATIONS}/${ids.admin}`])];
  return { stable: [...new Set(stable)], required, operations };
}

/** Read-only evidence. This module cannot reserve provider permission, create
 * a successful rehearsal result or write a readiness/selection record. All
 * snapshots retain only known owner projections, digests and exact SDK times. */
export async function captureRehearsalPreviewAudit({ firestore, transaction: suppliedTransaction, auditPaths = [], includeQueueRecords = false, ...input }) {
  const demo = typeof firestore?.projectId === 'string' && /^demo-[a-z0-9-]+$/.test(firestore.projectId) &&
    /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');
  const development = firestore?.projectId === 'njpbs-site-dev' && process.env.FIRESTORE_EMULATOR_HOST === undefined;
  if (!demo && !development) fail();
  if (!Array.isArray(auditPaths) || auditPaths.length > 19 || auditPaths.some(path =>
      typeof path !== 'string' || !/^publicReleaseRehearsalPreview\/[a-z0-9-]{1,48}(?:\/(?:intents|results|manifests)\/[a-z0-9-]{1,40})?$/.test(path))) fail();
  const { stable, required, operations } = pathsFor(input), paths = [...new Set([...stable, ...operations, ...auditPaths])];
  const read = async transaction => {
    const rows = await transaction.getAll(...paths.map(path => firestore.doc(path)));
    const byPath = Object.fromEntries(rows.map(row => [row.ref.path, row]));
    if (required.some(path => !byPath[path].exists)) fail();
    auditPaths.forEach(path => { if (byPath[path].exists) rehearsalAuditVersion(byPath[path]); });
    const rollout = byPath[`cmsPreviewPairRollouts/${input.rolloutOperationId}`].data();
    if (rollout?.proofDigest !== undefined) {
      if (!publicPairs.digest(rollout.proofDigest)) fail();
      const absent = preview.digest({ kind: 'named-absent-rehearsal-preview-proof',
        operationId: input.absentSelectionOperationId, originalProofDigest: rollout.proofDigest });
      rows.push(...await transaction.getAll(firestore.doc(`${preview.PROOFS}/${rollout.proofDigest}`),
        firestore.doc(`${preview.PROOFS}/${absent}`)));
    }
    const publicSelector = publicPairs.parseStoredPublicReleaseSelector(byPath['system/publicDeployment'].data());
    const pins = parseCmsPublicationRuntimeControl(byPath['system/cmsPublicationRuntime'].data());
    if (pins.phase !== 'ready' || pins.cloud?.phase !== 'ready' ||
        [pins, pins.cloud].some(pin => pin.commitSha !== publicSelector.activeCommitSha || pin.serializerId !== targets.publicationTarget('development').serializerId)) fail();
    const selector = preview.parseSelector(byPath[preview.SELECTOR_PATH].data());
    const selectedPair = [input.pair, input.recoveryPair].find(pair => pair.pairId === selector.selectedPairId);
    if (!selectedPair) fail();
    preview.assertProjection(selector, selectedPair);
    const renderer = byPath[preview.RENDERER_RECEIPT_PATH].data(), admin = byPath['cmsDeploymentReceipts/adminManifest'].data();
    const manifestDigest = admin?.lastComplete?.request?.manifestDigest ?? admin?.lastComplete?.manifestDigest;
    if (renderer?.schemaVersion !== 2 || renderer.state !== 'complete' || renderer.pairId !== selector.selectedPairId ||
        renderer.selectorDigest !== preview.digest(selector) || renderer.lastComplete?.sourceSha !== selectedPair.rendererSha ||
        admin?.state !== 'complete' || !publicPairs.digest(manifestDigest)) fail();
    const queues = await transaction.get(firestore.collection('cmsPreviewQueue').where('previewPairId', 'in', [input.pair.pairId, input.recoveryPair.pairId]).limit(201));
    if (queues.size > 200) fail();
    const queued = Object.fromEntries(queues.docs.map(row => [row.ref.path, projection(row)]));
    return publicPairs.freeze({ schemaVersion: 1, observedAt: rows[0].readTime.toDate().toISOString(),
      previewSelector: selector, adminManifestDigest: manifestDigest,
      adminReceiptDigest: preview.digest(admin), stablePaths: stable,
      records: { ...Object.fromEntries(rows.map(row => [row.ref.path, projection(row)])), ...(includeQueueRecords ? queued : {}) },
      queued: { count: queues.size, digest: preview.digest(queued) } });
  };
  return suppliedTransaction ? read(suppliedTransaction) : firestore.runTransaction(read, { readOnly: true });
}

/** A changed owner record or even a same-content rewrite refuses. OLD may
 * advance to NEW only at the named Admin boundary; every public/control,
 * reader, resource, queue and previous Admin projection must remain fixed. */
export function assertRehearsalPreviewAudit(before, after, { oldPair, newPair, selectedNew = false }) {
  preview.parsePair(oldPair); preview.parsePair(newPair);
  if (!same(before.stablePaths, after.stablePaths) || !same(before.queued, after.queued) ||
      before.stablePaths.some(path => !same(before.records[path], after.records[path])) ||
      before.adminManifestDigest !== after.adminManifestDigest || before.adminReceiptDigest !== after.adminReceiptDigest) fail();
  const prior = preview.parseSelector(before.previewSelector), selected = preview.parseSelector(after.previewSelector);
  const expectedPair = selectedNew ? newPair : oldPair;
  if (selected.selectedPairId !== expectedPair.pairId || selected.recoveryPairId !== (selectedNew ? oldPair : newPair).pairId ||
      prior.selectedPairId !== oldPair.pairId && !(selectedNew && prior.selectedPairId === newPair.pairId)) fail();
  const changed = prior.selectedPairId !== selected.selectedPairId;
  if (selected.epoch !== prior.epoch + (changed ? 1 : 0)) fail();
  if (!changed && [preview.SELECTOR_PATH, preview.RENDERER_RECEIPT_PATH].some(path => !same(before.records[path], after.records[path]))) fail();
  return true;
}


/** One continuity rule for action boundaries, retries and the final audit.
 * Allowed native transitions must change bytes too: a same-content rewrite
 * never counts as an owner transition. Newly named absent records are safe. */
export function assertChainedRehearsalPreviewAudit(before, after, { oldPair, newPair, allowed = [] }) {
  assertRehearsalPreviewAudit(before, after, { oldPair, newPair,
    selectedNew: after.previewSelector.selectedPairId === newPair.pairId });
  for (const path of new Set([...Object.keys(before.records), ...Object.keys(after.records)])) {
    const prior = before.records[path], next = after.records[path];
    if (same(prior ?? null, next ?? null)) continue;
    if (!prior && next?.exists === false || !next && prior?.exists === false) continue;
    if (!allowed.includes(path) || !next || prior?.digest === next.digest) fail();
  }
  return true;
}
