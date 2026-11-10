import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { qualifyPrivatePreviewPair, inspectPrivatePreviewPair } from './install-private-preview-pair.mjs';
import { createPrivatePreviewPairProvider, previewProviderDigest } from './private-preview-pair-provider.mjs';
import { rehearsalPreviewReaderAdapter, rehearsalPreviewReaderReadset, assertRehearsalPreviewReadersCurrent, withRehearsalPreviewReaderFault } from './rehearsal-preview-readers.mjs';
import { deployPreviewPairRuntime } from '../../site/scripts/deploy-cms-preview-pair.ts';
import { createRehearsalPreviewFault, armRehearsalPreviewFault, readRehearsalPreviewFault } from './rehearsal-preview-fault.mjs';
import { createPairedAdminPagesHttp, createPairedAdminPagesProvider } from './paired-admin-pages-provider.mjs';
import { publishPairedAdminManifest } from './cms-preview-pair-release.mjs';
import { captureRehearsalPreviewAudit, assertChainedRehearsalPreviewAudit, rehearsalAuditVersion, assertRehearsalAuditVersion, rehearsalAuditManifest, assertRehearsalAuditManifest } from './rehearsal-preview-audit.mjs';
import { ADMIN_PROVIDER_OPERATIONS } from './paired-admin-provider-operation.mjs';
import { PREVIEW_BOUNDARIES } from './public-release-rehearsal.mjs';

const api = createRequire(import.meta.url)('../../functions/lib/cms-preview-pair.js');
const sessions = createRequire(import.meta.url)('../../functions/lib/cms-reader-session.js');
const preparedRuntimes = new WeakMap();
const same = (a, b) => api.digest(a) === api.digest(b);
const refuse = () => { throw new Error('Rehearsal private preview binding refused'); };

/** Explicit development-only composition. The resource installer has already
 * retained the original provider permissions and assignments. Qualification
 * can read those resources and use its separately named health authority; it
 * cannot resend a resource upload or replace the installed resource identity. */
export async function prepareRehearsalPreviewRuntime({ firestore, readers, prepared, resourceOperationId, request,
  readToken, readSecret, fetchImpl = fetch, signal, authorized = false }) {
  if (authorized !== true || prepared?.environment !== 'development' ||
      !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(resourceOperationId) ||
      !request || [readToken, readSecret, fetchImpl].some(value => typeof value !== 'function')) refuse();
  const readerAdapter = rehearsalPreviewReaderAdapter(readers), state = await readerAdapter.readLiveState();
  await firestore.runTransaction(transaction => assertRehearsalPreviewReadersCurrent(readers, firestore, transaction), { readOnly: true });
  const pair = state.previewPairs[1];
  const { workerVersion: assignedVersion, ...descriptor } = pair;
  if (!same(descriptor, prepared.pair)) refuse();
  const resource = (await firestore.doc(`cmsPreviewPrivateInstalls/${resourceOperationId}`).get()).data();
  if (resource?.schemaVersion !== 1 || resource.plan?.operationId !== resourceOperationId ||
      resource.planDigest !== previewProviderDigest(resource.plan) || !same(resource.pair, pair)) refuse();
  const provider = createPrivatePreviewPairProvider({ prepared, operationDigest: resource.planDigest,
    readToken, readSecret, fetchImpl, signal });
  const context = { firestore, readers, readerAdapter, prepared, resourceOperationId,
    request: structuredClone(request), readToken, readSecret, fetchImpl, signal, pair, provider, assignedVersion,
    installedTargetDigest: resource.installedTargetDigest, resourcePlanDigest: resource.planDigest,
    qualificationRequestDigest: previewProviderDigest({ resourceOperationId, request }) };
  const handle = Object.freeze({ digest: api.digest({ readerEvidenceDigest: readers.digest, resourceOperationId,
    resourceDigest: api.digest(resource), request, pairDigest: api.digest(pair) }) });
  preparedRuntimes.set(handle, context);
  return handle;
}

function contextFor(handle) {
  const context = preparedRuntimes.get(handle);
  if (!context) refuse();
  return context;
}

