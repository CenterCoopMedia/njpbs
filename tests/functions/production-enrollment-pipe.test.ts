import { afterAll, beforeAll, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseBaselineCodeFixture } from '../helpers/public-release-baseline-code';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import deployment from '../../functions/lib/public-deployment.js';
import adoption from '../../functions/lib/public-release-bootstrap-adoption.js';
import pause from '../../functions/lib/dev-public-release-pause.js';

const raw = isolatedFirestore('production-enrollment-pipe');
const firestore = new Proxy(raw, { get(target, key) { if (key === 'projectId') return 'njpbs-site';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
const identity = { projectId: 'njpbs-site', clientEmail: 'install-operator@njpbs-site.iam.gserviceaccount.com',
  privateKeyId: 'c'.repeat(40), secretRef: 'pass://production/install' };
const account = { type: 'service_account', project_id: identity.projectId, client_email: identity.clientEmail,
  private_key_id: identity.privateKeyId, private_key: 'synthetic-credential-for-closed-sdk-boundary-only' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let directory: string, source: string, sha: string, hook: string, request: any, sequence = 0;
const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'production-enrollment-')); source = join(directory, 'source'); mkdirSync(source);
  for (const name of ['scripts', 'functions/lib', 'packages', 'config']) cpSync(resolve(name), join(source, name), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"type":"module"}');
  writeFileSync(join(source, 'functions/package.json'), '{"type":"commonjs"}');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n'); symlinkSync(resolve('node_modules'), join(source, 'node_modules'));
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Protected operator fixture'); sha = git('rev-parse', 'HEAD');
  const release = 'a'.repeat(40), operationId = 'production-original-enrollment';
  await raw.doc('system/publicDeployment').set({ ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true,
    activeGeneration: 1, activeDeploymentId: 'original-release', activeCommitSha: release, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: 'original-release' });
  const oldRuntime = { schemaVersion: 1, phase: 'ready', commitSha: release, serializerId: 'cloudflare-publisher' };
  await raw.doc('system/cmsPublicationRuntime').set(oldRuntime);
  await raw.doc('system/publicDeployment/contexts/public').set({ schemaVersion: 1, revision: 1 });
  await pause.pausePublicRelease({ firestore, attempt: { schemaVersion: 1, operationId, environment: 'production',
    projectId: firestore.projectId, oldRuntime,
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest((await raw.doc('system/publicDeployment').get()).data()) } });
  const code = publicReleaseBaselineCodeFixture(firestore, release);
  const observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore });
  request = { schemaVersion: 1, operationId, logEpoch: 'production-epoch', baselineDigest: 'f'.repeat(64), expected: observed.expected };
  const qualified = code.qualified;
  hook = join(directory, 'sdk-network-boundary.mjs');
  // Only vendor connection/certificate and HTTP boundaries are substituted.
  // Enrollment, packet/source gates, account parser and transactions stay real.
  writeFileSync(hook, `import {registerHooks,createRequire} from 'node:module';
import {appendFileSync} from 'node:fs';
const require=createRequire(process.cwd()+'/package.json');
const {Firestore}=require('@google-cloud/firestore');
const database=new Firestore({projectId:${JSON.stringify(raw.projectId)},host:${JSON.stringify(process.env.FIRESTORE_EMULATOR_HOST)},ssl:false});
globalThis.__testDatabase=new Proxy(database,{get(t,k){if(k==='projectId')return 'njpbs-site';const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
const record=x=>appendFileSync(process.env.TEST_EVENTS,x+'\\n');
globalThis.__testRecord=record; globalThis.__testClose=()=>database.terminate();
process.once('beforeExit',()=>{void database.terminate();});
globalThis.fetch=async(url,init)=>{
 if(String(url)!=='https://api.example.org/_internal/record-code'||init.headers['x-njpbs-cms-edge']!=='synthetic-edge')throw new Error('Unexpected network');
 record('code');return new Response(JSON.stringify({schemaVersion:1,kind:'current-code',reference:${JSON.stringify(qualified.reference)},bytes:${JSON.stringify(Buffer.from(JSON.stringify(qualified.publicContext)).toString('base64'))}}),{headers:{'content-type':'application/json'}});
};
registerHooks({load(url,ctx,next){
 if(url.includes('/firebase-admin/lib/app/index.js'))return {format:'commonjs',shortCircuit:true,source:\`
exports.applicationDefault=()=>{throw new Error('ADC forbidden');};
exports.cert=account=>{if(account.projectId!=='njpbs-site'||account.clientEmail!==${JSON.stringify(identity.clientEmail)})throw new Error('Wrong certificate');globalThis.__testRecord('cert');return {explicit:true};};
exports.initializeApp=options=>{if(options.projectId!=='njpbs-site'||!options.credential?.explicit)throw new Error('Ambient app forbidden');globalThis.__testRecord('init');return options;};
exports.deleteApp=async()=>{globalThis.__testRecord('close');await globalThis.__testClose();};
\`};
 if(url.includes('/firebase-admin/lib/firestore/index.js'))return {format:'commonjs',shortCircuit:true,source:\`
const sdk=require('@google-cloud/firestore');exports.Timestamp=sdk.Timestamp;exports.FieldValue=sdk.FieldValue;exports.FieldPath=sdk.FieldPath;exports.Firestore=sdk.Firestore;
exports.getFirestore=()=>globalThis.__testDatabase;
\`};
 return next(url,ctx);
}});
`);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(mode: string, options: any = {}) {
  const row = join(directory, String(++sequence)); mkdirSync(row);
  const packet = { schemaVersion: 1, kind: 'production-install-sdk', operatorCommitSha: options.sha ?? sha,
    credentialIdentity: { ...identity, ...options.identity } };
  const bytes = JSON.stringify(packet), filename = join(row, 'sdk.json'), requestFile = join(row, 'request.json');
  writeFileSync(filename, bytes); writeFileSync(requestFile, JSON.stringify(request));
  const events = join(row, 'events');
  const args = [mode, '--project', options.project ?? 'njpbs-site', ...(mode === 'inspect' ? [] : ['--request', requestFile]),
    ...(options.noPacket ? [] : ['--production-sdk-packet', filename, '--production-sdk-packet-digest', options.digest ?? hash(bytes)])];
  const command = '"$1" --import "$2" scripts/enroll-public-release-change-log.mjs "${@:3}" ' +
    (options.missing ? '3<&-' : '3<&0') + (['apply', 'dry-run'].includes(mode) ? options.noEdge ? ' 4<&-' : ' 4< <(printf %s synthetic-edge)' : '');
  const result = spawnSync('bash', ['-c', command, 'fixture', process.execPath, hook, ...args], { cwd: source,
    env: { PATH: process.env.PATH, TEST_EVENTS: events, METADATA_SERVER_DETECTION: 'none', ...options.env },
    input: JSON.stringify(options.account ?? account), encoding: 'utf8', timeout: 10_000 });
  return { ...result, events: (() => { try { return readFileSync(events, 'utf8').trim().split('\n'); } catch { return []; } })() };
}

