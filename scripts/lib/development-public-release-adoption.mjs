import { createRequire } from 'node:module';
import protocol from '../../functions/lib/public-release-pair.js';
import bootstrap from '../../functions/lib/public-release-bootstrap.js';
import { parseOperatorCredentialIdentity, operatorRefused as refuse } from './public-release-operator-io.mjs';
const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const owner = path => typedRequire(path, import.meta.url);
const controls = owner('../../site/scripts/public-release-bootstrap-controls.ts');
const installed = owner('../../site/scripts/public-release-installed-consumer-owner.ts');
const { prepareInitialBootstrapInstalledGuard } = owner('../../site/scripts/public-release-bootstrap-installed-guard.ts');
const { prepareMeasuredBootstrapQualification } = owner('../../site/scripts/public-release-bootstrap-read-budget.ts');
const { createBootstrapReadStore } = owner('../../site/scripts/public-release-bootstrap-read-store.ts');
const preview = owner('../../site/scripts/cms-preview-cloud-control.ts');
const resume = owner('../../site/scripts/public-release-bootstrap-logged-resume.ts');
const { readInitialBootstrapReceipt } = owner('../../site/scripts/public-release-bootstrap-readback.ts');
export function parseDevelopmentAdoptionPacket(raw) { return parseAdoptionPacket(raw, 'development'); }
export function parseProductionAdoptionPacket(raw) { return parseAdoptionPacket(raw, 'production'); }
function parseAdoptionPacket(raw, environment) {
  protocol.exact(raw, ['schemaVersion', 'kind', 'operatorCommitSha', 'credentialIdentity', 'step', 'attempt']);
  if (raw.schemaVersion !== 1 || raw.kind !== `${environment}-public-release-adoption` || !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? '') ||
      !['preview-pause', 'controls', 'initial', 'resume'].includes(raw.step)) refuse();
  if (raw.step === 'preview-pause') {
    protocol.exact(raw.attempt, ['rendererSha', 'expectedRuntimeDigest']);
    if (!/^[a-f0-9]{40}$/.test(raw.attempt.rendererSha ?? '') || !protocol.digest(raw.attempt.expectedRuntimeDigest)) refuse();
    parseOperatorCredentialIdentity(raw.credentialIdentity, environment);
    return protocol.freeze(structuredClone(raw));
  }
  const attempt = raw.step === 'controls' ? controls.parseBootstrapControlsAttempt(raw.attempt)
    : raw.step === 'resume' ? resume.parseBootstrapResumeAttempt(raw.attempt) : bootstrap.parseBootstrapAttempt(raw.attempt);
  const pair = raw.step === 'controls' ? attempt.pair : (attempt.bootstrap ?? attempt).currentPair;
  if (pair.environment !== environment || raw.step !== 'controls' && (attempt.bootstrap ?? attempt).recoveryPair.environment !== environment) refuse();
  parseOperatorCredentialIdentity(raw.credentialIdentity, environment);
  return protocol.freeze(structuredClone({ ...raw, attempt }));
}
/** Composition only: every write remains in its existing guarded native owner.
 * Supplied boundaries are process-local test seams, never serialized callbacks. */
export function runDevelopmentAdoption(options) { return runAdoption(options, 'development'); }
export function runProductionAdoption(options) { return runAdoption(options, 'production'); }
async function runAdoption({ firestore, packet: raw, objects, provider, request, signal, mode = 'plan', evidence = {} }, environment) {
  const packet = parseAdoptionPacket(raw, environment), { attempt, step } = packet;
  if (!['plan', 'apply', 'readback'].includes(mode)) refuse();
  if (mode === 'plan') return { step, mode, authorityReads: 0, authorityWrites: 0 };
  if (firestore.projectId !== packet.credentialIdentity.projectId) refuse();
  if (step === 'preview-pause') {
    const path = preview.PREVIEW_RUNTIME_DOCUMENT;
    if (mode === 'readback') {
      const current = preview.parsePreviewRuntimeControl((await firestore.doc(path).get()).data());
      if (current.rendererSha !== attempt.rendererSha || current.phase !== 'paused') refuse();
      return { kind: 'preview-pause-current-state', runtimeDigest: protocol.publicReleaseDigest(current) };
    }
    // Preserve the existing writer; add its exact original-source guard inside
    // the SAME transaction, before that owner's own read and write.
    const guarded = { doc: path => firestore.doc(path), runTransaction: run => firestore.runTransaction(async transaction => {
      signal?.throwIfAborted();
      const current = (await transaction.get(firestore.doc(path))).data();
      const control = preview.parsePreviewRuntimeControl(current);
      if (control.rendererSha !== attempt.rendererSha || protocol.publicReleaseDigest(current) !== attempt.expectedRuntimeDigest) refuse();
      return run(transaction);
    }) };
    await preview.pausePreviewRuntime(guarded, attempt.rendererSha);
    return { kind: 'preview-pause-applied', rendererSha: attempt.rendererSha };
  }
  const installedEvidence = { ...evidence, provider };
  if (mode === 'readback') {
    if (step === 'resume') return { receipt: await resume.readBootstrapResumeReceipt({ firestore, attempt }) };
    if (step === 'initial') return { receipt: await readInitialBootstrapReceipt({ firestore, attempt }) };
    const receipt = (await firestore.doc(`${controls.BOOTSTRAP_CONTROL_RECEIPTS}/${attempt.operationId}`).get()).data();
    if (receipt && receipt.attemptDigest !== protocol.publicReleaseDigest(attempt)) refuse();
    return { receipt: receipt ?? null };
  }
  if (step === 'controls') {
    const proof = await installed.prepareInstalledPublicReleaseConsumers({ ...installedEvidence, firestore, environment,
      sourceSha: attempt.consumerSourceSha, contractDigest: attempt.admittedContractDigest });
    return controls.installBootstrapOldControls({ firestore, attempt, installed: proof, dryRun: false });
  }
  const initial = attempt.bootstrap ?? attempt;
  if (step === 'resume') {
    const prior = await resume.readBootstrapResumeReceipt({ firestore, attempt });
    if (prior) return { idempotent: true, receipt: prior };
    const store = createBootstrapReadStore({ firestore, attempt: initial, objects, enabled: true, signal });
    const proof = await resume.prepareBootstrapLoggedResume({ firestore, attempt, store, request, evidence: installedEvidence, signal });
    return resume.resumePreparedBootstrap({ firestore, proof, dryRun: false });
  }
  const guard = await prepareInitialBootstrapInstalledGuard({ firestore, attempt, evidence: installedEvidence });
  const qualificationSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  const store = createBootstrapReadStore({ firestore, attempt, objects, enabled: true, signal: qualificationSignal });
  const { qualificationGuard, measurement } = await prepareMeasuredBootstrapQualification({ firestore, attempt, store, signal: qualificationSignal });
  const result = await bootstrap.bootstrapPublicReleaseSelector({ firestore, attempt, dryRun: false, qualificationGuard, ...guard });
  return { ...result, measurement };
}
