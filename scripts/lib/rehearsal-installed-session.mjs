import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import switches from '../../functions/lib/public-release-switch.js';
import visibility from '../../functions/lib/public-video-references.js';
import { parseRehearsalPacket, rehearsalSteps, rehearsalOperationId, rehearsalSourceCommit, PREVIEW_BOUNDARIES } from './public-release-rehearsal.mjs';
import { assertDevelopmentRehearsalEnvironment, hasDevelopmentCredentialSource } from './development-rehearsal-credentials.mjs';
import { createRehearsalIngressProof, readOriginalRehearsalProof } from './public-release-rehearsal-proof.mjs';
import { captureRehearsalInstalledCensus, bindRehearsalInstalledCensus } from './rehearsal-installed-census.mjs';
import { readRehearsalInstalledState } from './rehearsal-installed-state.mjs';
import { openRehearsalJournal } from './rehearsal-installed-journal.mjs';
import { createRehearsalPublicOwners } from './rehearsal-public-owners.mjs';
import { createRehearsalHoldActions } from './rehearsal-installed-hold.mjs';
import { createRehearsalQualificationProcess } from './rehearsal-qualification-process.mjs';
import { createRehearsalCandidateFault } from './rehearsal-candidate-fault.mjs';
import { readRehearsalOriginalOperation } from './rehearsal-original-operation.mjs';
import { createRehearsalReaderRefresh } from './rehearsal-reader-refresh.mjs';
import { createInstalledRehearsalPreflights, runInstalledRehearsalPreflights, INSTALLED_REHEARSAL_PUBLICATIONS } from './rehearsal-installed-preflights.mjs';
import { prepareRehearsalPreviewRuntime, createRehearsalPreviewActions } from './public-release-rehearsal-preview.mjs';
import { InstalledRehearsalStop, installedRehearsalStopReply } from './rehearsal-installed-stop.mjs';
import { assertNativeRehearsalDatabase } from './rehearsal-sdk-identity.mjs';
import { captureRehearsalAuditBaseline, readRehearsalOperationAudit, readRehearsalReturnAudit } from './rehearsal-installed-audit.mjs';
import { openRehearsalControlObserver, readRehearsalControlEvidence } from './rehearsal-installed-controls.mjs';
import { prepareRehearsalAcceptedRecovery, advanceRehearsalAcceptedRecovery } from './rehearsal-accepted-recovery.mjs';
import { waitForRehearsalReplay } from './rehearsal-replay-catch-up.mjs';

const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const { advancePublicReleaseSwitchCodeHead } = typedRequire('../../site/scripts/public-release-switch-code-head.ts', import.meta.url);
const sessions = new WeakMap();
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Installed rehearsal execution refused'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Construction is explicit, development-only and default-off. Provider and
 * credential callbacks are transport boundaries; none can supply owner success.
 * Installed metadata is checked against original native receipts before work.
 */
