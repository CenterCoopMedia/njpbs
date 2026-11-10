import { readFileSync } from 'node:fs';
import { mkdtemp, symlink, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseBaselineCodeFixture } from '../helpers/public-release-baseline-code';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import adoption from '../../functions/lib/public-release-bootstrap-adoption.js';
import pause from '../../functions/lib/dev-public-release-pause.js';
import admission from '../../functions/lib/public-release-bootstrap-admission.js';
import deployment from '../../functions/lib/public-deployment.js';
import { readPublicReleaseFirstInstallBaseline } from '../../functions/lib/public-release-first-install-baseline.js';
import { publicReleasePairSourceInputsBytes } from '../../site/scripts/public-release-pair-source-inputs';
import { freezeFirstInstallPublicReleasePair } from '../../site/scripts/public-release-first-install-freeze';
import { openFirstInstallInput } from '../../site/scripts/public-release-first-install-input';
import { publicBuildSettings } from '../helpers/first-install-build-settings';

describe.each(['development', 'production'] as const)('%s original first-install authority', environment => {
const raw = isolatedFirestore(`first-install-baseline-no-pairs-${environment}`);
const sha = 'a'.repeat(40);
// Only the SDK target label is projected; all data and transactions use this
// suite's isolated demo database. CODE HTTP is the existing wire fixture.
const firestore = new Proxy(raw, { get(target, key) {
  if (key === 'projectId') return environment === 'development' ? 'njpbs-site-dev' : 'njpbs-site';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
} });
const story = JSON.parse(readFileSync(new URL('../../site/tests/fixtures/shadow-posts/post.json', import.meta.url), 'utf8')).document;
let options: { environment: 'development' | 'production'; firestore: typeof firestore; enrollmentRequestDigest: string; logBaselineDigest: string };
const objects = new Map<string, Buffer>();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let scratch: string, sourceDirectory: string, sourceSha: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'first-install-source-'));
  sourceDirectory = path.join(scratch, 'source');
  // CI checks out one commit. Historical OLD91a proof is a separate local
  // receipt; this contract uses a protected source available in shallow CI.
  sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['worktree', 'add', '--detach', sourceDirectory, sourceSha], { stdio: 'pipe' });
  await symlink(path.resolve('node_modules'), path.join(sourceDirectory, 'node_modules'), 'dir');
  await symlink(path.resolve('site/node_modules'), path.join(sourceDirectory, 'site/node_modules'), 'dir');
});
afterAll(async () => {
  if (sourceDirectory) execFileSync('git', ['worktree', 'remove', '--force', sourceDirectory], { stdio: 'pipe' });
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, raw);
  const pointer = { ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true,
    activeGeneration: 1, activeDeploymentId: 'original-release', activeCommitSha: sha,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: 'original-release' };
  await raw.doc('system/publicDeployment').set(pointer);
  const oldRuntime = { schemaVersion: 1, phase: environment === 'production' ? 'ready' : 'paused', commitSha: sha,
    serializerId: 'node-compute', cloud: { phase: environment === 'production' ? 'ready' : 'paused', commitSha: sha,
      serializerId: environment === 'development' ? 'cloudflare-dev-publisher' : 'cloudflare-publisher' } };
  await raw.doc('system/cmsPublicationRuntime').set(oldRuntime);
  objects.clear();
  const external: any = { schemaVersion: 1, operationId: 'E'.repeat(20), runtime: { owner: 'cloudflare', release: sha },
    contentDigest: 'd'.repeat(64), checkedAt: 1_800_000_000_000, files: {} };
  for (const name of ['launch-media-manager.json', 'spotlight-news.json', 'schedule.json']) {
    const bytes = Buffer.from('{}'), key = `post-background-v1/external-inputs/${external.operationId}/${name}`;
    objects.set(key, bytes); external.files[name] = { key, size: bytes.length, digest: hash(bytes) };
  }
  external.schedulePacket = { files: {} };
  for (const [kind, bytes] of [['json', Buffer.from('{}')], ['pdf', Buffer.from('%PDF-1.7 fixture')]] as const) {
    const key = `post-background-v1/schedule-packets/${external.operationId}/${hash(bytes)}`;
    objects.set(key, bytes); external.schedulePacket.files[kind] = { key, size: bytes.length, digest: hash(bytes) };
  }
  await raw.doc('system/publicDeployment/contexts/public').set({ schemaVersion: 1, revision: 1, externalInputs: external });
  await raw.doc('cmsPosts/story').set({ ...story, title: 'PRIVATE WORKING TITLE' });
  if (environment === 'production') await pause.pausePublicRelease({ firestore, attempt: { schemaVersion: 1,
    operationId: 'original-bootstrap', environment, projectId: firestore.projectId, oldRuntime,
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) } });
  else await adoption.closePublicReleaseBootstrapAdmission({ firestore, attempt: { schemaVersion: 2,
    operationId: 'original-bootstrap', environment, legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) } });
  const code = publicReleaseBaselineCodeFixture(firestore, sha);
  const observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore });
  const enrolled = await enrollment.enrollPublicReleaseChangeLog({ firestore, dryRun: false, currentCodeRequest: code.request,
    request: { schemaVersion: 1, operationId: 'original-bootstrap', logEpoch: 'first-install-epoch',
      baselineDigest: 'f'.repeat(64), expected: observed.expected } });
  options = { firestore, environment, enrollmentRequestDigest: enrolled.receipt.requestDigest,
    logBaselineDigest: enrolled.receipt.baseline.logBaselineDigest };
});

