import { atFirstInstallPreparationStage } from '../../scripts/lib/first-install-preparation-stage.mjs';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { prepareCloudPublisher } from '../../scripts/prepare-cloud-publisher.mjs';
import { firstInstallPublicationTarget } from '../../functions/lib/public-release-first-install-target.js';
import { verifyPublicReleasePairRenderer } from './public-release-pair-renderer-release.mjs';
import { openFirstInstallInput } from './public-release-first-install-input';
import { firstInstallBuildEnvironment, firstInstallImageBuildArgs, type FirstInstallPublicBuildSettings } from './public-release-first-install-environment';
import { firstInstallFile as file, firstInstallHash as hash, firstInstallRefused as refuse,
  assertFirstInstallSource, createFirstInstallDirectory, firstInstallInventory, writeFirstInstallFile } from './public-release-first-install-files';

type Input = { environment: 'development' | 'production'; commitSha: string; sourceDirectory: string; directory: string;
  inputDirectory: string; inputDigest: string; operatorCommitSha: string; enrollmentRequestDigest: string; logBaselineDigest: string;
  publicBuildSettings?: FirstInstallPublicBuildSettings };
const root = fileURLToPath(new URL('../../', import.meta.url));

export async function prepareFirstInstallPairImage(options: Input) {
  firstInstallPublicationTarget(options.environment);
  const buildArgs = firstInstallImageBuildArgs(options.environment, options.publicBuildSettings);
  const sourceTree = assertFirstInstallSource(options.sourceDirectory, options.commitSha);
  const input = await atFirstInstallPreparationStage('input', async () => {
    const input = await openFirstInstallInput(options.inputDirectory, options.inputDigest, options);
    if (input.manifest.commitSha !== options.commitSha || input.manifest.sourceTree !== sourceTree) refuse();
    return input;
  });
  await createFirstInstallDirectory(options.directory, options.sourceDirectory);
  const prepared = await prepareCloudPublisher(options.commitSha, { sourceRepository: options.sourceDirectory, environment: options.environment });
  const dockerfile = await readFile(path.join(root, 'publisher/Dockerfile.pair'));
  await writeFile(path.join(prepared.directory, 'Dockerfile.pair'), dockerfile, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(prepared.directory, 'pair-source-inputs.json'), input.sourceInputs, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(prepared.directory, '.dockerignore'),
    '*\n!Dockerfile.pair\n!pair-source-inputs.json\n!source/\n!source/**\nsource/**/node_modules\nsource/**/.wrangler\n', { mode: 0o600 });
  const receipt = { schemaVersion: 1, kind: 'public-release-first-install-image-context', environment: options.environment,
    operatorCommitSha: options.operatorCommitSha, commitSha: options.commitSha, sourceTree,
    inputDigest: options.inputDigest, logBaselineDigest: input.manifest.logBaselineDigest,
    contextDirectory: prepared.directory, dockerfile: path.join(prepared.directory, 'Dockerfile.pair'),
    dockerfileDigest: hash(dockerfile), sourceInputsDigest: hash(input.sourceInputs), target: 'pair-first-install',
    buildArgs };
  await writeFirstInstallFile(options.directory, 'image-context.json', JSON.stringify(receipt) + '\n');
  return receipt;
}

/** Export a local, pinned image without running it or querying a registry.
 * Native image inspection/push receipts still own the later registry identity. */
export async function extractFirstInstallPairImage(options: Input & { imageId: string },
  docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 })) {
  firstInstallPublicationTarget(options.environment);
  if (!/^sha256:[a-f0-9]{64}$/.test(options.imageId)) refuse();
  const sourceTree = assertFirstInstallSource(options.sourceDirectory, options.commitSha);
  const input = await atFirstInstallPreparationStage('input', async () => {
    const input = await openFirstInstallInput(options.inputDirectory, options.inputDigest, options);
    if (input.manifest.commitSha !== options.commitSha || input.manifest.sourceTree !== sourceTree) refuse();
    return input;
  });
  await createFirstInstallDirectory(options.directory, options.sourceDirectory);
  const inspect = JSON.parse(docker(['image', 'inspect', options.imageId]));
  if (!Array.isArray(inspect) || inspect.length !== 1 || inspect[0].Id !== options.imageId ||
      inspect[0].Architecture !== 'amd64' || inspect[0].Os !== 'linux') refuse();
  const container = docker(['create', '--network=none', '--read-only', options.imageId]).trim();
  if (!/^[a-f0-9]{64}$/.test(container)) refuse();
  try {
    let publicBuildEnvironmentDigest: string | undefined;
    if (options.environment === 'production') {
      docker(['cp', `${container}:/pair-inputs/public-build-environment.json`, path.join(options.directory, 'image-public-build-environment.json')]);
      const actual = await file(options.directory, 'image-public-build-environment.json');
      if (!isDeepStrictEqual(JSON.parse(actual.toString('utf8')), firstInstallBuildEnvironment(options.environment, options.publicBuildSettings))) refuse();
      publicBuildEnvironmentDigest = hash(actual);
    }
    docker(['cp', `${container}:/app/site/.public-post-renderer`, path.join(options.directory, 'compiled')]);
    docker(['cp', `${container}:/app/.git/HEAD`, path.join(options.directory, 'image-source-head')]);
    if ((await file(options.directory, 'image-source-head')).toString().trim() !== options.commitSha) refuse();
    const directory = path.join(options.directory, 'compiled');
    const rendererDigest = hash(await file(directory, 'pair-renderer-release.json'));
    const digests = await verifyPublicReleasePairRenderer(directory, { commitSha: options.commitSha,
      environment: options.environment, rendererDigest });
    if (!Buffer.from(input.sourceInputs).equals(await file(directory, 'pair-source-inputs.json'))) refuse();
    const receipt = { schemaVersion: 1, kind: 'public-release-first-install-image-extraction', environment: options.environment,
      ...(options.environment === 'production' ? { publicBuildSettings: options.publicBuildSettings } : {}),
      ...(publicBuildEnvironmentDigest ? { publicBuildEnvironmentDigest } : {}),
      operatorCommitSha: options.operatorCommitSha, commitSha: options.commitSha, sourceTree,
      inputDigest: options.inputDigest, localImageId: options.imageId,
      ...digests, compiledDirectory: directory, files: await firstInstallInventory(directory) };
    const bytes = JSON.stringify(receipt) + '\n';
    await writeFirstInstallFile(options.directory, 'image-extraction.json', bytes);
    return { ...receipt, imageReceiptDigest: hash(bytes) };
  } finally { docker(['rm', container]); }
}
