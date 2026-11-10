import { assertDevelopmentSource } from "../render-development-config.mjs";
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import protocol from '../../functions/lib/public-release-pair.js';
import targets from '../../functions/lib/publication-target.js';
import schedules from '../../functions/lib/public-release-scheduled-operation.js';
import ownership from '../../functions/lib/public-release-pair-work.js';
import { missingBindings } from './public-release-rehearsal-adapter.mjs';
import { assertDevelopmentRehearsalEnvironment, hasDevelopmentCredentialSource,
  writeDevelopmentCredential, openDevelopmentSourceContext, openDemoRehearsalContext } from './development-rehearsal-credentials.mjs';
import { hasRehearsalHttpCredential, rehearsalHttpHeaders } from './public-release-rehearsal-http-auth.mjs';
import { verifyOriginalRehearsalProof } from './public-release-rehearsal-proof.mjs';
import { InstalledRehearsalStop, readInstalledRehearsalStop, assertRehearsalProviderTransition } from './rehearsal-installed-stop.mjs';
import { openRehearsalRecoveryEvidence } from './rehearsal-recovery-evidence.mjs';

/** Explicit abandoned-window recovery never runs the scenario or overwrites
 * its verdict. Restore only original SDK bytes, then settle accepted effects. */
export async function recoverInstalledRehearsal(rawPacket, outputDirectory, adapterOptions = {}) {
  const packet = parseRehearsalPacket(rawPacket);
  assert.equal(packet.schemaVersion, 2); assert.equal(packet.setupMode, 'preinstalled');
  assertDevelopmentRehearsalEnvironment();
  assert(hasDevelopmentCredentialSource(adapterOptions.developmentCredential));
  assert(hasRehearsalHttpCredential(adapterOptions.httpCredential, [packet.ingressOrigin, packet.proofOrigin]));
  const { installedRehearsalSession } = await import('./rehearsal-installed-session.mjs');
  const runtime = installedRehearsalSession(adapterOptions.installedSession, packet);
  assert.equal(runtime.recoveryOnly, true);
  const binding = { packet, sourceCommitSha: rehearsalSourceCommit(), adapterDigest: digest(await readFile(packet.adapter)) };
  const evidence = await openRehearsalRecoveryEvidence(outputDirectory, binding, await runtime.recoverVerifiedReceipts());
  try {
    const result = await runtime.recoverEffects();
    await evidence.write(result);
    return result;
  } finally { await evidence.close(); }
}

/** @typedef {'old' | 'new'} PairSide */
/** @typedef {import('../../packages/content-core/src/public-release.ts').PublicReleasePair} PublicReleasePair */
/** @typedef {{pairId: string, rendererSha: string, serializerId: string}} PreviewReference */
/** @typedef {{selector: {schemaVersion: 2, phase: 'ready', epoch: number, selectedPairId: string,
 * recoveryPairId: string, rendererSha: string, serializerId: string}, adminManifestDigest: string,
 * adminReceiptDigest: string}} PreviewState */
/** @typedef {{selector: import('../../packages/content-core/src/public-release.ts').PublicReleaseSelector, primary: {phase: 'ready', release: string},
 * cloud: {phase: 'ready', release: string}, admission: true, previewReady: true,
 * providerAttempts: number, preview: PreviewState}} RehearsalState */
/** @typedef {{schemaVersion: 1 | 2, mode?: 'development', runId: string, projectId: string,
 * emulatorHost: string | null, ingressOrigin: string, proofOrigin: string, adapter: string,
 * oldPair: PublicReleasePair, newPair: PublicReleasePair,
 * previewPairs: {old: PreviewReference, new: PreviewReference},
 * scheduledSource?: {collection: 'cmsPosts' | 'cmsPages', documentId: string, version: number, publishAt: string}}} RehearsalPacket */
/** @typedef {{packet: RehearsalPacket, actionId: string, action: string,
 * target: PairSide, operationId: string, resume: boolean}} RehearsalRequest */
/** @typedef {{schemaVersion: 1, actionId: string, state: RehearsalState,
 * receiptDigest: string, qualification?: {attemptId: string, checkpointDigest: string, status: 'interrupted' | 'complete'},
 * operation?: OperationReceipt, outcome: 'complete' | 'refused', reason?: 'byte-mismatch',
 * proof?: {path: string, status: number, bodyDigest: string, epoch: number,
 * contentSequence: number, selected: PairSide, headers: Record<string, string>},
 * audit?: {controlsContinuous: boolean, accepted: number, terminal: number,
 * duplicateOperations: number, orphanedOperations: number, returnUsedCurrentContent: boolean,
 * qualificationResumed: boolean, previewFailuresCovered: string[],
 * controlStates: RehearsalState[], operations: OperationReceipt[]}}} RehearsalReply */
/** @typedef {{operationId: string, originalPair: PairSide, snapshotDigest: string, claimDigest: string,
 * sourceVersion: number, acceptedCount: number, terminalCount: number, terminalReceiptDigest: string | null}} OperationReceipt */

