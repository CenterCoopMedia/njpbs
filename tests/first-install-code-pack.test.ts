import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, symlink, mkdir, access, chmod, truncate } from 'node:fs/promises';
import { cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { firstInstallCodePackFixture } from './helpers/first-install-code-pack';
import { sealFirstInstallPairCodePack } from '../site/scripts/public-release-first-install-seal';
import { openFirstInstallInput } from '../site/scripts/public-release-first-install-input';
import { extractFirstInstallPairImage, prepareFirstInstallPairImage } from '../site/scripts/public-release-first-install-image';
import { buildFirstInstallPublicReleasePair } from '../site/scripts/public-release-first-install-build';
import { firstInstallFile, firstInstallInventory } from '../site/scripts/public-release-first-install-files';
import { parseFirstInstallPreparationPacket } from '../scripts/prepare-development-pair-code-pack.mjs';
import { firstInstallPublicationTarget } from '../functions/lib/public-release-first-install-target.js';
import { freezeRetainedPublicImages } from '../site/scripts/retained-public-images';
import { publicBuildSettings, imageBuildEnvironment } from './helpers/first-install-build-settings';

let directory: string, fixture: Awaited<ReturnType<typeof firstInstallCodePackFixture>>;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'first-install-pack-')); fixture = await firstInstallCodePackFixture(directory); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const seal = () => sealFirstInstallPairCodePack({ commitSha: fixture.commitSha, rendererDigest: fixture.rendererDigest,
  environment: fixture.manifest.environment,
  sourceInputs: fixture.sourceInputs, artifactReceipt: fixture.artifactReceipt, distDirectory: fixture.distDirectory,
  compiledDirectory: fixture.compiledDirectory, directory: fixture.artifactDirectory });
const extract = (output: string) => extractFirstInstallPairImage({ environment: 'development', operatorCommitSha: fixture.commitSha,
  sourceDirectory: fixture.sourceDirectory, commitSha: fixture.commitSha, directory: output,
  inputDirectory: fixture.inputDirectory, inputDigest: fixture.inputDigest, imageId: 'sha256:' + 'a'.repeat(64),
  enrollmentRequestDigest: fixture.manifest.enrollmentRequestDigest, logBaselineDigest: fixture.manifest.logBaselineDigest }, args => {
  if (args[0] === 'image') return JSON.stringify([{ Id: 'sha256:' + 'a'.repeat(64), Architecture: 'amd64', Os: 'linux' }]);
  if (args[0] === 'create' || args[0] === 'rm') return 'b'.repeat(64);
  if (args[0] === 'cp') {
    if (args[1].endsWith('/HEAD')) writeFileSync(args[2], fixture.commitSha + '\n');
    else cpSync(fixture.compiledDirectory, args[2], { recursive: true });
    return '';
  }
  throw new Error('Unexpected Docker operation');
});

it.each(['development', 'production'] as const)('creates the %s first prepared artifact and native code digest from complete real files without a supplied digest', async environment => {
  if (environment === 'production') {
    const parent = path.join(directory, 'production'); await mkdir(parent);
    fixture = await firstInstallCodePackFixture(parent, environment);
  }
  const { pack, preparedArtifact } = await seal();
  expect(preparedArtifact.commitSha).toBe(fixture.commitSha);
  expect(preparedArtifact.artifactReceiptDigest).toBe(hash(JSON.stringify(fixture.artifactReceipt)));
  const canonical = pack.manifest.members.map(member => ({ path: member.path, mime: member.mime, size: member.size,
    sha256: member.sha256, family: member.family, source: member.source, dynamic: member.dynamic }));
  expect(pack.manifest.codeAssetManifestDigest).toBe(hash(JSON.stringify(canonical)));
  for (const name of ['/wiki/index.html', '/schedule/downloads/nj-pbs-schedule.pdf', '/schedule/downloads/schedule.json',
    '/pagefind/pagefind.js', '/api/v1/content.json', '/_pair-compiled/pair-source-inputs.json']) {
    expect(pack.manifest.members.some(row => row.path === name)).toBe(true);
  }
  for (const member of pack.manifest.members) expect(hash(await pack.readMember(member.path))).toBe(member.sha256);
});

