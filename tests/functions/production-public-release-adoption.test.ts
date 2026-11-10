import { afterAll, beforeAll, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
const firestore = isolatedFirestore('production-public-release-adoption');
let child: ChildProcess, sequence = 0, diagnostics = '';
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
beforeAll(async () => {
  child = fork(fileURLToPath(new URL('../helpers/production-public-release-adoption-child.mjs', import.meta.url)), [], {
    env: { ...process.env, PRODUCTION_ADOPTION_TEST_PROJECT: firestore.projectId }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  child.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); });
  await new Promise<void>((resolve, reject) => {
    child.on('message', (message: any) => {
      if ('ready' in message) { if (!message.ready) { reject(new Error(message.error.stack)); return; } resolve(); return; }
      const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.stack)); else call.resolve(message.result);
    });
    child.once('error', reject);
    child.once('exit', code => { const error = new Error(`Production fixture exited ${code}: ${diagnostics.slice(-2000)}`); reject(error); for (const call of pending.values()) call.reject(error); pending.clear(); });
  });
}, 60_000);
afterAll(async () => { if (child?.connected) { const exit = once(child, 'exit'); child.send({ action: 'close' }); await exit; } });
function call(action: string, corruptBytes = false) {
  return new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, action, corruptBytes }); });
}
it('retains both production pairs through actual native H/G work without replacing the enrolled baseline', async () => {
  expect(await call('stage')).toMatchObject({ status: 'retained' });
});
it('installs native OLD controls through the production command binding with producers still disabled', async () => {
  expect(await call('controls')).toMatchObject({ idempotent: false, receipt: { kind: 'public-release-bootstrap-controls' } });
  expect((await firestore.doc('system/publicReleaseChangeLog').get()).data()?.enabled).toBe(false);
});
it('obtains both real remote-byte qualifications before the original initial selector CAS', async () => {
  expect(await call('qualify')).toMatchObject({ status: 'qualified', references: [{}, {}] });
});
it('converts once through the immutable read store and measured full qualification, retaining closed admission', async () => {
  expect(await call('initial')).toMatchObject({ idempotent: false, receipt: { kind: 'public-release-bootstrap' } });
  expect((await firestore.doc('system/publicDeployment').get()).data()?.schemaVersion).toBe(2);
  expect((await firestore.doc('system/publicReleaseAdmissions/controls/bootstrapFence').get()).data()?.status).toBe('closed');
});
it.each([0, 1, 2, 3])('records native OLD router/slot HTTP roster part %i at the frozen system boundary', async part => {
  const result = await call(`record-http-${part}`); expect(result.count).toBeGreaterThan(0);
  expect(result.complete).toBe(part === 3);
});
it('refuses corrupt canonical OLD bytes before any logged resume commit', async () => {
  await expect(call('resume', true)).rejects.toThrow();
  expect((await firestore.doc('system/publicReleaseChangeLog').get()).data()?.enabled).toBe(false);
});
it('opens only logged producers after two fresh qualifications and recorded native router/slot canonical proofs', async () => {
  expect(await call('resume')).toMatchObject({ idempotent: false, receipt: { kind: 'public-release-bootstrap-resume' } });
});
it('reads both original receipts without object/provider credentials and retries resume without a second commit', async () => {
  const result = await call('readback');
  expect(result.initial).toMatchObject({ receipt: { kind: 'public-release-bootstrap' }, consumedCredentialFds: [] });
  expect(result.resume).toMatchObject({ receipt: { kind: 'public-release-bootstrap-resume' }, consumedCredentialFds: [] });
  expect(result.producer.enabled).toBe(true); expect(result.fence.status).toBe('open');
  expect(result.paths).toContain('/_publication-v2.json'); expect(result.paths).toContain('/');
  expect(await call('resume')).toMatchObject({ idempotent: true, receipt: result.resume.receipt });
  expect((await firestore.collection('admin_logs').where('action', '==', 'public-release.bootstrap-resume').get()).size).toBe(1);
});
