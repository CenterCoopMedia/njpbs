import { afterAll, beforeAll, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

let directory: string, source: string, sha: string;
const developmentSdkClientEmail = 'fixture-sdk-client@njpbs-site-dev.iam.gserviceaccount.com';
const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', source, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'native-sdk-refusals-')); source = join(directory, 'source'); mkdirSync(source);
  for (const name of ['config', 'scripts', 'functions/lib', 'packages']) cpSync(resolve(name), join(source, name), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"type":"module"}');
  writeFileSync(join(source, 'functions/package.json'), '{"type":"commonjs"}');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
  symlinkSync(resolve('node_modules'), join(source, 'node_modules'));
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Native operator fixture');
  sha = git('rev-parse', 'HEAD');
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const commands = [
  ['enroll-public-release-change-log.mjs', 'development'],
  ['enroll-public-release-change-log.mjs', 'production'],
  ['install-private-public-release.mjs', 'development'],
] as const;
// The refusal vocabulary is specified by #4612. All cases execute the real
// launchers; only Git's process reply is substituted for an unavailable source
// or inconsistent tree (a normal immutable SHA cannot change its own tree).
const cases = [
  ['arguments', 'sdk-packet-arguments'], ['mixed', 'sdk-packet-arguments'], ['orphan-digest', 'sdk-packet-arguments'],
  ['read', 'sdk-packet-read'], ['empty', 'sdk-packet-size'], ['large', 'sdk-packet-size'],
  ['digest', 'sdk-packet-digest'], ['json', 'sdk-packet-json'], ['utf8', 'sdk-packet-json'],
  ['identity', 'sdk-packet-identity'], ['credential-identity', 'sdk-packet-identity'],
  ['operator-type', 'sdk-packet-identity'], ['key-type', 'sdk-packet-identity'], ['ref-type', 'sdk-packet-identity'],
  ['project', 'sdk-packet-project-mismatch'], ['head', 'operator-head-mismatch'],
  ['tracked', 'operator-tree-dirty'], ['untracked', 'operator-tree-dirty'],
  ['tree', 'operator-tree-mismatch'], ['git', 'operator-source-unavailable'],
] as const;
for (const [command, environment] of commands) it.each(cases)(`${command} ${environment} refuses %s with a fixed safe code`, (condition, expected) => {
  const row = mkdtempSync(join(directory, 'case-')), projectId = environment === 'production' ? 'njpbs-site' : 'njpbs-site-dev';
  const packet = { schemaVersion: 1, kind: `${environment}-install-sdk`, operatorCommitSha: sha,
    credentialIdentity: { projectId, clientEmail: environment === 'production' ? 'install-operator@njpbs-site.iam.gserviceaccount.com'
      : developmentSdkClientEmail, privateKeyId: 'c'.repeat(40), secretRef: 'pass://synthetic/private-identity' } };
  if (condition === 'identity') packet.kind = 'other-sdk';
  if (condition === 'credential-identity') packet.credentialIdentity.privateKeyId = 'untrusted-value';
  if (condition === 'operator-type') Object.assign(packet, { operatorCommitSha: { toString: 'synthetic-invalid-type' } });
  if (condition === 'key-type') Object.assign(packet.credentialIdentity, { privateKeyId: { toString: 'synthetic-invalid-type' } });
  if (condition === 'ref-type') Object.assign(packet.credentialIdentity, { secretRef: { toString: 'synthetic-invalid-type' } });
  if (condition === 'project') packet.credentialIdentity.projectId = 'another-project';
  if (condition === 'head') packet.operatorCommitSha = '0'.repeat(40);
  const bytes = condition === 'empty' ? '' : condition === 'large' ? 'x'.repeat(16_385) : condition === 'json' ? '{private-input'
    : condition === 'utf8' ? Buffer.from([0xff]) : JSON.stringify(packet);
  const filename = join(row, 'private-packet.json'); if (condition !== 'read') writeFileSync(filename, bytes);
  const flag = `--${environment}-sdk-packet`;
  const args = [flag, filename, `${flag}-digest`, condition === 'digest' ? '0'.repeat(64) : hash(bytes)];
  if (condition === 'arguments') args.push('--extra');
  if (condition === 'mixed') args.unshift(`--${environment === 'production' ? 'development' : 'production'}-sdk-packet`, 'unused');
  if (condition === 'orphan-digest') args.splice(0, 2);
  const tracked = join(source, 'scripts', command), original = readFileSync(tracked), untracked = join(source, 'private-untracked-input');
  const bin = join(row, 'bin'); mkdirSync(bin);
  if (condition === 'git' || condition === 'tree') writeFileSync(join(bin, 'git'), condition === 'git' ? '#!/bin/bash\nexit 2\n'
    : `#!/bin/bash\nif [[ "\${!#}" == '${sha}^{tree}' ]]; then printf '%s\\n' '${'f'.repeat(40)}'; else exec /usr/bin/git "$@"; fi\n`, { mode: 0o755 });
  try {
    if (condition === 'tracked') writeFileSync(tracked, Buffer.concat([original, Buffer.from('\n// source drift\n')]));
    if (condition === 'untracked') writeFileSync(untracked, 'private fixture');
    const result = spawnSync(process.execPath, ['scripts/' + command, ...args], { cwd: source,
      env: { PATH: bin + ':' + process.env.PATH,
        ...(environment === 'development' ? { CMS_DEV_SDK_CLIENT_EMAIL: developmentSdkClientEmail } : {}) },
      encoding: 'utf8', timeout: 4_000 });
    expect(result.status, result.stderr).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toBe(JSON.stringify({ status: 'refused', code: expected }) + '\n');
  } finally {
    if (condition === 'tracked') writeFileSync(tracked, original);
    if (condition === 'untracked') rmSync(untracked);
  }
});
it.each(['enroll-public-release-change-log.mjs', 'install-private-public-release.mjs'])(
  '%s refuses a missing or mismatched configured development SDK identity before authority access', command => {
    for (const configured of [undefined, 'other-sdk-client@njpbs-site-dev.iam.gserviceaccount.com']) {
      const row = mkdtempSync(join(directory, 'configured-identity-')), filename = join(row, 'sdk.json');
      const bytes = JSON.stringify({ schemaVersion: 1, kind: 'development-install-sdk', operatorCommitSha: sha,
        credentialIdentity: { projectId: 'njpbs-site-dev', clientEmail: developmentSdkClientEmail,
          privateKeyId: 'c'.repeat(40), secretRef: 'pass://synthetic/private-identity' } });
      writeFileSync(filename, bytes);
      const args = command.startsWith('enroll-') ? ['inspect', '--project', 'njpbs-site-dev'] : ['--plan', join(row, 'unused-plan.json')];
      args.push('--development-sdk-packet', filename, '--development-sdk-packet-digest', hash(bytes));
      const result = spawnSync(process.execPath, ['scripts/' + command, ...args], { cwd: source,
        env: { PATH: process.env.PATH, ...(configured ? { CMS_DEV_SDK_CLIENT_EMAIL: configured } : {}) },
        encoding: 'utf8', timeout: 4_000 });
      expect(result.status, result.stderr).toBe(1); expect(result.stdout).toBe('');
      expect(result.stderr).toBe('{"status":"refused","code":"sdk-packet-identity"}\n');
    }
  });
it('refuses production without an explicit SDK packet before SDK or credential access', () => {
  const result = spawnSync(process.execPath, ['scripts/enroll-public-release-change-log.mjs', 'inspect', '--project', 'njpbs-site'], {
    cwd: source, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 4_000 });
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toBe('{"status":"refused","code":"sdk-packet-required"}\n');
});
it.each([['read', 'enrollment-request-read'], ['empty', 'enrollment-request-size'], ['large', 'enrollment-request-size'],
  ['json', 'enrollment-request-json']] as const)('refuses enrollment request %s before any credential use', (condition, expected) => {
  const filename = join(mkdtempSync(join(directory, 'request-')), 'private-request.json');
  if (condition !== 'read') writeFileSync(filename, condition === 'empty' ? '' : condition === 'large' ? 'x'.repeat(16_385) : '{private-input');
  const result = spawnSync(process.execPath, ['scripts/enroll-public-release-change-log.mjs', 'dry-run', '--project', 'demo-njpbs', '--request', filename], {
    cwd: source, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 4_000 });
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toBe(JSON.stringify({ status: 'refused', code: expected }) + '\n');
});

it.each([{ GOOGLE_APPLICATION_CREDENTIALS: '/unused/key.json' }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:19340' },
  { GCLOUD_PROJECT: 'another-project' }])('identifies an ambient or mixed development SDK environment before pipe use: %j', env => {
  const row = mkdtempSync(join(directory, 'environment-')), filename = join(row, 'sdk.json');
  const bytes = JSON.stringify({ schemaVersion: 1, kind: 'development-install-sdk', operatorCommitSha: sha,
    credentialIdentity: { projectId: 'njpbs-site-dev', clientEmail: developmentSdkClientEmail,
      privateKeyId: 'c'.repeat(40), secretRef: 'pass://synthetic/private-identity' } });
  writeFileSync(filename, bytes);
  const result = spawnSync(process.execPath, ['scripts/enroll-public-release-change-log.mjs', 'inspect', '--project', 'njpbs-site-dev',
    '--development-sdk-packet', filename, '--development-sdk-packet-digest', hash(bytes)], {
    cwd: source, env: { PATH: process.env.PATH, CMS_DEV_SDK_CLIENT_EMAIL: developmentSdkClientEmail, ...env },
    encoding: 'utf8', timeout: 4_000 });
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toBe('{"status":"refused","code":"sdk-environment-refused"}\n');
});
