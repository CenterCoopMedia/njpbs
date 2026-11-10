import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { releasePair } from './helpers/private-public-release-pair.js';
import { parseRehearsalPacket, runRehearsal, invokeRehearsalAdapter } from '../scripts/lib/public-release-rehearsal.mjs';
import { createDevelopmentCredentialSource, closeDevelopmentCredentialSource } from '../scripts/lib/development-rehearsal-credentials.mjs';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
let directory, packet;
const handles = [];
beforeEach(async () => {
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS',
    'FIREBASE_CONFIG', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
  vi.mocked(execFileSync).mockImplementation((program, args) => {
    if (program === '/usr/bin/git' && args.includes('rev-parse')) return 'a'.repeat(40) + '\n';
    if (program === '/usr/bin/git' && args.includes('status')) return '';
    throw new Error('Unexpected test Git operation');
  });
  directory = await mkdtemp(join(tmpdir(), 'development-rehearsal-'));
  packet = { schemaVersion: 2, mode: 'development', runId: 'development-transport', projectId: 'njpbs-site-dev',
    emulatorHost: null, ingressOrigin: 'http://127.0.0.1:18482', proofOrigin: 'http://127.0.0.1:18483',
    adapter: resolve('scripts/lib/public-release-rehearsal-adapter.mjs'),
    oldPair: releasePair(), newPair: releasePair('b', 'b'.repeat(40)),
    previewPairs: { old: { pairId: 'preview-old', rendererSha: 'a'.repeat(40), serializerId: 'preview-old' },
      new: { pairId: 'preview-new', rendererSha: 'b'.repeat(40), serializerId: 'preview-new' } } };
});
afterEach(async () => {
  handles.splice(0).forEach(closeDevelopmentCredentialSource);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const credential = input => {
  const handle = createDevelopmentCredentialSource(input);
  handles.push(handle);
  return handle;
};

it('accepts the explicit private development packet', () => {
  expect(parseRehearsalPacket(packet)).toMatchObject({ schemaVersion: 2, projectId: 'njpbs-site-dev', emulatorHost: null });
});

it.each([
  ['production project', value => { value.projectId = 'njpbs-site'; }],
  ['implicit mode', value => { delete value.mode; }],
  ['emulator target', value => { value.emulatorHost = '127.0.0.1:18481'; }],
  ['fixture adapter', value => { value.adapter = resolve('tests/fixtures/public-release-rehearsal-adapter.mjs'); }],
  ['extra credential field', value => { value.credential = 'synthetic'; }],
  ['preview serializer alias', value => { value.previewPairs.old.serializerId = 'other'; }],
  ['public worker identity', value => { value.oldPair.publicWorker.service = 'template-dev-public'; }],
])('refuses %s before any adapter or SDK operation', (label, change) => {
  change(packet);
  expect(() => parseRehearsalPacket(packet)).toThrow();
});

it('refuses missing owner bindings before reading a credential or creating evidence', async () => {
  let reads = 0;
  const input = new Readable({ read() { reads++; this.push(null); } });
  const output = join(directory, 'evidence');
  await expect(runRehearsal(packet, output, { developmentCredential: credential(input) }))
    .rejects.toMatchObject({ code: 'development-bindings-unavailable' });
  expect(reads).toBe(0);
  await expect(readFile(join(output, 'status.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('the actual CLI refuses missing bindings before requiring or opening fd3', async () => {
  const packetPath = join(directory, 'packet.json'), outputPath = join(directory, 'evidence');
  await writeFile(packetPath, JSON.stringify(packet));
  const child = spawn(process.execPath, [resolve('scripts/rehearse-public-release-pairs.mjs'),
    'run-development', packetPath, outputPath], {
    env: { PATH: process.env.PATH, HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const code = await new Promise((accept, reject) => { child.on('error', reject); child.on('close', accept); });
  expect(code).toBe(1);
  expect(output).toBe('');
  expect(errors).toContain('development-bindings-unavailable');
  expect(errors).not.toContain('Input or evidence is invalid');
  await expect(readFile(join(outputPath, 'status.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires the opaque source at the actual adapter process boundary', async () => {
  await expect(invokeRehearsalAdapter({ packet, action: 'inspect', actionId: 'development-inspect' }))
    .rejects.toMatchObject({ code: 'development-credential-required' });
});

it('refuses invalid credential bytes with a bounded process error', async () => {
  const developmentCredential = credential(Readable.from(['not-a-credential']));
  await expect(invokeRehearsalAdapter({ packet, action: 'inspect', actionId: 'development-inspect' }, { developmentCredential }))
    .rejects.toMatchObject({ code: 'development-credential-refused' });
});

it('refuses an unbound real child even with a valid development credential shape', async () => {
  const account = { type: 'service_account', project_id: 'njpbs-site-dev',
    client_email: 'fixture@njpbs-site-dev.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nfixture-not-a-real-key' };
  const developmentCredential = credential(Readable.from([JSON.stringify(account)]));
  await expect(invokeRehearsalAdapter({ packet, action: 'inspect', actionId: 'development-inspect' }, { developmentCredential }))
    .rejects.toMatchObject({ code: 'adapter-exit' });
});