async function rendererReadback(context) {
  // A reserved rollout can skip deployPrivate on retry. It must not thereby
  // skip the original private health owner after an earlier failed readback.
  const health = (await context.firestore.doc(`cmsPreviewPrivateHealth/${context.request.operationId}`).get()).data();
  const expectedRequestDigest = previewProviderDigest({ resourceOperationId: context.resourceOperationId, request: context.request });
  const completedAt = Date.parse(health?.completedAt), now = Date.now();
  if (health?.schemaVersion !== 1 || health.resourceOperationId !== context.resourceOperationId ||
      health.requestDigest !== expectedRequestDigest || !same(health.request, context.request) ||
      !same(health.pair, context.pair) || health.installedTargetDigest !== context.installedTargetDigest ||
      health.health?.ready !== true || health.health.workerVersion !== context.assignedVersion ||
      !Number.isFinite(completedAt) || now < completedAt || now - completedAt > 300_000) refuse();
  const observed = await inspectPrivatePreviewPair({ provider: context.provider, prepared: context.prepared,
    versionId: context.assignedVersion });
  if (!same(observed.pair, context.pair) || observed.installedTargetDigest !== context.installedTargetDigest) refuse();
  const { pair, evidence } = observed;
  // This is the exact native installer's candidate identity projection.
  return { pairId: pair.pairId, rendererSha: pair.rendererSha, serializerId: pair.serializerId,
    workerName: pair.workerName, applicationName: pair.applicationName, workerVersion: pair.workerVersion,
    imageDigest: pair.imageDigest, applicationId: evidence.container.applicationId,
    workerDeploymentId: evidence.deployment.deploymentId, workerId: evidence.worker.workerId,
    namespaceId: evidence.namespace.namespaceId, bundleDigest: context.prepared.bundleDigest,
    configurationDigest: context.prepared.configurationDigest };
}

/** Uses the original resource assignments and actual rollout/candidate owners.
 * The separately named request is a health/qualification attempt, never a new
 * resource installation. The owner retains any ambiguous original outcome. */
export async function qualifyRehearsalPreviewRuntime(handle, { operationId, expectedSelectorDigest }) {
  const context = contextFor(handle);
  context.signal?.throwIfAborted();
  const state = await context.readerAdapter.readLiveState();
  if (!same(state.previewPairs[1], context.pair) || context.request.expectedRuntimeDigest !== expectedSelectorDigest) refuse();
  const qualification = await deployPreviewPairRuntime({ firestore: context.firestore, pair: context.pair, operationId, expectedSelectorDigest,
    candidate: context.request.candidate, signal: context.signal, qualificationRequestDigest: context.qualificationRequestDigest, adapter: { ...context.readerAdapter,
      deployPrivate: () => qualifyPrivatePreviewPair({ ...context, request: context.request }),
      readback: () => rendererReadback(context) } });
  context.qualification = Object.freeze({ ...qualification });
  return qualification;
}

/** Fresh external reads precede the actual owning selector CAS. The opaque
 * installed-bridge guard joins that transaction, so later SDK drift aborts
 * selection without changing its original receipt or the selected renderer. */
export async function selectRehearsalPreviewRuntime(handle, selection, signal) {
  const context = contextFor(handle);
  context.signal?.throwIfAborted(); signal?.throwIfAborted();
  if (!/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(selection?.operationId ?? '') ||
      selection?.newPairId !== context.pair.pairId || !/^[a-f0-9]{64}$/.test(selection.expectedSelectorDigest ?? '') ||
      !/^[a-f0-9]{64}$/.test(selection.proofDigest ?? '')) refuse();
  const request = { operationId: selection.operationId, expectedSelectorDigest: selection.expectedSelectorDigest,
    newPairId: selection.newPairId, proofDigest: selection.proofDigest };
  const prior = (await context.firestore.doc(`${api.SWITCHES}/${request.operationId}`).get()).data();
  if (prior !== undefined) {
    if (prior.schemaVersion !== 2 || !same(prior.request, request) ||
        !Number.isFinite(Date.parse(prior.selectedAt)) || new Date(prior.selectedAt).toISOString() !== prior.selectedAt) refuse();
    api.assertProjection(api.parseSelector(prior.selector), context.pair);
    return prior;
  }
  if (!context.qualification || selection?.newPairId !== context.pair.pairId ||
      selection.expectedSelectorDigest !== context.request.expectedRuntimeDigest ||
      selection.proofDigest !== context.qualification.proofDigest) refuse();
  await context.readerAdapter.readLiveState();
  await rendererReadback(context);
  return api.selectPair(context.firestore, { ...selection,
    signal: AbortSignal.any([...(context.signal ? [context.signal] : []), ...(signal ? [signal] : [])]) }, undefined,
  { assertCurrentInTransaction: ({ firestore, transaction }) => assertRehearsalPreviewReadersCurrent(context.readers, firestore, transaction) });
}

