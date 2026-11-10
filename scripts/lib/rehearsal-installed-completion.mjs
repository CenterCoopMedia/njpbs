import { createHash } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import protocol from '../../functions/lib/public-release-pair.js';
import preview from '../../functions/lib/cms-preview-pair.js';
import { rehearsalSteps, PREVIEW_BOUNDARIES, rehearsalOperationId } from './public-release-rehearsal.mjs';
import { assertRehearsalAuditManifest, assertChainedRehearsalPreviewAudit } from './rehearsal-preview-audit.mjs';
import { readRehearsalQualificationInterruption } from './rehearsal-qualification-process.mjs';
import { readRehearsalCandidateFaultHistory } from './rehearsal-candidate-fault.mjs';
import { readRehearsalOperationAudit, readRehearsalReturnAudit } from './rehearsal-installed-audit.mjs';
import { readRehearsalControlEvidence } from './rehearsal-installed-controls.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Installed rehearsal completion refused'); };
async function json(directory, name, maximum = 4 * 1024 * 1024) {
  const filename = join(directory, name), actual = await realpath(filename), metadata = await stat(actual);
  if (actual !== filename || !metadata.isFile() || metadata.size < 1 || metadata.size > maximum) refuse();
  const bytes = await readFile(actual);
  if (bytes.length > maximum) refuse();
  return { value: JSON.parse(bytes.toString('utf8')), digest: hash(bytes) };
}
function immutable(row) {
  if (!row?.exists || !row.createTime?.isEqual(row.updateTime)) refuse();
  return row.data();
}

/** A local JSON verdict is insufficient. Each scenario must match this run's
 * original immutable SDK action journal, all original native terminal facts,
 * both guarded switch receipts and the six original preview audit manifests.
 * This reader creates no evidence and cannot turn a STOP into completion.
 */