it.each(['source-inputs', 'graph', 'source', 'context', 'missing-wiki'])('refuses %s without accepting a partial first seal', async kind => {
  if (kind === 'source-inputs') await writeFile(path.join(fixture.compiledDirectory, 'pair-source-inputs.json'), '{}');
  if (kind === 'graph') await writeFile(path.join(fixture.compiledDirectory, 'server/entry.mjs'), 'changed');
  if (kind === 'source') fixture.artifactReceipt.commitSha = 'e'.repeat(40);
  if (kind === 'context') await writeFile(path.join(fixture.artifactDirectory, 'public-context.json'), '{}');
  if (kind === 'missing-wiki') await rm(path.join(fixture.distDirectory, 'wiki'), { recursive: true });
  await expect(seal()).rejects.toThrow();
});

it('reopens only the exact exported source and refuses changed source bodies, public input or symlink aliases', async () => {
  const opened = await openFirstInstallInput(fixture.inputDirectory, fixture.inputDigest);
  expect(opened.sourceInputs).toEqual(fixture.sourceInputs);
  await writeFile(path.join(fixture.inputDirectory, 'input.json'), '{}');
  await expect(openFirstInstallInput(fixture.inputDirectory, fixture.inputDigest)).rejects.toThrow();
  const target = path.join(directory, 'original.json'); await writeFile(target, '{}');
  await symlink(target, path.join(fixture.inputDirectory, 'alias.json'));
  await expect(firstInstallFile(fixture.inputDirectory, 'alias.json')).rejects.toThrow();
});

it('refuses cross-environment input and an environment relabel with the original enrollment project', async () => {
  await expect(openFirstInstallInput(fixture.inputDirectory, fixture.inputDigest, {
    environment: 'production', enrollmentRequestDigest: fixture.manifest.enrollmentRequestDigest,
    logBaselineDigest: fixture.manifest.logBaselineDigest,
  })).rejects.toThrow();
  const manifest = JSON.stringify({ ...fixture.manifest, environment: 'production', publicBuildSettings }) + '\n';
  await writeFile(path.join(fixture.inputDirectory, 'first-install-input.json'), manifest);
  await expect(openFirstInstallInput(fixture.inputDirectory, hash(manifest))).rejects.toThrow();
});

it('retains the existing 25 MiB image contract while keeping other inputs within 16 MiB', async () => {
  const input = path.join(directory, 'image-input'); await mkdir(input);
  await writeFile(path.join(input, 'input.json'), JSON.stringify({ programs: [{ keyArt: {
    url: 'https://media.njpbs.org/cms-media/fixture/original.webp', mimeType: 'image/webp', width: 640, height: 360,
  } }] }));
  const bytes = Buffer.alloc(25 * 1024 * 1024), imagePath = 'images/' + hash(bytes);
  await freezeRetainedPublicImages(input, { buildBatchId: 'image-boundary', commitSha: fixture.commitSha },
    async () => new Response(bytes, { headers: { 'content-type': 'image/webp' } }));
  expect(await firstInstallInventory(input)).toContainEqual({ path: imagePath, size: bytes.length, sha256: hash(bytes) });
  const ordinary = path.join(input, 'oversize.json'); await writeFile(ordinary, ''); await truncate(ordinary, 16 * 1024 * 1024 + 1);
  await expect(firstInstallInventory(input)).rejects.toThrow();
  await rm(ordinary);
  await truncate(path.join(input, imagePath), 25 * 1024 * 1024 + 1);
  await expect(firstInstallInventory(input)).rejects.toThrow();
});

