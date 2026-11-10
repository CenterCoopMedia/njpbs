import { initialPairNative } from './initial-pair-native.mjs';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import admission from '../../functions/lib/public-release-bootstrap-adoption.js';
import code from '../../functions/lib/public-release-pair-code-reference.js';
import input from '../../functions/lib/public-release-pair-input.js';
import retention from '../../functions/lib/public-release-bootstrap-pairs.js';
import controlled from '../../functions/lib/public-release-bootstrap-control-source.js';
import { prepareInitialPairRetentionGuard } from './initial-pair-retention-guard.mjs';
import { operatorRefused as refuse } from './public-release-operator-io.mjs';
const owner = filename => initialPairNative(filename, import.meta.url);
const source = owner('../../site/scripts/public-release-pair-source-owner.ts');
const { publicReleasePairSourceInputPath } = owner('../../site/scripts/public-release-pair-input-storage.ts');
const { createPublicReleasePairExecutor } = owner('../../site/scripts/public-release-pair-executor.ts');
const { initializePublicReleasePairReplayBaseline } = owner('../../site/scripts/public-release-pair-log-replay.ts');
const { reconcilePublicReleasePairReplay } = owner('../../site/scripts/public-release-pair-replay-runner.ts');
const { sealPublicReleasePairCodePublication } = owner('../../site/scripts/public-release-switch-code.ts');
const { qualifyPublicReleasePair } = owner('../../site/scripts/public-release-pair-qualification.ts');
const { readQualificationReceiptInTransaction } = owner('../../site/scripts/public-release-pair-qualification-receipt.ts');
const replay = owner('../../functions/lib/public-release-pair-replay.js');
import { parseInitialPairsPacket } from './initial-pairs-packet.mjs';
import targets from '../../functions/lib/publication-target.js';
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);


/** Current closed first-install authority, checked before and after effects.
 * No seed, flag change, selector conversion or deadline extension lives here. */
export async function readInitialPairsAuthority({ firestore, packet, signal, environment }) {
  packet = parseInitialPairsPacket(packet, environment);
  if (firestore.projectId !== targets.publicationTarget(environment).projectId) refuse();
  signal?.throwIfAborted();
  return firestore.runTransaction(async transaction => {
    const rows = await transaction.getAll(...['system/publicDeployment', 'system/publicReleaseChangeLog',
      'system/publicReleaseAdmissions/controls/adoption'].map(name => firestore.doc(name)));
    const before = rows[0].data(), producer = rows[1].data(), adoption = rows[2].data();
    if (before?.schemaVersion === 2 || before?.state !== 'idle' || before.activeCommitSha !== packet.currentPair.commitSha ||
        producer && producer.enabled !== false || adoption && adoption.enabled !== false) refuse();
    await admission.assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment, before,
      operationId: packet.bootstrapOperationId });
    const original = await enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction,
      requestDigest: packet.enrollmentRequestDigest });
    // Closed initial setup has no accepted logged changes. Do not quietly
    // qualify a different cutoff or replace a missing head with local hints.
    if (!same(original.head, original.receipt.initialHead) || original.receipt.request.operationId !== packet.bootstrapOperationId ||
        original.receipt.request.expected.liveReleaseSha !== packet.currentPair.commitSha) refuse();
    for (const pair of [packet.currentPair, packet.recoveryPair]) {
      const stored = (await transaction.get(firestore.doc(work.publicReleasePairPath(pair.pairId)))).data();
      if (!same(protocol.parsePublicReleasePair(stored), pair)) refuse();
    }
    signal?.throwIfAborted();
    return { ...original, before };
  }, { readOnly: true });
}

/** Enqueue through the native owner; only its completed original claim can
 * stage G. Installed pair runtimes own rendering, retries and cancellation. */