export async function createInstalledRehearsalSession(options = {}) {
  if (options.authorized !== true) refuse();
  const recoveryOnly = options.recoveryOnly ?? false;
  if (typeof recoveryOnly !== 'boolean') refuse();
  assertDevelopmentRehearsalEnvironment();
  const { firestore, sourceSha, installed, store, readerCredentials, developmentCredential, httpCredential,
    fieldValues, probeDocumentId, readToken, preview, readerRefresh, executionDigest, signal: upstreamSignal } = options;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(upstreamSignal ? [upstreamSignal] : [])]);
  const packet = protocol.freeze(structuredClone(parseRehearsalPacket(options.packet)));
  if (packet.schemaVersion !== 2 || packet.setupMode !== 'preinstalled' || firestore?.projectId !== 'njpbs-site-dev' ||
      !hasDevelopmentCredentialSource(developmentCredential) || !protocol.digest(executionDigest) || rehearsalSourceCommit() !== sourceSha ||
      ![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT) ||
      !Array.isArray(readerCredentials) || readerCredentials.length !== 2 || readerCredentials.some(fn => typeof fn !== 'function') ||
      typeof options.captureRecovery !== 'function' || typeof store?.put !== 'function' || typeof store?.get !== 'function') refuse();
  if (!Number.isSafeInteger(options.holdDurationMs) || options.holdDurationMs < 1_000 || options.holdDurationMs > 600_000 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(probeDocumentId ?? '') ||
      preview?.admin?.fetchImpl !== undefined && preview.admin.fetchImpl !== fetch ||
      preview?.runtime?.fetchImpl !== undefined && preview.runtime.fetchImpl !== fetch) refuse();
  assertNativeRehearsalDatabase(firestore, packet.projectId);
  const adapterDigest = sha(await readFile(packet.adapter));
  const plans = protocol.freeze(structuredClone(options.publications));
  if (!Array.isArray(plans) || plans.length !== 9 || new Set(plans.map(value => value.step)).size !== 9) refuse();
  const publications = new Map();
  for (const value of plans) {
    protocol.exact(value, ['step', 'documentId', 'beforeDocumentDigest', 'nextDocument', 'path']);
    if (!INSTALLED_REHEARSAL_PUBLICATIONS.includes(value.step) || value.step === 'scheduled' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(value.documentId) || !protocol.digest(value.beforeDocumentDigest) ||
        value.nextDocument?.id !== value.documentId || value.nextDocument?.type !== 'post' ||
        !protocol.positive(value.nextDocument.version) || !value.nextDocument.published ||
        visibility.publiclyVisible(value.nextDocument) !== (value.step !== 'withdraw') ||
        value.path !== `/posts/${value.nextDocument.published.metadata?.slug}/` ||
        !/^\/posts\/[A-Za-z0-9_-]+\/$/.test(value.path)) refuse();
    publications.set(value.step, value);
  }
  if (!packet.scheduledSource || packet.scheduledSource.collection !== 'cmsPosts' ||
      !/^\/posts\/[A-Za-z0-9_-]+\/$/.test(options.scheduledPath ?? '') ||
      publications.get('withdraw').documentId === publications.get('hold-new').documentId ||
      publications.get('withdraw').documentId === publications.get('after-return').documentId) refuse();
  const censusOptions = { firestore, packet, sourceSha, authorized: true, publishers: installed.publishers.map(value => value.plan),
    gateways: installed.gateways, workers: installed.workers.map((value, index) => {
      const { main, ...config } = value.config;
      return { role: ['slot-old', 'slot-new', 'ingress', 'operator'][index], attemptId: value.attemptId,
        attemptPlanDigest: value.attemptPlanDigest, workerName: value.config.name, versionId: value.versionId,
        workerPlanDigest: protocol.publicReleaseDigest({ config, sourceDigest: sha(value.source) }) };
    }) };
  const census = await captureRehearsalInstalledCensus(censusOptions);
  const observe = () => readRehearsalInstalledState({ firestore, packet, probeDocumentId, signal, authorized: true });
  const initialState = await observe();
  const ingress = createRehearsalIngressProof({ packet, httpCredential });
  let closed = false, controls;
  const current = () => {
    assertDevelopmentRehearsalEnvironment(); signal?.throwIfAborted();
    if (closed || !hasDevelopmentCredentialSource(developmentCredential) || rehearsalSourceCommit() !== sourceSha) refuse();
    controls?.assertHealthy();
  };
  // This native provider preflight performs GETs only, including both private
  // reader gateways, compiled worker bytes, original domain and Access claims.
  await bindRehearsalInstalledCensus(census, census.receiptDigest);
  const preflightOptions = { firestore, packet, probeDocumentId, installed, census, store, readToken,
    readerCredentials, httpCredential, admin: preview.admin, sourceSha, adapterDigest, executionDigest, signal, authorized: true };
  await createInstalledRehearsalPreflights(preflightOptions)[2]();
  const auditOptions = { firestore, packet, signal, authorized: true };
  const priorJournal = await firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}`).get();
  if (recoveryOnly && !priorJournal.exists) refuse();
  const auditBaseline = priorJournal.exists ? null : await captureRehearsalAuditBaseline(auditOptions);
  const journal = await openRehearsalJournal({ firestore, packet, sourceSha, adapterDigest,
    censusDigest: census.receiptDigest, executionDigest, initialState, auditBaseline, authorized: true });
  const owners = createRehearsalPublicOwners({ firestore, packet, store, ingress, fieldValues, signal, authorized: true,
    credentials: readerCredentials[0], credentialsForPair: pair => readerCredentials[pair.pairId === packet.oldPair.pairId ? 0 : 1](),
    currentCodeRequest: options.currentCodeRequest });
  const holds = createRehearsalHoldActions({ firestore, packet, initialEpoch: journal.initialState.selector.epoch,
    durationMs: options.holdDurationMs, cases: { old: publications.get('hold-old'), new: publications.get('hold-new') },
    store, ingress, fieldValues, signal, authorized: true });
  const qualifier = createRehearsalQualificationProcess({ firestore, packet, store, credentials: readerCredentials[1],
    developmentCredential, sourceSha, signal, authorized: true });
  const fault = createRehearsalCandidateFault({ firestore, packet, store, credentials: readerCredentials[1], sourceSha, signal, authorized: true });
  const refresh = createRehearsalReaderRefresh({ ...readerRefresh, firestore, packet, admin: preview.admin,
    developmentCredential, sourceSha, signal, authorized: true });
  let previewActions, previewReaders, qualifications;
  const previewResults = new Map();
  const issued = new Map();
  const pathFor = step => step === 'scheduled' ? options.scheduledPath : publications.get(step)?.path;
  async function waitFor(action) {
    const deadline = Date.now() + 120_000;
    while (true) {
      signal?.throwIfAborted();
      const result = await action(); if (result) return result;
      if (Date.now() >= deadline) refuse();
      await delay(500, undefined, { signal });
    }
  }
  async function recovery() { current(); await options.captureRecovery(signal); }
  async function caughtUp() {
    return waitForRehearsalReplay({ ...auditOptions, wake: recovery });
  }
  async function codeHead(side, switchStep) {
    const pair = packet[`${side}Pair`], operationId = switches.switchChangeOperationId(rehearsalOperationId(packet, switchStep));
    const receipt = firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/switchCodeActivations/${operationId}`);
    await recovery();
    await waitFor(async () => {
      const prior = await receipt.get(); let view;
      if (prior.exists) view = prior.data().sourceView;
      else {
        let sealed;
        try { sealed = await replay.sealPublicReleasePairReplayWitness({ firestore, pair }); }
        catch (error) { if (error.code === 'replay-not-caught-up') return null; throw error; }
        view = (await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair,
          headCursor: sealed.witness.headCursor, witnessDigest: sealed.witnessDigest })).headView;
        if (view?.identity.sourceOperationId !== operationId) return null;
      }
      try {
        const result = await advancePublicReleaseSwitchCodeHead({ firestore, store, pair, ...view, signal });
        if (result.status !== 'activated') refuse(); return result;
      } catch (error) { if (error.code === 'switch-code-replay-pending') return null; throw error; }
    });
  }
  async function complete(operationId, terminal = true) {
    await recovery();
    const original = await waitFor(() => readRehearsalOriginalOperation({ firestore, packet, operationId, signal }));
    if (!terminal) { if (original.terminalCount !== 0) refuse(); return original; }
    await owners.finish(operationId);
    const settled = await readRehearsalOriginalOperation({ firestore, packet, operationId, signal });
    if (settled?.terminalCount !== 1) refuse(); return settled;
  }
  async function prove(operationId, path) {
    const source = await readOriginalRehearsalProof({ firestore, packet, operationId, path });
    const state = await observe();
    const response = await ingress.prove(new Request(new URL(path, 'https://dev-public.example.org'), { signal }),
      source.proof.bodyDigest, { status: source.proof.status });
    const chunks = []; let bytes = 0;
    try {
      if (response.body) for await (const chunk of response.body) {
        bytes += chunk.byteLength; if (bytes > 16 * 1024 * 1024) refuse(); chunks.push(Buffer.from(chunk));
      }
    } finally { await response.body?.cancel().catch(() => {}); }
    if (sha(Buffer.concat(chunks)) !== source.proof.bodyDigest || bytes !== source.proof.bytes) refuse();
    return { operation: source.operation, proof: { path, status: response.status, bodyDigest: source.proof.bodyDigest,
      epoch: state.selector.epoch, contentSequence: state.selector.contentHead.contextSequence,
      selected: state.selector.selectedPair.pairId === packet.oldPair.pairId ? 'old' : 'new',
      headers: Object.fromEntries([...response.headers].filter(([name]) => name.startsWith('x-njpbs-'))) } };
  }
  async function previewOwner() {
    if (!previewActions) {
      previewReaders = await refresh.refresh();
      const handle = await prepareRehearsalPreviewRuntime({ ...preview.runtime, firestore, readers: previewReaders,
        signal, authorized: true });
      previewActions = await createRehearsalPreviewActions(handle, { runId: packet.runId, admin: preview.admin, authorized: true });
    }
    return previewActions;
  }
  async function executePreview(step, actionId) {
    const result = await (await previewOwner()).execute({ boundary: step.slice(8), actionId });
    const digest = protocol.publicReleaseDigest(result), previous = previewResults.get(actionId);
    if (previous !== undefined && previous !== digest) refuse();
    previewResults.set(actionId, digest);
  }
  async function audit() {
    const operations = [];
    for (const step of INSTALLED_REHEARSAL_PUBLICATIONS) {
      const row = await readOriginalRehearsalProof({ firestore, packet, operationId: rehearsalOperationId(packet, step), path: pathFor(step) });
      operations.push(row.operation);
    }
    const boundaries = await (await previewOwner()).completedBoundaries(), interrupted = await qualifier.inspect();
    if (interrupted.status !== 'complete' || !same(boundaries, PREVIEW_BOUNDARIES)) refuse();
    // Actual fresh native qualifications are produced before the read-only
    // callbacks; those callbacks cannot refresh a stale receipt themselves.
    await caughtUp(); qualifications = [];
    for (const side of ['old', 'new']) {
      const result = await owners.qualify(side, rehearsalOperationId(packet, 'audit'));
      qualifications.push({ qualificationId: result.receipt.qualificationId, receiptDigest: protocol.publicReleaseDigest(result.receipt) });
    }
    const operationAudit = await readRehearsalOperationAudit({ ...auditOptions, baseline: journal.auditBaseline });
    const returnAudit = await readRehearsalReturnAudit(auditOptions);
    await controls.sampleNow();
    const { states: controlStates, ...controlEvidence } = await readRehearsalControlEvidence(auditOptions);
    if (controlStates.at(-1).selector.epoch !== journal.initialState.selector.epoch + 2) refuse();
    return { ...operationAudit, ...returnAudit, controlsContinuous: controlEvidence.controlsContinuous, controlEvidence,
      qualificationResumed: interrupted.status === 'complete', previewFailuresCovered: boundaries, controlStates, operations, qualifications };
  }
  const handle = Object.freeze({});
  const api = Object.freeze({ firestore, packet, sourceSha, adapterDigest, recoveryOnly,
    close() { closed = true; controls?.stop(); controller.abort(); },
    async recoverVerifiedReceipts() { current(); return journal.recoverBytes(); },
    async execute(request) {
      current(); if (recoveryOnly || !same(request.packet, packet)) refuse();
      if (request.action === 'inspect') {
        const state = await observe(), qualification = (await firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/qualifications/new`).get()).exists
          ? await qualifier.inspect() : undefined;
        const reply = { schemaVersion: 1, actionId: request.actionId, state, outcome: 'complete',
          ...(qualification ? { qualification } : {}), receiptDigest: protocol.publicReleaseDigest({ state, qualification: qualification ?? null }) };
        issued.set(request.actionId, reply); return reply;
      }
      const definition = rehearsalSteps().find(([step, action, target]) => request.actionId === `${packet.runId}-${step}` && action === request.action && target === request.target);
      if (!definition || request.operationId !== rehearsalOperationId(packet, definition[0]) || request.resume !== true) refuse();
      const [step] = definition;
      if (issued.has(request.actionId)) {
        // The harness's same-ID retry must re-enter the actual native owner.
        // Keep its original HTTP/SDK reply only after checking the returned
        // immutable owner result again; fresh inspection follows in the harness.
        if (step.startsWith('preview-')) await executePreview(step, request.actionId);
        return issued.get(request.actionId);
      }
      const history = await journal.recover();
      if (history.length !== rehearsalSteps().findIndex(([name]) => name === step)) refuse();
      let extra = {}, outcome = 'complete';
      try {
        if (publications.has(step)) {
          const held = step === 'hold-old' || step === 'hold-new';
          if (held) { holds.available(); await holds.reserve(request.target); }
          const plan = publications.get(step);
          const accepted = await owners.acceptPost({ ...plan, operationId: request.operationId });
          if (step === 'retry-new' && !same(accepted, await owners.acceptPost({ ...plan, operationId: request.operationId }))) refuse();
          const operation = await complete(request.operationId, !held);
          if (held) {
            const hold = await holds.read(request.target);
            if (hold?.status !== 'held') refuse(); extra = { operation };
          } else extra = await prove(request.operationId, plan.path);
        } else if (step === 'scheduled') {
          await owners.acceptScheduled({ operationId: request.operationId, target: 'old' });
          await complete(request.operationId); extra = await prove(request.operationId, options.scheduledPath);
        } else if (step === 'prepare') await bindRehearsalInstalledCensus(census, census.receiptDigest);
        else if (step === 'interrupt') {
          await caughtUp();
          const result = await qualifier.interrupt(); issued.set(request.actionId, result); return result;
        } else if (step === 'resume') extra = { qualification: await qualifier.resume() };
        else if (step === 'corrupt') await fault.arm(request.actionId);
        else if (step === 'refuse-corrupt') { await caughtUp(); await fault.qualifyCorrupt(); outcome = 'refused'; extra = { reason: 'byte-mismatch' }; }
        else if (step === 'repair') await fault.restore(request.actionId);
        else if (step === 'qualify-new' || step === 'catch-up-old') {
          await caughtUp(); await owners.qualify(step === 'qualify-new' ? 'new' : 'old', request.operationId);
        } else if (step === 'switch-new' || step === 'return-old') {
          holds.available(); await caughtUp(); await owners.switchTo(request.target, request.operationId);
          await codeHead(request.target, step);
        } else if (step === 'settle-old' || step === 'settle-new') {
          await holds.release(step === 'settle-old' ? 'old' : 'new', request.actionId);
          await complete(request.operationId); extra = await prove(request.operationId, pathFor(step === 'settle-old' ? 'hold-old' : 'hold-new'));
        } else if (step === 'withdraw-after-return') extra = await prove(request.operationId, pathFor('withdraw'));
        else if (step.startsWith('preview-')) await executePreview(step, request.actionId);
        else if (step === 'audit') extra = { audit: await audit() };
        else refuse();
      } catch (error) {
        if (error instanceof InstalledRehearsalStop) return installedRehearsalStopReply(request, error);
        throw error;
      }
      const state = await observe(); current();
      const reply = protocol.freeze({ schemaVersion: 1, actionId: request.actionId, state, outcome, ...extra,
        receiptDigest: protocol.publicReleaseDigest({ actionId: request.actionId, state, outcome, extra }) });
      issued.set(request.actionId, reply); return reply;
    },
    async record(receipt) {
      current(); if (recoveryOnly) refuse();
      if (!same(issued.get(receipt.actionId), receipt.result) ||
          !same(issued.get(`${receipt.actionId}-inspect`), receipt.observed)) refuse();
      return journal.record(receipt);
    },
    async verifyCompletion(directory) {
      current(); if (recoveryOnly) refuse();
      if (!qualifications) qualifications = (await journal.recover()).find(value => value.step === 'audit')?.result?.audit?.qualifications;
      if (!previewReaders) await previewOwner();
      return runInstalledRehearsalPreflights({ ...preflightOptions, previewReaders, qualifications,
        completion: { directory, publications: INSTALLED_REHEARSAL_PUBLICATIONS.map(step => ({ step, path: pathFor(step) })) } });
    },
    async recoverEffects() {
      current(); if (!recoveryOnly) refuse();
      const handle = await prepareRehearsalAcceptedRecovery({ ...auditOptions, owners, holds, sourceSha, recoveryOnly: true });
      // Complete an already committed switch's own CODE activation; never
      // create a switch, return, acceptance or preview action during recovery.
      const state = await observe();
      for (const [step, side] of [['switch-new', 'new'], ['return-old', 'old']]) {
        if (state.selector.switchOperationId === rehearsalOperationId(packet, step)) await codeHead(side, step);
      }
      const operations = [];
      for (const operationId of handle.operationIds) {
        await recovery();
        await waitFor(() => advanceRehearsalAcceptedRecovery(handle, operationId, 'render'));
        operations.push(await advanceRehearsalAcceptedRecovery(handle, operationId, 'settle'));
      }
      current();
      return protocol.freeze({ kind: 'recovery-only', runId: packet.runId, sourceSha,
        operations, scenarioPassed: false, controlsContinuous: false, productionAdoption: false, measurementsAccepted: false });
    },
  });
  if (!recoveryOnly) controls = await openRehearsalControlObserver({ ...auditOptions, probeDocumentId, onFailure: () => controller.abort() });
  sessions.set(handle, api); return handle;
}

export function installedRehearsalSession(handle, packet) {
  const session = sessions.get(handle);
  if (!session || !same(session.packet, packet)) refuse();
  return session;
}
export function hasInstalledRehearsalSession(handle) { return sessions.has(handle); }
export function closeInstalledRehearsalSession(handle) {
  sessions.get(handle)?.close(); sessions.delete(handle);
}