it('exports the exact local image graph without running the image or assuming reproducible builds', async () => {
  // Docker is the process boundary. Its fixture copies real sealed graph files;
  // all extraction, source-input and graph verifiers run unchanged.
  const result = await extract(path.join(directory, 'image'));
  expect(result.files).toEqual(await firstInstallInventory(fixture.compiledDirectory));
  expect(result.rendererDigest).toBe(fixture.rendererDigest);
  expect(result.localImageId).toBe('sha256:' + 'a'.repeat(64));
  expect(await readFile(path.join(result.compiledDirectory, 'pair-source-inputs.json'))).toEqual(Buffer.from(fixture.sourceInputs));
});

it.each(['enrollmentRequestDigest', 'logBaselineDigest'] as const)('binds the requested %s before any image or build side effect', async field => {
  const imageDirectory = path.join(directory, 'valid-image'), image = await extract(imageDirectory);
  const options = { environment: 'development' as const, operatorCommitSha: fixture.commitSha,
    sourceDirectory: fixture.sourceDirectory, commitSha: fixture.commitSha,
    inputDirectory: fixture.inputDirectory, inputDigest: fixture.inputDigest,
    enrollmentRequestDigest: fixture.manifest.enrollmentRequestDigest, logBaselineDigest: fixture.manifest.logBaselineDigest,
    [field]: '0'.repeat(64) };
  const context = path.join(directory, 'wrong-context'), extracted = path.join(directory, 'wrong-image'), output = path.join(directory, 'wrong-build');
  await expect(prepareFirstInstallPairImage({ ...options, directory: context })).rejects.toThrow();
  await expect(extractFirstInstallPairImage({ ...options, directory: extracted, imageId: image.localImageId }, () => {
    throw new Error('Docker must not run for the wrong baseline');
  })).rejects.toThrow();
  // This is a valid, natively verified image receipt/graph. With the binding
  // removed, build would create its result before reaching the absent model.
  await expect(buildFirstInstallPublicReleasePair({ ...options, directory: output, imageDirectory,
    imageReceiptDigest: image.imageReceiptDigest })).rejects.toThrow();
  for (const created of [context, extracted, output]) await expect(access(created)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('binds each CLI to one reviewed target and rejects incomplete build authority', () => {
  const packet = { schemaVersion: 1, kind: 'public-release-first-install-preparation', environment: 'development',
    operatorCommitSha: fixture.commitSha, sourceDirectory: fixture.sourceDirectory, commitSha: fixture.commitSha,
    directory: path.join(directory, 'result'), enrollmentRequestDigest: fixture.manifest.enrollmentRequestDigest,
    logBaselineDigest: fixture.manifest.logBaselineDigest, inputDirectory: fixture.inputDirectory, inputDigest: fixture.inputDigest,
    imageDirectory: path.join(directory, 'image'), imageReceiptDigest: 'a'.repeat(64) };
  expect(parseFirstInstallPreparationPacket('build', packet)).toEqual(packet);
  expect(firstInstallPublicationTarget('production').projectId).toBe('njpbs-site');
  expect(() => parseFirstInstallPreparationPacket('build', { ...packet, environment: 'production' })).toThrow();
  expect(parseFirstInstallPreparationPacket('build', { ...packet, environment: 'production', publicBuildSettings }, 'production').environment).toBe('production');
  expect(() => parseFirstInstallPreparationPacket('build', { ...packet, codeAssetManifestDigest: 'b'.repeat(64) })).toThrow();
  expect(() => parseFirstInstallPreparationPacket('build', { ...packet, imageReceiptDigest: '' })).toThrow();
});

it('keeps actual CLI refusal bounded before loading a credential or SDK', async () => {
  const packet = path.join(directory, 'packet.json'); await writeFile(packet, '{}');
  const result = await promisify(execFile)(process.execPath, ['scripts/prepare-development-pair-code-pack.mjs', 'freeze',
    '--packet', packet, '--packet-digest', hash('{}')], { env: { PATH: process.env.PATH }, cwd: process.cwd() }).catch(error => error);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toEqual({ status: 'refused', code: 'first-install-code-pack-refused', stage: 'packet', reason: 'packet-identity' });
});

it.each(['development', 'production'] as const)('runs the actual successful %s CLI with real mixed ESM/CommonJS TypeScript modules after its trust gate', async environment => {
  if (environment === 'production') {
    const parent = path.join(directory, 'production'); await mkdir(parent);
    fixture = await firstInstallCodePackFixture(parent, environment);
  }
  const operator = path.join(directory, 'operator'), image = path.join(directory, 'cli-image'), bin = path.join(directory, 'bin');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
  // A clean local snapshot is the command's real operator boundary. Sparse
  // checkout keeps the modules unchanged without copying unrelated assets.
  git('clone', '--shared', '--no-checkout', '--quiet', process.cwd(), operator);
  git('-C', operator, 'sparse-checkout', 'set', 'config', 'functions/lib', 'packages', 'scripts', 'site/scripts', 'site/src/lib', 'site/src/data');
  git('-C', operator, 'checkout', '--detach', 'HEAD');
  await symlink(path.resolve('node_modules'), path.join(operator, 'node_modules'), 'dir');
  await symlink(path.resolve('site/node_modules'), path.join(operator, 'site/node_modules'), 'dir');
  await mkdir(bin);
  const docker = path.join(bin, 'docker');
  // Only the external Docker process is a fixture. Native imports, inventory,
  // exact-source checks and graph verification execute from the real snapshot.
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2), image = 'sha256:' + 'a'.repeat(64);
if (args[0] === 'image') console.log(JSON.stringify([{Id:image,Architecture:'amd64',Os:'linux'}]));
else if (args[0] === 'create' || args[0] === 'rm') console.log('b'.repeat(64));
else if (args[0] === 'cp') {
  if (args[1].endsWith('/public-build-environment.json')) fs.writeFileSync(args[2], process.env.PB5_TEST_PUBLIC_ENV);
  else if (args[1].endsWith('/HEAD')) fs.writeFileSync(args[2], process.env.PB5_TEST_SOURCE_SHA + '\\n');
  else fs.cpSync(process.env.PB5_TEST_COMPILED, args[2], {recursive:true});
} else process.exit(1);
`);
  await chmod(docker, 0o700);
  const packet = { schemaVersion: 1, kind: 'public-release-first-install-preparation', environment,
    ...(environment === 'production' ? { publicBuildSettings } : {}),
    operatorCommitSha: git('-C', operator, 'rev-parse', 'HEAD'), sourceDirectory: fixture.sourceDirectory, commitSha: fixture.commitSha,
    directory: image, enrollmentRequestDigest: fixture.manifest.enrollmentRequestDigest, logBaselineDigest: fixture.manifest.logBaselineDigest,
    inputDirectory: fixture.inputDirectory, inputDigest: fixture.inputDigest, imageId: 'sha256:' + 'a'.repeat(64) };
  const filename = path.join(directory, 'cli-packet.json'), bytes = JSON.stringify(packet); await writeFile(filename, bytes);
  const result = await promisify(execFile)(process.execPath, [path.join(operator, `scripts/prepare-${environment}-pair-code-pack.mjs`),
    'extract', '--packet', filename, '--packet-digest', hash(bytes)], { cwd: operator,
    env: { PATH: bin + path.delimiter + process.env.PATH, PB5_TEST_COMPILED: fixture.compiledDirectory, PB5_TEST_SOURCE_SHA: fixture.commitSha,
      PB5_TEST_PUBLIC_ENV: JSON.stringify(imageBuildEnvironment) + '\n' } });
  expect(result.stderr).toBe('');
  const receipt = JSON.parse(result.stdout);
  expect(receipt.localImageId).toBe(packet.imageId);
  expect(receipt.rendererDigest).toBe(fixture.rendererDigest);
  expect(await readFile(path.join(receipt.compiledDirectory, 'pair-source-inputs.json'))).toEqual(Buffer.from(fixture.sourceInputs));
});

it.each(['dirty-operator', 'wrong-operator', 'dirty-target'])('rejects %s before evaluating repository code or a loader', async kind => {
  const operator = path.join(directory, 'operator'), marker = path.join(directory, 'evaluated');
  await mkdir(path.join(operator, 'scripts'), { recursive: true });
  await mkdir(path.join(operator, 'functions/lib'), { recursive: true });
  const entry = path.join(operator, 'scripts/prepare-development-pair-code-pack.mjs');
  await writeFile(entry, await readFile('scripts/prepare-development-pair-code-pack.mjs'));
  await writeFile(path.join(operator, 'scripts/prepare-first-install-pair-code-pack.mjs'),
    await readFile('scripts/prepare-first-install-pair-code-pack.mjs'));
  await mkdir(path.join(operator, 'config'), { recursive: true });
  await writeFile(path.join(operator, 'config/development-inputs.json'), await readFile('config/development-inputs.json'));
  await writeFile(path.join(operator, 'scripts/render-development-config.mjs'), await readFile('scripts/render-development-config.mjs'));
  // Deliberately untrusted source sentinel: it must never evaluate before the
  // real built-in source gate. This tests the Git/process trust boundary.
  const business = path.join(operator, 'functions/lib/public-release-first-install-target.js');
  const payload = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'evaluated'); throw new Error('Untrusted source ran');`;
  await writeFile(business, payload);
  const git = (...args: string[]) => execFileSync('git', ['-C', operator, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'Operator trust fixture');
  const sha = git('rev-parse', 'HEAD');
  if (kind === 'dirty-operator') await writeFile(business, payload + '\n// Changed tracked source\n');
  if (kind === 'dirty-target') await writeFile(path.join(fixture.sourceDirectory, 'source.txt'), 'Changed target source');
  const packet = { schemaVersion: 1, kind: 'public-release-first-install-preparation', environment: 'development',
    operatorCommitSha: kind === 'wrong-operator' ? '0'.repeat(40) : sha, sourceDirectory: fixture.sourceDirectory,
    commitSha: fixture.commitSha, directory: path.join(directory, 'freeze-output'),
    enrollmentRequestDigest: fixture.manifest.enrollmentRequestDigest, logBaselineDigest: fixture.manifest.logBaselineDigest, credentialIdentity: {} };
  const filename = path.join(directory, 'operator-packet.json'), bytes = JSON.stringify(packet); await writeFile(filename, bytes);
  const result = await promisify(execFile)(process.execPath, [entry, 'freeze', '--packet', filename, '--packet-digest', hash(bytes)],
    { cwd: operator, env: { PATH: process.env.PATH } }).catch(error => error);
  expect(result.code).toBe(1); expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toEqual({ status: 'refused', code: 'first-install-code-pack-refused', stage: 'source',
    reason: kind === 'dirty-operator' ? 'operator-tree-dirty' : kind === 'wrong-operator' ? 'operator-head-mismatch' : 'target-tree-dirty' });
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('prepares an older source from its own repository without requiring that commit in the operator clone', async () => {
  const sourceDirectory = fixture.sourceDirectory;
  await writeFile(path.join(sourceDirectory, 'ignored.local'), 'This ignored file is outside the image input');
  const prepared = await prepareFirstInstallPairImage({ environment: 'development', sourceDirectory, commitSha: fixture.commitSha,
    operatorCommitSha: 'a'.repeat(40), directory: path.join(directory, 'image-context-receipt'),
    inputDirectory: fixture.inputDirectory, inputDigest: fixture.inputDigest,
    enrollmentRequestDigest: fixture.manifest.enrollmentRequestDigest, logBaselineDigest: fixture.manifest.logBaselineDigest });
  try {
    const target = path.join(prepared.contextDirectory, 'source');
    expect(execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(fixture.commitSha);
    expect(prepared.target).toBe('pair-first-install');
    expect(hash(await readFile(prepared.dockerfile))).toBe(prepared.dockerfileDigest);
    expect(await readFile(path.join(prepared.contextDirectory, 'pair-source-inputs.json'))).toEqual(Buffer.from(fixture.sourceInputs));
    expect(execFileSync('git', ['-C', sourceDirectory, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
    await expect(readFile(path.join(target, 'ignored.local'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(prepared.contextDirectory, { recursive: true, force: true }); }
});
