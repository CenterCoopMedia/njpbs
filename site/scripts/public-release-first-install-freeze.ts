import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Firestore } from 'firebase-admin/firestore';
import baselineOwner from '../../functions/lib/public-release-first-install-baseline.js';
import { firstInstallPublicationTarget } from '../../functions/lib/public-release-first-install-target.js';
import protocol from '../../functions/lib/public-release-pair.js';
import sourceBody from '../../functions/lib/public-release-source-body.js';
import { publicReleasePairSourceInputsBytes } from './public-release-pair-source-inputs';
import { freezePublicReleaseSourceDependencies } from './public-release-pair-frozen-sources';
import type { PairViewStore } from './public-release-pair-view-storage';
import { freezeRetainedPublicImages } from './retained-public-images';
import { assertContextMatchesPublication } from '../src/lib/retained-public-context';
import { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, SITE_NAVIGATION_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID, COVERAGE_LABELS_SETTINGS_ID, STORY_CTAS_SETTINGS_ID } from '../../packages/content-core/src/cms-settings';
import { firstInstallHash as hash, firstInstallRefused as refuse, assertFirstInstallSource,
  firstInstallInventory, createFirstInstallDirectory, writeFirstInstallFile } from './public-release-first-install-files';
import { firstInstallBuildEnvironment, type FirstInstallPublicBuildSettings } from './public-release-first-install-environment';

export type FirstInstallFreezeRequest = { environment: 'development' | 'production'; commitSha: string; sourceDirectory: string;
  enrollmentRequestDigest: string; logBaselineDigest: string; directory: string; publicBuildSettings?: FirstInstallPublicBuildSettings };

/** Actual enrolled public bodies, not the post-registration historical reader.
 * Provider and public-image reads are explicit boundaries. No write capability
 * is given to the SDK or dependency store by this owner. */
