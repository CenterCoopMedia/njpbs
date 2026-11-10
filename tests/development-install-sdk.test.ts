import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { developmentInstallCredential } from '../scripts/lib/development-install-credentials.mjs';
import { operatorAccount } from '../scripts/lib/public-release-operator-io.mjs';
import { sealedPair } from './helpers/sealed-public-release-pair';
import { releasePair } from './helpers/private-public-release-pair.js';
import context from '../functions/lib/public-context-revision.js';
import protocol from '../functions/lib/public-release-pair.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = { projectId: 'njpbs-site-dev', clientEmail: 'dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com',
  privateKeyId: 'c'.repeat(40), secretRef: 'pass://example/service/credential' };
const edgeSecret = 'synthetic-enrollment-edge-never-sent-to-a-provider';
const account = { type: 'service_account', project_id: identity.projectId, client_email: identity.clientEmail,
  private_key_id: identity.privateKeyId, private_key: 'synthetic-private-key-never-written-or-sent-to-a-provider' };
let dir: string, source: string, sha: string, hook: string, counter = 0;
const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dev-sdk-contract-')); source = join(dir, 'source'); mkdirSync(source);
  for (const name of ['scripts', 'functions/lib', 'packages', 'config']) cpSync(resolve(name), join(source, name), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"type":"module"}');
  writeFileSync(join(source, 'functions/package.json'), '{"type":"commonjs"}');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
  symlinkSync(resolve('node_modules'), join(source, 'node_modules'), 'dir');
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'contract source'); sha = git('rev-parse', 'HEAD');
  // Closed SDK/provider boundaries: every accidental network call is refused.
  // Native argument, request, plan, identity and dispatch logic remains real.
  hook = join(dir, 'closed-boundaries.mjs');
  writeFileSync(hook, `import { registerHooks } from 'node:module';
globalThis.fetch = () => { throw new Error('Live network forbidden in SDK contract proof'); };
registerHooks({ load(url, ctx, next) {
  if (url.includes('/firebase-admin/lib/app/index.js')) return { format: 'commonjs', shortCircuit: true, source: \`
exports.applicationDefault = () => { throw new Error('Ambient ADC forbidden'); };
exports.cert = account => { if (account.clientEmail !== '${identity.clientEmail}' || account.projectId !== 'njpbs-site-dev') throw new Error('Wrong SDK account'); return { explicit: true }; };
exports.initializeApp = options => { if (options.projectId !== 'njpbs-site-dev' || !options.credential?.explicit) throw new Error('Missing explicit cert'); return options; };
exports.deleteApp = async () => {};
\` };
  if (url.includes('/firebase-admin/lib/firestore/index.js')) return { format: 'commonjs', shortCircuit: true, source: \`
exports.getFirestore = () => ({ projectId: 'njpbs-site-dev', databaseId: '(default)',
 runTransaction: async (fn, options) => { if (options?.readOnly !== true) throw new Error('Unexpected transaction'); return fn({}); } });
\` };
  if (url.endsWith('/public-release-private-install-ledger.mjs')) return { format: 'module', shortCircuit: true, source: 'export const privateInstallLedger = () => ({ bindAttempt: async () => {} });' };
  if (url.endsWith('/public-release-private-provider.mjs')) return { format: 'module', shortCircuit: true, source: \`
export class PrivateProviderNotSent extends Error {}
export const cloudflarePrivatePairProvider = () => ({});
let version = 123;
export const installPrivateWorker = async ({dryRun}) => ({ versionId: '00000000-0000-4000-8000-' + String(++version).padStart(12,'0'), dryRun });
\` };
  if (url.includes('/esbuild/lib/main.js')) return { format: 'commonjs', shortCircuit: true, source: \`
exports.build = async ({entryPoints}) => ({ metafile: {inputs:{}}, outputFiles: [{contents: Buffer.from(entryPoints[0].includes('-slot-') ? 'slot' : 'ingress')}] });
\` };
  const result = next(url, ctx);
  if (url.endsWith('/public-release-change-enrollment.js')) return { ...result, source: result.source.toString() + \`
module.exports.inspectPublicReleaseChangeEnrollment = async () => ({mode:'inspect'});
module.exports.enrollPublicReleaseChangeLog = async ({request,dryRun,readSecret}) => {
  if (readSecret?.() !== '${edgeSecret}' || Object.hasOwn(process.env, 'CMS_EDGE_ORIGIN_SECRET')) throw new Error('Wrong edge credential seam');
  // Keep the real private transport: only the HTTP boundary is replaced.
  const {createCurrentCodeTransport} = require('./current-public-code-source');
  let verified = false;
  const transport = createCurrentCodeTransport({target: require('./publication-target').publicationTarget('development'),
    rendererSha: request.expected.liveReleaseSha, readSecret, request: async (url, init) => {
      if (url !== 'https://dev-api.example.org/_internal/record-code' || init.headers['x-njpbs-cms-edge'] !== '${edgeSecret}') throw new Error('Wrong edge header');
      verified = true; return new Response('{}', {headers:{'content-type':'application/json'}});
    }});
  await transport.readCurrentCode().catch(() => {});
  if (!verified) throw new Error('CODE transport was not exercised');
  return {mode:dryRun?'dry-run':'apply',request};
};
module.exports.assertReadPublicReleaseChangeEnrollmentInTransaction = async ({requestDigest}) => ({mode:'readback',requestDigest});
\` };
  return result;
}});
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function fixture() {
  const row = join(dir, String(++counter)); mkdirSync(row);
  const put = (name: string, value: any) => { const file = join(row, name); writeFileSync(file, JSON.stringify(value)); return file; };
  const packet = { schemaVersion: 1, kind: 'development-install-sdk', operatorCommitSha: sha, credentialIdentity: { ...identity } };
  const plan = { schemaVersion: 1, operationId: 'original-slots', accountId: 'a'.repeat(32), ingressName: 'njpbs-private-ingress-development',
    oldPair: sealedPair('https://reader-old.example.test').pair,
    newPair: sealedPair('https://reader-new.example.test', releasePair('b', 'b'.repeat(40))).pair,
    developmentIngress: true, slotEnabled: [true, true], readerOrigins: ['https://reader-old.example.test', 'https://reader-new.example.test'],
    readerAccess: [0, 1].map(() => ({ enabled: true, audience: 'd'.repeat(64), clientId: 'reader123.access' })),
    slotBundleDigest: hash('slot'), ingressBundleDigest: hash('ingress') };
  const request = { schemaVersion: 1, operationId: 'original-enrollment', logEpoch: 'original-epoch', baselineDigest: 'a'.repeat(64),
    expected: { projectId: 'njpbs-site-dev', liveReleaseSha: 'a'.repeat(40), pointerDigest: 'b'.repeat(64), runtimeDigest: 'c'.repeat(64),
      contextRevision: 1, contextDigest: context.publicContextDigest(1), publicSourceCensusDigest: 'd'.repeat(64) } };
  return { row, put, packet, plan, request };
}
function run(f: ReturnType<typeof fixture>, kind: 'slots' | 'enrollment', mode: string, options: any = {}) {
  const packet = f.put('sdk.json', f.packet);
  const args = kind === 'slots' ? ['--plan', f.put('plan.json', f.plan), ...(mode === 'apply' ? ['--apply'] : [])]
    : [mode, '--project', options.projectId ?? 'njpbs-site-dev', ...(mode === 'inspect' ? [] : ['--request', f.put('request.json', f.request)])];
  args.push('--development-sdk-packet', packet, '--development-sdk-packet-digest', options.digest ?? hash(readFileSync(packet, 'utf8')));
  const credential = options.account ?? account;
  const executable = kind === 'slots' ? 'scripts/install-private-public-release.mjs' : 'scripts/enroll-public-release-change-log.mjs';
  const command = kind === 'slots' ? '"$1" --import "$2" "$3" "${@:4}" 3< <(printf %s provider-token-fixture-12345678) 4<&0'
    : '"$1" --import "$2" "$3" "${@:4}" 3<&0' + (['dry-run', 'apply'].includes(mode) ? options.edgeMissing ? ' 4<&-' : options.edgeFile ? ' 4</dev/null' : ` 4< <(printf %s '${options.edge ?? edgeSecret}')` : '');
  const result = spawnSync('bash', ['-c', options.missing ? command.replace(kind === 'slots' ? '4<&0' : '3<&0', kind === 'slots' ? '4<&-' : '3<&-') : command,
    'contract', process.execPath, hook, executable, ...args], { cwd: source, env: { PATH: process.env.PATH, CMS_DEV_SDK_CLIENT_EMAIL: identity.clientEmail, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, CMS_DEV_ACCESS_ORIGIN: process.env.CMS_DEV_ACCESS_ORIGIN, PRIVATE_INSTALL_TOKEN_FD: '3', ...options.env },
    input: JSON.stringify(credential), encoding: 'utf8', timeout: 8000 });
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(account.private_key);
  expect(result.stdout + result.stderr).not.toContain(edgeSecret);
  expect(readdirSync(f.row).sort()).toEqual(['sdk.json', ...(kind === 'slots' ? ['plan.json'] : mode === 'inspect' ? [] : ['request.json'])].sort());
  return result;
}
it('uses explicit certificates for slot apply and every enrollment mode, preserving original identities', () => {
  const f = fixture(), slot = run(f, 'slots', 'apply');
  expect(slot.status, slot.stderr).toBe(0); expect(JSON.parse(slot.stdout).operationId).toBe(f.plan.operationId);
  for (const mode of ['inspect', 'dry-run', 'apply', 'readback']) {
    const e = fixture(), result = run(e, 'enrollment', mode);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout); expect(output.mode).toBe(mode);
    if (['dry-run', 'apply'].includes(mode)) expect(output.request).toEqual(e.request);
    if (mode === 'readback') expect(output.requestDigest).toBe(protocol.publicReleaseDigest(e.request));
  }
  expect(git('status', '--porcelain')).toBe('');
});
it('plans slots without opening an SDK pipe', () => {
  const result = run(fixture(), 'slots', 'plan', { missing: true }); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).dryRun).toBe(true);
});
it.each(['slots', 'enrollment'] as const)('refuses an absent %s pipe without ADC fallback', kind => {
  expect(run(fixture(), kind, kind === 'slots' ? 'apply' : 'inspect', { missing: true }).status).toBe(1);
});
it.each(['project_id', 'client_email', 'private_key_id'])('refuses wrong credential %s for both owners', field => {
  for (const kind of ['slots', 'enrollment'] as const) {
    const result = run(fixture(), kind, kind === 'slots' ? 'apply' : 'inspect', { account: { ...account, [field]: 'wrong' } }); expect(result.status).toBe(1);
  }
});
it('refuses production targets, unapproved accounts, wrong packet digests and ambient credential settings', () => {
  const production = fixture(); production.plan.oldPair.environment = 'production';
  expect(run(production, 'slots', 'apply').status).toBe(1);
  expect(run(fixture(), 'enrollment', 'inspect', { projectId: 'njpbs-site' }).status).toBe(1);
  const unapproved = fixture(); unapproved.packet.credentialIdentity.clientEmail = 'other@njpbs-site-dev.iam.gserviceaccount.com';
  expect(run(unapproved, 'enrollment', 'inspect', { account: { ...account, client_email: unapproved.packet.credentialIdentity.clientEmail } }).status).toBe(1);
  for (const kind of ['slots', 'enrollment'] as const) {
    expect(run(fixture(), kind, kind === 'slots' ? 'apply' : 'inspect', { digest: '0'.repeat(64) }).status).toBe(1);
    expect(run(fixture(), kind, kind === 'slots' ? 'apply' : 'inspect', { env: { GOOGLE_APPLICATION_CREDENTIALS: '/unused/key.json' } }).status).toBe(1);
    expect(run(fixture(), kind, kind === 'slots' ? 'apply' : 'inspect', { env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:19340' } }).status).toBe(1);
  }
});
it('rejects a credential file descriptor and oversized input at the real pipe reader boundary', async () => {
  const f = fixture();
  const file = f.put('not-a-key.json', { nonsecret: true });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {openSync} from 'node:fs';import {developmentInstallCredential} from ${JSON.stringify(resolve('scripts/lib/development-install-credentials.mjs'))};try{developmentInstallCredential(openSync(process.argv[1],'r'),x=>x);process.exitCode=7}catch{}`, file], { encoding: 'utf8' });
  expect(child.status).toBe(0);
  const pipe = developmentInstallCredential(3, raw => operatorAccount(raw, identity), Readable.from(['x'.repeat(32769)]));
  await expect(pipe.read()).rejects.toThrow(); pipe.close();
});
it('rejects source drift before SDK/dependency evaluation', () => {
  const filename = join(source, 'scripts/enroll-public-release-change-log.mjs'), original = readFileSync(filename);
  try {
    writeFileSync(filename, Buffer.concat([original, Buffer.from('\n// source drift\n')]));
    expect(run(fixture(), 'slots', 'apply').status).toBe(1);
    expect(run(fixture(), 'enrollment', 'inspect').status).toBe(1);
  } finally { writeFileSync(filename, original); }
});

