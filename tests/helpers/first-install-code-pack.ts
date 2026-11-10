import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import context from '../../functions/lib/public-context-revision.js';
import source from '../../functions/lib/public-release-source-body.js';
import log from '../../functions/lib/public-release-change-log.js';
import deployment from '../../functions/lib/public-deployment.js';
import { createPublicArtifactInventoryReceipt, finalizePublicArtifactInventoryReceipt } from '../../site/src/lib/public-artifact-inventory';
import { PUBLIC_PAGES } from '../../packages/content-core/src/public-pages';
import { publicReleasePairSourceInputsBytes } from '../../site/scripts/public-release-pair-source-inputs';
import { firstInstallInventory, writeFirstInstallFile } from '../../site/scripts/public-release-first-install-files';
import { publicReleaseCodePackFixture } from './public-release-code-pack';
import { sealPublicReleasePairRenderer } from '../../site/scripts/public-release-pair-renderer-release.mjs';
import { publicBuildSettings } from './first-install-build-settings';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** Serialized first-install protocol example with real Git/files, native
 * inventory and graph producers. No provider, SDK, compiler or deployment. */
export async function firstInstallCodePackFixture(directory: string, environment: 'development' | 'production' = 'development') {
  const sourceDirectory = path.join(directory, 'source'), inputDirectory = path.join(directory, 'input');
  await mkdir(sourceDirectory); await mkdir(inputDirectory);
  await writeFile(path.join(sourceDirectory, 'source.txt'), 'Reviewed fixture source\n');
  await mkdir(path.join(sourceDirectory, 'publisher'));
  await writeFile(path.join(sourceDirectory, 'publisher/package.json'), '{"name":"closed-context-fixture","version":"1.0.0"}');
  await writeFile(path.join(sourceDirectory, 'publisher/package-lock.json'), JSON.stringify({ name: 'closed-context-fixture', version: '1.0.0',
    lockfileVersion: 3, requires: true, packages: { '': { name: 'closed-context-fixture', version: '1.0.0' } } }));
  await writeFile(path.join(sourceDirectory, 'publisher/wrangler.json'), JSON.stringify({ vars: {}, containers: [{}] }));
  await writeFile(path.join(sourceDirectory, '.gitignore'), '*.local\nnode_modules\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', sourceDirectory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'Fixture source');
  const commitSha = git('rev-parse', 'HEAD'), sourceTree = git('rev-parse', 'HEAD^{tree}');
  const renderedAt = '2026-10-30T15:00:00.000Z', cutoffAt = { seconds: Date.parse(renderedAt) / 1000, nanoseconds: 0, toMillis: () => Date.parse(renderedAt) };
  const pointer = { ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true, activeGeneration: 1,
    activeDeploymentId: 'original-release', activeCommitSha: commitSha, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: 'original-release' };
  const body = source.makePublicReleaseSourceBody({ kind: 'provider', id: 'original-pointer', action: 'dependency', sourceVersion: 1,
    snapshot: pointer, sourceDocuments: [{ path: 'system/publicDeployment', data: pointer }] });
  const sourceMembers = [{ collection: 'system', id: 'publicDeployment', publicRevision: body.contentDigest, contentDigest: body.contentDigest }];
  const baselineCursor = { baselineDigest: 'f'.repeat(64), sequence: 0, lastDigest: 'f'.repeat(64) };
  const receipt = { schemaVersion: 2, logEpoch: 'fixture-epoch', baselineCursor, liveReleaseSha: commitSha,
    sourceMemberCensusDigest: protocol.publicReleaseDigest(sourceMembers), codeAssetManifestDigest: null,
    codeAssetManifestReason: 'legacy-release-predates-code-packs', createdAt: renderedAt };
  const logBaselineDigest = protocol.publicReleaseDigest(receipt);
  const request = { schemaVersion: 1, operationId: 'original-bootstrap', logEpoch: 'fixture-epoch', baselineDigest: baselineCursor.baselineDigest,
    expected: { projectId: environment === 'production' ? 'njpbs-site' : 'njpbs-site-dev', liveReleaseSha: commitSha, pointerDigest: 'b'.repeat(64), runtimeDigest: 'c'.repeat(64),
      contextRevision: 1, contextDigest: context.publicContextDigest(1), publicSourceCensusDigest: protocol.publicReleaseDigest(sourceMembers) } };
  const enrollment = { schemaVersion: 1, kind: 'initial-public-release-change-enrollment', request, requestDigest: protocol.publicReleaseDigest(request),
    initialHead: log.initialPublicReleaseChangeHead(baselineCursor.baselineDigest), baseline: { receipt, logBaselineDigest }, createdAt: renderedAt };
  const artifactReceipt = createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId: 'baseline',
    generation: 1, commitSha, reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null,
    cutoffAt, reservedAt: cutoffAt }, pages: [], posts: [], programs: [], authors: [], settings: [] });
  const bundle = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [], receipt: artifactReceipt };
  const sourceInputs = publicReleasePairSourceInputsBytes(receipt, logBaselineDigest);
  await writeFirstInstallFile(inputDirectory, 'input.json', JSON.stringify(bundle) + '\n');
  await writeFirstInstallFile(inputDirectory, 'baseline.json', JSON.stringify({ enrollment, receipt, logBaselineDigest,
    sourceMembers, sourceBodies: [body.contentDigest] }) + '\n');
  await writeFirstInstallFile(inputDirectory, `sources/${body.contentDigest}.json`, body.json);
  await writeFirstInstallFile(inputDirectory, 'pair-source-inputs.json', sourceInputs);
  const manifest = { schemaVersion: 1, kind: 'public-release-first-install-input', environment, commitSha, sourceTree,
    ...(environment === 'production' ? { publicBuildSettings } : {}),
    logBaselineDigest, enrollmentRequestDigest: enrollment.requestDigest, buildBatchId: 'baseline', generation: 1, renderedAt,
    files: await firstInstallInventory(inputDirectory) };
  const manifestBytes = JSON.stringify(manifest) + '\n';
  await writeFirstInstallFile(inputDirectory, 'first-install-input.json', manifestBytes);
  const artifactDirectory = path.join(directory, 'artifact'); await mkdir(artifactDirectory);
  const artifact = await publicReleaseCodePackFixture(artifactDirectory, commitSha, sourceInputs,
    { 'schedule/downloads/schedule.json': '{}' });
  const routes = [...PUBLIC_PAGES.flatMap(page => [page.path, ...('aliases' in page ? page.aliases : [])]), ...artifactReceipt.aggregateRoutes];
  for (const route of routes) {
    const relative = route.endsWith('/') ? route.slice(1) + 'index.html' : route.slice(1);
    await mkdir(path.dirname(path.join(artifact.distDirectory, relative)), { recursive: true });
    if (!existsSync(path.join(artifact.distDirectory, relative))) {
      await writeFile(path.join(artifact.distDirectory, relative), route.endsWith('.json') ? '{}' : '<html>Public source fixture</html>');
    }
  }
  await writeFirstInstallFile(artifact.compiledDirectory, 'runtime/pair.mjs', 'export{}');
  await writeFile(path.join(artifact.compiledDirectory, 'renderer-release.json'), JSON.stringify({ schemaVersion: 1, rendererSha: commitSha, environment }));
  const digests = await sealPublicReleasePairRenderer(artifact.compiledDirectory, commitSha);
  await finalizePublicArtifactInventoryReceipt({ receipt: artifactReceipt, distDirectory: artifact.distDirectory,
    outputPath: path.join(artifactDirectory, 'inventory.json') });
  await writeFirstInstallFile(artifactDirectory, 'public-context.json', JSON.stringify(bundle));
  return { sourceDirectory, sourceTree, commitSha, inputDirectory, inputDigest: hash(manifestBytes), sourceInputs,
    manifest, artifactReceipt, artifactDirectory, ...artifact, ...digests };
}