export async function freezeFirstInstallPublicReleasePair(options: FirstInstallFreezeRequest & {
  firestore: Firestore; providerStore: Pick<PairViewStore, 'get'>; contentStore?: Pick<PairViewStore, 'get'>; fetchImages?: typeof fetch;
}) {
  firstInstallPublicationTarget(options.environment);
  firstInstallBuildEnvironment(options.environment, options.publicBuildSettings);
  const sourceTree = assertFirstInstallSource(options.sourceDirectory, options.commitSha);
  const state = await baselineOwner.readPublicReleaseFirstInstallBaseline(options);
  await createFirstInstallDirectory(options.directory, options.sourceDirectory);
  const dependencies = await freezePublicReleaseSourceDependencies({ firestore: options.firestore, state: state as any,
    providerStore: { get: options.providerStore.get.bind(options.providerStore), put: async () => refuse() },
    contentStore: options.contentStore ?? options.providerStore, pair: { environment: options.environment } });
  const qualified = dependencies.qualifiedCode;
  if (!qualified) refuse();
  assertContextMatchesPublication(qualified.publicContext, qualified.publication);
  const importSource = (file: string) => import(pathToFileURL(path.join(options.sourceDirectory, file)).href);
  const [{ projectPublicArtifactContent }, { assertPublicArtifactBundle }, { default: approvals }] = await Promise.all([
    importSource('site/src/lib/cms-loader.ts'), importSource('site/src/lib/public-artifact-bundle.ts'),
    importSource('functions/lib/approved-library-records.js'),
  ]);
  const documents = state.documents as Map<string, any>;
  const rows = (collection: string) => [...documents].filter(([name]) => name.startsWith(collection + '/') && name.split('/').length === 2)
    .map(([name, value]) => ({ ...value, id: name.slice(collection.length + 1) }));
  const renderedAt = state.renderedAt, instant = Date.parse(renderedAt), cutoffAt = {
    seconds: Math.floor(instant / 1000), nanoseconds: instant % 1000 * 1_000_000, toMillis: () => instant,
  };
  const buildBatchId = 'pair-install-' + hash(JSON.stringify([options.commitSha, state.logBaselineDigest]));
  const generation = qualified.publication.generation;
  const reservation = { schemaVersion: 1, buildBatchId, generation, commitSha: options.commitSha,
    reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt };
  const setting = (id: string) => { const value = documents.get(`cmsSettings/${id}`); return value ? { ...value, id } : undefined; };
  const projected = projectPublicArtifactContent({ pages: rows('cmsPages'),
    posts: rows('cmsPosts').map(record => ({ ...record, approvedLibraryVersion: approvals.approvedLibraryVersion(record, rows('cmsVersionHistory')) })),
    assets: rows('media_assets_public'), authors: rows('cmsAuthorProfilesPublic').map(({ id, ...data }) => ({ authorId: id, data })),
    setting: setting(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID), navigation: setting(SITE_NAVIGATION_SETTINGS_ID), chrome: setting(PUBLIC_SITE_CHROME_SETTINGS_ID),
    njDecides: setting(NJ_DECIDES_SETTINGS_ID), coverageLabels: setting(COVERAGE_LABELS_SETTINGS_ID), storyCtas: setting(STORY_CTAS_SETTINGS_ID), reservation, admissionTime: new Date(renderedAt) });
  const bundle = assertPublicArtifactBundle({ schemaVersion: 3, ...projected });
  // Retain original dependency DTOs independently. The target source creates a
  // new rendered Home catalog and prepared artifact; no old receipt is retagged.
  const files = new Map<string, Uint8Array>(dependencies.files);
  files.set('input.json', Buffer.from(JSON.stringify(bundle) + '\n'));
  files.set('baseline.json', Buffer.from(JSON.stringify({ enrollment: state.enrollment, receipt: state.receipt,
    logBaselineDigest: state.logBaselineDigest, sourceMembers: state.sourceMembers,
    sourceBodies: [...state.sourceBodies.keys()] }) + '\n'));
  for (const [digest, body] of state.sourceBodies) {
    files.set(`sources/${digest}.json`, Buffer.from(sourceBody.publicReleaseSnapshotJson(body, 2_000_000)));
  }
  files.set('pair-source-inputs.json', publicReleasePairSourceInputsBytes(state.receipt, state.logBaselineDigest));
  const external = documents.get('system/publicDeployment/contexts/public')?.externalInputs;
  if (!external?.files || !external.schedulePacket) refuse();
  for (const name of ['launch-media-manager.json', 'spotlight-news.json', 'schedule.json']) {
    const receipt = external.files[name];
    if (!receipt) refuse();
    files.set(name, await dependencies.readProviderInput(receipt.key));
  }
  for (const [kind, name] of [['json', 'schedule-packet.json'], ['pdf', 'schedule-packet.pdf']]) {
    const receipt = external.schedulePacket.files?.[kind];
    if (!receipt) refuse();
    files.set(name, await dependencies.readProviderInput(receipt.key));
  }
  for (const [name, bytes] of files) await writeFirstInstallFile(options.directory, name, bytes);
  await freezeRetainedPublicImages(options.directory, { buildBatchId, commitSha: options.commitSha }, options.fetchImages);
  // The public state/fences may not move while exact external bytes are read.
  const after = await baselineOwner.readPublicReleaseFirstInstallBaseline(options);
  if (protocol.publicReleaseDigest(after.receipt) !== protocol.publicReleaseDigest(state.receipt) ||
      assertFirstInstallSource(options.sourceDirectory, options.commitSha) !== sourceTree) refuse();
  const manifest = { schemaVersion: 1, kind: 'public-release-first-install-input', environment: options.environment,
    ...(options.environment === 'production' ? { publicBuildSettings: options.publicBuildSettings } : {}),
    commitSha: options.commitSha, sourceTree, logBaselineDigest: state.logBaselineDigest,
    enrollmentRequestDigest: options.enrollmentRequestDigest, buildBatchId, generation, renderedAt,
    files: await firstInstallInventory(options.directory) };
  const bytes = JSON.stringify(manifest) + '\n';
  await writeFirstInstallFile(options.directory, 'first-install-input.json', bytes);
  return { status: 'frozen', directory: options.directory, inputDigest: hash(bytes), commitSha: options.commitSha,
    sourceTree, logBaselineDigest: state.logBaselineDigest, buildBatchId, generation };
}