const auditNamespace = 'publicReleaseRehearsalPreview';
const nativeId = (runId, kind) => `preview-rnp-${api.digest({ runId, kind }).slice(0, 20)}`;
const actionIdFor = (runId, boundary) => `${runId}-preview-${boundary}`;
const snapshotInput = (context, ids) => ({ firestore: context.firestore, pair: context.pair, recoveryPair: ids.oldPair,
  resourceOperationId: context.resourceOperationId, healthOperationId: context.request.operationId,
  candidateReceiptId: `renderer-${context.request.candidate.runId}-${context.request.candidate.runAttempt}`,
  rolloutOperationId: ids.rollout, selectionOperationId: ids.selection, adminOperationId: ids.admin,
  readerPaths: ids.readerPaths, readerDigests: ids.readerDigests, actionOperations: ids.actionOperations,
  absentSelectionOperationId: ids.absentSelectionOperationId });
const resultRef = (firestore, runId, boundary) => firestore.doc(`${auditNamespace}/${runId}/results/${boundary}`);

function actionFault(context, boundary, fetchImpl = context.fetchImpl) {
  return createRehearsalPreviewFault({ boundary, projectId: context.firestore.projectId,
    emulatorHost: context.firestore.projectId.startsWith('demo-') ? process.env.FIRESTORE_EMULATOR_HOST : null,
    prepared: context.prepared, fetchImpl, signal: context.signal, authorized: true });
}

function faultedRuntime(handle, fault, readers = null) {
  const original = contextFor(handle);
  const next = Object.freeze({ digest: handle.digest });
  const context = { ...original, signal: AbortSignal.any([fault.signal, ...(original.signal ? [original.signal] : [])]) };
  if (readers) { context.readers = readers; context.readerAdapter = rehearsalPreviewReaderAdapter(readers); }
  else {
    context.fetchImpl = fault.fetch;
    context.provider = createPrivatePreviewPairProvider({ prepared: context.prepared, operationDigest: context.resourcePlanDigest,
      readToken: context.readToken, readSecret: context.readSecret, fetchImpl: fault.fetch, signal: context.signal });
  }
  preparedRuntimes.set(next, context);
  return next;
}

async function expectOwnerRefusal(action) {
  try { await action(); }
  catch (error) { return error; }
  refuse();
}

async function failedQualification(handle, boundary, ids, before, chained) {
  const context = contextFor(handle), fault = actionFault(context, boundary);
  chained(before, await captureRehearsalPreviewAudit(snapshotInput(context, ids)), []);
  const readers = boundary === 'functions' ? withRehearsalPreviewReaderFault(context.readers, fault) : null;
  if (!readers) armRehearsalPreviewFault(fault);
  const interrupted = faultedRuntime(handle, fault, readers);
  await expectOwnerRefusal(() => qualifyRehearsalPreviewRuntime(interrupted, {
    operationId: ids.rollout, expectedSelectorDigest: context.request.expectedRuntimeDigest }));
  const witness = readRehearsalPreviewFault(fault);
  if (witness.boundary !== boundary || witness.dispatched !== false) refuse();
  const failed = await captureRehearsalPreviewAudit(snapshotInput(context, ids));
  const transitions = [{ stage: 'qualification', snapshot: failed }];
  if (boundary === 'functions') {
    if ((await context.firestore.doc(`cmsPreviewPairRollouts/${ids.rollout}`).get()).exists) refuse();
  } else {
    const row = (await context.firestore.doc(`cmsPreviewPairRollouts/${ids.rollout}`).get()).data();
    if (row?.state !== 'reserved') refuse();
    // Resume the original health owner after the named readback interruption,
    // before retrying its reserved rollout. No resource install is called.
    chained(failed, await captureRehearsalPreviewAudit(snapshotInput(context, ids)), []);
    await qualifyPrivatePreviewPair(context);
    await qualifyRehearsalPreviewRuntime(handle, { operationId: ids.rollout,
      expectedSelectorDigest: context.request.expectedRuntimeDigest });
  }
  if (boundary !== 'functions') transitions.push({ stage: 'qualification', snapshot: await captureRehearsalPreviewAudit(snapshotInput(context, ids)) });
  return { witness, failed, transitions };
}

async function qualifiedSelection(handle, ids) {
  const context = contextFor(handle);
  return qualifyRehearsalPreviewRuntime(handle, { operationId: ids.rollout,
    expectedSelectorDigest: context.request.expectedRuntimeDigest });
}