it('reads once at use and bounds a pipe that never reaches EOF', async () => {
  let reads = 0;
  const source = Readable.from((async function* () { reads++; yield JSON.stringify(account); })());
  const pipe = developmentInstallCredential(3, raw => operatorAccount(raw, identity), source);
  expect(reads).toBe(0);
  const expected = { projectId: identity.projectId, clientEmail: identity.clientEmail, privateKey: account.private_key };
  expect(await pipe.read()).toEqual(expected); expect(await pipe.read()).toEqual(expected); expect(reads).toBe(1); pipe.close();
  vi.useFakeTimers();
  const stalled = developmentInstallCredential(3, x => x, new PassThrough());
  try {
    const result = stalled.read().catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeInstanceOf(Error);
  } finally { stalled.close(); vi.useRealTimers(); }
});
it('loads the private reader operator through its documented tsx CommonJS path', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {createRequire} from 'node:module';
    const require = createRequire(import.meta.url);
    require('./site/node_modules/tsx/dist/cjs/index.cjs');
    const {runPrivateReaderOperator} = require('./site/scripts/public-release-pair-reader-operator.ts');
    if (typeof runPrivateReaderOperator !== 'function') throw new Error('Reader operator unavailable');
  `], { cwd: process.cwd(), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 8000 });
  expect(result.status, result.stderr).toBe(0);
});

const invalidEdges = [
  {name: 'missing', options: {edgeMissing: true}}, {name: 'empty', options: {edge: ''}},
  {name: 'whitespace', options: {edge: '   \n'}}, {name: 'oversized', options: {edge: 'x'.repeat(32769)}},
  {name: 'file', options: {edgeFile: true}},
  {name: 'env-only', options: {edgeMissing: true, env: {CMS_EDGE_ORIGIN_SECRET: edgeSecret}}},
  {name: 'env-and-fd', options: {env: {CMS_EDGE_ORIGIN_SECRET: edgeSecret}}},
  {name: 'empty-env-and-fd', options: {env: {CMS_EDGE_ORIGIN_SECRET: ''}}},
];
it.each(invalidEdges.flatMap(row => ['dry-run', 'apply'].map(mode => ({...row, mode}))))(
  'refuses $name edge input for $mode without outputting values', ({mode, options}) => {
    const result = run(fixture(), 'enrollment', mode, options);
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({status:'refused', code:'enrollment-failed'});
  });