it('inspects and dry-runs real production enrollment through explicit SDK/edge pipes without writes', async () => {
  const inspect = run('inspect'); expect(inspect.status, inspect.stderr).toBe(0);
  expect(JSON.parse(inspect.stdout).expected.projectId).toBe('njpbs-site'); expect(inspect.events).toEqual(['cert', 'init', 'close']);
  const dry = run('dry-run'); expect(dry.status, dry.stderr).toBe(0);
  expect(JSON.parse(dry.stdout).status).toBe('dry-run'); expect(dry.events).toContain('code');
  expect((await raw.doc(enrollment.ENROLLMENT_PATH).get()).exists).toBe(false);
});
it('applies and reads back only the original native atomic receipt', async () => {
  const applied = run('apply'); expect(applied.status, applied.stderr).toBe(0);
  const receipt = JSON.parse(applied.stdout); expect(receipt.status).toBe('enrolled');
  const readback = run('readback'); expect(readback.status, readback.stderr).toBe(0);
  expect(JSON.parse(readback.stdout).receiptDigest).toBe(receipt.receiptDigest); expect(readback.events).not.toContain('code');
  const repeated = run('apply'); expect(repeated.status, repeated.stderr).toBe(0); expect(JSON.parse(repeated.stdout).idempotent).toBe(true);
});
// #4612 requires fixed codes for packet/source/project refusals. Credential
// failures keep their existing bounded fallback; no native effect is retried.
it.each([
  { options: { missing: true }, expected: 'enrollment-failed' },
  { options: { noPacket: true }, expected: 'sdk-packet-required' },
  { options: { noEdge: true }, expected: 'enrollment-failed' },
  { options: { project: 'njpbs-site-dev' }, expected: 'enrollment-project-mismatch' },
  { options: { sha: '0'.repeat(40) }, expected: 'operator-head-mismatch' },
  { options: { digest: '0'.repeat(64) }, expected: 'sdk-packet-digest' },
  { options: { identity: { projectId: 'njpbs-site-dev' } }, expected: 'sdk-packet-project-mismatch' },
  { options: { account: { ...account, private_key_id: 'd'.repeat(40) } }, expected: 'enrollment-failed' },
  { options: { account: { ...account, client_email: 'other@njpbs-site.iam.gserviceaccount.com' } }, expected: 'enrollment-failed' },
  { options: { env: { GOOGLE_APPLICATION_CREDENTIALS: '/unused' } }, expected: 'sdk-environment-refused' },
  { options: { env: { STORAGE_EMULATOR_HOST: 'http://127.0.0.1:1' } }, expected: 'sdk-environment-refused' },
])('refuses invalid/mixed/ambient input before any native authority operation: %j', ({ options, expected }) => {
  const result = run('dry-run', options); expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.events).toEqual([]); expect(JSON.parse(result.stderr)).toEqual({ status: 'refused', code: expected });
});
it('rejects tracked-source drift before opening the SDK or credential stream', () => {
  const filename = join(source, 'scripts/enroll-public-release-change-log.mjs'), original = readFileSync(filename);
  try {
    writeFileSync(filename, Buffer.concat([original, Buffer.from('\n// tracked drift\n')]));
    const result = run('inspect'); expect(result.status).toBe(1); expect(result.events).toEqual([]);
    expect(result.stdout).toBe(''); expect(JSON.parse(result.stderr)).toEqual({ status: 'refused', code: 'operator-tree-dirty' });
  } finally { writeFileSync(filename, original); }
});