async function preflightSelection(handle, ids) {
  const context = contextFor(handle);
  const rollout = (await context.firestore.doc(`cmsPreviewPairRollouts/${ids.rollout}`).get()).data();
  const identity = { pairDigest: api.digest(context.pair), expectedSelectorDigest: context.request.expectedRuntimeDigest,
    candidate: context.request.candidate, qualificationRequestDigest: context.qualificationRequestDigest };
  if (rollout?.schemaVersion !== 2 || rollout.state !== 'verified' || !same(rollout.identity, identity) ||
      !/^[a-f0-9]{64}$/.test(rollout.proofDigest ?? '')) refuse();
  // The preceding rollout completed this exact immutable owner. Its native
  // verified return is read-only; no new qualification permission is created.
  const selection = await qualifiedSelection(handle, ids);
  await rendererReadback(context);
  return selection;
}

async function failedSelection(handle, boundary, ids, original) {
  const context = contextFor(handle);
  const operationId = ids.selection;
  let selection = { ...original, operationId };
  const absentProof = api.digest({ kind: 'named-absent-rehearsal-preview-proof', operationId, originalProofDigest: original.proofDigest });
  let signal;
  if (boundary === 'preview-selection') {
    if ((await context.firestore.doc(`${api.PROOFS}/${absentProof}`).get()).exists) refuse();
    selection = { ...selection, proofDigest: absentProof };
  } else signal = AbortSignal.abort();
  const error = await expectOwnerRefusal(() => api.selectPair(context.firestore, { ...selection, signal }, undefined,
    { assertCurrentInTransaction: ({ firestore, transaction }) => assertRehearsalPreviewReadersCurrent(context.readers, firestore, transaction) }));
  if (boundary === 'preview-selection' ? error?.message !== 'CMS preview pair contract is invalid' : error !== signal.reason) refuse();
  if ((await context.firestore.doc(`${api.SWITCHES}/${operationId}`).get()).exists) refuse();
  return { witness: boundary === 'preview-selection'
    ? { schemaVersion: 1, boundary, absentProofDigest: absentProof, selectionOperationId: operationId }
    : { schemaVersion: 1, boundary, aborted: signal.aborted, selectionOperationId: operationId } };
}

async function readAdminBaseline(provider, admin) {
  const baseline = await provider.readActiveManifest();
  if (baseline.manifestDigest !== admin.baseline.artifact.manifestDigest) refuse();
  return baseline;
}

async function failedAdmin(handle, boundary, ids, admin, baseline, qualification, before, chained) {
  const context = contextFor(handle), current = (await context.firestore.doc(api.SELECTOR_PATH).get()).data();
  const normal = createPairedAdminPagesProvider({ ...admin, firestore: context.firestore, signal: context.signal });
  const transitions = [];
  chained(before, await captureRehearsalPreviewAudit(snapshotInput(context, ids)), []);
  if (boundary === 'admin-assets') {
    if (current?.selectedPairId !== ids.oldPair.pairId) refuse();
    await api.selectPair(context.firestore, { ...qualification, operationId: ids.selection, signal: context.signal }, undefined,
      { assertCurrentInTransaction: async ({ firestore, transaction }) => {
        await assertRehearsalPreviewReadersCurrent(context.readers, firestore, transaction);
        chained(before, await captureRehearsalPreviewAudit({ ...snapshotInput(context, ids), transaction }), []);
      } });
    transitions.push({ stage: 'selection', snapshot: await captureRehearsalPreviewAudit(snapshotInput(context, ids)) });
  } else if (current?.selectedPairId !== context.pair.pairId) refuse();
  const request = { operationId: ids.admin, manifestDigest: admin.prepared.manifestDigest,
    expectedProviderReceiptDigest: baseline.providerReceiptDigest };
  const fault = actionFault(context, boundary, admin.fetchImpl ?? fetch);
  const interrupted = createPairedAdminPagesProvider({ ...admin, firestore: context.firestore, fetchImpl: fault.fetch, signal: fault.signal });
  chained(transitions.at(-1)?.snapshot ?? before, await captureRehearsalPreviewAudit(snapshotInput(context, ids)), []);
  armRehearsalPreviewFault(fault);
  await expectOwnerRefusal(() => publishPairedAdminManifest(context.firestore, request, interrupted, fault.signal));
  const witness = readRehearsalPreviewFault(fault);
  if (witness.boundary !== boundary || witness.dispatched !== false ||
      boundary === 'cancellation' && !fault.signal.aborted) refuse();
  const failed = await captureRehearsalPreviewAudit(snapshotInput(context, ids));
  transitions.push({ stage: 'admin', snapshot: failed });
  // This new invocation uses the same original owner/provider journal, with
  // the un-aborted parent signal. Reconciliation grants no upload permission.
  await expectOwnerRefusal(() => publishPairedAdminManifest(context.firestore, request, normal, context.signal));
  const [attempt, writer, journal] = await context.firestore.getAll(
    context.firestore.doc(`cmsAdminManifestAttempts/${ids.admin}`), context.firestore.doc('cmsAdminManifestState/writer'),
    context.firestore.doc(`${ADMIN_PROVIDER_OPERATIONS}/${ids.admin}`));
  if (attempt.data()?.state !== 'not_written' || !same(attempt.data()?.request, request) ||
      writer.data()?.state !== 'not_written' || writer.data()?.operationId !== ids.admin ||
      journal.data()?.state !== 'fenced' || journal.data()?.deploymentId !== null ||
      journal.data()?.binding?.request?.operationId !== ids.admin) refuse();
  const observed = await normal.readActiveManifest();
  if (!same(observed, baseline)) refuse();
  transitions.push({ stage: 'admin', snapshot: await captureRehearsalPreviewAudit(snapshotInput(context, ids)) });
  return { witness, failed, transitions };
}

