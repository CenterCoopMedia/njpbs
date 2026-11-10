import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import inputs from '../../functions/lib/public-release-pair-input.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import { parseRehearsalPacket, rehearsalOperationId, rehearsalSourceCommit } from './public-release-rehearsal.mjs';
import { assertDemoRehearsalEnvironment, assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';

const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const { openStagedPublicReleasePairCodePack } = typedRequire('../../site/scripts/public-release-pair-code-pack-executor.ts', import.meta.url);
const { publicReleasePairCodePackBaselinePath } = typedRequire('../../site/scripts/public-release-pair-code-pack-storage.ts', import.meta.url);
const { qualifyPublicReleasePair } = typedRequire('../../site/scripts/public-release-pair-qualification.ts', import.meta.url);
const { qualificationReceiptPath } = typedRequire('../../site/scripts/public-release-pair-qualification-receipt.ts', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Rehearsal candidate byte fault refused'); };
function original(row) { if (!row.exists || !row.createTime.isEqual(row.updateTime)) refuse(); return row.data(); }
async function bytes(object) {
  if (!object || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > 16 * 1024 * 1024) refuse();
  const parts = []; let size = 0;
  try {
    for await (const chunk of object.body) { size += chunk.length; if (size > object.size) refuse(); parts.push(Buffer.from(chunk)); }
    if (size !== object.size) refuse(); return Buffer.concat(parts, size);
  } finally { if (object.body && !object.body.locked) await object.body.cancel().catch(() => {}); }
}

/** Independent completed-history consumer. It reads original native-bound
 * fault records, not a local report or a callback's negative result. */
export async function readRehearsalCandidateFaultHistory({ firestore, packet: raw, sourceSha, authorized = false }) {
  if (authorized !== true) refuse();
  const packet = parseRehearsalPacket(raw), pair = packet.newPair;
  if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet); else assertDevelopmentRehearsalEnvironment();
  if (firestore?.projectId !== packet.projectId || rehearsalSourceCommit() !== sourceSha) refuse();
  const base = `publicReleaseRehearsalRuns/${packet.runId}/faults/candidate`;
  return firestore.runTransaction(async transaction => {
    const rows = await transaction.getAll(...[base, `${base}/receipts/armed`, `${base}/receipts/refused`, `${base}/receipts/restored`]
      .map(path => firestore.doc(path)));
    const [intent, armed, refused, restored] = rows.map(original), intentDigest = protocol.publicReleaseDigest(intent);
    protocol.exact(intent, ['schemaVersion', 'sourceSha', 'packetDigest', 'pairDigest', 'objectKey', 'bodyDigest', 'bytes', 'metadataDigest']);
    if (intent.schemaVersion !== 1 || intent.sourceSha !== sourceSha || intent.packetDigest !== protocol.publicReleaseDigest(packet) ||
        intent.pairDigest !== protocol.publicReleaseDigest(pair) || ![intent.bodyDigest, intent.metadataDigest].every(protocol.digest) ||
        intent.objectKey !== inputs.publicReleasePairInputObjectKey(pair, intent.bodyDigest) ||
        !Number.isSafeInteger(intent.bytes) || intent.bytes < 1 || intent.bytes > 16 * 1024 * 1024) refuse();
    if (!same(armed, { schemaVersion: 1, intentDigest, actionId: `${packet.runId}-corrupt` }) ||
        !same(restored, { schemaVersion: 1, intentDigest, actionId: `${packet.runId}-repair` })) refuse();
    protocol.exact(refused, ['schemaVersion', 'intentDigest', 'qualificationId', 'witnessDigest', 'dispatched', 'nativeRefusal', 'reason']);
    const qualificationId = `rehearsal-${protocol.publicReleaseDigest({ operationId: rehearsalOperationId(packet, 'refuse-corrupt'),
      pair, witnessDigest: refused.witnessDigest }).slice(0, 32)}`;
    if (!protocol.digest(refused.witnessDigest) || !same(refused, { schemaVersion: 1, intentDigest, qualificationId,
      witnessDigest: refused.witnessDigest, dispatched: true, nativeRefusal: 'input-unavailable', reason: 'byte-mismatch' }) ||
        (await transaction.get(firestore.doc(qualificationReceiptPath(pair, qualificationId)))).exists) refuse();
    return Object.freeze({ receiptDigest: protocol.publicReleaseDigest({ intent, armed, refused, restored }) });
  }, { readOnly: true });
}

/** A named fault at the real R2 read boundary, limited to the exact original
 * NEW CODE manifest. Actual stored bytes, keys, metadata and provider state
 * remain unchanged. Only a native qualifier refusal after dispatch can issue
 * the fault witness; no callback supplies successful qualification evidence.
 */
export function createRehearsalCandidateFault({ firestore, packet: raw, store: underlying, credentials,
  sourceSha, authorized = false, signal }) {
  const packet = parseRehearsalPacket(raw), pair = packet.newPair;
  if (authorized !== true || firestore?.projectId !== packet.projectId || typeof underlying?.get !== 'function' ||
      typeof underlying?.put !== 'function' || typeof credentials !== 'function' || rehearsalSourceCommit() !== sourceSha) refuse();
  const current = (source = true) => {
    signal?.throwIfAborted();
    if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet); else assertDevelopmentRehearsalEnvironment();
    if (source && rehearsalSourceCommit() !== sourceSha) refuse();
  };
  const ref = firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/faults/candidate`);
  const armedRef = firestore.doc(`${ref.path}/receipts/armed`), restoredRef = firestore.doc(`${ref.path}/receipts/restored`);
  const refusedRef = firestore.doc(`${ref.path}/receipts/refused`);
  let intent = null, active = false, dispatched = 0;
  const state = async () => {
    const [row, armed, restored] = await firestore.getAll(ref, armedRef, restoredRef);
    if (!row.exists) { if (armed.exists || restored.exists) refuse(); return null; }
    const value = original(row);
    protocol.exact(value, ['schemaVersion', 'sourceSha', 'packetDigest', 'pairDigest', 'objectKey', 'bodyDigest', 'bytes', 'metadataDigest']);
    if (value.schemaVersion !== 1 || value.sourceSha !== sourceSha || value.packetDigest !== protocol.publicReleaseDigest(packet) ||
        value.pairDigest !== protocol.publicReleaseDigest(pair) || ![value.bodyDigest, value.metadataDigest].every(protocol.digest) ||
        value.objectKey !== inputs.publicReleasePairInputObjectKey(pair, value.bodyDigest) ||
        !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 16 * 1024 * 1024) refuse();
    const digest = protocol.publicReleaseDigest(value);
    for (const [record, action] of [[armed, 'corrupt'], [restored, 'repair']]) {
      if (record.exists && !same(original(record), { schemaVersion: 1, intentDigest: digest, actionId: `${packet.runId}-${action}` })) refuse();
    }
    if (restored.exists && !armed.exists) refuse();
    intent = value; active = armed.exists && !restored.exists;
    return { intentDigest: digest, state: restored.exists ? 'restored' : armed.exists ? 'armed' : 'prepared' };
  };
  const expectedObject = async () => {
    const object = await underlying.get(intent.objectKey), value = await bytes(object);
    if (value.length !== intent.bytes || hash(value) !== intent.bodyDigest ||
        protocol.publicReleaseDigest(object.customMetadata ?? {}) !== intent.metadataDigest) refuse();
    return { object, value };
  };
  const store = Object.freeze({
    async get(key) {
      current(false);
      if (!active || key !== intent?.objectKey) return underlying.get(key);
      const { object, value } = await expectedObject();
      value[0] ^= 1; dispatched++;
      return { size: value.length, customMetadata: object.customMetadata, body: new Response(value).body };
    },
    async put(...args) { current(); return underlying.put(...args); },
  });
  const selectedOld = async transaction => {
    const root = protocol.parseStoredPublicReleaseSelector((await transaction.get(firestore.doc('system/publicDeployment'))).data());
    if (!same(root.selectedPair, protocol.publicReleasePairReference(packet.oldPair))) refuse();
  };
  return Object.freeze({ store,
    async arm(actionId) {
      current(); if (actionId !== `${packet.runId}-corrupt`) refuse();
      if (!await state()) {
        const opened = await openStagedPublicReleasePairCodePack({ firestore, store: underlying, pair, signal });
        await opened.verifyAll();
        const baseline = (await firestore.doc(publicReleasePairCodePackBaselinePath(pair)).get()).data();
        if (!baseline || baseline.pairDigest !== protocol.publicReleaseDigest(pair) ||
            baseline.codePackManifestKey !== inputs.publicReleasePairInputObjectKey(pair, baseline.codePackManifestDigest)) refuse();
        const object = await underlying.get(baseline.codePackManifestKey), value = await bytes(object);
        if (value.length !== baseline.codePackManifestBytes || hash(value) !== baseline.codePackManifestDigest) refuse();
        const next = { schemaVersion: 1, sourceSha, packetDigest: protocol.publicReleaseDigest(packet), pairDigest: protocol.publicReleaseDigest(pair),
          objectKey: baseline.codePackManifestKey, bodyDigest: hash(value), bytes: value.length,
          metadataDigest: protocol.publicReleaseDigest(object.customMetadata ?? {}) };
        await firestore.runTransaction(async transaction => {
          const prior = await transaction.get(ref); await selectedOld(transaction);
          if (prior.exists) { if (!same(original(prior), next)) refuse(); } else transaction.create(ref, next);
        });
        await state();
      }
      await firestore.runTransaction(async transaction => {
        const [row, restored] = await transaction.getAll(armedRef, restoredRef); await selectedOld(transaction);
        const value = { schemaVersion: 1, intentDigest: protocol.publicReleaseDigest(intent), actionId };
        if (row.exists) { if (!same(original(row), value)) refuse(); return; }
        if (restored.exists) refuse(); transaction.create(armedRef, value);
      });
      return state();
    },
    async qualifyCorrupt() {
      current(); const bound = await state(); if (!bound) refuse();
      const prior = await refusedRef.get();
      if (prior.exists) {
        const value = original(prior);
        const expectedId = `rehearsal-${protocol.publicReleaseDigest({ operationId: rehearsalOperationId(packet, 'refuse-corrupt'),
          pair, witnessDigest: value.witnessDigest }).slice(0, 32)}`;
        if (value.intentDigest !== bound.intentDigest || value.qualificationId !== expectedId ||
            (await firestore.doc(qualificationReceiptPath(pair, expectedId)).get()).exists) refuse();
        return value;
      }
      if (!active) refuse();
      const witness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
      const qualificationId = `rehearsal-${protocol.publicReleaseDigest({ operationId: rehearsalOperationId(packet, 'refuse-corrupt'),
        pair, witnessDigest: witness.witnessDigest }).slice(0, 32)}`;
      const receiptRef = firestore.doc(qualificationReceiptPath(pair, qualificationId));
      if ((await receiptRef.get()).exists) refuse();
      const before = dispatched; let refused = false;
      try { await qualifyPublicReleasePair({ firestore, store, pair, qualificationId, witnessDigest: witness.witnessDigest, credentials, signal }); }
      catch (error) { if (error?.code === 'input-unavailable' && dispatched > before) refused = true; }
      current(); if (!refused || (await receiptRef.get()).exists || !same(bound, await state())) refuse();
      const value = { schemaVersion: 1, intentDigest: bound.intentDigest, qualificationId,
        witnessDigest: witness.witnessDigest, dispatched: true, nativeRefusal: 'input-unavailable', reason: 'byte-mismatch' };
      await refusedRef.create(value); return value;
    },
    async restore(actionId) {
      current(); const bound = await state(); if (!bound || actionId !== `${packet.runId}-repair`) refuse();
      await expectedObject();
      await firestore.runTransaction(async transaction => {
        const [armed, restored] = await transaction.getAll(armedRef, restoredRef); await selectedOld(transaction);
        original(armed);
        const value = { schemaVersion: 1, intentDigest: bound.intentDigest, actionId };
        if (restored.exists) { if (!same(original(restored), value)) refuse(); } else transaction.create(restoredRef, value);
      });
      return state();
    },
    async inspect() { current(); return state(); },
  });
}
