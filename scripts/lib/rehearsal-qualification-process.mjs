import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import protocol from '../../functions/lib/public-release-pair.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import { parseRehearsalPacket, rehearsalSourceCommit } from './public-release-rehearsal.mjs';
import { assertDevelopmentRehearsalEnvironment, assertDemoRehearsalEnvironment,
  hasDevelopmentCredentialSource, writeDevelopmentCredential } from './development-rehearsal-credentials.mjs';

const childPath = fileURLToPath(new URL('./rehearsal-qualification-child.mjs', import.meta.url));
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const hash = value => createHash('sha256').update(value).digest('hex');
const refuse = () => { throw new Error('Rehearsal qualifier process refused'); };
const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const { qualificationReceiptPath, parseQualificationReceipt } = typedRequire('../../site/scripts/public-release-pair-qualification-receipt.ts', import.meta.url);
const { QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT } = typedRequire('../../site/scripts/public-release-pair-qualification-evidence.ts', import.meta.url);
const putLimit = Math.ceil(QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT / 3) * 4;
async function body(value) {
  if (value === null) return null;
  const chunks = []; let size = 0;
  try {
    if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > 16 * 1024 * 1024) refuse();
    for await (const chunk of value.body) {
      size += chunk.length; if (size > value.size) refuse(); chunks.push(Buffer.from(chunk));
    }
    if (size !== value.size) refuse();
    return { size, customMetadata: value.customMetadata ?? {}, base64: Buffer.concat(chunks, size).toString('base64') };
  } finally { if (value.body && !value.body.locked) await value.body.cancel().catch(() => {}); }
}

/** Read original process intent, byte checkpoint and native qualification.
 * This consumer has no process launch, credential or storage write authority. */
