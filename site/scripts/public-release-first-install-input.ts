import { isDeepStrictEqual } from 'node:util';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import source from '../../functions/lib/public-release-source-body.js';
import protocol from '../../functions/lib/public-release-pair.js';
import { firstInstallPublicationTarget } from '../../functions/lib/public-release-first-install-target.js';
import { publicReleasePairSourceInputsBytes } from './public-release-pair-source-inputs';
import { assertPublicArtifactBundle } from '../src/lib/public-artifact-bundle';
import { firstInstallBuildEnvironment, type FirstInstallPublicBuildSettings } from './public-release-first-install-environment';
import { firstInstallFile as file, firstInstallHash as hash, firstInstallRefused as refuse,
  firstInstallInventory } from './public-release-first-install-files';
import { atFirstInstallPreparationStage } from '../../scripts/lib/first-install-preparation-stage.mjs';

type ExpectedInput = { enrollmentRequestDigest: string; logBaselineDigest: string; environment?: 'development' | 'production'; publicBuildSettings?: FirstInstallPublicBuildSettings };
export function openFirstInstallInput(directory: string, inputDigest: string, expected?: ExpectedInput): ReturnType<typeof readFirstInstallInput> {
  return atFirstInstallPreparationStage('input', () => readFirstInstallInput(directory, inputDigest, expected));
}
async function readFirstInstallInput(directory: string, inputDigest: string, expected?: ExpectedInput) {
  const bytes = await file(directory, 'first-install-input.json');
  if (!protocol.digest(inputDigest) || hash(bytes) !== inputDigest) refuse();
  const manifest = JSON.parse(bytes.toString('utf8'));
  const target = firstInstallPublicationTarget(manifest.environment);
  protocol.exact(manifest, ['schemaVersion', 'kind', 'environment', 'commitSha', 'sourceTree', 'logBaselineDigest',
    'enrollmentRequestDigest', 'buildBatchId', 'generation', 'renderedAt', 'files',
    ...(manifest.environment === 'production' ? ['publicBuildSettings'] : [])]);
  firstInstallBuildEnvironment(manifest.environment, manifest.publicBuildSettings);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'public-release-first-install-input' ||
      !/^[a-f0-9]{40}$/.test(manifest.commitSha) ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceTree) || !Array.isArray(manifest.files)) refuse();
  if (expected && (expected.environment !== undefined && manifest.environment !== expected.environment ||
      expected.environment === 'production' && !isDeepStrictEqual(manifest.publicBuildSettings, expected.publicBuildSettings) ||
      manifest.enrollmentRequestDigest !== expected.enrollmentRequestDigest ||
      manifest.logBaselineDigest !== expected.logBaselineDigest)) refuse();
  const actual = (await firstInstallInventory(directory)).filter(row => row.path !== 'first-install-input.json');
  if (!isDeepStrictEqual(actual, manifest.files)) refuse();
  const baseline = JSON.parse((await file(directory, 'baseline.json')).toString('utf8'));
  const original = enrollment.parsePublicReleaseChangeEnrollmentReceipt(baseline.enrollment);
  if (original.request.expected.projectId !== target.projectId ||
      original.requestDigest !== manifest.enrollmentRequestDigest || original.baseline.logBaselineDigest !== manifest.logBaselineDigest ||
      !isDeepStrictEqual(original.baseline.receipt, baseline.receipt) ||
      protocol.publicReleaseDigest(baseline.sourceMembers) !== baseline.receipt.sourceMemberCensusDigest ||
      baseline.logBaselineDigest !== manifest.logBaselineDigest || !Array.isArray(baseline.sourceBodies) ||
      manifest.renderedAt !== baseline.receipt.createdAt) refuse();
  const bodies = new Map<string, any>();
  for (const digest of baseline.sourceBodies) {
    if (!protocol.digest(digest) || bodies.has(digest)) refuse();
    const bytes = await file(directory, `sources/${digest}.json`, 2_000_000);
    const body = JSON.parse(bytes.toString('utf8'));
    if (hash(bytes) !== digest || source.publicReleaseSnapshotJson(body, 2_000_000) !== bytes.toString('utf8')) refuse();
    bodies.set(digest, body);
  }
  for (const member of baseline.sourceMembers) if (!bodies.get(member.contentDigest)?.documents?.some(
    (row: any) => row.path === `${member.collection}/${member.id}` && row.data !== null)) refuse();
  const expectedInputs = publicReleasePairSourceInputsBytes(baseline.receipt, manifest.logBaselineDigest);
  if (!Buffer.from(expectedInputs).equals(await file(directory, 'pair-source-inputs.json'))) refuse();
  const bundle = assertPublicArtifactBundle(JSON.parse((await file(directory, 'input.json')).toString('utf8')));
  if (bundle.receipt.commitSha !== manifest.commitSha || bundle.receipt.buildBatchId !== manifest.buildBatchId ||
      bundle.receipt.generation !== manifest.generation) refuse();
  return { manifest, bundle, baseline, sourceInputs: expectedInputs };
}