const RESULT_BYTES_LIMIT = 192 * 1024;
function assertResultCapacity(before, intent, oldPair, newPair) {
  const longest = (left, right) => left.length >= right.length ? left : right;
  const pairId = longest(oldPair.pairId, newPair.pairId), hash = 'f'.repeat(64);
  const projected = { ...before, queued: { count: 200, digest: hash },
    previewSelector: { ...before.previewSelector, epoch: Number.MAX_SAFE_INTEGER,
      selectedPairId: pairId, recoveryPairId: pairId, rendererSha: longest(oldPair.rendererSha, newPair.rendererSha),
      serializerId: longest(oldPair.serializerId, newPair.serializerId) },
    records: Object.fromEntries([...Object.keys(before.records), `${api.PROOFS}/${hash}`].map(path =>
      [path, { exists: true, digest: hash, updateTime: '9'.repeat(64) }])) };
  // Six snapshots is the largest native result. Budget every absent operation
  // as present, the future proof and the longest OLD/NEW selector projection.
  const version = { seconds: Number.MAX_SAFE_INTEGER, nanoseconds: 999_999_999 };
  const envelope = { schemaVersion: 1, state: 'complete', baselineVersion: version, intentVersion: version,
    intent, before: projected, failed: projected, after: projected,
    witness: { schemaVersion: 1, boundary: 'pre-selection-cancellation', method: 'POST', requestDigest: hash,
      selectionOperationId: intent.selectionOperationId, absentProofDigest: hash, dispatched: false, aborted: true },
    transitions: Array.from({ length: 3 }, () => ({ stage: 'qualification', snapshot: projected })) };
  if (Buffer.byteLength(JSON.stringify(envelope)) > RESULT_BYTES_LIMIT) refuse();
}

function assertFaultWitness(result, boundary, ids, context, originalProofDigest) {
  let expected;
  if (boundary === 'preview-selection') expected = { schemaVersion: 1, boundary,
    absentProofDigest: api.digest({ kind: 'named-absent-rehearsal-preview-proof', operationId: ids.selection, originalProofDigest }),
    selectionOperationId: ids.selection };
  else if (boundary === 'pre-selection-cancellation') expected = { schemaVersion: 1, boundary, aborted: true, selectionOperationId: ids.selection };
  else {
    const method = ['functions', 'preview-rollout'].includes(boundary) ? 'GET' : 'POST';
    const url = boundary === 'functions' ? 'https://cloudfunctions.googleapis.com/v2/projects/njpbs-site-dev/locations/us-central1/functions'
      : boundary === 'preview-rollout' ? `https://api.cloudflare.com/client/v4/accounts/${context.prepared.accountId}/workers/workers/${context.prepared.applicationName}/versions/${context.assignedVersion}`
      : 'https://api.cloudflare.com/client/v4/pages/assets/upload';
    expected = { schemaVersion: 1, boundary, method,
      requestDigest: createHash('sha256').update(`${method}\n${url}`).digest('hex'), dispatched: false };
  }
  if (!same(result.witness, expected)) refuse();
}

/** Explicit source-level composition only. The audit records are create-only
 * observations and never act as provider permission or readiness authority.
 * Completed retry returns its original result after fresh read-only checks.
 * An incomplete intent refuses: inspect its original owners before recovery;
 * it cannot repeat a fault or obtain another upload under a new identity. */