const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = /^[a-z0-9][a-z0-9-]{0,95}$/;
const sha256 = /^[a-f0-9]{64}$/;
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const adapterHost = fileURLToPath(new URL('./public-release-rehearsal-host.mjs', import.meta.url));
const integrationAdapter = fileURLToPath(new URL('./public-release-rehearsal-adapter.mjs', import.meta.url));
const fixtureAdapter = fileURLToPath(new URL('../../tests/fixtures/public-release-rehearsal-adapter.mjs', import.meta.url));
const typescriptLoader = fileURLToPath(new URL('../../site/node_modules/tsx/dist/loader.mjs', import.meta.url));
export const PREVIEW_BOUNDARIES = Object.freeze(['functions', 'preview-rollout', 'preview-selection',
  'pre-selection-cancellation', 'admin-assets', 'cancellation']);

export class RehearsalRefusal extends Error {
  constructor(code, step = null, actionId = null) {
    super(`Rehearsal refused: ${code}`);
    this.code = code;
    this.step = step;
    this.actionId = actionId;
  }
}

export function rehearsalSourceCommit() {
  const options = { cwd: root, encoding: /** @type {const} */ ('utf8'),
    env: { PATH: process.env.PATH, HOME: '/nonexistent', LC_ALL: 'C' },
    stdio: /** @type {['ignore', 'pipe', 'ignore']} */ (['ignore', 'pipe', 'ignore']), maxBuffer: 1024 * 1024 };
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  let commit, status;
  try {
    commit = execFileSync('/usr/bin/git', [...args, 'rev-parse', 'HEAD'], options).trim();
  } catch { throw new RehearsalRefusal('source-unavailable'); }
  // A checkout that is not an exact committed or verified rendered source is dirty.
  try { status = assertDevelopmentSource(options.cwd) ? "" : "dirty"; } catch { status = "dirty"; }
  if (!/^[a-f0-9]{40}$/.test(commit) || status.length) throw new RehearsalRefusal('source-not-clean');
  return commit;
}

// Never copy arbitrary assertion values, adapter errors or provider output.
function refusalCode(error) {
  if (error instanceof RehearsalRefusal) return error.code;
  if (error instanceof SyntaxError) return 'evidence-json-invalid';
  const messages = [
    ['Public byte mismatch', 'public-byte-mismatch'],
    ['Public proof identity mismatch:', 'public-proof-identity-mismatch'],
    ['Fallback cannot certify publication', 'fallback-cannot-certify'],
    ['Unexpected selector epoch', 'unexpected-selector-epoch'],
    ['Content rewound', 'content-rewound'],
    ['Repeated provider mutation', 'repeated-provider-mutation'],
    ['Authority changed during exact-byte GET', 'authority-changed-during-get'],
    ['Final authority changed', 'final-authority-changed'],
    ['Return resurrected withdrawn content', 'withdrawal-resurrected'],
    ['Return withdrawal proof changed path', 'withdrawal-path-changed'],
    ['Ordinary ingress leaked proof', 'ordinary-ingress-proof-leak'],
    ['Preview selection mismatch', 'preview-selection-mismatch'],
    ['Preview Admin receipt changed', 'preview-admin-receipt-changed'],
    ['Preview retry changed state', 'preview-retry-changed-state'],
  ];
  return messages.find(([message]) => error.message?.startsWith(message))?.[1] ?? 'scenario-contract-refused';
}

function loopbackOrigin(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert(['127.0.0.1', '[::1]'].includes(url.hostname), 'Loopback origin required');
  assert(url.port && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password);
  return url.origin;
}