it('freezes and reopens a source-specific public input with actual native receipts before registration', async () => {
  const directory = path.join(scratch, 'frozen');
  const result = await freezeFirstInstallPublicReleasePair({ ...options, environment,
    ...(environment === 'production' ? { publicBuildSettings } : {}),
    sourceDirectory, commitSha: sourceSha, directory, providerStore: { async get(key) {
      const bytes = objects.get(key); return bytes ? { size: bytes.length, body: new Response(bytes).body! } : null;
    } }, fetchImages: async () => { throw new Error('No image request is needed for this source'); } });
  const opened = await openFirstInstallInput(directory, result.inputDigest);
  expect(opened.bundle.receipt.commitSha).toBe(sourceSha);
  expect(opened.bundle.posts[0].title).toBe(story.published.metadata.title);
  expect(opened.bundle.posts[0].sourceVersion).toBe(story.published.sourceVersion);
  expect(opened.sourceInputs).toEqual(publicReleasePairSourceInputsBytes(opened.baseline.receipt, options.logBaselineDigest));
  expect((await raw.doc('system/publicReleasePairs').get()).exists).toBe(false);
  expect((await readFile(path.join(directory, 'baseline.json'), 'utf8'))).not.toContain('PRIVATE WORKING TITLE');
  await writeFile(path.join(directory, 'input.json'), '{}');
  await expect(openFirstInstallInput(directory, result.inputDigest)).rejects.toThrow();
});

it('exports the real enrolled public closure before any pair exists, without database writes', async () => {
  const before = await raw.doc(enrollment.ENROLLMENT_PATH).get();
  const state = await readPublicReleaseFirstInstallBaseline(options);
  expect((await raw.doc('system/publicReleasePairs').get()).exists).toBe(false);
  expect(state.documents.get('cmsPosts/story').published).toEqual(story.published);
  expect(JSON.stringify([...state.documents])).not.toContain('PRIVATE WORKING TITLE');
  const sourceInputs = JSON.parse(Buffer.from(publicReleasePairSourceInputsBytes(state.receipt, state.logBaselineDigest)).toString());
  expect(sourceInputs).toEqual({ schemaVersion: 1, logBaselineDigest: options.logBaselineDigest,
    sourceMemberCensusDigest: state.receipt.sourceMemberCensusDigest,
    baselineCursor: { baselineDigest: 'f'.repeat(64), sequence: 0, lastDigest: 'f'.repeat(64) } });
  expect((await raw.doc(enrollment.ENROLLMENT_PATH).get()).updateTime).toEqual(before.updateTime);
  expect((await raw.doc('system/publicReleaseChangeLog').get()).exists).toBe(false);
});

it.each(['unenrolled', 'head', 'fence', 'runtime', 'source', 'body', 'baseline', 'request', 'mixed-project'])('refuses %s rather than supplying guessed build authority', async kind => {
  if (kind === 'unenrolled') await raw.doc(enrollment.ENROLLMENT_PATH).delete();
  if (kind === 'head') await raw.doc('system/publicReleaseChanges').update({ sequence: 1, lastDigest: 'e'.repeat(64) });
  if (kind === 'fence') await raw.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).delete();
  if (kind === 'runtime') await raw.doc('system/cmsPublicationRuntime').update({ phase: 'ready' });
  if (kind === 'source') await raw.doc('cmsPosts/story').update({ 'published.metadata.title': 'Unlogged drift' });
  if (kind === 'body') {
    const state = await readPublicReleaseFirstInstallBaseline(options);
    await raw.doc(`system/publicReleaseChanges/bodies/${state.sourceMembers[0].contentDigest}`).update({ json: '{}' });
  }
  if (kind === 'baseline') options.logBaselineDigest = '0'.repeat(64);
  if (kind === 'request') options.enrollmentRequestDigest = '0'.repeat(64);
  if (kind === 'mixed-project') options.firestore = new Proxy(firestore, { get(target, key) { return key === 'projectId' ? (environment === 'development' ? 'njpbs-site' : 'njpbs-site-dev') : Reflect.get(target, key); } });
  await expect(readPublicReleaseFirstInstallBaseline(options)).rejects.toThrow();
});

});
