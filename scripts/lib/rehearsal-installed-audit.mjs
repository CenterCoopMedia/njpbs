import { createRequire } from 'node:module';
import protocol from '../../functions/lib/public-release-pair.js';
import admission from '../../functions/lib/public-release-admission.js';
import terminal from '../../functions/lib/public-release-terminal.js';
import { PUBLICATION_STEPS, rehearsalOperationId, parseRehearsalPacket } from './public-release-rehearsal.mjs';
import { assertDemoRehearsalEnvironment, assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { readRehearsalOriginalOperation } from './rehearsal-original-operation.mjs';

const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const { readGuardedPublicReleaseSwitchReceipt } = typedRequire('../../site/scripts/public-release-switch-operator.ts', import.meta.url);
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Installed rehearsal operation audit refused'); };
const paths = { operations: `${admission.ADMISSIONS}/operations`, queues: 'cmsPublishQueue',
  pending: `${admission.ADMISSIONS}/pending`, terminals: terminal.TERMINAL_RECEIPTS };

export function assertRehearsalAuditScope({ firestore, packet: raw, authorized = false }) {
  const packet = parseRehearsalPacket(raw);
  if (authorized !== true || firestore?.projectId !== packet.projectId) refuse();
  if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
  else { assertDevelopmentRehearsalEnvironment(); if (packet.setupMode !== 'preinstalled') refuse(); }
  return packet;
}

async function census(options) {
  const packet = assertRehearsalAuditScope(options), { firestore, signal } = options;
  const expected = new Set(PUBLICATION_STEPS.map(step => rehearsalOperationId(packet, step)));
  return firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const head = admission.parseAdmissionHead((await transaction.get(firestore.doc(admission.ADMISSIONS))).data());
    const groups = {}, originals = [];
    for (const [key, path] of Object.entries(paths)) {
      // Every row is read at the same SDK snapshot. Overflow refuses; a limit
      // never becomes a claim that an unexamined census is complete.
      const rows = (await transaction.get(firestore.collection(path).limit(5001))).docs;
      if (rows.length > 5000) refuse();
      const historical = [], own = [];
      for (const row of rows) {
        const data = row.data();
        if (['operations', 'terminals'].includes(key) && !row.createTime.isEqual(row.updateTime)) refuse();
        if (key === 'operations') {
          const accepted = admission.parseAdmission(data);
          if (accepted.operationId !== row.id) refuse();
          if (expected.has(row.id)) originals.push(accepted);
        }
        if (key === 'queues' && !expected.has(row.id) && data.transport === admission.TRANSPORT &&
            ['pending', 'publishing'].includes(data.status)) refuse();
        const metadata = { id: row.id, version: { seconds: row.updateTime.seconds, nanoseconds: row.updateTime.nanoseconds },
          digest: protocol.publicReleaseDigest(data) };
        (expected.has(row.id) ? own : historical).push(metadata);
      }
      groups[key] = { historicalCount: historical.length, historicalDigest: protocol.publicReleaseDigest(historical), own };
    }
    if (groups.pending.historicalCount !== 0 || head.sequence !== groups.operations.historicalCount + groups.operations.own.length) refuse();
    signal?.throwIfAborted();
    return { head, groups, originals };
  }, { readOnly: true });
}

/** A compact seal of the complete original census. A real cron may already
 * have accepted this run's exact scheduled operation; no other run work may
 * predate the initial journal. Historical rows remain pinned by SDK version. */
export async function captureRehearsalAuditBaseline(options) {
  const packet = assertRehearsalAuditScope(options), value = await census(options);
  const scheduled = rehearsalOperationId(packet, 'scheduled');
  for (const group of Object.values(value.groups)) if (group.own.some(row => row.id !== scheduled)) refuse();
  if (value.head.pendingCount !== value.groups.pending.own.length) refuse();
  return protocol.freeze({ schemaVersion: 1, packetDigest: protocol.publicReleaseDigest(packet), ...value });
}

export async function readRehearsalOperationAudit({ baseline, ...options }) {
  const packet = assertRehearsalAuditScope(options), value = await census(options);
  if (baseline?.schemaVersion !== 1 || baseline.packetDigest !== protocol.publicReleaseDigest(packet)) refuse();
  const expected = PUBLICATION_STEPS.map(step => rehearsalOperationId(packet, step));
  for (const key of Object.keys(paths)) {
    const before = baseline.groups?.[key], after = value.groups[key];
    if (!before || before.historicalCount !== after.historicalCount || before.historicalDigest !== after.historicalDigest) refuse();
    if (['operations', 'terminals'].includes(key) && before.own.some(row => !after.own.some(now => same(now, row)))) refuse();
    if (key !== 'pending' && !same(after.own.map(row => row.id).sort(), [...expected].sort())) refuse();
  }
  const orphanedOperations = Math.max(value.groups.pending.own.length, value.head.pendingCount);
  const duplicateOperations = value.originals.length - new Set(value.originals.map(row => protocol.publicReleaseDigest(row.source))).size;
  if (value.head.sequence !== baseline.head.sequence + expected.length - baseline.groups.operations.own.length ||
      value.head.pendingDigest !== '0'.repeat(64) || orphanedOperations !== 0 || duplicateOperations !== 0) refuse();
  const originals = await Promise.all(expected.map(operationId => readRehearsalOriginalOperation({ ...options, packet, operationId })));
  if (originals.some(value => value?.terminalCount !== 1) ||
      !same(admission.parseAdmissionHead((await options.firestore.doc(admission.ADMISSIONS).get()).data()), value.head)) refuse();
  return protocol.freeze({ accepted: value.groups.operations.own.length, terminal: originals.filter(value => value.terminalCount === 1).length,
    orphanedOperations, duplicateOperations, censusDigest: protocol.publicReleaseDigest(value) });
}

/** The guarded native return must include the actual held NEW source, not
 * the older content at the first switch. Native terminal consumers separately
 * prove the original claim's complete inclusion after that return. */
export async function readRehearsalReturnAudit(options) {
  const packet = assertRehearsalAuditScope(options), { firestore } = options;
  const receipts = await Promise.all(['switch-new', 'return-old'].map(step => readGuardedPublicReleaseSwitchReceipt({
    firestore, operationId: rehearsalOperationId(packet, step) })));
  const row = await firestore.doc(`${paths.operations}/${rehearsalOperationId(packet, 'hold-new')}`).get();
  if (!row.exists || !row.createTime.isEqual(row.updateTime)) refuse();
  const accepted = admission.parseAdmission(row.data());
  const returnUsedCurrentContent = receipts.every(Boolean) &&
    same(accepted.pair, protocol.publicReleasePairReference(packet.newPair)) &&
    same(receipts[1].selector.selectedPair, protocol.publicReleasePairReference(packet.oldPair)) &&
    receipts[1].selector.epoch === receipts[0].selector.epoch + 1 &&
    receipts[1].selector.contentHead.contextSequence > receipts[0].selector.contentHead.contextSequence &&
    receipts[1].selector.contentHead.contextSequence >= accepted.changeSequence;
  if (!returnUsedCurrentContent) refuse();
  return { returnUsedCurrentContent, returnEvidenceDigest: protocol.publicReleaseDigest({ receipts, accepted }) };
}