export function parseRehearsalPacket(packet) {
  const development = packet.schemaVersion === 2;
  assert(packet.schemaVersion === 1 || development);
  assert.deepEqual(Object.keys(packet).sort(), ['adapter', 'emulatorHost', 'ingressOrigin', 'newPair', 'oldPair', 'previewPairs', 'projectId', 'proofOrigin', 'runId', 'schemaVersion',
    ...(development ? ['mode'] : []), ...(Object.hasOwn(packet, 'scheduledSource') ? ['scheduledSource'] : []),
    ...(Object.hasOwn(packet, 'setupMode') ? ['setupMode'] : [])].sort());
  assert(identifier.test(packet.runId) && packet.runId.length <= 48);
  if (development) {
    assert.equal(packet.mode, 'development');
    assert.equal(packet.projectId, targets.publicationTarget('development').projectId);
    assert.equal(packet.emulatorHost, null);
  } else {
    assert(/^demo-[a-z0-9-]{1,50}$/.test(packet.projectId), 'Demo project required');
    assert(/^127\.0\.0\.1:\d{2,5}$/.test(packet.emulatorHost));
    const port = Number(packet.emulatorHost.split(':')[1]);
    assert(port > 1023 && port <= 65535);
  }
  if (Object.hasOwn(packet, 'setupMode')) {
    assert(development);
    assert.equal(packet.setupMode, 'preinstalled');
  }
  assert.equal(loopbackOrigin(packet.ingressOrigin), packet.ingressOrigin);
  assert.equal(loopbackOrigin(packet.proofOrigin), packet.proofOrigin);
  assert.notEqual(packet.proofOrigin, packet.ingressOrigin, 'Private binding bridge must be separate from public ingress');
  const oldPair = protocol.parsePublicReleasePair(packet.oldPair);
  const newPair = protocol.parsePublicReleasePair(packet.newPair);
  assert.equal(oldPair.environment, 'development');
  assert.equal(newPair.environment, 'development');
  assert.notEqual(oldPair.pairId, newPair.pairId);
  assert.notEqual(oldPair.publicWorker.service, newPair.publicWorker.service);
  assert.notEqual(oldPair.publicWorker.versionId, newPair.publicWorker.versionId);
  assert.notEqual(oldPair.publisher.application, newPair.publisher.application);
  assert.notEqual(oldPair.publisher.journalNamespace, newPair.publisher.journalNamespace);
  if (development) [oldPair, newPair].forEach(pair => ownership.assertPrivatePairResources(pair));
  assert.deepEqual(Object.keys(packet.previewPairs).sort(), ['new', 'old']);
  for (const pair of Object.values(packet.previewPairs)) {
    assert.deepEqual(Object.keys(pair).sort(), ['pairId', 'rendererSha', 'serializerId']);
    assert(identifier.test(pair.pairId) && identifier.test(pair.serializerId));
    assert(/^[a-f0-9]{40}$/.test(pair.rendererSha));
    if (development) {
      assert(/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(pair.pairId));
      assert.equal(pair.serializerId, pair.pairId);
    }
  }
  assert.notEqual(packet.previewPairs.old.pairId, packet.previewPairs.new.pairId);
  const adapter = resolve(packet.adapter);
  assert([integrationAdapter, fixtureAdapter].includes(adapter), 'Named rehearsal adapter required');
  if (development) assert.equal(adapter, integrationAdapter, 'Development cannot use a fixture adapter');
  let scheduledSource;
  if (Object.hasOwn(packet, 'scheduledSource')) {
    const source = packet.scheduledSource;
    assert.deepEqual(Object.keys(source).sort(), ['collection', 'documentId', 'publishAt', 'version']);
    assert(['cmsPosts', 'cmsPages'].includes(source.collection) && /^[A-Za-z0-9_-]{1,128}$/.test(source.documentId));
    assert(Number.isSafeInteger(source.version) && source.version > 0);
    assert(typeof source.publishAt === 'string' && new Date(source.publishAt).toISOString() === source.publishAt);
    scheduledSource = Object.freeze({ ...source });
  }
  return Object.freeze({ ...packet, adapter, oldPair, newPair, ...(scheduledSource ? { scheduledSource } : {}) });
}

/** Legacy adapters cross a process boundary without the parent credential
 * environment. Opaque installed sessions use their native owner deadlines. */
export async function invokeRehearsalAdapter(request, { timeoutMs = 60_000, developmentCredential, installedSession } = {}) {
  const packet = parseRehearsalPacket(request.packet), development = packet.schemaVersion === 2;
  if (installedSession !== undefined) {
    const { installedRehearsalSession } = await import('./rehearsal-installed-session.mjs');
    return installedRehearsalSession(installedSession, packet).execute(request);
  }
  if (development) {
    try { assertDevelopmentRehearsalEnvironment(); }
    catch { throw new RehearsalRefusal('development-environment-refused'); }
    if (!hasDevelopmentCredentialSource(developmentCredential)) throw new RehearsalRefusal('development-credential-required');
  }
  const replyLimit = request.action === 'audit' ? 4 * 1024 * 1024 : 64 * 1024;
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [...(development ? ['--import', typescriptLoader] : []), adapterHost, packet.adapter], {
      cwd: root, env: { PATH: process.env.PATH, HOME: '/nonexistent', TMPDIR: process.env.TMPDIR ?? '/tmp',
        ...(!development ? { FIRESTORE_EMULATOR_HOST: packet.emulatorHost } : {}), GCLOUD_PROJECT: packet.projectId,
        GOOGLE_CLOUD_PROJECT: packet.projectId }, stdio: ['pipe', 'pipe', 'pipe', ...(development ? ['pipe'] : [])],
    });
    let output = '', exceeded = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', data => {
      output += data;
      if (Buffer.byteLength(output) > replyLimit) { exceeded = true; child.kill('SIGKILL'); }
    });
    // Neither arbitrary child output nor provider/credential errors enter reports.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new RehearsalRefusal('adapter-start-failed')); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (exceeded) return reject(new RehearsalRefusal('adapter-reply-too-large'));
      if (request.action === 'interrupt-qualification' && code === 86 && !signal) return accept({ interrupted: true });
      if (code !== 0 || signal) return reject(new RehearsalRefusal(signal === 'SIGKILL' ? 'adapter-timeout' : 'adapter-exit'));
      try { accept(JSON.parse(output)); } catch { reject(new RehearsalRefusal('adapter-reply-invalid')); }
    });
    child.stdin.on('error', () => {});
    if (development) {
      child.stdio[3].on('error', () => {});
      writeDevelopmentCredential(developmentCredential, child.stdio[3]).catch(() => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new RehearsalRefusal('development-credential-refused'));
      });
    }
    child.stdin.end(JSON.stringify({ ...request, packet }));
  });
}