export async function stageInitialCapture({ firestore, store, pair, captured, signal }) {
  signal?.throwIfAborted();
  const { taskId, task } = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({
    firestore, transaction, pair, input: { ...captured.receipt.scope, inputManifestDigest: captured.receipt.inputManifestDigest } }));
  if (task.status === 'failed' && task.nextAttemptAt === null) refuse();
  if (task.status !== 'complete') return { status: 'waiting', pairId: pair.pairId, taskId, taskStatus: task.status };
  const receipt = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/receipts/${taskId}`).get()).data();
  if (!receipt || protocol.publicReleaseDigest(receipt.identity) !== taskId) refuse();
  await createPublicReleasePairExecutor({ firestore, store, pair }).stage({ identity: receipt.identity,
    claimDigest: receipt.claimDigest, manifestDigest: receipt.manifestDigest, signal });
  const staged = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/views/${receipt.manifestDigest}`).get()).data();
  return { status: 'staged', taskId, reference: replay.parseReplayViewReference({ identity: staged.identity,
    claimDigest: staged.claimDigest, manifestDigest: staged.manifestDigest, manifestBytes: staged.manifestBytes }, pair) };
}

export async function runInitialPairs({ firestore, packet: raw, store, providerStore, credentials, credentialsForPair, signal, mode = 'plan', environment }) {
  const packet = parseInitialPairsPacket(raw, environment), pairs = [packet.currentPair, packet.recoveryPair];
  if (!['plan', 'apply', 'readback'].includes(mode)) refuse();
  if (mode === 'plan') return { step: packet.step, mode, projectId: targets.publicationTarget(environment).projectId, authorityReads: 0, authorityWrites: 0 };
  const current = () => readInitialPairsAuthority({ firestore, packet, signal, environment });
  const authority = await current();
  const retentionAttempt = views => ({ schemaVersion: 2, operationId: packet.bootstrapOperationId, environment,
    expectedSourceDigest: protocol.publicReleaseDigest(authority.before), enrollmentRequestDigest: packet.enrollmentRequestDigest,
    currentPair: packet.currentPair, recoveryPair: packet.recoveryPair, views });
  if (mode === 'readback') {
    if (packet.step === 'old-code') {
      const row = await firestore.doc(code.pairCodePublicationPath(packet.currentPair)).get();
      if (!row.exists) return { status: 'incomplete', receipt: null };
      const receipt = code.parsePairCodePublication(row.data(), packet.currentPair);
      await firestore.runTransaction(transaction => code.assertPairCodeReferenceInTransaction({ firestore, transaction, reference: receipt.reference }), { readOnly: true });
      if (receipt.historicalCode.reference.publication.generation !== authority.before.activeGeneration) refuse();
      await current();
      return { status: 'old-code-sealed', receipt };
    }
    const tasks = [], controls = (await firestore.doc(`system/publicReleaseAdmissions/bootstrapControls/${packet.bootstrapOperationId}`).get()).data();
    const contentOperationId = packet.step === 'qualify' && controls ? `baseline-controls-${protocol.publicReleaseDigest(controls)}`
      : `baseline-${authority.receipt.baseline.logBaselineDigest}`;
    for (const pair of pairs) for (const sourceOperationId of [`baseline-codepack-${authority.receipt.baseline.logBaselineDigest}`, contentOperationId]) {
      const binding = (await firestore.doc(publicReleasePairSourceInputPath(pair, { kind: 'qualification', sourceOperationId })).get()).data();
      if (!binding) { tasks.push({ pairId: pair.pairId, sourceOperationId, status: 'not-captured' }); continue; }
      const scope = input.parsePublicReleasePairInputScope(binding.scope);
      if (binding.pairDigest !== protocol.publicReleaseDigest(pair) || scope.sourceOperationId !== sourceOperationId ||
          scope.kind !== 'qualification' || !protocol.digest(binding.inputManifestDigest)) refuse();
      const identity = { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...scope, inputManifestDigest: binding.inputManifestDigest };
      const taskId = protocol.publicReleaseDigest(identity), task = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/work/${taskId}`).get()).data();
      if (task && (!same(task.identity, identity) || !['pending', 'running', 'failed', 'complete'].includes(task.status))) refuse();
      tasks.push({ pairId: pair.pairId, sourceOperationId, taskId, status: task?.status ?? 'not-queued' });
    }
    const qualifications = packet.step === 'qualify' ? await firestore.runTransaction(transaction => Promise.all(pairs.map((pair, index) =>
      readQualificationReceiptInTransaction({ firestore, transaction, pair, qualificationId: packet.qualificationIds[index] }))), { readOnly: true }) : [];
    // This is original-outcome readback, not a new current qualification.
    await current();
    let retained = null;
    if (packet.step === 'stage') {
      const row = await firestore.doc(`system/publicReleaseAdmissions/bootstrapPairRetentions/${packet.bootstrapOperationId}`).get();
      if (row.exists) {
        const attempt = retention.parseInitialPairRetentionAttempt(row.data().attempt);
        if (!same(attempt, retentionAttempt(attempt.views))) refuse();
        retained = await retention.readInitialPairRetentionReceipt({ firestore, attempt });
      }
    }
    return { status: retained ? 'retained' : qualifications.length === 2 && qualifications.every(Boolean) ? 'receipts-present' : 'incomplete', tasks, qualifications, retention: retained };
  }
  if (packet.step === 'stage') {
    const prior = await runInitialPairs({ firestore, packet, signal, mode: 'readback', environment });
    if (prior.retention) return prior;
  }
  if (packet.step === 'qualify') for (const pair of pairs) await firestore.runTransaction(transaction =>
    controlled.assertInitialControlCaptureInTransaction({ firestore, transaction, pair }), { readOnly: true });
  const results = [];
  for (const [index, pair] of pairs.entries()) {
    if (packet.step === 'old-code' && index !== 0) break;
    await current();
    const { publicContextPath, ...codePackArtifacts } = packet.artifacts[index];
    const options = { firestore, store, providerStore, contentStore: store, pair, signal,
      logBaselineDigest: authority.receipt.baseline.logBaselineDigest, codePackArtifacts };
    const codeInput = await source.capturePublicReleasePairCodePackBaselineInput(options);
    await sealPublicReleasePairCodePublication({ firestore, store, pair, publicContextPath, signal });
    if (packet.step === 'old-code') {
      await current();
      return runInitialPairs({ firestore, packet, signal, mode: 'readback', environment });
    }
    const codeView = await stageInitialCapture({ ...options, captured: codeInput });
    if (codeView.status === 'waiting') { results.push({ pairId: pair.pairId, status: 'waiting', tasks: [codeView] }); continue; }
    const contentInput = await source.captureHistoricalPublicReleasePairBaselineInput({ ...options, firstInstallControls: packet.step === 'qualify' });
    const contentView = await stageInitialCapture({ ...options, captured: contentInput });
    if ([codeView, contentView].some(result => result.status === 'waiting')) {
      results.push({ pairId: pair.pairId, status: 'waiting', tasks: [codeView, contentView] });
      continue;
    }
    const views = { codePackView: codeView.reference, contentView: contentView.reference };
    if (packet.step === 'stage') { results.push({ pairId: pair.pairId, status: 'staged', views }); continue; }
    await initializePublicReleasePairReplayBaseline({ ...options, views: [contentView.reference], codePackView: codeView.reference });
    const replayed = await reconcilePublicReleasePairReplay({ ...options, contentStore: store });
    if (replayed.status !== 'complete') refuse();
    results.push({ pairId: pair.pairId, status: 'replayed', witnessDigest: replayed.witnessDigest });
  }
  await current();
  if (results.some(result => result.status === 'waiting')) return { status: 'waiting', pairs: results };
  if (packet.step === 'stage') {
    const attempt = retentionAttempt(results.map(result => result.views));
    const guardSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    const retentionGuard = await prepareInitialPairRetentionGuard({ firestore, attempt, store, signal: guardSignal });
    const retained = await retention.retainInitialPublicReleasePairs({ firestore, attempt, retentionGuard, dryRun: false });
    return { status: 'retained', retention: retained.receipt };
  }
  const qualifications = [];
  for (const [index, pair] of pairs.entries()) {
    await current();
    qualifications.push(await qualifyPublicReleasePair({ firestore, store, pair, qualificationId: packet.qualificationIds[index],
      witnessDigest: results[index].witnessDigest,
      credentials: credentialsForPair ? credentialsForPair(pair, index) : credentials, signal }));
  }
  await current();
  const references = qualifications.map((result, index) => ({ qualificationId: packet.qualificationIds[index], receiptDigest: result.digest }));
  return { status: 'qualified', qualifications, references };
}