export async function readRehearsalCompletion({ firestore, packet, sourceSha, adapterDigest, executionDigest, completion, state,
  switches, originals, signal }) {
  if (!protocol.digest(executionDigest) || !completion || typeof completion.directory !== 'string' || !Array.isArray(originals) || originals.length !== 10 ||
      !Array.isArray(switches) || switches.length !== 2) refuse();
  const directory = resolve(completion.directory);
  if (directory === root || directory.startsWith(`${root}/`) || await realpath(directory) !== directory) refuse();
  const report = await json(directory, 'report.json'), status = await json(directory, 'status.json', 4096);
  const binding = await json(directory, 'packet.json', 128 * 1024), value = report.value;
  if (status.value.status !== 'complete' || status.value.reportDigest !== report.digest || value.kind !== 'isolated-rehearsal' ||
      value.schemaVersion !== 1 || value.runId !== packet.runId || value.projectId !== packet.projectId ||
      value.sourceCommitSha !== sourceSha || value.adapterDigest !== adapterDigest || value.adapter !== packet.adapter ||
      value.packetDigest !== binding.digest || value.verdict !== 'scenario-checks-passed' ||
      value.productionAdoption !== false || value.measurementsAccepted !== false || !same(binding.value.packet, packet) ||
      binding.value.sourceCommitSha !== sourceSha || binding.value.adapterDigest !== adapterDigest) refuse();
  const steps = rehearsalSteps();
  if (!Array.isArray(value.receipts) || value.receipts.length !== steps.length) refuse();
  const run = immutable(await firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}`).get());
  if (run.schemaVersion !== 1 || run.sourceSha !== sourceSha || run.adapterDigest !== adapterDigest ||
      run.packetDigest !== protocol.publicReleaseDigest(packet) || run.executionDigest !== executionDigest || !protocol.digest(run.initialStateDigest) ||
      run.initialStateDigest !== protocol.publicReleaseDigest(run.initialState) ||
      run.auditBaselineDigest !== protocol.publicReleaseDigest(run.auditBaseline)) refuse();
  const journals = [], states = [], operations = new Map(originals.map(row => [row.operation.operationId, row.operation]));
  let previousDigest = protocol.publicReleaseDigest(run);
  for (const [index, [step, action, target]] of steps.entries()) {
    signal?.throwIfAborted();
    const actionId = `${packet.runId}-${step}`, reference = value.receipts[index], local = await json(directory, `${step}.json`);
    const entry = local.value;
    if (reference.step !== step || reference.digest !== local.digest || entry.step !== step || entry.actionId !== actionId ||
        !entry.observed?.state || entry.observed.outcome !== 'complete') refuse();
    const journal = immutable(await firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/actions/${actionId}`).get());
    if (journal.schemaVersion !== 1 || journal.step !== step || journal.actionId !== actionId || journal.action !== action ||
        journal.target !== target || journal.operationId !== rehearsalOperationId(packet, step) ||
        journal.sourceSha !== sourceSha || journal.adapterDigest !== adapterDigest || journal.packetDigest !== run.packetDigest ||
        journal.executionDigest !== executionDigest || journal.censusDigest !== run.censusDigest ||
        journal.previousDigest !== previousDigest ||
        journal.resultDigest !== protocol.publicReleaseDigest(entry.result) || !same(journal.state, entry.observed.state) ||
        !same(journal.receipt, entry) || journal.receiptDigest !== protocol.publicReleaseDigest(entry) ||
        journal.receiptFileDigest !== local.digest || hash(journal.receiptBytes) !== local.digest) refuse();
    if (entry.result?.operation?.terminalCount === 1 && !same(operations.get(entry.result.operation.operationId), entry.result.operation)) refuse();
    states.push(journal.state); journals.push(protocol.publicReleaseDigest(journal));
    previousDigest = protocol.publicReleaseDigest(journal);
  }
  if (!same(states.at(-1), state) || state.selector.selectedPair.pairId !== packet.oldPair.pairId ||
      states.at(-1).selector.epoch !== states[0].selector.epoch + 2 ||
      run.initialState.selector.epoch !== states[0].selector.epoch ||
      run.initialState.selector.contentHead.contextSequence > states[0].selector.contentHead.contextSequence) refuse();
  for (const [index, current] of [run.initialState, ...states].entries()) {
    const side = index === 0 ? 'old' : steps[index - 1][2], pair = packet[`${side}Pair`];
    const selector = protocol.parsePublicReleaseSelector(current.selector);
    if (!same(selector.selectedPair, protocol.publicReleasePairReference(pair)) || current.providerAttempts !== 0 ||
        current.admission !== true || current.previewReady !== true ||
        [current.primary, current.cloud].some(pin => pin.phase !== 'ready' || pin.release !== pair.commitSha)) refuse();
  }
  const audit = (await json(directory, 'audit.json')).value.result.audit;
  const auditOptions = { firestore, packet, signal, authorized: true };
  const operationAudit = await readRehearsalOperationAudit({ ...auditOptions, baseline: run.auditBaseline });
  const returnAudit = await readRehearsalReturnAudit(auditOptions);
  const controls = await readRehearsalControlEvidence({ ...auditOptions, prefix: audit?.controlEvidence });
  if (!audit?.controlEvidence || !controls.controlsContinuous || !same(audit.controlStates, controls.prefixStates) ||
      [...Object.entries(operationAudit), ...Object.entries(returnAudit)].some(([key, value]) => !same(audit[key], value))) refuse();
  const process = await readRehearsalQualificationInterruption({ firestore, packet, sourceSha, authorized: true });
  if (!process.checkpoint || !process.qualification) refuse();
  const interrupted = (await json(directory, 'interrupt.json')).value.observed.qualification;
  const resumed = (await json(directory, 'resume.json')).value.result.qualification;
  const expected = { attemptId: process.plan.attemptId, checkpointDigest: protocol.publicReleaseDigest(process.checkpoint) };
  if (!same(interrupted, { ...expected, status: 'interrupted' }) || !same(resumed, { ...expected, status: 'complete' })) refuse();
  const fault = await readRehearsalCandidateFaultHistory({ firestore, packet, sourceSha, authorized: true });
  const baseline = await firestore.doc(`publicReleaseRehearsalPreview/${packet.runId}`).get();
  immutable(baseline);
  const previewPairs = await Promise.all(['old', 'new'].map(async side => {
    const pair = preview.parsePair((await firestore.doc(`${preview.PAIRS}/${packet.previewPairs[side].pairId}`).get()).data());
    if (['pairId', 'rendererSha', 'serializerId'].some(key => pair[key] !== packet.previewPairs[side][key])) refuse();
    return pair;
  }));
  let previous;
  const previewResults = [];
  for (const boundary of PREVIEW_BOUNDARIES) {
    const prefix = `publicReleaseRehearsalPreview/${packet.runId}`;
    const [intent, result, manifest] = await firestore.getAll(firestore.doc(`${prefix}/intents/${boundary}`),
      firestore.doc(`${prefix}/results/${boundary}`), firestore.doc(`${prefix}/manifests/${boundary}`));
    const original = immutable(result);
    assertRehearsalAuditManifest(manifest, baseline, intent, result);
    if (original.state !== 'complete' || original.intent?.boundary !== boundary ||
        original.intent.actionId !== `${packet.runId}-preview-${boundary}`) refuse();
    if (previous) assertChainedRehearsalPreviewAudit(previous, original.before, {
      oldPair: previewPairs[0], newPair: previewPairs[1], allowed: [] });
    previous = original.after; previewResults.push(preview.digest(original));
  }
  return protocol.freeze({ reportDigest: report.digest, journals, previewResults, fault,
    switches: switches.map(protocol.publicReleaseDigest), operations: originals,
    currentStateDigest: protocol.publicReleaseDigest(state), productionAuthority: false });
}