function readyState(packet, state, side) {
  const selector = protocol.parsePublicReleaseSelector(state.selector);
  const pair = side === 'old' ? packet.oldPair : packet.newPair;
  const recovery = side === 'old' ? packet.newPair : packet.oldPair;
  assert.deepEqual(selector.selectedPair, protocol.publicReleasePairReference(pair));
  assert.deepEqual(selector.recoveryPair, protocol.publicReleasePairReference(recovery));
  for (const pin of [state.primary, state.cloud]) {
    assert.equal(pin.phase, 'ready');
    assert.equal(pin.release, pair.commitSha);
  }
  assert(Number.isSafeInteger(state.providerAttempts) && state.providerAttempts >= 0);
  assert.equal(state.admission, true);
  assert.equal(state.previewReady, true);
  checkPreviewState(packet, state.preview);
}

function checkPreviewState(packet, preview) {
  const selector = preview.selector;
  assert.equal(selector.schemaVersion, 2);
  assert.equal(selector.phase, 'ready');
  assert(Number.isSafeInteger(selector.epoch) && selector.epoch > 0);
  const selected = selector.selectedPairId === packet.previewPairs.old.pairId ? 'old' : 'new';
  const pair = packet.previewPairs[selected], recovery = packet.previewPairs[selected === 'old' ? 'new' : 'old'];
  assert.equal(selector.selectedPairId, pair.pairId);
  assert.equal(selector.recoveryPairId, recovery.pairId);
  assert.equal(selector.rendererSha, pair.rendererSha);
  assert.equal(selector.serializerId, pair.serializerId);
  assert(sha256.test(preview.adminManifestDigest) && sha256.test(preview.adminReceiptDigest));
}

function checkPreviewBoundary(packet, step, before, after) {
  checkPreviewState(packet, before); checkPreviewState(packet, after);
  const expectedBefore = packet.previewPairs[step === 'preview-cancellation' ? 'new' : 'old'];
  assert.equal(before.selector.selectedPairId, expectedBefore.pairId, 'Preview selection mismatch');
  const postSelection = step === 'preview-admin-assets' || step === 'preview-cancellation';
  const expected = packet.previewPairs[postSelection ? 'new' : 'old'];
  assert.equal(after.selector.selectedPairId, expected.pairId, 'Preview selection mismatch');
  const changed = before.selector.selectedPairId !== expected.pairId;
  assert.equal(after.selector.epoch, before.selector.epoch + (changed ? 1 : 0), 'Preview selection mismatch');
  assert.equal(after.adminManifestDigest, before.adminManifestDigest, 'Preview Admin receipt changed');
  assert.equal(after.adminReceiptDigest, before.adminReceiptDigest, 'Preview Admin receipt changed');
}

function replyFor(reply, request) {
  assert.equal(reply.schemaVersion, 1);
  assert.equal(reply.actionId, request.actionId);
  assert(sha256.test(reply.receiptDigest));
  assert(['complete', 'refused'].includes(reply.outcome));
}

async function inspectRehearsal(request, actionId, adapterOptions) {
  const inspection = { ...request, action: 'inspect', actionId };
  const reply = await invokeRehearsalAdapter(inspection, adapterOptions);
  replyFor(reply, inspection);
  assert.equal(reply.outcome, 'complete', 'Fresh authority inspection refused');
  readyState(request.packet, reply.state, request.target);
  return reply;
}

async function checkPreviewRetry(request, result, observed, adapterOptions) {
  const repeated = await invokeRehearsalAdapter(request, adapterOptions);
  assert.deepEqual(repeated, result, 'Preview retry changed state');
  const retry = await inspectRehearsal(request, `${request.actionId}-after-preview-retry`, adapterOptions);
  assert.deepEqual(retry.state, observed.state, 'Preview retry changed state');
}

