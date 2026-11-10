import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { cpSync, writeFileSync } from 'node:fs';
import { firstInstallCodePackFixture } from './helpers/first-install-code-pack';
import { publicBuildSettings, imageBuildEnvironment } from './helpers/first-install-build-settings';
import { firstInstallBuildEnvironment, firstInstallImageBuildArgs } from '../site/scripts/public-release-first-install-environment';
import { parseFirstInstallPreparationPacket } from '../scripts/prepare-first-install-pair-code-pack.mjs';
import { prepareFirstInstallPairImage, extractFirstInstallPairImage } from '../site/scripts/public-release-first-install-image';
import { buildFirstInstallPublicReleasePair } from '../site/scripts/public-release-first-install-build';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'first-install-settings-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('keeps required production analytics/report/share settings and rejects missing, unsafe or unrecognized values', () => {
  const environment = firstInstallBuildEnvironment('production', publicBuildSettings);
  expect(environment).toMatchObject({ ...publicBuildSettings, CMS_DEPLOYMENT_ENVIRONMENT: 'production',
    PUBLIC_GA4_REQUIRED: '1', PUBLIC_REPORT_REQUIRED: '1', PUBLIC_SHARE_REQUIRED: '1' });
  for (const settings of [undefined, { ...publicBuildSettings, PUBLIC_GA4_MEASUREMENT_ID: 'invalid' },
    { ...publicBuildSettings, PUBLIC_REPORT_ENDPOINT: 'http://reports.example.test' },
    { ...publicBuildSettings, PUBLIC_TURNSTILE_SITEKEY: '' },
    { ...publicBuildSettings, PUBLIC_SHARE_INTAKE_ENDPOINT: 'http://intake.example.test' },
    { ...publicBuildSettings, PUBLIC_SHARE_UPLOAD_ORIGIN: '' },
    { ...publicBuildSettings, PUBLIC_SHARE_UPLOAD_ORIGIN: 'https://uploads.example.org' },
    { ...publicBuildSettings, PUBLIC_SHARE_UPLOAD_ORIGIN: 'http://uploads.example.test' },
    { ...publicBuildSettings, PUBLIC_SHARE_UPLOAD_ORIGIN: 'https://uploads.example.test/path' },
    { ...publicBuildSettings, PUBLIC_GA4_REQUIRED: '0' }, { ...publicBuildSettings, GOOGLE_APPLICATION_CREDENTIALS: '/ambient' }])
    expect(() => firstInstallBuildEnvironment('production', settings)).toThrow();
  expect(firstInstallBuildEnvironment('development')).toMatchObject({ PUBLIC_GA4_REQUIRED: '0', PUBLIC_REPORT_REQUIRED: '0', PUBLIC_SHARE_REQUIRED: '0' });
  expect(firstInstallBuildEnvironment('production', { ...publicBuildSettings, PUBLIC_SHARE_PAGE: '0' }).PUBLIC_SHARE_PAGE).toBeUndefined();
});

it.each(['omitted', 'empty'] as const)('keeps a disabled share page inert with an %s upload origin', kind => {
  const { PUBLIC_SHARE_UPLOAD_ORIGIN, ...withoutOrigin } = publicBuildSettings;
  const settings = { ...withoutOrigin, PUBLIC_SHARE_PAGE: '0',
    ...(kind === 'empty' ? { PUBLIC_SHARE_UPLOAD_ORIGIN: '' } : {}) };
  const environment = firstInstallBuildEnvironment('production', settings);
  expect(environment.PUBLIC_SHARE_PAGE).toBeUndefined();
  expect(environment.PUBLIC_SHARE_UPLOAD_ORIGIN).toBeUndefined();
  expect(firstInstallImageBuildArgs('production', settings)).toEqual({
    CMS_DEPLOYMENT_ENVIRONMENT: 'production', ...withoutOrigin, PUBLIC_SHARE_PAGE: '0',
  });
  const packet = { schemaVersion: 1, kind: 'public-release-first-install-preparation', environment: 'production',
    operatorCommitSha: 'a'.repeat(40), sourceDirectory: '/fixture-source', commitSha: 'b'.repeat(40),
    directory: '/fixture-output', enrollmentRequestDigest: 'c'.repeat(64), logBaselineDigest: 'd'.repeat(64),
    inputDirectory: '/fixture-input', inputDigest: 'e'.repeat(64), imageId: 'sha256:' + 'f'.repeat(64),
    publicBuildSettings: settings };
  expect(parseFirstInstallPreparationPacket('extract', packet, 'production')).toEqual(packet);
});

