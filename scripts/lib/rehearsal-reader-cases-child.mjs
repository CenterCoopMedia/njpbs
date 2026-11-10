import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { openDevelopmentRehearsalContext } from './development-rehearsal-credentials.mjs';

let context, finished = false, sequence = 0;
const pending = new Map();
process.on('message', message => {
  const request = pending.get(message?.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok === true && typeof message.value === 'string') request.resolve(message.value);
  else request.reject(new Error('Reader credential unavailable'));
});
process.once('disconnect', () => { if (!finished) process.exit(1); });
try {
  const input = await new Promise(resolve => process.once('message', resolve));
  if (input?.kind !== 'start-cases' || input.packet?.schemaVersion !== 2) throw new Error();
  const metadata = fstatSync(4);
  if (!metadata.isFIFO() && !metadata.isSocket()) throw new Error();
  context = await openDevelopmentRehearsalContext(new Socket({ fd: 4, readable: true, writable: false, pauseOnCreate: true }));
  const firestore = context.firestore; // Actual explicit SDK app precedes native Auth imports.
  const { deriveRehearsalReaderCases } = await import('./rehearsal-reader-cases.mjs');
  const result = await deriveRehearsalReaderCases({ firestore, ...input, authorized: true,
    signal: AbortSignal.timeout(60_000), readStaffToken: () => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); process.send?.({ kind: 'staff-token', id });
    }) });
  await new Promise((resolve, reject) => process.send?.({ kind: 'cases', result }, error => error ? reject(new Error()) : resolve()));
} catch { process.exitCode = 1; }
finally {
  try { await context?.close(); } catch { process.exitCode = 1; }
  finished = true; process.disconnect?.();
}