export async function readRehearsalQualificationInterruption({ firestore, packet: raw, sourceSha, authorized = false }) {
  if (authorized !== true) refuse();
  const packet = parseRehearsalPacket(raw), pair = packet.newPair;
  if (firestore?.projectId !== packet.projectId || rehearsalSourceCommit() !== sourceSha) refuse();
  if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
  else assertDevelopmentRehearsalEnvironment();
  const ref = firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/qualifications/new`);
  const checkpointRef = firestore.doc(`${ref.path}/receipts/interrupted`);
  const [row, checkpoint] = await firestore.getAll(ref, checkpointRef);
  if (!row.exists || !row.createTime.isEqual(row.updateTime)) refuse();
  const plan = row.data();
  protocol.exact(plan, ['schemaVersion', 'runId', 'attemptId', 'sourceSha', 'packetDigest', 'pairDigest', 'witnessDigest', 'qualificationId']);
  if (plan.schemaVersion !== 1 || plan.runId !== packet.runId || plan.attemptId !== `${packet.runId}-qualification-new` ||
      plan.sourceSha !== sourceSha || plan.packetDigest !== protocol.publicReleaseDigest(packet) ||
      plan.pairDigest !== protocol.publicReleaseDigest(pair) || !protocol.digest(plan.witnessDigest) ||
      plan.qualificationId !== `rehearsal-${protocol.publicReleaseDigest({ attemptId: plan.attemptId, pair, witnessDigest: plan.witnessDigest }).slice(0, 32)}`) refuse();
  if (checkpoint.exists) {
    const value = checkpoint.data();
    protocol.exact(value, ['schemaVersion', 'planDigest', 'keyDigest', 'bodyDigest', 'bytes']);
    if (!checkpoint.createTime.isEqual(checkpoint.updateTime) || value.schemaVersion !== 1 ||
        value.planDigest !== protocol.publicReleaseDigest(plan) || ![value.keyDigest, value.bodyDigest].every(protocol.digest) ||
        !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 16 * 1024 * 1024) refuse();
  }
  const receiptRow = await firestore.doc(qualificationReceiptPath(pair, plan.qualificationId)).get();
  let qualification = null;
  if (receiptRow.exists) {
    if (!receiptRow.createTime.isEqual(receiptRow.updateTime)) refuse();
    qualification = parseQualificationReceipt(receiptRow.data(), pair);
    if (qualification.qualificationId !== plan.qualificationId || qualification.witnessDigest !== plan.witnessDigest) refuse();
  }
  return { plan, checkpoint: checkpoint.exists ? checkpoint.data() : null, qualification };
}

/** Native qualifier in a real process, with bounded storage/credential IPC.
 * The parent retains credentials and actual R2 capability. Writes are limited
 * to this exact native qualification's conditional immutable evidence keys.
 */
export function createRehearsalQualificationProcess({ firestore, packet: raw, store, credentials,
  developmentCredential, sourceSha, authorized = false, signal }) {
  const packet = parseRehearsalPacket(raw), pair = packet.newPair;
  if (authorized !== true || firestore?.projectId !== packet.projectId || typeof store?.get !== 'function' ||
      typeof store?.put !== 'function' || typeof credentials !== 'function' || rehearsalSourceCommit() !== sourceSha) refuse();
  const current = (checkSource = true) => {
    signal?.throwIfAborted();
    if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
    else { assertDevelopmentRehearsalEnvironment(); if (!hasDevelopmentCredentialSource(developmentCredential)) refuse(); }
    if (checkSource && rehearsalSourceCommit() !== sourceSha) refuse();
  };
  const ref = firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/qualifications/new`);
  const checkpointRef = firestore.doc(`${ref.path}/receipts/interrupted`);
  const read = async () => {
    current();
    return readRehearsalQualificationInterruption({ firestore, packet, sourceSha, authorized: true });
  };
  const run = (plan, interrupt) => new Promise((resolve, reject) => {
    current();
    const evidencePrefix = `release-pair-qualifications/v1/${protocol.publicReleaseDigest(pair)}/${protocol.publicReleaseDigest({ qualificationId: plan.qualificationId })}/`;
    const prefixes = [`release-pairs/${pair.pairId}/`, `release-pair-inputs/v2/${pair.pairId}/`,
      `release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/`, evidencePrefix];
    const child = fork(childPath, [], { env: { PATH: process.env.PATH, HOME: '/nonexistent', METADATA_SERVER_DETECTION: 'none',
      GCLOUD_PROJECT: packet.projectId, GOOGLE_CLOUD_PROJECT: packet.projectId,
      ...(packet.schemaVersion === 1 ? { FIRESTORE_EMULATOR_HOST: packet.emulatorHost, FUNCTIONS_EMULATOR: 'true' } : {}) },
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc', ...(packet.schemaVersion === 2 ? ['pipe'] : [])] });
    // IPC occupies fd3, so the development credential is explicitly fd4 here.
    // The child opens that named pipe as its SDK source below.
    let completed = null, active = 0, failed = false, closing = false, lastId = 0, queuedBytes = 0, reason = 'child-exit';
    const pending = new Set(), queue = [];
    const fail = (code = 'transport-refused') => {
      failed = true; if (reason === 'child-exit') reason = typeof code === 'string' ? code : 'transport-refused';
      queue.length = 0; child.kill('SIGKILL');
    };
    const timer = setTimeout(fail, 60_000);
    const cancel = () => fail(); signal?.addEventListener('abort', cancel, { once: true });
    const dispatch = message => {
      active++;
      let boundary = 'source-check';
      const task = (async () => {
        // The process/action binds clean source at start and completion.
        // Do not launch two Git processes for every immutable body read.
        // Target, cancellation and credential revocation remain per boundary.
        current(false); let value;
        if (message.kind === 'credentials') {
          boundary = 'reader-credential';
          const headers = new Headers(await credentials());
          value = Object.fromEntries(headers);
        } else {
          boundary = 'read-key-scope';
          if (typeof message.key !== 'string' || message.key.length > 1024 || message.key.includes('..') ||
              !prefixes.some(prefix => message.key.startsWith(prefix))) refuse();
          if (message.kind === 'get') { boundary = 'storage-get'; value = await body(await store.get(message.key)); }
          else {
            boundary = 'write-key-scope';
            if (!message.key.startsWith(evidencePrefix) || typeof message.base64 !== 'string' || message.base64.length > putLimit) refuse();
            boundary = 'write-contract'; const bytes = Buffer.from(message.base64, 'base64');
            if (bytes.toString('base64') !== message.base64 || !same(message.options?.onlyIf, { etagDoesNotMatch: '*' }) ||
                message.options.sha256 !== hash(bytes)) refuse();
            boundary = 'storage-put'; current(); await store.put(message.key, bytes, message.options); value = null;
          }
        }
        current(false);
        if (!closing && child.connected) await new Promise((accept, reject) => child.send({ id: message.id, ok: true, value },
          error => error ? reject(new Error('Qualification IPC closed')) : accept()));
      })().catch(() => fail(boundary)).finally(() => { active--; pending.delete(task); pump(); });
      pending.add(task);
    };
    const pump = () => {
      while (!closing && !failed && active < 4 && queue.length) {
        const message = queue.shift(); queuedBytes -= message.base64?.length ?? 0; dispatch(message);
      }
    };
    child.on('message', message => {
      if (message?.kind === 'complete') { if (protocol.digest(message.receiptDigest)) completed = message.receiptDigest; else fail(); return; }
      if (message?.kind === 'refused') {
        const allowed = ['replay-unproven', 'coverage-mismatch', 'stale-qualification', 'reader-mismatch',
          'byte-mismatch', 'source-mismatch', 'authority-changed', 'native-qualifier-refused'];
        if (reason === 'child-exit') reason = allowed.includes(message.code) ? message.code : 'native-qualifier-refused';
        return;
      }
      if (!Number.isSafeInteger(message?.id) || message.id <= lastId || !['get', 'put', 'credentials'].includes(message.kind) ||
          queue.length >= 32 || message.kind === 'put' && (typeof message.base64 !== 'string' || message.base64.length > putLimit ||
            queuedBytes + message.base64.length > 16 * 1024 * 1024)) {
        fail('ipc-contract'); return;
      }
      lastId = message.id; queuedBytes += message.base64?.length ?? 0; queue.push(message); pump();
    });
    child.on('error', () => fail('ipc-disconnected'));
    child.once('exit', async (code, stopped) => {
      closing = true; queue.length = 0;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      await Promise.allSettled([...pending]);
      try { current(); } catch { failed = true; reason = 'source-or-target-changed'; }
      if (failed || stopped || code !== (interrupt ? 86 : 0) || !interrupt && !completed) reject(new Error(`Rehearsal qualifier process refused (${reason})`));
      else resolve(completed);
    });
    if (packet.schemaVersion === 2) {
      child.stdio[4].on('error', () => {});
      writeDevelopmentCredential(developmentCredential, child.stdio[4]).catch(fail);
    }
    child.send({ kind: 'start', packet, plan, interrupt }, error => { if (error) fail('ipc-start'); });
  });
  return Object.freeze({
    async interrupt() {
      current();
      if (!(await ref.get()).exists) {
        const witness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
        const attemptId = `${packet.runId}-qualification-new`, witnessDigest = witness.witnessDigest;
        const plan = { schemaVersion: 1, runId: packet.runId, attemptId, sourceSha,
          packetDigest: protocol.publicReleaseDigest(packet), pairDigest: protocol.publicReleaseDigest(pair), witnessDigest,
          qualificationId: `rehearsal-${protocol.publicReleaseDigest({ attemptId, pair, witnessDigest }).slice(0, 32)}` };
        await ref.create(plan);
      }
      const prior = await read();
      // An ambiguous original start never creates a replacement attempt.
      if (!prior.checkpoint) await run(prior.plan, true);
      const observed = await read(); if (!observed.checkpoint) refuse();
      return { interrupted: true };
    },
    async resume() {
      const { plan, checkpoint, qualification } = await read(); if (!checkpoint) refuse();
      // A lost local acknowledgement does not rerun an already completed
      // native qualification or pretend its old timestamp is fresh. Later
      // selection qualification uses its own current-source owner attempt.
      if (qualification) return this.inspect();
      const digest = await run(plan, false);
      const receipt = parseQualificationReceipt((await firestore.doc(qualificationReceiptPath(pair, plan.qualificationId)).get()).data(), pair);
      if (protocol.publicReleaseDigest(receipt) !== digest) refuse();
      return this.inspect();
    },
    async inspect() {
      const { plan, checkpoint, qualification } = await read(); if (!checkpoint) refuse();
      return Object.freeze({ attemptId: plan.attemptId, checkpointDigest: protocol.publicReleaseDigest(checkpoint),
        status: qualification ? 'complete' : 'interrupted' });
    },
  });
}
