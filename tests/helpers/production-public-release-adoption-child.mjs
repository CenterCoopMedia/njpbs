import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const require = createRequire(new URL('../../site/package.json', import.meta.url));
if (!/^demo-[a-z0-9-]+$/.test(process.env.PRODUCTION_ADOPTION_TEST_PROJECT ?? '') || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Local fixture only');
require('tsx/cjs/api').register();
const native = createRequire(import.meta.url), protocol = native('../../functions/lib/public-release-pair.js');
const work = native('../../functions/lib/public-release-pair-work.js');
const serving = native('../../functions/lib/public-release-serving.js');
const { developmentInitialPairInstallFixture } = native('./development-initial-pair-install.ts');
const { inspectBootstrapControls } = native('../../site/scripts/public-release-bootstrap-controls.ts');
const { qualifyPublicReleasePair } = native('../../site/scripts/public-release-pair-qualification.ts');
const { createPublicReleaseRouter } = native('../../workers/src/public-release-router.ts');
const { createPublicReleaseSlot } = native('../../workers/src/public-release-slot.ts');
const { readQualificationEvidence } = native('../../site/scripts/public-release-pair-qualification-evidence.ts');
const { isPublicPairRequestPath } = native('../../workers/src/public-release-view-reader.ts');
const { runProductionPublicReleaseOperator, productionCanonicalRequest } = await import('../../scripts/lib/production-public-release-operator.mjs');
const app = initializeApp({ projectId: process.env.PRODUCTION_ADOPTION_TEST_PROJECT }, 'production-adoption-smoke');
const raw = getFirestore(app), firestore = new Proxy(raw, { get(target, key) { if (key === 'projectId') return 'njpbs-site';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
const directory = await mkdtemp(join(tmpdir(), 'production-adoption-smoke-'));
let fixture, closing = false, qualification, initialAttempt, resumeAttempt, corrupt = false, sequence = 0;
const canonicalPaths = new Set(), recordedResponses = new Map();
const close = async () => { if (closing) return; closing = true; await fixture?.close(); await rm(directory, { recursive: true, force: true }); await deleteApp(app); process.disconnect?.(); };
process.on('disconnect', () => { void close(); });
const identity = { projectId: 'njpbs-site', clientEmail: 'fixture-operator@njpbs-site.iam.gserviceaccount.com', privateKeyId: 'b'.repeat(40), secretRef: 'pass://synthetic/production-operator' };
function routerForFixture() {
  const pairs = fixture.pairs;
  const slot = createPublicReleaseSlot({ pair: pairs[0], workerVersionId: pairs[0].publicWorker.versionId, store: fixture.store,
    getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, pair: pairs[0], selection, path, environment: 'production', composedReadersEnabled: true }) });
  return createPublicReleaseRouter({ environment: 'production', bootstrapPairId: pairs[0].pairId,
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: 'production' }), slots: [slot,
      { identity: pairs[1], serve: async () => { throw new Error('Recovery must not serve first-install OLD'); } }] });
}
async function run(step, attempt, mode = 'apply') {
  const packet = { schemaVersion: 1, kind: 'production-public-release-adoption', operatorCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), credentialIdentity: identity, step, attempt };
  const bytes = JSON.stringify(packet), filename = join(directory, `${++sequence}.json`); await writeFile(filename, bytes);
  const handles = [], credentials = [];
  const router = routerForFixture();
  const result = await runProductionPublicReleaseOperator(['--packet', filename, '--packet-digest', createHash('sha256').update(bytes).digest('hex'), `--${mode}`], {
    environment: {}, openSdk: async publicIdentity => {
      if (publicIdentity.projectId !== 'njpbs-site') throw new Error('Mixed SDK identity');
      return { firestore, close: async () => {} };
    },
    credential: fd => { const handle = { closed: false, read: async () => { credentials.push(fd); return 'synthetic-boundary-only'; }, close() { this.closed = true; } }; handles.push(handle); return handle; },
    createObjects: ({ environment }) => { if (environment !== 'production') throw new Error('Mixed object target'); return { get: key => fixture.store.get(key), close() {} }; },
    createProvider: ({ environment }) => { if (environment !== 'production') throw new Error('Mixed provider target'); return fixture.evidence.provider; },
    evidence: fixture.evidence,
    request: productionCanonicalRequest(async (url, init) => {
      canonicalPaths.add(new URL(String(url)).pathname);
      if (corrupt && !String(url).endsWith('/_publication-v2.json')) return new Response('corrupt', { headers: { 'cache-control': 'no-store' } });
      const recorded = recordedResponses.get(new URL(String(url)).pathname);
      return recorded ? new Response(recorded.bytes.slice(), { status: recorded.status, headers: recorded.headers }) : router.fetch(new Request(url, init));
    }),
  });
  if (!handles.every(value => value.closed)) throw new Error('Credential handle leaked');
  return { ...result, consumedCredentialFds: credentials };
}
try {
  fixture = await developmentInitialPairInstallFixture(firestore, { environment: 'production' });
  process.send({ ready: true, pairs: fixture.pairs });
  process.on('message', async ({ id, action, corruptBytes }) => {
    try {
      let result;
      if (action === 'stage') {
        await fixture.run('old-code'); await fixture.run('stage'); await fixture.complete(); await fixture.run('stage'); await fixture.complete();
        result = await fixture.run('stage');
      } else if (action === 'controls') {
        const pair = fixture.pairs[0], enrolled = (await firestore.doc('system/publicReleaseChanges/enrollment/initial').get()).data();
        const attempt = { schemaVersion: 2, operationId: fixture.packet.bootstrapOperationId, pair,
          ...await inspectBootstrapControls({ firestore, pair }), enrollmentReceiptDigest: protocol.publicReleaseDigest(enrolled),
          admittedContractDigest: fixture.evidence.contractDigest, consumerSourceSha: fixture.evidence.sourceSha,
          familyAdmission: { schemaVersion: 2, revision: 1, enabled: true, families: { posts: { mode: 'all' } }, backgroundBucket: 'njpbs-public-artifacts' } };
        result = await run('controls', attempt);
      } else if (action === 'qualify') {
        await fixture.run('qualify'); await fixture.complete(); qualification = await fixture.run('qualify'); result = { status: qualification.status, references: qualification.references };
      } else if (action === 'initial') {
        initialAttempt = { schemaVersion: 2, operationId: fixture.packet.bootstrapOperationId,
          expectedSourceDigest: protocol.publicReleaseDigest((await firestore.doc('system/publicDeployment').get()).data()),
          currentPair: fixture.pairs[0], recoveryPair: fixture.pairs[1], admittedContractDigest: fixture.evidence.contractDigest, qualifications: qualification.references };
        result = await run('initial', initialAttempt);
      } else if (action.startsWith('record-http-')) {
        // Record the real router/slot's frozen HTTP boundary separately. Resume
        // still exhausts the native guarded object store and byte comparison,
        // without paying for a second full set of routing SDK reads in one test.
        const receipt = qualification.qualifications[0].receipt, pair = fixture.pairs[0], paths = new Set(['/_publication-v2.json']);
        for await (const member of readQualificationEvidence({ store: fixture.store, pair, qualificationId: receipt.qualificationId,
          witnessDigest: receipt.witnessDigest, ...receipt.evidence, signal: AbortSignal.timeout(20_000) }))
          if (isPublicPairRequestPath(member.path) && !member.path.startsWith('/_pair-')) paths.add(member.path);
        const router = routerForFixture();
        const ordered = [...paths].sort(), part = Number(action.slice('record-http-'.length));
        if (!Number.isInteger(part) || part < 0 || part > 3) throw new Error('Unknown HTTP roster part');
        const size = Math.ceil(ordered.length / 4), subset = ordered.slice(part * size, (part + 1) * size);
        for (const path of subset) {
          const response = await router.fetch(new Request(`https://njpbs.org${path}`));
          recordedResponses.set(path, { bytes: new Uint8Array(await response.arrayBuffer()), status: response.status, headers: [...response.headers] });
        }
        result = { count: subset.length, complete: recordedResponses.size === paths.size };
      } else if (action === 'resume') {
        corrupt = Boolean(corruptBytes);
        if (!resumeAttempt) {
          const qualifications = [];
          for (const [index, pair] of fixture.pairs.entries()) {
            const head = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/heads/current`).get()).data();
            const qualified = await qualifyPublicReleasePair({ firestore, store: fixture.store, pair,
              witnessDigest: head.contentHead.viewId, qualificationId: `production-resume-${index}`, credentials: fixture.credentialsForPair(pair, index) });
            qualifications.push({ qualificationId: qualified.receipt.qualificationId, receiptDigest: qualified.digest });
          }
          resumeAttempt = { schemaVersion: 2, operationId: 'production-original-resume', bootstrap: initialAttempt, qualifications };
        }
        result = await run('resume', resumeAttempt);
      } else if (action === 'readback') {
        result = { initial: await run('initial', initialAttempt, 'readback'), resume: await run('resume', resumeAttempt, 'readback'),
          paths: [...canonicalPaths], producer: (await firestore.doc('system/publicReleaseChangeLog').get()).data(),
          fence: (await firestore.doc('system/publicReleaseAdmissions/controls/bootstrapFence').get()).data() };
      } else if (action === 'close') { await close(); return; }
      else throw new Error('Unknown fixture action');
      process.send({ id, result });
    } catch (error) { process.send({ id, error: { message: error.message, stack: error.stack } }); }
  });
} catch (error) { process.send({ ready: false, error: { message: error.message, stack: error.stack } }); await close(); }
