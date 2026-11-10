import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { releasePair } from './helpers/private-public-release-pair.js';
import { parseRehearsalPacket, runRehearsal, rehearsalSteps } from '../scripts/lib/public-release-rehearsal.mjs';
import { createRehearsalHttpCredential, bindRehearsalHttpCredential,
  acceptRehearsalHttpAuthorization, closeRehearsalHttpCredential } from '../scripts/lib/public-release-rehearsal-http-auth.mjs';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

let directory, packet, server, ingress, wrongBytes, pending, previousTmp, ingressLeak, ingressRequests, httpCredential;
const body = '<!doctype html><html>Fixture public bytes</html>';
beforeEach(async () => {
  // Git is the process boundary here; scenario proofs must not depend on the
  // developer's checkout or a concurrent review's temporary artifact files.
  vi.mocked(execFileSync).mockReset().mockImplementation((program, args) => {
    if (program !== '/usr/bin/git') throw new Error('Unexpected test process');
    if (args.includes('rev-parse')) return 'a'.repeat(40) + '\n';
    if (args.includes('status')) return '';
    throw new Error('Unexpected test Git operation');
  });
  directory = await mkdtemp(join(tmpdir(), 'release-rehearsal-'));
  previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  wrongBytes = false; pending = false;
  ingressLeak = false; ingressRequests = 0; httpCredential = undefined;
  const authorize = (request, response, origin) => {
    if (!httpCredential || acceptRehearsalHttpAuthorization(httpCredential, origin, request.headers.authorization)) return true;
    response.writeHead(403).end(); return false;
  };
  server = createServer(async (request, response) => {
    if (!authorize(request, response, packet.proofOrigin)) return;
    const saved = JSON.parse(await readFile(join(directory, `${packet.runId}.json`), 'utf8'));
    const publication = Object.values(saved.receipts).filter(receipt => receipt.proof).at(-1);
    response.writeHead(publication.proof.status, { ...publication.proof.headers,
      ...(pending ? { 'publication-refresh': 'pending' } : {}) });
    response.end(wrongBytes ? '<html>Corrupted</html>' : publication.proof.status === 410 ? '' : body);
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  ingress = createServer(async (request, response) => {
    if (!authorize(request, response, packet.ingressOrigin)) return;
    ingressRequests++;
    expect(request.headers['x-rehearsal-expected-status']).toBe('418');
    const saved = JSON.parse(await readFile(join(directory, `${packet.runId}.json`), 'utf8'));
    const publication = Object.values(saved.receipts).filter(receipt => receipt.proof).at(-1);
    response.writeHead(publication.proof.status, ingressLeak ? publication.proof.headers : {});
    response.end(publication.proof.status === 410 ? '' : body);
  });
  await new Promise(accept => ingress.listen(0, '127.0.0.1', accept));
  packet = { schemaVersion: 1, runId: `fixture-${randomUUID()}`, projectId: 'demo-njpbs',
    emulatorHost: '127.0.0.1:18481', ingressOrigin: `http://127.0.0.1:${ingress.address().port}`,
    proofOrigin: `http://127.0.0.1:${server.address().port}`,
    adapter: resolve('tests/fixtures/public-release-rehearsal-adapter.mjs'),
    oldPair: releasePair(), newPair: releasePair('b', 'b'.repeat(40)),
    previewPairs: { old: { pairId: 'preview-old', rendererSha: 'a'.repeat(40), serializerId: 'preview-old' },
      new: { pairId: 'preview-new', rendererSha: 'b'.repeat(40), serializerId: 'preview-new' } } };
});
afterEach(async () => {
  if (httpCredential) closeRehearsalHttpCredential(httpCredential);
  await new Promise(accept => server.close(accept));
  await new Promise(accept => ingress.close(accept));
  if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
  await rm(directory, { recursive: true, force: true });
});

it('carries the parent-only HTTP capability through public and ordinary ingress checks', async () => {
  httpCredential = createRehearsalHttpCredential();
  bindRehearsalHttpCredential(httpCredential, [packet.ingressOrigin, packet.proofOrigin]);
  const output = join(directory, 'authenticated-evidence');
  await expect(runRehearsal(packet, output)).rejects.toThrow();
  const report = await runRehearsal(packet, output, { httpCredential });
  expect(report).toMatchObject({ kind: 'harness-contract-fixture', verdict: 'scenario-checks-passed' });
  expect(ingressRequests).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(join(output, 'packet.json'), 'utf8'))).not.toHaveProperty('httpCredential');
  expect(JSON.stringify(report)).not.toContain('authorization');
});