export async function createRehearsalPreviewActions(handle, { runId, admin, authorized = false }) {
  const context = contextFor(handle);
  if (authorized !== true || typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(runId) ||
      admin?.target?.environment !== 'development' || admin?.prepared?.environment !== 'development' ||
      admin.prepared.sourceSha !== context.request.candidate.sourceSha ||
      admin.prepared.manifestDigest === admin.baseline?.artifact?.manifestDigest) refuse();
  const http = createPairedAdminPagesHttp({ ...admin, signal: context.signal });
  // Validate the same closed database/baseline gate before any intent exists.
  const normal = createPairedAdminPagesProvider({ ...admin, firestore: context.firestore, signal: context.signal });
  await readAdminBaseline(normal, admin);
  const state = await context.readerAdapter.readLiveState(), oldPair = state.previewPairs[0];
  const readerPaths = rehearsalPreviewReaderReadset(context.readers);
  const readerDigests = ['functions', 'cmsApi'].map(component => sessions.readerSessionDigest(api.currentReader(state.readers[component], component)));
  const actionOperations = PREVIEW_BOUNDARIES.map(boundary => ({ selection: nativeId(runId, `selection-${boundary}`), admin: nativeId(runId, `admin-${boundary}`) }));
  const common = { rollout: nativeId(runId, 'qualification'), oldPair, readerPaths, readerDigests, actionOperations,
    absentSelectionOperationId: nativeId(runId, 'selection-preview-selection') };
  const configurationDigest = api.digest({ runtimeDigest: handle.digest, targetDigest: http.targetDigest,
    candidateArtifactDigest: admin.prepared.artifactDigest, baselineArtifactDigest: admin.baseline.artifact.artifactDigest,
    baselineDeploymentId: admin.baseline.deploymentId });
  const idsFor = boundary => ({ ...common, selection: nativeId(runId, `selection-${boundary}`), admin: nativeId(runId, `admin-${boundary}`) });
  const capture = boundary => captureRehearsalPreviewAudit(snapshotInput(context, idsFor(boundary)));
  const chained = (before, after, allowed = []) => {
    try { return assertChainedRehearsalPreviewAudit(before, after, { oldPair, newPair: context.pair, allowed }); }
    catch { refuse(); }
  };
  const observedInitial = await capture('functions');
  const baselineRef = context.firestore.doc(`${auditNamespace}/${runId}`);
  const refsFor = boundary => [context.firestore.doc(`${auditNamespace}/${runId}/intents/${boundary}`),
    resultRef(context.firestore, runId, boundary), context.firestore.doc(`${auditNamespace}/${runId}/manifests/${boundary}`)];
  const auditRefs = PREVIEW_BOUNDARIES.flatMap(refsFor);
  await context.firestore.runTransaction(async transaction => {
    const [row, ...retained] = await transaction.getAll(baselineRef, ...auditRefs);
    if (row.exists) return;
    if (retained.some(value => value.exists)) refuse();
    transaction.create(baselineRef, { schemaVersion: 1, configurationDigest,
      snapshotDigest: api.digest(observedInitial), snapshot: observedInitial });
  });
  const originalBaseline = await context.firestore.runTransaction(async transaction => {
    const [row, ...retained] = await transaction.getAll(baselineRef, ...auditRefs);
    const baseline = row.data();
    rehearsalAuditVersion(row);
    if (baseline?.schemaVersion !== 1 || baseline.configurationDigest !== configurationDigest ||
        baseline.snapshotDigest !== api.digest(baseline.snapshot)) refuse();
    for (let index = 0; index < PREVIEW_BOUNDARIES.length; index++) {
      const [intent, result, manifest] = retained.slice(index * 3, index * 3 + 3);
      if (![intent, result, manifest].some(value => value.exists)) continue;
      assertRehearsalAuditManifest(manifest, row, intent, result);
    }
    return row;
  }, { readOnly: true });
  const initial = originalBaseline.data().snapshot, baselineVersion = rehearsalAuditVersion(originalBaseline);
  const readBaseline = async transaction => {
    const row = await transaction.get(baselineRef);
    assertRehearsalAuditVersion(row, baselineVersion);
    if (!same(row.data(), originalBaseline.data())) refuse();
    return row;
  };
  const readResult = (baseline, intent, result, manifest) => {
    assertRehearsalAuditManifest(manifest, baseline, intent, result);
    return result.data();
  };
  const auditPaths = [baselineRef, ...auditRefs].map(ref => ref.path);
  const allowed = (stage, boundary, after) => {
    const ids = idsFor(boundary);
    if (stage === 'qualification' && boundary === 'functions') return [];
    if (stage === 'qualification' && boundary === 'preview-rollout') return [
      `cmsPreviewPrivateHealth/${context.request.operationId}`, `privatePairPreflightAttempts/${context.request.operationId}`,
      `cmsDeploymentCandidates/renderer-${context.request.candidate.runId}-${context.request.candidate.runAttempt}`,
      `cmsPreviewPairRollouts/${ids.rollout}`, `cmsPreviewPairCandidatePointers/${context.pair.pairId}`,
      `cmsPreviewPairCandidatePointerReceipts/${context.request.operationId}`, ...Object.keys(after.records).filter(path => path.startsWith(`${api.PROOFS}/`))];
    if (stage === 'selection' && boundary === 'admin-assets') return [api.SELECTOR_PATH, api.RENDERER_RECEIPT_PATH, `${api.SWITCHES}/${ids.selection}`];
    if (stage === 'admin' && ['admin-assets', 'cancellation'].includes(boundary)) return [
      `cmsAdminManifestAttempts/${ids.admin}`, 'cmsAdminManifestState/writer', `${ADMIN_PROVIDER_OPERATIONS}/${ids.admin}`];
    refuse();
  };
  const checkResult = async (result, intent, boundary, transaction = null) => {
    if (!intent || !same(result.intent, intent) || result.state !== 'complete' || intent.configurationDigest !== configurationDigest ||
        intent.boundary !== boundary || intent.actionId !== actionIdFor(runId, boundary) || intent.baselineDigest !== api.digest(result.before) ||
        !Array.isArray(result.transitions)) refuse();
    const stages = { functions: ['qualification'], 'preview-rollout': ['qualification', 'qualification'],
      'preview-selection': [], 'pre-selection-cancellation': [], 'admin-assets': ['selection', 'admin', 'admin'], cancellation: ['admin', 'admin'] };
    if (!same(result.transitions.map(row => row.stage), stages[boundary])) refuse();
    const failed = result.transitions.find(row => row.stage === 'admin' || row.stage === 'qualification')?.snapshot ?? result.after;
    if (!same(result.failed, failed)) refuse();
    let originalProofDigest;
    if (boundary === 'preview-selection') {
      const ref = context.firestore.doc(`cmsPreviewPairRollouts/${intent.rolloutOperationId}`);
      const row = transaction ? await transaction.get(ref) : await ref.get();
      if (row.data()?.state !== 'verified' || !/^[a-f0-9]{64}$/.test(row.data()?.proofDigest ?? '')) refuse();
      originalProofDigest = row.data().proofDigest;
    }
    assertFaultWitness(result, boundary, idsFor(boundary), context, originalProofDigest);
    let prior = result.before;
    for (const transition of result.transitions) {
      chained(prior, transition.snapshot, allowed(transition.stage, boundary, transition.snapshot));
      prior = transition.snapshot;
    }
    chained(prior, result.after);
    const expected = ['admin-assets', 'cancellation'].includes(boundary) ? context.pair : oldPair;
    if (result.after.previewSelector.selectedPairId !== expected.pairId) refuse();
  };
  return Object.freeze({
    async inspect(boundary) {
      if (!PREVIEW_BOUNDARIES.includes(boundary)) refuse();
      return captureRehearsalPreviewAudit({ ...snapshotInput(context, idsFor(boundary)), auditPaths, includeQueueRecords: true });
    },
    async execute({ boundary, actionId }) {
      if (!PREVIEW_BOUNDARIES.includes(boundary) || actionId !== actionIdFor(runId, boundary)) refuse();
      context.signal?.throwIfAborted();
      const ids = idsFor(boundary), before = await capture(boundary);
      const baseline = ['admin-assets', 'cancellation'].includes(boundary) ? await readAdminBaseline(normal, admin) : null;
      const intent = { schemaVersion: 1, runId, boundary, actionId, configurationDigest,
        originalResourceOperationId: context.resourceOperationId, originalHealthOperationId: context.request.operationId,
        rolloutOperationId: ids.rollout, selectionOperationId: ids.selection, adminOperationId: ids.admin,
        baselineVersion, baselineDigest: api.digest(before) };
      const [intentRef, outputRef, manifestRef] = refsFor(boundary);
      const index = PREVIEW_BOUNDARIES.indexOf(boundary), previousBoundary = PREVIEW_BOUNDARIES[index - 1];
      const previousRefs = index ? refsFor(previousBoundary) : [];
      const readAction = async transaction => {
        const baselineRow = await readBaseline(transaction);
        const [priorIntent, priorResult, manifest, previousIntent, previous, previousManifest] =
          await transaction.getAll(intentRef, outputRef, manifestRef, ...previousRefs);
        if (priorResult.exists) {
          const result = readResult(baselineRow, priorIntent, priorResult, manifest);
          await checkResult(result, priorIntent.data(), boundary, transaction);
          chained(result.after, await captureRehearsalPreviewAudit({ ...snapshotInput(context, ids), transaction }));
          return result;
        }
        if (priorIntent.exists || manifest.exists) refuse();
        let prior = initial;
        if (index) {
          if (!previous.exists) throw new Error('Rehearsal preview action order refused');
          const result = readResult(baselineRow, previousIntent, previous, previousManifest);
          await checkResult(result, previousIntent.data(), previousBoundary, transaction);
          prior = result.after;
        }
        const fresh = await captureRehearsalPreviewAudit({ ...snapshotInput(context, ids), transaction });
        chained(before, fresh);
        chained(prior, fresh);
        const expectedBefore = boundary === 'cancellation' ? context.pair : oldPair;
        if (before.previewSelector.selectedPairId !== expectedBefore.pairId) refuse();
        return null;
      };
      const original = await context.firestore.runTransaction(readAction, { readOnly: true });
      if (original) { chained(original.after, before); return original; }
      const qualification = ['preview-selection', 'pre-selection-cancellation', 'admin-assets'].includes(boundary)
        ? await preflightSelection(handle, ids) : null;
      const raced = await context.firestore.runTransaction(async transaction => {
        const result = await readAction(transaction);
        if (result) return result;
        assertResultCapacity(before, intent, oldPair, context.pair);
        transaction.create(intentRef, intent);
        return null;
      });
      if (raced) { chained(raced.after, before); return raced; }
      const intentRow = await intentRef.get();
      const intentVersion = rehearsalAuditVersion(intentRow);
      if (!same(intentRow.data(), intent)) refuse();
      let outcome;
      if (['functions', 'preview-rollout'].includes(boundary)) outcome = await failedQualification(handle, boundary, ids, before, chained);
      else if (['preview-selection', 'pre-selection-cancellation'].includes(boundary)) outcome = await failedSelection(handle, boundary, ids, qualification);
      else outcome = await failedAdmin(handle, boundary, ids, admin, baseline, qualification, before, chained);
      const after = await capture(boundary);
      const result = { schemaVersion: 1, state: 'complete', baselineVersion, intentVersion, intent, before,
        failed: outcome.failed ?? after, after, witness: outcome.witness, transitions: outcome.transitions ?? [] };
      await checkResult(result, intent, boundary);
      if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES_LIMIT) refuse();
      await context.firestore.runTransaction(async transaction => {
        const [retained, output] = await transaction.getAll(intentRef, outputRef);
        await readBaseline(transaction);
        assertRehearsalAuditVersion(retained, intentVersion);
        if (!same(retained.data(), intent)) refuse();
        chained(after, await captureRehearsalPreviewAudit({ ...snapshotInput(context, ids), transaction }));
        if (output.exists) { if (!same(output.data(), result)) refuse(); return; }
        transaction.create(outputRef, result);
      });
      // Seal the exact SDK result version after its create. A crash before
      // this receipt leaves an incomplete boundary; it cannot repeat effects.
      return context.firestore.runTransaction(async transaction => {
        const baselineRow = await readBaseline(transaction);
        const [retained, output, manifest] = await transaction.getAll(intentRef, outputRef, manifestRef);
        assertRehearsalAuditVersion(retained, intentVersion);
        if (!same(retained.data(), intent) || !same(output.data(), result)) refuse();
        chained(after, await captureRehearsalPreviewAudit({ ...snapshotInput(context, ids), transaction }));
        const seal = rehearsalAuditManifest(baselineRow, retained, output);
        if (manifest.exists) { readResult(baselineRow, retained, output, manifest); return output.data(); }
        transaction.create(manifestRef, seal);
        return result;
      });
    },
    async completedBoundaries() {
      return context.firestore.runTransaction(async transaction => {
        const baselineRow = await readBaseline(transaction);
        const rows = await transaction.getAll(...auditRefs);
        const completed = [];
        let prior = initial, missing = false;
        for (const [index, boundary] of PREVIEW_BOUNDARIES.entries()) {
          const [intent, row, manifest] = rows.slice(index * 3, index * 3 + 3);
          if (!row.exists) { missing = true; if (intent.exists || manifest.exists) refuse(); continue; }
          if (missing) refuse();
          const result = readResult(baselineRow, intent, row, manifest);
          await checkResult(result, intent.data(), boundary, transaction);
          chained(prior, result.before);
          prior = result.after;
          completed.push(boundary);
        }
        chained(prior, await captureRehearsalPreviewAudit({ ...snapshotInput(context, idsFor(completed.at(-1) ?? 'functions')), transaction }));
        return completed;
      }, { readOnly: true });
    },
  });
}
