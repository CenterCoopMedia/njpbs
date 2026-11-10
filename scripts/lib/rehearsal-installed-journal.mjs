import protocol from '../../functions/lib/public-release-pair.js';
import { createHash } from 'node:crypto';
import { rehearsalSteps, rehearsalOperationId } from './public-release-rehearsal.mjs';
import { parseRehearsalPacket } from './public-release-rehearsal.mjs';
import { assertDemoRehearsalEnvironment, assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';

const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = () => { throw new Error('Installed rehearsal journal refused'); };
const immutable = row => {
  if (!row.exists || !row.createTime.isEqual(row.updateTime)) refuse();
  return row.data();
};
const bounded = value => {
  if (Buffer.byteLength(JSON.stringify(value)) > 750_000) refuse();
  return protocol.freeze(structuredClone(value));
};

/** Create-only history of harness-verified observations. The execution session
 * calls record only after the harness independently checks native facts and
 * HTTP bytes. These historical receipts never replace a fresh authority read.
 */
export async function openRehearsalJournal({ firestore, packet: raw, sourceSha, adapterDigest, censusDigest, executionDigest, initialState, auditBaseline = null, authorized = false }) {
  if (authorized !== true) refuse();
  const packet = parseRehearsalPacket(raw);
  const current = () => {
    if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
    else { assertDevelopmentRehearsalEnvironment(); if (packet.setupMode !== 'preinstalled') refuse(); }
  };
  current();
  if (firestore?.projectId !== packet.projectId || !/^[a-f0-9]{40}$/.test(sourceSha ?? '') ||
      ![adapterDigest, censusDigest, executionDigest].every(protocol.digest)) refuse();
  const base = `publicReleaseRehearsalRuns/${packet.runId}`, root = firestore.doc(base);
  const binding = { schemaVersion: 1, sourceSha, adapterDigest, censusDigest, executionDigest,
    packetDigest: protocol.publicReleaseDigest(packet) };
  const run = await firestore.runTransaction(async transaction => {
    const row = await transaction.get(root);
    if (row.exists) {
      const value = immutable(row);
      protocol.exact(value, [...Object.keys(binding), 'initialState', 'initialStateDigest', 'auditBaseline', 'auditBaselineDigest']);
      if (!same(Object.fromEntries(Object.keys(binding).map(key => [key, value[key]])), binding) ||
          !value.initialState || typeof value.initialState !== 'object' ||
          value.initialStateDigest !== protocol.publicReleaseDigest(value.initialState) ||
          value.auditBaselineDigest !== protocol.publicReleaseDigest(value.auditBaseline) ||
          packet.schemaVersion === 2 && value.auditBaseline?.packetDigest !== binding.packetDigest) refuse();
      return value;
    }
    if (packet.schemaVersion === 2 && auditBaseline?.packetDigest !== binding.packetDigest) refuse();
    const value = bounded({ ...binding, initialState, initialStateDigest: protocol.publicReleaseDigest(initialState),
      auditBaseline, auditBaselineDigest: protocol.publicReleaseDigest(auditBaseline) });
    transaction.create(root, value); return value;
  });
  const steps = rehearsalSteps();
  const requestAt = index => {
    const [step, action, target] = steps[index];
    return { step, action, target, actionId: `${packet.runId}-${step}`, operationId: rehearsalOperationId(packet, step) };
  };
  function parse(row, index, previousDigest) {
    const value = immutable(row), expected = requestAt(index);
    const keys = [...Object.keys(binding), ...Object.keys(expected), 'previousDigest', 'resultDigest', 'state', 'receipt', 'receiptDigest', 'receiptBytes', 'receiptFileDigest'];
    protocol.exact(value, keys);
    if (!same(Object.fromEntries(Object.keys(binding).map(key => [key, value[key]])), binding) ||
        !same(Object.fromEntries(Object.keys(expected).map(key => [key, value[key]])), expected) ||
        value.previousDigest !== previousDigest || value.resultDigest !== protocol.publicReleaseDigest(value.receipt?.result) ||
        value.receiptDigest !== protocol.publicReleaseDigest(value.receipt) ||
        typeof value.receiptBytes !== 'string' || hash(value.receiptBytes) !== value.receiptFileDigest ||
        !same(JSON.parse(value.receiptBytes), value.receipt) ||
        !same(value.state, value.receipt?.observed?.state) || value.receipt?.step !== expected.step ||
        value.receipt?.actionId !== expected.actionId || value.receipt?.observed?.outcome !== 'complete') refuse();
    bounded(value); return value;
  }
  async function read(transaction) {
    const runRow = await transaction.get(root);
    if (!same(immutable(runRow), run)) refuse();
    const rows = await transaction.getAll(...steps.map((_, i) => firestore.doc(`${base}/actions/${requestAt(i).actionId}`)));
    const values = []; let missing = false, previousDigest = protocol.publicReleaseDigest(run);
    for (const [index, row] of rows.entries()) {
      if (!row.exists) { missing = true; continue; }
      if (missing) refuse();
      const value = parse(row, index, previousDigest); values.push(value); previousDigest = protocol.publicReleaseDigest(value);
    }
    return values;
  }
  return Object.freeze({ initialState: run.initialState, auditBaseline: run.auditBaseline,
    async recover() {
      current();
      return firestore.runTransaction(async transaction => (await read(transaction)).map(value => JSON.parse(value.receiptBytes)), { readOnly: true });
    },
    async recoverBytes() {
      current();
      return firestore.runTransaction(async transaction => (await read(transaction)).map(value => ({
        receipt: JSON.parse(value.receiptBytes), bytes: value.receiptBytes })), { readOnly: true });
    },
    async record(receipt) {
      current();
      const index = steps.findIndex(([step]) => step === receipt?.step);
      if (index < 0 || receipt.actionId !== requestAt(index).actionId || receipt.observed?.outcome !== 'complete') refuse();
      return firestore.runTransaction(async transaction => {
        const values = await read(transaction);
        if (index < values.length) {
          if (!same(values[index].receipt, receipt)) refuse();
          return values[index].receipt;
        }
        if (index !== values.length) refuse();
        const receiptBytes = JSON.stringify(receipt, null, 2) + '\n';
        const value = bounded({ ...binding, ...requestAt(index),
          previousDigest: protocol.publicReleaseDigest(values.at(-1) ?? run),
          resultDigest: protocol.publicReleaseDigest(receipt.result), state: receipt.observed.state,
          receipt, receiptDigest: protocol.publicReleaseDigest(receipt), receiptBytes, receiptFileDigest: hash(receiptBytes) });
        transaction.create(firestore.doc(`${base}/actions/${value.actionId}`), value);
        return value.receipt;
      });
    },
  });
}