it('refuses production, remote origins and colliding pair identities before an adapter can run', () => {
  expect(() => parseRehearsalPacket({ ...packet, projectId: 'njpbs-site' })).toThrow('Demo');
  expect(() => parseRehearsalPacket({ ...packet, ingressOrigin: 'https://njpbs.org' })).toThrow();
  expect(() => parseRehearsalPacket({ ...packet, ingressOrigin: 'http://example.test:18482' })).toThrow();
  expect(() => parseRehearsalPacket({ ...packet, oldPair: { ...packet.oldPair, environment: 'production' } })).toThrow();
  expect(() => parseRehearsalPacket({ ...packet, newPair: packet.oldPair })).toThrow();
  expect(() => parseRehearsalPacket({ ...packet, adapter: resolve('scripts/copied-fixture.mjs') })).toThrow('Named rehearsal adapter');
});

it('refuses a dirty checkout before creating rehearsal evidence', async () => {
  vi.mocked(execFileSync).mockReturnValueOnce('a'.repeat(40) + '\n').mockReturnValueOnce(' M scripts/operator.mjs\n');
  const output = join(directory, 'evidence');
  await expect(runRehearsal(packet, output)).rejects.toMatchObject({ code: 'source-not-clean' });
  await expect(readFile(join(output, 'status.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('runs the complete scenario through real child processes and HTTP, then resumes without another mutation', async () => {
  packet.scheduledSource = { collection: 'cmsPosts', documentId: 'scheduled-coverage', version: 2, publishAt: '2026-11-03T23:30:00.000Z' };
  const output = join(directory, 'evidence');
  const report = await runRehearsal(packet, output);
  expect(report.receipts.map(item => item.step)).toEqual(rehearsalSteps().map(([step]) => step));
  expect(report).toMatchObject({ kind: 'harness-contract-fixture', verdict: 'scenario-checks-passed', productionAdoption: false, measurementsAccepted: false });
  const stateFile = join(directory, `${packet.runId}.json`);
  const before = await readFile(stateFile, 'utf8');
  const saved = JSON.parse(before);
  expect(saved).toMatchObject({ selected: 'old', epoch: 3, attempts: 2, interrupted: true });
  expect(Object.values(saved.receipts).filter(receipt => receipt.operation)
    .every(receipt => /^[A-Za-z0-9]{20}$/.test(receipt.operation.operationId))).toBe(true);
  // Golden from the unchanged scheduler formula before its extraction.
  expect(saved.receipts[`${packet.runId}-scheduled`].operation.operationId).toBe('e59db35fa876a3ebee91');
  expect(ingressRequests).toBeGreaterThan(0);
  expect(await runRehearsal(packet, output)).toEqual(report);
  expect(await readFile(stateFile, 'utf8')).toEqual(before);
  const status = JSON.parse(await readFile(join(output, 'status.json'), 'utf8'));
  expect(status.reportDigest).toBe(createHash('sha256').update(await readFile(join(output, 'report.json'))).digest('hex'));
  expect(report.packetDigest).toBe(createHash('sha256').update(await readFile(join(output, 'packet.json'))).digest('hex'));
  for (const receipt of report.receipts) {
    expect(receipt.digest).toBe(createHash('sha256').update(await readFile(join(output, `${receipt.step}.json`))).digest('hex'));
  }
  const statusBefore = await readFile(join(output, 'status.json'), 'utf8');
  await expect(runRehearsal({ ...packet, runId: 'different-run' }, output)).rejects.toThrow();
  expect(await readFile(join(output, 'status.json'), 'utf8')).toBe(statusBefore);
  vi.mocked(execFileSync).mockReturnValueOnce('0'.repeat(40) + '\n').mockReturnValueOnce('');
  await expect(runRehearsal(packet, output)).rejects.toThrow();
  expect(await readFile(join(output, 'status.json'), 'utf8')).toBe(statusBefore);
});

it.each(['bytes', 'fallback'])('rejects %s as public confirmation', async mode => {
  wrongBytes = mode === 'bytes'; pending = mode === 'fallback';
  await expect(runRehearsal(packet, join(directory, 'evidence'))).rejects.toThrow(
    mode === 'bytes' ? 'public-byte-mismatch' : 'fallback-cannot-certify');
});

it('rejects an ordinary ingress that exposes private proof to a viewer', async () => {
  ingressLeak = true;
  await expect(runRehearsal(packet, join(directory, 'evidence'))).rejects.toMatchObject({ code: 'ordinary-ingress-proof-leak' });
});

it.each([
  ['pause', 'scenario-contract-refused'],
  ['transient-pause', 'scenario-contract-refused'],
  ['duplicate-provider', 'repeated-provider-mutation'],
  ['duplicate-provider-prepare', 'repeated-provider-mutation'],
  ['orphan', 'scenario-contract-refused'],
  ['wrong-proof-operation', 'public-proof-identity-mismatch'],
  ['resurrected-withdrawal', 'withdrawal-resurrected'],
  ['refused-after-get', 'scenario-contract-refused'],
  ['refused-final-inspect', 'scenario-contract-refused'],
  ['preview-returned-old', 'preview-selection-mismatch'],
  ['preview-admin-overwrite', 'preview-admin-receipt-changed'],
  ['preview-retry-mutation', 'preview-retry-changed-state'],
])('rejects a release with %s evidence', async (mode, code) => {
  await writeFile(join(directory, `${packet.runId}.json`), JSON.stringify({ selected: 'old', epoch: 1,
    sequence: 0, generation: 10, attempts: 1, receipts: {}, mode }));
  await expect(runRehearsal(packet, join(directory, 'evidence'))).rejects.toMatchObject({ code });
});

it('refuses unbound operators without creating a successful rehearsal receipt', async () => {
  const output = join(directory, 'evidence');
  await expect(runRehearsal({ ...packet, adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs') }, output)).rejects.toThrow('adapter-exit');
  await expect(readFile(join(output, 'report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(join(output, 'status.json'), 'utf8'))).toEqual({ status: 'refused',
    failure: { code: 'adapter-exit', step: 'baseline', actionId: `${packet.runId}-baseline` } });
  const failureBefore = await readFile(join(output, 'status.json'), 'utf8');
  await expect(runRehearsal({ ...packet, runId: 'different-run' }, output)).rejects.toThrow();
  expect(await readFile(join(output, 'status.json'), 'utf8')).toBe(failureBefore);
});

it.each(['lost-switch-response', 'lost-preview-response'])('resumes %s from the original durable evidence', async mode => {
  const output = join(directory, 'evidence');
  const file = join(directory, `${packet.runId}.json`);
  await writeFile(file, JSON.stringify({ selected: 'old', epoch: 1, sequence: 0, generation: 10,
    attempts: 1, receipts: {}, mode }));
  await expect(runRehearsal(packet, output)).rejects.toThrow('adapter-exit');
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject(mode === 'lost-switch-response'
    ? { selected: 'new', epoch: 2, attempts: 2 } : { selected: 'old', epoch: 3, previewSelected: 'new', previewEpoch: 2, attempts: 2 });
  if (mode === 'lost-preview-response') {
    const pending = JSON.parse(await readFile(join(output, 'preview-admin-assets.pending.json'), 'utf8'));
    expect(pending.previewBefore.selector).toMatchObject({ selectedPairId: 'preview-old', epoch: 1 });
  }
  expect(JSON.parse(await readFile(join(output, 'status.json'), 'utf8')).status).toBe('refused');
  expect((await runRehearsal(packet, output)).verdict).toBe('scenario-checks-passed');
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ selected: 'old', epoch: 3, attempts: 2 });
  expect(JSON.parse(await readFile(join(output, 'status.json'), 'utf8')).status).toBe('complete');
});
