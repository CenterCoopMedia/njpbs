import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import admission from '../../functions/lib/public-release-admission.js';
import terminal from '../../functions/lib/public-release-terminal.js';
import { parseRehearsalPacket } from './public-release-rehearsal.mjs';
import { assertDevelopmentRehearsalEnvironment, assertDemoRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
const require = createRequire(import.meta.url);
// Load the existing CommonJS TypeScript graph through its pinned site loader.
// Native ESM traversal loses re-exports from its extensionless CJS modules.
const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const owner = path => typedRequire(path, import.meta.url);
const { qualifyPublicReleasePair } = owner('../../site/scripts/public-release-pair-qualification.ts');
const { prepareGuardedPublicReleaseSwitch, applyPreparedGuardedPublicReleaseSwitch,
  readGuardedPublicReleaseSwitchAttempt, readGuardedPublicReleaseSwitchReceipt } = owner('../../site/scripts/public-release-switch-operator.ts');
const { recoverOriginalPublicReleaseWork } = owner('../../site/scripts/public-release-original-work-recovery.ts');
const { activateStagedPublicReleasePairPublication } = owner('../../site/scripts/public-release-pair-content-activation.ts');
const { preparePublicReleasePublicationTerminal, settlePreparedPublicReleasePublication } = owner('../../site/scripts/public-release-publication-terminal.ts');
const family = require('../../functions/lib/public-release-family-admission.js');
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Rehearsal public owner binding refused'); };
const bindings = new WeakMap();
export function assertRehearsalPublicOwners(handle, firestore, packet) {
  const binding = bindings.get(handle);
  if (binding?.firestore !== firestore || binding.packetDigest !== protocol.publicReleaseDigest(packet)) refuse();
}

/** The launcher supplies actual SDK/R2/HTTP boundaries. No qualification,
 * switch, activation or terminal success can be supplied by its packet. */
export function createRehearsalPublicOwners({ packet: raw, firestore, store, credentials, credentialsForPair, ingress, fieldValues,
  capture = {}, currentCodeRequest = undefined, scheduleNow = undefined, signal = undefined, authorized = false }) {
  if (authorized !== true) refuse();
  const packet = parseRehearsalPacket(raw);
  if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
  else assertDevelopmentRehearsalEnvironment();
  if (firestore.projectId !== packet.projectId || typeof credentials !== 'function' ||
      typeof ingress?.prove !== 'function' || typeof fieldValues?.serverTimestamp !== 'function' ||
      credentialsForPair !== undefined && typeof credentialsForPair !== 'function' ||
      currentCodeRequest !== undefined && typeof currentCodeRequest !== 'function' ||
      scheduleNow !== undefined && typeof scheduleNow !== 'function') refuse();
  const pair = side => { if (!['old', 'new'].includes(side)) refuse(); return packet[`${side}Pair`]; };
  for (const side of ['old', 'new']) {
    work.assertPrivatePairResources(pair(side));
    work.assertPublicReleasePairDatabase(firestore, pair(side));
  }
  const operation = id => { if (!/^[A-Za-z0-9]{20}$/.test(id)) refuse(); signal?.throwIfAborted(); return id; };

  const qualify = async (side, operationId, witnessDigest = undefined, attemptId = undefined) => {
    operation(operationId);
    const selected = pair(side);
    witnessDigest ??= (await replay.sealPublicReleasePairReplayWitness({ firestore, pair: selected })).witnessDigest;
    const qualificationId = `rehearsal-${protocol.publicReleaseDigest({ operationId, pair: selected, witnessDigest,
      ...(attemptId ? { attemptId } : {}) }).slice(0, 32)}`;
    return qualifyPublicReleasePair({ firestore, store, pair: selected, qualificationId, witnessDigest,
      credentials: credentialsForPair ? () => credentialsForPair(selected) : credentials, signal });
  };
  const switchTo = async (target, operationId) => {
    operation(operationId);
    const before = pair(target === 'new' ? 'old' : 'new'), after = pair(target);
    const original = await readGuardedPublicReleaseSwitchReceipt({ firestore, operationId });
    if (original) {
      const attempt = await readGuardedPublicReleaseSwitchAttempt({ firestore, operationId });
      if (!same(attempt.oldPair, before) || !same(attempt.newPair, after)) refuse();
      return original;
    }
    // A held acceptance can advance the head after the earlier candidate
    // check. Qualify both exact current heads immediately before the switch.
    // A failed pre-reservation qualification cannot refresh its immutable
    // receipt. A new attempt keeps the original switch/publication IDs.
    const attemptId = randomUUID();
    const old = await qualify(target === 'new' ? 'old' : 'new', operationId, undefined, attemptId);
    const next = await qualify(target, operationId, undefined, attemptId);
    const proof = await prepareGuardedPublicReleaseSwitch({ firestore, store, oldPair: before, newPair: after, operationId,
      oldQualificationId: old.receipt.qualificationId, newQualificationId: next.receipt.qualificationId, signal });
    return (await applyPreparedGuardedPublicReleaseSwitch({ firestore, proof })).receipt;
  };
  const acceptPost = async ({ operationId, documentId, nextDocument, beforeDocumentDigest }) => {
    operation(operationId);
    if (beforeDocumentDigest !== undefined && !protocol.digest(beforeDocumentDigest)) refuse();
    return firestore.runTransaction(async transaction => {
      // Preserve the native original-admission-first retry rule. A later
      // private edit cannot be overwritten by retrying the accepted source.
      if (beforeDocumentDigest !== undefined && !(await transaction.get(firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`))).exists) {
        const before = await transaction.get(firestore.doc(`cmsPosts/${documentId}`));
        if (!before.exists || protocol.publicReleaseDigest(before.data()) !== beforeDocumentDigest ||
            nextDocument.version !== before.data().version + 1) refuse();
      }
      const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: 'cmsPosts', documentId,
        nextDocument, queueRef: firestore.doc(`cmsPublishQueue/${operationId}`), actor: { uid: 'system:isolated-rehearsal' }, kind: 'post', family: 'posts' });
      prepared.write();
      if (!prepared.idempotent) transaction.set(firestore.doc(`cmsPosts/${documentId}`), nextDocument);
      return prepared.admission;
    });
  };
  const acceptScheduled = async ({ operationId, target }) => {
    operation(operationId);
    const source = packet.scheduledSource;
    if (!source || operationId !== require('../../functions/lib/public-release-scheduled-operation.js')
      .scheduledPairPublicationOperation({ collection: source.collection, id: source.documentId, version: source.version, publishAt: source.publishAt })) refuse();
    const scoped = require('../../functions/lib/public-release-rehearsal-schedule.js');
    const sourceBinding = scoped.createRehearsalScheduledSourceBinding({ firestore, configuration: scoped.CONFIGURATION,
      runId: packet.runId, pair: pair(target), source: { collection: source.collection, id: source.documentId,
        version: source.version, publishAt: source.publishAt }, authorized: true });
    const scheduler = require('../../functions/scheduled-publish.js');
    const readAccepted = () => firestore.runTransaction(async transaction => {
      const [row, queue] = await transaction.getAll(firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`),
        firestore.doc(`cmsPublishQueue/${operationId}`));
      if (!row.exists) { if (queue.exists) refuse(); return null; }
      const accepted = admission.parseAdmission(row.data());
      admission.assertQueue(queue.data(), accepted);
      if (accepted.operationId !== operationId || accepted.source.id !== source.documentId || accepted.source.sourceVersion !== source.version + 1 ||
          !same(accepted.pair, protocol.publicReleasePairReference(pair(target))) || accepted.pairDigest !== protocol.publicReleaseDigest(pair(target)) ||
          queue.data().triggeredBy !== scheduler.SCHEDULER_ACTOR) refuse();
      return accepted;
    }, { readOnly: true });
    const original = await readAccepted();
    if (original) return original;
    const unavailable = async () => refuse();
    // Stdout belongs to the adapter protocol. The result and actual atomic
    // admission are reconciled below; a logged message can never prove success.
    const result = await scheduler.createScheduledPublishRunner({ firestore, sourceBinding, currentCodeRequest: currentCodeRequest ?? unavailable,
      ...(scheduleNow ? { now: scheduleNow } : {}),
      assertPublishReadyFn: unavailable, assertPublishedMediaSafeFn: unavailable, enqueuePublishFn: unavailable,
      log: { info() {}, warn() {}, error() {} } })();
    if (result.publications?.some(value => value.queueId !== operationId || value.transport !== admission.TRANSPORT)) refuse();
    const accepted = await readAccepted();
    if (!accepted) refuse();
    return accepted;
  };
  const original = async operationId => {
    operation(operationId);
    const accepted = admission.parseAdmission((await firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).data());
    const side = ['old', 'new'].find(name => same(accepted.pair, protocol.publicReleasePairReference(pair(name))) &&
      accepted.pairDigest === protocol.publicReleaseDigest(pair(name)));
    if (!side || accepted.operationId !== operationId) refuse();
    return { accepted, side };
  };
  const recover = async operationId => {
    const { side } = await original(operationId);
    const unavailable = async () => refuse();
    return recoverOriginalPublicReleaseWork({ firestore, store, pair: pair(side), operationId,
      capture: capture[side] ?? { resourceRequest: unavailable, providerStore: { get: unavailable, put: unavailable } }, signal });
  };
  const finish = async operationId => {
    const { accepted, side } = await original(operationId);
    const prior = await firestore.runTransaction(async transaction => {
      if (!(await transaction.get(firestore.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`))).exists) return null;
      return terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction, operationId,
        admissionDigest: protocol.publicReleaseDigest(accepted) });
    }, { readOnly: true });
    if (prior) return { idempotent: true, receipt: prior };
    const queue = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data();
    admission.assertQueue(queue, accepted);
    if (!queue.execution) refuse();
    const execution = terminal.parseCompletedPairPublicationExecution(queue.execution);
    const selector = protocol.parseStoredPublicReleaseSelector((await firestore.doc('system/publicDeployment').get()).data());
    if (same(selector.selectedPair, accepted.pair)) await activateStagedPublicReleasePairPublication({ firestore, store, pair: pair(side),
      identity: execution.identity, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest, signal });
    // Cross-pair settlement uses the existing complete inclusion proof. The
    // original admission and completed claim are never transferred or renamed.
    const proof = await preparePublicReleasePublicationTerminal({ firestore, store, ingress, fieldValues, operationId, signal });
    return settlePreparedPublicReleasePublication({ firestore, proof });
  };
  const handle = Object.freeze({ acceptPost, acceptScheduled, qualify, switchTo, recover, finish });
  bindings.set(handle, { firestore, packetDigest: protocol.publicReleaseDigest(packet) });
  return handle;
}