async function capturePreviewBefore(directory, step, request, adapterOptions) {
  const file = join(directory, `${step}.pending.json`);
  try {
    const pending = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(pending.step, step); assert.equal(pending.actionId, request.actionId);
    checkPreviewState(request.packet, pending.previewBefore);
    assert.equal(pending.previewBefore.selector.selectedPairId,
      request.packet.previewPairs[step === 'preview-cancellation' ? 'new' : 'old'].pairId, 'Preview selection mismatch');
    return pending.previewBefore;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const before = await inspectRehearsal(request, `${request.actionId}-before-preview`, adapterOptions);
  assert.equal(before.state.preview.selector.selectedPairId,
    request.packet.previewPairs[step === 'preview-cancellation' ? 'new' : 'old'].pairId, 'Preview selection mismatch');
  const pending = { step, actionId: request.actionId, previewBefore: before.state.preview };
  await writeFile(file, JSON.stringify(pending, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return pending.previewBefore;
}

function checkProofIdentity(packet, proof, state, operation) {
  const pair = proof.selected === 'old' ? packet.oldPair : packet.newPair;
  const expected = {
    'x-njpbs-publication-origin': targets.publicationTarget(pair.environment).workerName,
    'x-njpbs-selector-sha256': protocol.publicReleaseDigest(state.selector),
    'x-njpbs-release-epoch': String(state.selector.epoch),
    'x-njpbs-release-pair': pair.pairId,
    'x-njpbs-content-head-sha256': state.selector.contentHead.manifestDigest,
    'x-njpbs-publication-operation': operation.operationId,
    'x-njpbs-source-version': String(operation.sourceVersion),
    'x-njpbs-snapshot-sha256': operation.snapshotDigest,
    'x-njpbs-renderer-sha': pair.commitSha,
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(proof.headers[name], value, `Public proof identity mismatch: ${name}`);
}

async function checkPublicBytes(packet, proof, state, operation, httpCredential) {
  assert(proof && proof.path.startsWith('/') && !proof.path.startsWith('//'));
  const url = new URL(proof.path, packet.proofOrigin);
  assert.equal(url.origin, packet.proofOrigin);
  assert(!url.search && !url.hash && !url.username && !url.password);
  assert(sha256.test(proof.bodyDigest));
  assert([200, 410].includes(proof.status));
  assert.equal(proof.headers['x-njpbs-html-sha256'], proof.bodyDigest, 'Exact-byte proof required');
  if (proof.status === 410) assert.equal(proof.bodyDigest, digest(''), 'Withdrawal body must be empty');
  checkProofIdentity(packet, proof, state, operation);
  // This local bridge invokes ingress.prove(Request(canonicalURL), digest).
  // It never forwards a viewer header as proof authorization. Normal ingress
  // responses intentionally strip the proof headers checked below.
  const response = await fetch(url, { redirect: 'manual', cache: 'no-store',
    headers: { 'x-rehearsal-expected-sha256': proof.bodyDigest,
      'x-rehearsal-expected-status': String(proof.status),
      ...(httpCredential ? rehearsalHttpHeaders(httpCredential, url.origin) : {}) }, signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, proof.status);
  assert.notEqual(response.headers.get('publication-refresh'), 'pending', 'Fallback cannot certify publication');
  assert.notEqual(response.headers.get('x-njpbs-publication-refresh'), 'pending', 'Fallback cannot certify publication');
  for (const [name, value] of Object.entries(proof.headers)) assert.equal(response.headers.get(name), value);
  const reader = response.body.getReader();
  const body = createHash('sha256');
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= 16 * 1024 * 1024, 'Public proof body too large');
      body.update(value);
    }
  } finally { await reader.cancel(); }
  assert.equal(body.digest('hex'), proof.bodyDigest, 'Public byte mismatch');
}

async function checkOrdinaryIngress(packet, proof, httpCredential) {
  const url = new URL(proof.path, packet.ingressOrigin);
  assert.equal(url.origin, packet.ingressOrigin);
  const headers = Object.fromEntries(Object.keys(proof.headers).map(name => [name, 'forged-viewer-value']));
  headers['x-rehearsal-expected-sha256'] = '0'.repeat(64);
  headers['x-rehearsal-expected-status'] = '418';
  if (httpCredential) Object.assign(headers, rehearsalHttpHeaders(httpCredential, url.origin));
  const response = await fetch(url, { headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(3_000) });
  try {
    assert.equal(response.status, proof.status);
    for (const [name] of response.headers) {
      assert(!name.startsWith('x-njpbs-') && !name.startsWith('x-rehearsal-'), 'Ordinary ingress leaked proof');
    }
  } finally { await response.body?.cancel(); }
}

export const PUBLICATION_STEPS = Object.freeze(['baseline', 'scheduled', 'during-preparation', 'while-corrupt', 'hold-old', 'after-switch',
  'retry-new', 'withdraw', 'hold-new', 'after-return']);
/** Select the native source-owner ID before acceptance. Recovery must address
 * that same admission, never map or rename an already accepted operation. */
export function rehearsalOperationId(packet, step) {
  assert(identifier.test(packet.runId) && packet.runId.length <= 48);
  assert(rehearsalSteps().some(([name]) => name === step));
  const original = ({ 'settle-old': 'hold-old', 'settle-new': 'hold-new', 'withdraw-after-return': 'withdraw' })[step] ?? step;
  if (original === 'scheduled' && packet.scheduledSource) return schedules.scheduledPairPublicationOperation({
    collection: packet.scheduledSource.collection, id: packet.scheduledSource.documentId,
    version: packet.scheduledSource.version, publishAt: packet.scheduledSource.publishAt });
  return digest(JSON.stringify({ kind: 'public-release-rehearsal-operation', projectId: packet.projectId,
    runId: packet.runId, step: original })).slice(0, 20);
}

function checkOperation(operation, expectedId, side, terminal) {
  assert(operation && operation.operationId === expectedId);
  assert.equal(operation.originalPair, side);
  assert(sha256.test(operation.snapshotDigest) && sha256.test(operation.claimDigest));
  assert(Number.isSafeInteger(operation.sourceVersion) && operation.sourceVersion > 0);
  assert.equal(operation.acceptedCount, 1);
  assert.equal(operation.terminalCount, terminal ? 1 : 0);
  if (terminal) assert(sha256.test(operation.terminalReceiptDigest));
  else assert.equal(operation.terminalReceiptDigest, null);
}

function checkAudit(packet, audit, operations) {
  assert(audit && audit.controlsContinuous && audit.qualificationResumed && audit.returnUsedCurrentContent);
  assert.equal(audit.accepted, PUBLICATION_STEPS.length);
  assert.equal(audit.terminal, audit.accepted);
  assert.equal(audit.duplicateOperations, 0);
  assert.equal(audit.orphanedOperations, 0);
  assert.deepEqual([...audit.previewFailuresCovered].sort(), [...PREVIEW_BOUNDARIES].sort());
  assert(audit.controlStates.length >= 3, 'Continuous control evidence missing');
  for (const state of audit.controlStates) {
    const side = state.selector.selectedPair.pairId === packet.oldPair.pairId ? 'old' : 'new';
    readyState(packet, state, side);
  }
  assert.deepEqual(audit.operations.map(op => op.operationId).sort(), PUBLICATION_STEPS.map(step => rehearsalOperationId(packet, step)).sort());
  for (const operation of audit.operations) {
    const original = operations.get(operation.operationId);
    assert(original, 'Audit operation was not observed');
    checkOperation(operation, original.operationId, original.originalPair, true);
    for (const key of ['snapshotDigest', 'claimDigest', 'sourceVersion']) assert.equal(operation[key], original[key], 'Original ownership changed');
  }
}

export function rehearsalSteps() {
  const steps = [
    ['baseline', 'publish-and-prove', 'old'],
    // A real global cron may accept the already scheduled source first. Keep
    // OLD selected until its original native operation has been observed;
    // preparation must not depend on winning a race against that cron.
    ['scheduled', 'scheduled-acceptance-and-prove', 'old'],
    ['prepare', 'prepare-both-pairs', 'old'],
    ['during-preparation', 'publish-and-prove', 'old'],
    ['interrupt', 'interrupt-qualification', 'old'],
    ['resume', 'resume-qualification', 'old'],
    ['corrupt', 'inject-candidate-byte-failure', 'old'],
    ['refuse-corrupt', 'qualify-corrupt-candidate', 'old'],
    ['while-corrupt', 'publish-and-prove', 'old'],
    ['repair', 'restore-candidate-bytes', 'old'],
    ['qualify-new', 'qualify-new', 'old'],
    ['hold-old', 'accept-held-old-operation', 'old'],
    ['switch-new', 'switch-new', 'new'],
    ['settle-old', 'settle-original-old-through-new', 'new'],
    ['after-switch', 'publish-and-prove', 'new'],
    ['retry-new', 'retry-lost-acceptance-response', 'new'],
    ['withdraw', 'withdraw-and-prove-both-pairs', 'new'],
    ['catch-up-old', 'catch-up-and-qualify-old', 'new'],
    ['hold-new', 'accept-held-new-operation', 'new'],
    ['return-old', 'return-old-current-content', 'old'],
    ['withdraw-after-return', 'prove-withdrawal-after-return', 'old'],
    ['settle-new', 'settle-original-new-through-old', 'old'],
    ['after-return', 'publish-and-prove', 'old'],
  ];
  for (const boundary of PREVIEW_BOUNDARIES) steps.push([`preview-${boundary}`, `preview-failure-${boundary}`, 'old']);
  steps.push(['audit', 'audit', 'old']);
  return steps;
}

function checkStepReceipts({ packet, step, request, result, observed, operations, interruptedQualification }) {
  if (step === 'interrupt') {
    interruptedQualification = observed.qualification;
    assert.equal(interruptedQualification?.attemptId, `${packet.runId}-qualification-new`);
    assert.equal(interruptedQualification.status, 'interrupted');
    assert(sha256.test(interruptedQualification.checkpointDigest));
  }
  if (step === 'resume') assert.deepEqual(result.qualification, { ...interruptedQualification, status: 'complete' });
  if (PUBLICATION_STEPS.includes(step)) {
    checkOperation(result.operation, request.operationId, request.target, !step.startsWith('hold-'));
    operations.set(request.operationId, result.operation);
  }
  if (step === 'settle-old' || step === 'settle-new') {
    const original = operations.get(request.operationId);
    checkOperation(result.operation, request.operationId, original.originalPair, true);
    for (const key of ['snapshotDigest', 'claimDigest', 'sourceVersion']) assert.equal(result.operation[key], original[key], 'In-flight claim transferred');
  }
  if (step === 'withdraw') assert.equal(result.proof?.status, 410, 'Withdrawal did not remove public content');
  if (step === 'withdraw-after-return') assert.equal(result.proof?.status, 410, 'Return resurrected withdrawn content');
  if (step === 'audit') checkAudit(packet, result.audit, operations);
  return interruptedQualification;
}

/**
 * Re-runs reuse the packet, action ids and durable adapter receipts. A completed
 * local receipt skips completed scenarios. A final fresh authority read is
 * mandatory even when every scenario already has a receipt.
 */
export async function runRehearsal(rawPacket, outputDirectory, adapterOptions = {}) {
  const packet = parseRehearsalPacket(rawPacket);
  const sourceCommitSha = rehearsalSourceCommit();
  const runtime = adapterOptions.installedSession === undefined ? null :
    (await import('./rehearsal-installed-session.mjs')).installedRehearsalSession(adapterOptions.installedSession, packet);
  if (packet.schemaVersion === 2) {
    try { assertDevelopmentRehearsalEnvironment(); }
    catch { throw new RehearsalRefusal('development-environment-refused'); }
    if (missingBindings.length && !runtime) throw new RehearsalRefusal('development-bindings-unavailable');
    if (!hasDevelopmentCredentialSource(adapterOptions.developmentCredential)) throw new RehearsalRefusal('development-credential-required');
    if (!hasRehearsalHttpCredential(adapterOptions.httpCredential, [packet.ingressOrigin, packet.proofOrigin])) {
      throw new RehearsalRefusal('development-http-credential-required');
    }
  }
  const directory = resolve(outputDirectory);
  assert(!directory.startsWith(`${root}/`) && directory !== root, 'Evidence belongs outside the checkout');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binding = { packet, sourceCommitSha, adapterDigest: digest(await readFile(packet.adapter)) };
  const lock = join(directory, 'running');
  await mkdir(lock);
  let currentStep = 'setup', currentActionId = null;
  let bindingVerified = false;
  let proofContext;
  const verifiedHistory = new Map();
  try {
    const packetFile = join(directory, 'packet.json');
    const packetBytes = JSON.stringify(binding, null, 2) + '\n';
    try { assert.equal(await readFile(packetFile, 'utf8'), packetBytes, 'Bound packet bytes changed'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(packetFile, packetBytes, { flag: 'wx', mode: 0o600 });
    }
    bindingVerified = true;
    if (runtime) {
      // Only restore original SDK receipts recorded after independent harness
      // verification. Their historical observations retain their exact bytes.
      // An unverified effect resumes its native original owner instead.
      for (const { receipt, bytes } of await runtime.recoverVerifiedReceipts()) {
        verifiedHistory.set(receipt.step, bytes);
        const filename = join(directory, `${receipt.step}.json`);
        try { assert.equal(await readFile(filename, 'utf8'), bytes, 'Original SDK journal differs from local receipt'); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        }
      }
    }
    await writeFile(join(directory, 'status.json'), JSON.stringify({ status: 'running', packetDigest: digest(packetBytes) }) + '\n', { mode: 0o600 });
    let previous, switches = 0;
    const receipts = [], operations = new Map();
    let interruptedQualification;
    for (const [step, action, side] of rehearsalSteps()) {
      const actionId = `${packet.runId}-${step}`;
      currentStep = step; currentActionId = actionId;
      if (rehearsalSourceCommit() !== sourceCommitSha) throw new RehearsalRefusal('source-changed');
      const request = { packet, actionId, action, target: side,
        operationId: rehearsalOperationId(packet, step), resume: true };
      const file = join(directory, `${step}.json`);
      let prior;
      try { prior = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (prior) {
        if (runtime && verifiedHistory.get(step) !== await readFile(file, 'utf8')) {
          throw new RehearsalRefusal('unverified-local-receipt');
        }
        assert.equal(prior.step, step);
        assert.equal(prior.actionId, actionId);
      }
      const isPreview = step.startsWith('preview-');
      let previewBefore = prior?.previewBefore;
      if (isPreview && !prior) previewBefore = await capturePreviewBefore(directory, step, request, adapterOptions);
      const result = prior ? prior.result : await invokeRehearsalAdapter(request, adapterOptions);
      if (result?.outcome === 'stopped') throw readInstalledRehearsalStop(result, request);
      if (action === 'interrupt-qualification') assert.deepEqual(result, { interrupted: true }, 'Qualifier host did not exit');
      else {
        replyFor(result, request);
        assert.equal(result.outcome, step === 'refuse-corrupt' ? 'refused' : 'complete');
        if (step === 'refuse-corrupt') assert.equal(result.reason, 'byte-mismatch');
      }
      const observed = prior ? prior.observed : await inspectRehearsal(request, `${actionId}-inspect`, adapterOptions);
      replyFor(observed, { ...request, actionId: `${actionId}-inspect` });
      assert.equal(observed.outcome, 'complete');
      readyState(packet, observed.state, side);
      if (isPreview) checkPreviewBoundary(packet, step, previewBefore, observed.state.preview);
      if (isPreview && !prior) await checkPreviewRetry(request, result, observed, adapterOptions);
      if (previous) {
        const isSwitch = step === 'switch-new' || step === 'return-old';
        assert.equal(observed.state.selector.epoch, previous.selector.epoch + (isSwitch ? 1 : 0), 'Unexpected selector epoch');
        assert(observed.state.selector.contentHead.contextSequence >= previous.selector.contentHead.contextSequence, 'Content rewound');
        assertRehearsalProviderTransition(packet, step, previous.providerAttempts, observed.state.providerAttempts);
        if (isSwitch) switches++;
      }
      interruptedQualification = checkStepReceipts({ packet, step, request, result, observed, operations, interruptedQualification });
      let originalProof;
      if (result.proof && !prior) {
        assert.equal(result.proof.selected, side);
        assert.equal(result.proof.epoch, observed.state.selector.epoch);
        assert.equal(result.proof.contentSequence, observed.state.selector.contentHead.contextSequence);
        const operation = step === 'withdraw-after-return' ? operations.get(request.operationId) : result.operation;
        if (step === 'withdraw-after-return') {
          const withdrawn = receipts.find(item => item.step === 'withdraw');
          assert.equal(result.proof.path, withdrawn.proofPath, 'Return withdrawal proof changed path');
        }
        if (packet.adapter === integrationAdapter) {
          proofContext ??= runtime ? { firestore: runtime.firestore } : packet.schemaVersion === 2 ? await openDevelopmentSourceContext(adapterOptions.developmentCredential)
            : openDemoRehearsalContext(packet);
          originalProof = await verifyOriginalRehearsalProof({ firestore: proofContext.firestore, packet,
            operation, proof: result.proof, selector: observed.state.selector, httpCredential: adapterOptions.httpCredential });
        }
        await checkPublicBytes(packet, result.proof, observed.state, operation, adapterOptions.httpCredential);
        await checkOrdinaryIngress(packet, result.proof, adapterOptions.httpCredential);
        const after = await inspectRehearsal(request, `${actionId}-after-get`, adapterOptions);
        assert.deepEqual(after.state, observed.state, 'Authority changed during exact-byte GET; revalidate');
      }
      if (['baseline', 'during-preparation', 'while-corrupt', 'settle-old', 'after-switch', 'retry-new', 'withdraw', 'withdraw-after-return', 'scheduled', 'settle-new', 'after-return'].includes(step)) assert(result.proof, 'Missing public proof');
      const receipt = { step, actionId, result, observed, ...(isPreview ? { previewBefore } : {}),
        ...(originalProof ? { originalProof } : {}) };
      if (!prior) {
        await runtime?.record(receipt);
        await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      }
      receipts.push({ step, digest: digest(await readFile(file)), receiptDigest: result.receiptDigest ?? null,
        ...(step === 'withdraw' ? { proofPath: result.proof.path } : {}) });
      previous = observed.state;
    }
    assert.equal(switches, 2);
    const finalRequest = { packet, actionId: `${packet.runId}-final-inspect`, action: 'inspect', target: 'old',
      operationId: rehearsalOperationId(packet, 'audit'), resume: true };
    currentStep = 'final-inspect'; currentActionId = finalRequest.actionId;
    const final = await inspectRehearsal(finalRequest, finalRequest.actionId, adapterOptions);
    if (rehearsalSourceCommit() !== sourceCommitSha) throw new RehearsalRefusal('source-changed');
    assert.deepEqual(final.state, previous, 'Final authority changed; inspect before resuming');
    const fixture = packet.adapter === fixtureAdapter;
    const report = { schemaVersion: 1, kind: fixture ? 'harness-contract-fixture' : 'isolated-rehearsal', runId: packet.runId,
      projectId: packet.projectId, sourceCommitSha, adapter: packet.adapter, adapterDigest: binding.adapterDigest, packetDigest: digest(packetBytes),
      verdict: 'scenario-checks-passed', productionAdoption: false, measurementsAccepted: false, receipts };
    const reportBytes = JSON.stringify(report, null, 2) + '\n';
    await writeFile(join(directory, 'report.json'), reportBytes, { mode: 0o600 });
    await writeFile(join(directory, 'status.json'), JSON.stringify({ status: 'complete', reportDigest: digest(reportBytes) }) + '\n', { mode: 0o600 });
    return report;
  } catch (error) {
    if (error instanceof InstalledRehearsalStop) {
      if (bindingVerified) await writeFile(join(directory, 'status.json'), JSON.stringify({ status: 'stopped',
        failure: { code: error.code, issue: error.issue, blockedStep: error.blockedStep,
          step: currentStep, actionId: currentActionId } }) + '\n', { mode: 0o600 });
      throw error;
    }
    const failure = new RehearsalRefusal(refusalCode(error), currentStep, currentActionId);
    if (bindingVerified) await writeFile(join(directory, 'status.json'), JSON.stringify({ status: 'refused',
      failure: { code: failure.code, step: failure.step, actionId: failure.actionId } }) + '\n', { mode: 0o600 });
    throw failure;
  } finally {
    try { await proofContext?.close?.(); }
    finally { await rm(lock, { recursive: true }); }
  }
}
