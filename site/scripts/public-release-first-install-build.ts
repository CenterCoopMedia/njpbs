import { atFirstInstallPreparationStage } from '../../scripts/lib/first-install-preparation-stage.mjs';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { firstInstallPublicationTarget } from '../../functions/lib/public-release-first-install-target.js';
import { openFirstInstallInput } from './public-release-first-install-input';
import { verifyPublicReleasePairRenderer } from './public-release-pair-renderer-release.mjs';
import { restorePublicReleasePairSemanticEngine } from './public-release-pair-semantic-engine';
import { sealFirstInstallPairCodePack } from './public-release-first-install-seal';
import { assertPublicArtifactInventoryReceipt } from '../src/lib/public-artifact-inventory';
import { firstInstallBuildEnvironment, type FirstInstallPublicBuildSettings } from './public-release-first-install-environment';
import { firstInstallFile as file, firstInstallHash as hash, firstInstallRefused as refuse,
  assertFirstInstallSource, createFirstInstallDirectory, firstInstallInventory, writeFirstInstallFile } from './public-release-first-install-files';

type Request = { environment: 'development' | 'production'; commitSha: string; sourceDirectory: string; directory: string;
  inputDirectory: string; inputDigest: string; imageDirectory: string; imageReceiptDigest: string;
  enrollmentRequestDigest: string; logBaselineDigest: string; publicBuildSettings?: FirstInstallPublicBuildSettings };

/** Only the OS process boundary is injectable. Native file, source, inventory,
 * graph, prepared-artifact and pack owners always perform their real checks. */
