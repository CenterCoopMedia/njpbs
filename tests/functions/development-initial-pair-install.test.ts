import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import work from '../../functions/lib/public-release-pair-work.js';
import protocol from '../../functions/lib/public-release-pair.js';
import controlled from '../../functions/lib/public-release-bootstrap-control-source.js';
describe.each(['development', 'production'] as const)('%s full initial-pair composition', environment => {
const firestore = isolatedFirestore(`${environment}-initial-pair-install`);
let child: ChildProcess, packet: any, pairs: any[], references: any[], sequence = 0;
let diagnostics = '';
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
beforeAll(async () => {
  child = fork(fileURLToPath(new URL('../helpers/development-initial-pair-install-child.mjs', import.meta.url)), [], {
    env: { ...process.env, INITIAL_PAIR_TEST_PROJECT: firestore.projectId, INITIAL_PAIR_TEST_ENVIRONMENT: environment }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  child.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); });
  await new Promise<void>((resolve, reject) => {
    child.on('message', (message: any) => {
      if ('ready' in message) { if (!message.ready) { reject(new Error(message.error.message)); return; } packet = message.packet; pairs = message.pairs; resolve(); return; }
      const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
    });
    child.once('error', reject);
    child.once('exit', code => { const error = new Error(`Fixture child exited ${code}: ${diagnostics.split('\n').filter(line => /^Error:/.test(line)).join(' ').slice(0, 2000)}`); reject(error); for (const call of pending.values()) call.reject(error); pending.clear(); });
  });
}, 60_000);
afterAll(async () => { if (child?.connected) { const exit = once(child, 'exit'); child.send({ action: 'close' }); await exit; } });
function call(action: string, step?: string, mode?: string) {
  return new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, action, step, mode, qualifications: references }); });
}
it('seals actual OLD CODE, queues native candidate work, and refuses qualification before OLD controls', async () => {
  expect(await call('run', 'old-code')).toMatchObject({ status: 'old-code-sealed' });
  expect(await call('run', 'stage')).toMatchObject({ status: 'waiting' });
  await expect(call('run', 'qualify')).rejects.toThrow();
});
it('exhausts both original H/G claims and retains without creating a replay baseline', async () => {
  await call('complete');
  expect(await call('run', 'stage')).toMatchObject({ status: 'waiting' });
  await call('complete');
  expect(await call('run', 'stage')).toMatchObject({ status: 'retained' });
  expect(await call('run', 'stage', 'readback')).toMatchObject({ status: 'retained' });
  for (const pair of pairs) expect((await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/replay/current`).get()).exists).toBe(false);
});
it('captures distinct fresh H after the actual native OLD-control transition', async () => {
  await call('controls'); expect(await call('run', 'qualify')).toMatchObject({ status: 'waiting' });
  for (const result of await call('census')) { expect(result.actual).toBe(result.expected); expect(result.controlFile).toBe(true); }
});
it('seals the single post-control replay baseline and obtains both qualifications through actual HTTP', async () => {
  await call('complete');
  const result = await call('run', 'qualify'); expect(result.status).toBe('qualified'); expect(result.references).toHaveLength(2);
  references = result.references;
  for (const [index, pair] of pairs.entries()) {
    expect(result.qualifications[index].receipt.pairDigest).toBe(protocol.publicReleaseDigest(pair));
    expect((await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/replayBaselines`).get()).size).toBe(1);
  }
  expect((await firestore.doc(`system/publicReleaseAdmissions/bootstrapPairRetentions/${packet.bootstrapOperationId}`).get()).exists).toBe(true);
});
it('refuses the initial retained admission on wrong projects and later heads', async () => {
  const dev = new Proxy(firestore, { get(target, key) { if (key === 'projectId') return environment === 'development' ? 'njpbs-site-dev' : 'njpbs-site';
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  await expect(controlled.assertInitialControlCaptureInTransaction({ firestore: { projectId: environment === 'development' ? 'njpbs-site' : 'njpbs-site-dev' }, transaction: {}, pair: pairs[0] })).rejects.toThrow('mixed publication database');
  const headRef = firestore.doc('system/publicReleaseChanges'), head = (await headRef.get()).data()!;
  try { await headRef.update({ sequence: 1, lastDigest: 'e'.repeat(64) });
    await expect(dev.runTransaction(transaction => controlled.assertInitialControlCaptureInTransaction({ firestore: dev, transaction, pair: pairs[0] }))).rejects.toThrow();
  } finally { await headRef.set(head); }
});
it('refuses to refresh an old qualification identity after an authority fault', async () => {
  await expect(call('run', 'qualify')).rejects.toThrow();
});
it('obtains separately named fresh receipts without replacing original qualification identities', async () => {
  const refreshed = await call('refresh'); references = refreshed.references;
  expect(references.map(row => row.qualificationId)).toEqual(packet.qualificationIds.map(id => id + '-after-fault'));
});
it('supplies actual qualifications accepted by the initial-selector owner and refuses later capture', async () => {
  const converted = await call('convert'); expect(converted.after.schemaVersion).toBe(2);
  const dev = new Proxy(firestore, { get(target, key) { if (key === 'projectId') return environment === 'development' ? 'njpbs-site-dev' : 'njpbs-site';
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  await expect(dev.runTransaction(transaction => controlled.assertInitialControlCaptureInTransaction({ firestore: dev, transaction, pair: pairs[0] }))).rejects.toThrow();
  await expect(call('run', 'qualify')).rejects.toThrow();
});

});
