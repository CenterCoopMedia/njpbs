// Process-boundary contract fixture only. This is not a release runtime.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import targets from '../../functions/lib/publication-target.js';

export const body = '<!doctype html><html>Fixture public bytes</html>';
const digest = value => createHash('sha256').update(value).digest('hex');
export async function execute(request) {
  const { packet, action, actionId } = request;
  const file = join(tmpdir(), `${packet.runId}.json`);
  let saved;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  saved ??= { selected: 'old', epoch: 1, sequence: 0, generation: 10, attempts: 1, receipts: {}, controls: [] };
  const persist = () => writeFile(file, JSON.stringify(saved));
  const side = () => saved.selected === 'old' ? packet.oldPair : packet.newPair;
  const state = () => ({ selector: {
    schemaVersion: 2, state: 'idle', mediaLifecycleReady: true, epoch: saved.epoch,
    activeGeneration: saved.generation, lastReservedGeneration: saved.generation, newestEligibleGeneration: saved.generation,
    activeDeploymentId: 'fixture-deployment', activeCommitSha: side().commitSha,
    newestEligibleBuildBatchId: 'fixture-build', selectedPair: protocol.publicReleasePairReference(side()),
    recoveryPair: protocol.publicReleasePairReference(saved.selected === 'old' ? packet.newPair : packet.oldPair),
    contentHead: { pairId: side().pairId, viewId: 'fixture-view', manifestDigest: '1'.repeat(64), contextSequence: saved.sequence },
    admittedContractDigest: '2'.repeat(64), priorSelectorDigest: '3'.repeat(64), switchOperationId: 'fixture-switch', proofDigest: '4'.repeat(64),
  }, primary: { phase: saved.mode === 'pause' ? 'paused' : 'ready', release: side().commitSha },
    cloud: { phase: 'ready', release: side().commitSha }, admission: true, previewReady: true, providerAttempts: saved.attempts,
    preview: { selector: { schemaVersion: 2, phase: 'ready', epoch: saved.previewEpoch ?? 1,
      selectedPairId: packet.previewPairs[saved.previewSelected ?? 'old'].pairId,
      recoveryPairId: packet.previewPairs[saved.previewSelected === 'new' ? 'old' : 'new'].pairId,
      rendererSha: packet.previewPairs[saved.previewSelected ?? 'old'].rendererSha,
      serializerId: packet.previewPairs[saved.previewSelected ?? 'old'].serializerId },
      adminManifestDigest: saved.adminManifestDigest ?? 'e'.repeat(64), adminReceiptDigest: 'f'.repeat(64) } });
  saved.controls ??= [];
  if (action !== 'inspect' && saved.receipts[actionId]) {
    if (saved.mode === 'preview-retry-mutation' && action === 'preview-failure-admin-assets') {
      saved.previewEpoch++; await persist();
    }
    return saved.receipts[actionId];
  }
  if (action === 'interrupt-qualification') { saved.interrupted = true; await persist(); process.exit(86); }
  if (action === 'resume-qualification' && !saved.interrupted) throw new Error('Missing durable checkpoint');
  if (action === 'prepare-both-pairs') saved.attempts++;
  if (action === 'prepare-both-pairs' && saved.mode === 'duplicate-provider-prepare') saved.attempts++;
  if (action === 'switch-new' || action === 'return-old-current-content') {
    saved.selected = action === 'switch-new' ? 'new' : 'old'; saved.epoch++; saved.generation++;
    if (saved.mode === 'duplicate-provider') saved.attempts++;
  }
  if (action === 'publish-and-prove') saved.sequence++;
  if (action === 'preview-failure-admin-assets') {
    saved.previewSelected = saved.mode === 'preview-returned-old' ? 'old' : 'new';
    saved.previewEpoch = 2;
    if (saved.mode === 'preview-admin-overwrite') saved.adminManifestDigest = 'd'.repeat(64);
  }
  const reply = { schemaVersion: 1, actionId, state: state(), receiptDigest: digest(actionId),
    outcome: action === 'qualify-corrupt-candidate' ? 'refused' : 'complete' };
  if (action === 'inspect' && (saved.mode === 'refused-after-get' && actionId.endsWith('-after-get') ||
      saved.mode === 'refused-final-inspect' && actionId.endsWith('-final-inspect'))) reply.outcome = 'refused';
  if (saved.interrupted) reply.qualification = { attemptId: `${packet.runId}-qualification-new`,
    checkpointDigest: 'a'.repeat(64), status: action === 'inspect' && !saved.resumed ? 'interrupted' : 'complete' };
  if (action === 'resume-qualification') saved.resumed = true;
  const publishing = ['publish-and-prove', 'accept-held-old-operation', 'accept-held-new-operation',
    'retry-lost-acceptance-response', 'withdraw-and-prove-both-pairs', 'scheduled-acceptance-and-prove',
    'settle-original-old-through-new', 'settle-original-new-through-old', 'prove-withdrawal-after-return'];
  if (publishing.includes(action)) {
    const held = action.startsWith('accept-held-');
    const original = action.includes('original-old') ? 'old'
      : action.includes('original-new') || action === 'prove-withdrawal-after-return' ? 'new' : saved.selected;
    reply.operation = { operationId: request.operationId, originalPair: original, snapshotDigest: 'b'.repeat(64),
      claimDigest: 'c'.repeat(64), sourceVersion: 1, acceptedCount: 1, terminalCount: held ? 0 : 1,
      terminalReceiptDigest: held ? null : 'd'.repeat(64) };
  }
  if (reply.outcome === 'refused') reply.reason = 'byte-mismatch';
  if (publishing.includes(action) && !action.startsWith('accept-held-')) reply.proof = { path: '/fixture/', status: 200,
    bodyDigest: digest(body), epoch: saved.epoch, contentSequence: saved.sequence, selected: saved.selected,
    headers: { 'x-njpbs-html-sha256': digest(body), 'x-njpbs-publication-operation': request.operationId,
      'x-njpbs-source-version': '1', 'x-njpbs-publication-origin': targets.publicationTarget(side().environment).workerName,
      'x-njpbs-selector-sha256': protocol.publicReleaseDigest(reply.state.selector),
      'x-njpbs-release-epoch': String(saved.epoch), 'x-njpbs-release-pair': side().pairId,
      'x-njpbs-content-head-sha256': reply.state.selector.contentHead.manifestDigest,
      'x-njpbs-snapshot-sha256': reply.operation.snapshotDigest, 'x-njpbs-renderer-sha': side().commitSha } };
  if (reply.proof && saved.mode === 'wrong-proof-operation') reply.proof.headers['x-njpbs-publication-operation'] = 'another-operation';
  if (action !== 'inspect') saved.controls.push(state());
  if (action === 'prepare-both-pairs' && saved.mode === 'transient-pause') saved.controls.push({ ...state(), admission: false });
  if (action === 'withdraw-and-prove-both-pairs' || action === 'prove-withdrawal-after-return') {
    reply.proof.status = 410; reply.proof.bodyDigest = digest('');
    reply.proof.headers['x-njpbs-html-sha256'] = digest('');
    if (action === 'prove-withdrawal-after-return' && saved.mode === 'resurrected-withdrawal') reply.proof.status = 200;
  }
  if (action === 'audit') reply.audit = { controlsContinuous: true, accepted: 10, terminal: 10,
    controlStates: saved.controls, operations: [...new Map(Object.values(saved.receipts)
      .filter(item => item.operation).map(item => [item.operation.operationId, item.operation])).values()],
    duplicateOperations: 0, orphanedOperations: saved.mode === 'orphan' ? 1 : 0,
    returnUsedCurrentContent: true, qualificationResumed: true,
    previewFailuresCovered: ['functions', 'preview-rollout', 'preview-selection', 'pre-selection-cancellation', 'admin-assets', 'cancellation'] };
  if (action !== 'inspect') saved.receipts[actionId] = reply;
  if (action === 'switch-new' && saved.mode === 'lost-switch-response') {
    delete saved.mode; await persist(); process.exit(1);
  }
  if (action === 'preview-failure-admin-assets' && saved.mode === 'lost-preview-response') {
    delete saved.mode; await persist(); process.exit(1);
  }
  await persist();
  return reply;
}
