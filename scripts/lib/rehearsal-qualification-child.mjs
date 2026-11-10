import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { openDevelopmentRehearsalContext, openDemoRehearsalContext } from './development-rehearsal-credentials.mjs';

// Private process boundary. Credentials arrive on fd4 or authenticated parent
// IPC at use. Nothing from a provider/SDK error is printed or returned.
const pending = new Map(); let sequence = 0, context, finished = false;
const call = (kind, fields = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  process.send?.({ id, kind, ...fields });
});
process.on('message', message => {
  if (!Number.isSafeInteger(message?.id) || !pending.has(message.id)) return;
  const request = pending.get(message.id); pending.delete(message.id);
  if (message.ok !== true) request.reject(new Error('Qualification transport refused'));
  else request.resolve(message.value);
});
process.once('disconnect', () => { if (!finished) process.exit(1); });
try {
  const input = await new Promise(resolve => process.once('message', resolve));
  if (input?.kind !== 'start') throw new Error();
  const { packet, plan, interrupt } = input;
  if (packet.schemaVersion === 2) {
    const metadata = fstatSync(4);
    if (!metadata.isFIFO() && !metadata.isSocket()) throw new Error();
    context = await openDevelopmentRehearsalContext(new Socket({ fd: 4, readable: true, writable: false, pauseOnCreate: true }));
  } else context = openDemoRehearsalContext(packet);
  // Initialize the actual explicit SDK identity before importing any function
  // module that selects the first SDK app. No ADC or project proxy is used.
  const firestore = context.firestore;
  const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
  const { qualifyPublicReleasePair } = typedRequire('../../site/scripts/public-release-pair-qualification.ts', import.meta.url);
  const { default: protocol } = await import('../../functions/lib/public-release-pair.js');
  const { parseRehearsalPacket } = await import('./public-release-rehearsal.mjs');
  parseRehearsalPacket(packet);
  const ref = firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}/qualifications/new`);
  const original = await ref.get();
  if (!original.exists || !original.createTime.isEqual(original.updateTime) ||
      protocol.publicReleaseDigest(original.data()) !== protocol.publicReleaseDigest(plan)) throw new Error();
  const checkpointRef = firestore.doc(`${ref.path}/receipts/interrupted`);
  const store = {
    async get(key) {
      const value = await call('get', { key });
      if (interrupt) {
        if (!value || typeof value.base64 !== 'string') throw new Error();
        const body = Buffer.from(value.base64, 'base64');
        const witness = { schemaVersion: 1, planDigest: protocol.publicReleaseDigest(plan),
          keyDigest: createHash('sha256').update(key).digest('hex'),
          bodyDigest: createHash('sha256').update(body).digest('hex'), bytes: body.length };
        await checkpointRef.create(witness);
        await context.close(); context = null;
        // A real exit from inside the actual qualifier after its first real
        // storage boundary; the original witness and attempt remain unchanged.
        process.exit(86);
      }
      if (value === null) return null;
      const bytes = Buffer.from(value.base64, 'base64');
      if (bytes.toString('base64') !== value.base64 || bytes.length !== value.size) throw new Error();
      return { size: value.size, customMetadata: value.customMetadata, body: new Response(bytes).body };
    },
    async put(key, bytes, options) { await call('put', { key, base64: Buffer.from(bytes).toString('base64'), options }); },
  };
  const receipt = await qualifyPublicReleasePair({ firestore, store, pair: packet.newPair,
    qualificationId: plan.qualificationId, witnessDigest: plan.witnessDigest,
    credentials: () => call('credentials'), signal: AbortSignal.timeout(60_000) });
  process.send?.({ kind: 'complete', receiptDigest: protocol.publicReleaseDigest(receipt.receipt) });
} catch (error) {
  const allowed = new Set(['replay-unproven', 'coverage-mismatch', 'stale-qualification', 'reader-mismatch',
    'byte-mismatch', 'source-mismatch', 'authority-changed']);
  process.send?.({ kind: 'refused', code: allowed.has(error?.code) ? error.code : 'native-qualifier-refused' });
  process.exitCode = 1;
}
finally {
  try { await context?.close(); } catch { process.exitCode = 1; }
  finished = true;
  process.disconnect?.();
}