it('binds the actual pinned image build environment and refuses altered extraction evidence before a full build', async () => {
  const f = await firstInstallCodePackFixture(directory, 'production');
  const options = { environment: 'production' as const, publicBuildSettings, sourceDirectory: f.sourceDirectory, commitSha: f.commitSha,
    operatorCommitSha: 'a'.repeat(40), inputDirectory: f.inputDirectory, inputDigest: f.inputDigest,
    enrollmentRequestDigest: f.manifest.enrollmentRequestDigest, logBaselineDigest: f.manifest.logBaselineDigest, imageId: 'sha256:' + 'a'.repeat(64) };
  let actualEnvironment = imageBuildEnvironment;
  const docker = (args: string[]) => {
    if (args[0] === 'image') return JSON.stringify([{ Id: options.imageId, Architecture: 'amd64', Os: 'linux' }]);
    if (args[0] === 'create' || args[0] === 'rm') return 'b'.repeat(64);
    if (args[0] === 'cp') {
      if (args[1].endsWith('/public-build-environment.json')) writeFileSync(args[2], JSON.stringify(actualEnvironment) + '\n');
      else if (args[1].endsWith('/HEAD')) writeFileSync(args[2], f.commitSha + '\n');
      else cpSync(f.compiledDirectory, args[2], { recursive: true });
      return '';
    }
    throw new Error('Unexpected Docker call');
  };
  actualEnvironment = { ...imageBuildEnvironment, PUBLIC_REPORT_ENDPOINT: 'https://wrong.example.test/' };
  await expect(extractFirstInstallPairImage({ ...options, directory: path.join(directory, 'wrong-image') }, docker)).rejects.toThrow();
  actualEnvironment = imageBuildEnvironment;
  const imageDirectory = path.join(directory, 'image');
  const image = await extractFirstInstallPairImage({ ...options, directory: imageDirectory }, docker);
  expect(image.publicBuildEnvironmentDigest).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(path.join(imageDirectory, 'image-public-build-environment.json'), '{}');
  const output = path.join(directory, 'build');
  await expect(buildFirstInstallPublicReleasePair({ ...options, directory: output, imageDirectory,
    imageReceiptDigest: image.imageReceiptDigest })).rejects.toThrow();
  await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('returns every required production Docker build argument from the exact frozen input', async () => {
  const f = await firstInstallCodePackFixture(directory, 'production');
  const output = path.join(directory, 'image-context');
  const options = { environment: 'production' as const, publicBuildSettings, sourceDirectory: f.sourceDirectory,
    commitSha: f.commitSha, operatorCommitSha: 'a'.repeat(40), directory: output,
    inputDirectory: f.inputDirectory, inputDigest: f.inputDigest,
    enrollmentRequestDigest: f.manifest.enrollmentRequestDigest, logBaselineDigest: f.manifest.logBaselineDigest };
  const result = await prepareFirstInstallPairImage(options);
  try {
    expect(result.buildArgs).toEqual({ CMS_DEPLOYMENT_ENVIRONMENT: 'production', ...publicBuildSettings });
    const wrongOutput = path.join(directory, 'wrong-context');
    await expect(prepareFirstInstallPairImage({ ...options, directory: wrongOutput,
      publicBuildSettings: { ...publicBuildSettings, PUBLIC_GA4_MEASUREMENT_ID: 'G-OTHER12345' } })).rejects.toThrow();
    await expect(access(wrongOutput)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(result.contextDirectory, { recursive: true, force: true }); }
});

it('refuses a production full build with missing public settings before file or process effects', async () => {
  let processes = 0;
  await expect(buildFirstInstallPublicReleasePair({ environment: 'production', sourceDirectory: '/unused', directory,
    commitSha: 'a'.repeat(40), inputDirectory: '/unused', inputDigest: 'b'.repeat(64), imageDirectory: '/unused',
    imageReceiptDigest: 'c'.repeat(64), enrollmentRequestDigest: 'd'.repeat(64), logBaselineDigest: 'e'.repeat(64) },
  async () => { processes++; throw new Error('No child should run'); })).rejects.toThrow();
  expect(processes).toBe(0);
});