export async function buildFirstInstallPublicReleasePair(options: Request,
  run = promisify(execFile)) {
  const target = firstInstallPublicationTarget(options.environment);
  const publicEnvironment = firstInstallBuildEnvironment(options.environment, options.publicBuildSettings);
  const sourceTree = assertFirstInstallSource(options.sourceDirectory, options.commitSha);
  const input = await atFirstInstallPreparationStage('input', async () => {
    const input = await openFirstInstallInput(options.inputDirectory, options.inputDigest, options);
    if (input.manifest.commitSha !== options.commitSha || input.manifest.sourceTree !== sourceTree) refuse();
    return input;
  });
  const { image, compiled, digests, verifyGraph } = await atFirstInstallPreparationStage('image', async () => {
    const imageBytes = await file(options.imageDirectory, 'image-extraction.json');
    if (hash(imageBytes) !== options.imageReceiptDigest) refuse();
    const image = JSON.parse(imageBytes.toString('utf8'));
    if (image.schemaVersion !== 1 || image.kind !== 'public-release-first-install-image-extraction' ||
        image.environment !== options.environment || image.commitSha !== options.commitSha || image.sourceTree !== sourceTree ||
        options.environment === 'production' && !isDeepStrictEqual(image.publicBuildSettings, options.publicBuildSettings) ||
        image.inputDigest !== options.inputDigest || !/^sha256:[a-f0-9]{64}$/.test(image.localImageId) ||
        image.compiledDirectory !== path.join(options.imageDirectory, 'compiled')) refuse();
    if (options.environment === 'production') {
      const actual = await file(options.imageDirectory, 'image-public-build-environment.json');
      if (hash(actual) !== image.publicBuildEnvironmentDigest ||
          !isDeepStrictEqual(JSON.parse(actual.toString('utf8')), publicEnvironment)) refuse();
    }
    const compiled = image.compiledDirectory;
    const verifyGraph = async () => atFirstInstallPreparationStage('image', async () => {
      const digests = await verifyPublicReleasePairRenderer(compiled, { commitSha: options.commitSha,
        environment: options.environment, rendererDigest: image.rendererDigest });
      if (digests.compiledClientManifestDigest !== image.compiledClientManifestDigest ||
          !isDeepStrictEqual(await firstInstallInventory(compiled), image.files) ||
          !Buffer.from(input.sourceInputs).equals(await file(compiled, 'pair-source-inputs.json'))) refuse();
      return digests;
    });
    const digests = await verifyGraph();
    return { image, compiled, digests, verifyGraph };
  });
  await createFirstInstallDirectory(options.directory, options.sourceDirectory);
  const distDirectory = path.join(options.directory, 'dist'), compiledDirectory = path.join(options.directory, 'compiled');
  await mkdir(distDirectory, { mode: 0o700 });
  await cp(compiled, compiledDirectory, { recursive: true, errorOnExist: true, force: false });
  // Copy once into the fresh target's ignored renderer directory so its own
  // --copy-assets owner can validate the original exact-source client graph.
  const localGraph = path.join(options.sourceDirectory, 'site/.public-post-renderer');
  await mkdir(localGraph, { mode: 0o700 });
  await mkdir(path.join(options.sourceDirectory, 'site/dist'), { mode: 0o700 });
  for (const member of image.files) {
    await writeFirstInstallFile(localGraph, member.path, await file(compiled, member.path));
  }
  const semantic = path.join(options.directory, 'semantic');
  const engine = await restorePublicReleasePairSemanticEngine(compiledDirectory, semantic);
  const targetRequire = createRequire(path.join(options.sourceDirectory, 'site/package.json'));
  const transformersRoot = path.dirname(path.dirname(targetRequire.resolve('@huggingface/transformers')));
  const onnxRoot = path.dirname(path.dirname(targetRequire.resolve('onnxruntime-node')));
  if (JSON.parse(await readFile(path.join(transformersRoot, 'package.json'), 'utf8')).version !== engine.transformersVersion ||
      JSON.parse(await readFile(path.join(onnxRoot, 'package.json'), 'utf8')).version !== engine.onnxVersion) refuse();
  const cache = path.join(transformersRoot, '.cache');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const site = path.join(options.sourceDirectory, 'site');
  const siteDependencies = await realpath(path.join(site, 'node_modules'));
  for (const directory of ['.astro', 'node_modules/.astro', 'node_modules/.vite', 'node_modules/.vite-temp']) {
    await mkdir(path.join(site, directory), { recursive: true, mode: 0o700 });
  }
  const environment: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', TZ: 'America/New_York', ASTRO_TELEMETRY_DISABLED: '1',
    CMS_DEPLOYMENT_ENVIRONMENT: options.environment, FIREBASE_PROJECT_ID: target.projectId,
    CMS_DEV_FROZEN_BUILD: '1', CMS_OFFLINE_BUILD: "1", CMS_LOADER_STRICT: '1', CMS_CONTENT_MODE: 'published', DATA_HUB_PUBLIC: '1',
    ...publicEnvironment, INTERNAL_SURFACES: '0',
    PUBLIC_BUILD_BATCH_ID: input.manifest.buildBatchId, PUBLIC_BUILD_COMMIT_SHA: options.commitSha,
    // This existing retained-build branch installs frozen images before Astro.
    // Its background mode is a local input parser, never a live reservation.
    PUBLIC_ARTIFACT_BATCH_MODE: 'background', PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH: '/first-install/input/input.json',
    PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH: '/first-install/input/remote-images.json',
    PUBLIC_ARTIFACT_INVENTORY_PATH: '/first-install/output/inventory.json',
    PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH: '/first-install/output/public-context.json', PUBLIC_POST_RENDERER_COMPILE: '0',
    LAUNCH_CONTENT_DATA_PATH: '/first-install/input/launch-media-manager.json',
    SPOTLIGHT_NEWS_DATA_PATH: '/first-install/input/spotlight-news.json', SCHEDULE_DATA_PATH: '/first-install/input/schedule.json',
    CMS_PREVIEW_INPUT_PATH: path.join(options.inputDirectory, 'input.json'),
  };
  const { privatePreviewSandbox } = await import(pathToFileURL(path.join(site, 'scripts/process-cms-preview.ts')).href);
  const sandbox = await privatePreviewSandbox(environment, distDirectory);
  const args = sandbox.args.slice(0, -1);
  const interpreter = await realpath(process.execPath);
  args.push('--ro-bind', options.inputDirectory, '/first-install/input', '--bind', options.directory, '/first-install/output',
    '--ro-bind', interpreter, '/first-install/node',
    '--ro-bind', path.join(semantic, 'model-cache'), cache,
    '--ro-bind', path.join(semantic, 'native'), path.join(onnxRoot, 'bin/napi-v6/linux/x64'),
    '--tmpfs', path.join(site, '.astro'), '--tmpfs', path.join(siteDependencies, '.astro'),
    '--tmpfs', path.join(siteDependencies, '.vite'), '--tmpfs', path.join(siteDependencies, '.vite-temp'),
    '--bind', distDirectory, path.join(site, 'dist'), '--', '/first-install/node', '--import',
    path.join(site, 'node_modules/tsx/dist/loader.mjs'), path.join(site, 'scripts/build-with-production-sync.mjs'));
  const childEnvironment = { ...sandbox.environment }; delete childEnvironment.CMS_PREVIEW_INPUT_PATH;
  await run('/usr/bin/bwrap', args, { cwd: site, env: childEnvironment,
    timeout: 300_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
  // No compiler is allowed here. This source-pinned phase copies only the
  // existing client files; its process receives public build settings only.
  await run(process.execPath, ['--import', path.join(site, 'node_modules/tsx/dist/loader.mjs'),
    path.join(site, 'scripts/build-public-post-renderer.ts'), '--copy-assets'], {
    cwd: site, env: { ...childEnvironment, PUBLIC_ARTIFACT_INVENTORY_PATH: path.join(options.directory, 'inventory.json') },
    timeout: 30_000, maxBuffer: 64 * 1024 });
  // The fresh host site/dist is copy-only staging after the sandbox exits.
  // Copy its verified client subtree; keep the full build's other output.
  await cp(path.join(site, 'dist/posts/_no-build-assets'), path.join(distDirectory, 'posts/_no-build-assets'),
    { recursive: true, errorOnExist: true, force: false });
  const artifactReceipt = assertPublicArtifactInventoryReceipt(JSON.parse((await file(options.directory, 'inventory.json')).toString()));
  const { preparedArtifact, pack } = await sealFirstInstallPairCodePack({ commitSha: options.commitSha, environment: options.environment,
    rendererDigest: digests.rendererDigest, sourceInputs: input.sourceInputs, artifactReceipt,
    distDirectory, compiledDirectory, directory: options.directory });
  // The image's own source codec must accept the full pack as well. A newer
  // operator cannot grant an older runtime a namespace it does not understand.
  const { parsePublicReleasePairCodePack } = await import(pathToFileURL(path.join(site, 'scripts/public-release-pair-code-pack.ts')).href);
  parsePublicReleasePairCodePack(pack.manifest, { commitSha: options.commitSha,
    codeAssetManifestDigest: pack.manifest.codeAssetManifestDigest });
  await verifyGraph();
  await verifyPublicReleasePairRenderer(compiledDirectory, { commitSha: options.commitSha,
    environment: options.environment, rendererDigest: digests.rendererDigest });
  await verifyPublicReleasePairRenderer(localGraph, { commitSha: options.commitSha,
    environment: options.environment, rendererDigest: digests.rendererDigest });
  await openFirstInstallInput(options.inputDirectory, options.inputDigest, options);
  if (assertFirstInstallSource(options.sourceDirectory, options.commitSha) !== sourceTree) refuse();
  await writeFirstInstallFile(options.directory, 'code-pack.json', JSON.stringify(pack.manifest) + '\n');
  const result = { schemaVersion: 1, kind: 'public-release-first-install-code-pack', status: 'prepared',
    commitSha: options.commitSha, sourceTree, environment: options.environment, inputDigest: options.inputDigest,
    logBaselineDigest: input.manifest.logBaselineDigest, imageReceiptDigest: options.imageReceiptDigest,
    localImageId: image.localImageId, ...digests, codeAssetManifestDigest: pack.manifest.codeAssetManifestDigest,
    distDirectory, compiledDirectory, publicContextPath: path.join(options.directory, 'public-context.json'), preparedArtifact };
  await writeFirstInstallFile(options.directory, 'code-pack-preparation.json', JSON.stringify(result) + '\n');
  return result;
}
