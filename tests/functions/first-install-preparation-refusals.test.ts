import { afterEach, beforeEach, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { cpSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { firstInstallCodePackFixture } from '../helpers/first-install-code-pack';
import { extractFirstInstallPairImage } from '../../site/scripts/public-release-first-install-image';
import { openFirstInstallInput } from '../../site/scripts/public-release-first-install-input';
import { repositoryFixture } from '../helpers/repository-identity.mjs';

let directory: string, operator: string, fixture: Awaited<ReturnType<typeof firstInstallCodePackFixture>>;
const developmentSdkClientEmail = 'fixture-sdk-client@njpbs-site-dev.iam.gserviceaccount.com';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'preparation-refusals-'));
  fixture = await firstInstallCodePackFixture(directory);
  operator = path.join(directory, 'operator');
  git('clone', '--shared', '--no-checkout', '--quiet', process.cwd(), operator);
  git('-C', operator, 'sparse-checkout', 'set', 'config', 'functions/lib', 'packages', 'scripts', 'site/scripts', 'site/src/lib', 'site/src/data', 'publisher');
  git('-C', operator, 'checkout', '--detach', 'HEAD');
  await symlink(path.resolve('node_modules'), path.join(operator, 'node_modules'), 'dir');
  await symlink(path.resolve('site/node_modules'), path.join(operator, 'site/node_modules'), 'dir');
});
afterEach(async () => rm(directory, { recursive: true, force: true }));
function packet(mode: string) {
  return { schemaVersion: 1, kind: 'public-release-first-install-preparation', environment: 'development',
    operatorCommitSha: git('-C', operator, 'rev-parse', 'HEAD'), sourceDirectory: fixture.sourceDirectory,
    commitSha: fixture.commitSha, directory: path.join(directory, 'new-output'),
    enrollmentRequestDigest: fixture.manifest.enrollmentRequestDigest, logBaselineDigest: fixture.manifest.logBaselineDigest,
    ...(mode === 'freeze' ? { credentialIdentity: {} } : { inputDirectory: fixture.inputDirectory, inputDigest: fixture.inputDigest }),
    ...(mode === 'extract' ? { imageId: 'sha256:' + 'a'.repeat(64) } : {}),
    ...(mode === 'build' ? { imageDirectory: path.join(directory, 'image'), imageReceiptDigest: 'd'.repeat(64) } : {}),
  };
}
async function run(mode: string, value: any = packet(mode), env: Record<string, string> = {}) {
  const filename = path.join(directory, 'private-packet.json'), bytes = JSON.stringify(value); await writeFile(filename, bytes);
  return spawnSync('bash', ['-c', 'exec "$1" "${@:2}" 3<&- 4< <(printf %s synthetic-unused-r2)', 'fixture', process.execPath, 'scripts/prepare-development-pair-code-pack.mjs', mode, '--packet', filename, '--packet-digest', hash(bytes)], {
    cwd: operator, env: { PATH: process.env.PATH, ...repositoryFixture,
      CMS_DEV_SDK_CLIENT_EMAIL: developmentSdkClientEmail, ...env },
    encoding: 'utf8', timeout: 8_000 });
}
function refused(result: ReturnType<typeof spawnSync>, stage: string, reason: string) {
  expect(result.status, String(result.stderr)).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toBe(JSON.stringify({ status: 'refused', code: 'first-install-code-pack-refused', stage, reason }) + '\n');
}
it.each(['site/scripts/public-release-first-install-freeze.ts', 'functions/lib/post-background-storage.js'])(
  'reports a real %s module-link refusal before even validating or reserving credentials', async modulePath => {
  // The protected fixture contains a real SyntaxError, committed before the
  // source gate. Invalid identity and closed pipes would fail at credentials
  // if any credential-capable work preceded native graph linking (#4631).
  await writeFile(path.join(operator, modulePath), modulePath.endsWith('.ts')
    ? 'export const = "PRIVATE_IMPORT_DETAIL";\n' : 'module.exports = ; // PRIVATE_IMPORT_DETAIL\n');
  git('-C', operator, 'add', '.'); git('-C', operator, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Module-link refusal fixture');
  refused(await run('freeze'), 'import', 'module-import-refused');
  await expect(access(path.join(directory, 'new-output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reports a credential identity refusal without printing identity or SDK errors', async () => {
  const value = { ...packet('freeze'), credentialIdentity: { projectId: 'njpbs-site-dev',
    clientEmail: 'mismatched-sdk-client@njpbs-site-dev.iam.gserviceaccount.com',
    privateKeyId: 'b'.repeat(40), secretRef: 'pass://synthetic/dev-operator' } };
  refused(await run('freeze', value), 'credential', 'credential-refused');
  await expect(access(path.join(directory, 'new-output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reports SDK opening refusal with a valid identity and closed SDK pipe before any authority call', async () => {
  const value = { ...packet('freeze'), credentialIdentity: { projectId: 'njpbs-site-dev',
    clientEmail: developmentSdkClientEmail, privateKeyId: 'b'.repeat(40), secretRef: 'pass://synthetic/dev-operator' } };
  refused(await run('freeze', value, { CLOUDFLARE_ACCOUNT_ID: '1'.repeat(32) }), 'sdk', 'sdk-open-refused');
  await expect(access(path.join(directory, 'new-output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reports an input refusal before creating output or invoking Docker', async () => {
  refused(await run('extract', { ...packet('extract'), inputDigest: '0'.repeat(64) }), 'input', 'input-refused');
  await expect(access(path.join(directory, 'new-output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves the input stage when a previously verified frozen input fails a later recheck', async () => {
  const opened = await openFirstInstallInput(fixture.inputDirectory, fixture.inputDigest);
  expect(opened.manifest.commitSha).toBe(fixture.commitSha);
  await writeFile(path.join(fixture.inputDirectory, 'input.json'), 'PRIVATE_CHANGED_INPUT');
  await expect(openFirstInstallInput(fixture.inputDirectory, fixture.inputDigest)).rejects.toMatchObject({ stage: 'input' });
});
it('reports one Docker process refusal without echoing its output or retrying it', async () => {
  const bin = path.join(directory, 'bin'), calls = path.join(directory, 'calls');
  await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), '#!/bin/bash\nprintf "invoked\\n" >> "$PREP_CALLS"\nprintf "PRIVATE_PROVIDER_BODY\\n"\nprintf "PRIVATE_PROVIDER_ERROR\\n" >&2\nexit 7\n', { mode: 0o755 });
  refused(await run('extract', packet('extract'), { PATH: bin + ':' + process.env.PATH, PREP_CALLS: calls }), 'image', 'image-refused');
  expect(await readFile(calls, 'utf8')).toBe('invoked\n');
});
it('distinguishes a build image-receipt refusal from invalid input and later build work', async () => {
  refused(await run('build'), 'image', 'image-refused');
  await expect(access(path.join(directory, 'new-output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reports guarded build preparation failure after real input and image verification', async () => {
  const imageDirectory = path.join(directory, 'image');
  const extracted = await extractFirstInstallPairImage({ ...packet('extract'), environment: 'development', directory: imageDirectory,
    inputDirectory: fixture.inputDirectory, inputDigest: fixture.inputDigest, imageId: 'sha256:' + 'a'.repeat(64) } as any, args => {
    if (args[0] === 'image') return JSON.stringify([{ Id: 'sha256:' + 'a'.repeat(64), Architecture: 'amd64', Os: 'linux' }]);
    if (args[0] === 'create' || args[0] === 'rm') return 'b'.repeat(64);
    if (args[0] === 'cp') {
      if (args[1].endsWith('/HEAD')) writeFileSync(args[2], fixture.commitSha + '\n');
      else cpSync(fixture.compiledDirectory, args[2], { recursive: true });
      return '';
    }
    throw new Error('Unexpected Docker fixture command');
  });
  refused(await run('build', { ...packet('build'), imageReceiptDigest: extracted.imageReceiptDigest }), 'build', 'build-refused');
  // The minimal target has no model/runtime dependencies. It fails at their
  // existing guarded check before an Astro build or any remote operation.
});

it.each([
  ['arguments', 'arguments', 'arguments-invalid'], ['packet', 'packet', 'packet-identity'],
  ['head', 'source', 'operator-head-mismatch'], ['operator', 'source', 'operator-tree-dirty'], ['target', 'source', 'target-tree-dirty'],
])('reports bounded %s diagnostics before module loading or output creation', async (condition, stage, reason) => {
  const value = packet('freeze');
  if (condition === 'packet') value.kind = 'untrusted-packet';
  if (condition === 'head') value.operatorCommitSha = '0'.repeat(40);
  if (condition === 'operator') {
    const filename = path.join(operator, 'functions/lib/public-release-first-install-target.js');
    await writeFile(filename, await readFile(filename, 'utf8') + '\n// tracked source drift\n');
  }
  if (condition === 'target') await writeFile(path.join(fixture.sourceDirectory, 'source.txt'), 'Changed target');
  refused(await run(condition === 'arguments' ? 'unsupported' : 'freeze', value), stage, reason);
  await expect(access(path.join(directory, 'new-output'))).rejects.toMatchObject({ code: 'ENOENT' });
});
