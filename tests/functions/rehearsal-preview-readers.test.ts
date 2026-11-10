import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { bridgeFixture, bodyDigest } from '../helpers/cms-reader-bridge.js';
import { releasePair, releaseSelector } from '../helpers/private-public-release-pair.js';
import { selector as previewSelector } from '../helpers/cms-preview-pairs.js';
import { candidate as rendererCandidate } from '../helpers/cms-preview-pairs.js';
import { previewProviderFixture } from '../helpers/private-preview-provider-fixture.js';
import { createCmsReaderBridge } from '../../cms-api/src/cms-reader-bridge';
import { proveCmsReaderBridge, installCmsReaderBridge, createCmsReaderReplayTransport, BRIDGE_ATTEMPTS, BRIDGE_PROOFS } from '../../scripts/lib/cms-reader-bridge-install.mjs';
import { startReceipt, completeReceipt, startCandidateReceipt, verifyCandidateReceipt, commitLiveReaderReceipt, functionsInventoryIdentity } from '../../scripts/lib/cms-component-receipt.mjs';
import { preparePairedAdminArtifact } from '../../scripts/lib/paired-admin-pages-artifact.mjs';
import { createPairedAdminPagesHttp } from '../../scripts/lib/paired-admin-pages-provider.mjs';
import { prepareRehearsalPreviewReaders, rehearsalPreviewReaderAdapter, assertRehearsalPreviewReadersCurrent } from '../../scripts/lib/rehearsal-preview-readers.mjs';
import { prepareRehearsalPreviewRuntime, qualifyRehearsalPreviewRuntime, selectRehearsalPreviewRuntime, createRehearsalPreviewActions } from '../../scripts/lib/public-release-rehearsal-preview.mjs';
import { installPrivatePreviewPair } from '../../scripts/lib/install-private-preview-pair.mjs';
import { qualifyPrivatePreviewPair, inspectPrivatePreviewPair } from '../../scripts/lib/install-private-preview-pair.mjs';
import { createPrivatePreviewPairProvider } from '../../scripts/lib/private-preview-pair-provider.mjs';
import { deployPreviewPairRuntime } from '../../site/scripts/deploy-cms-preview-pair.ts';
import { createRehearsalPreviewFault, armRehearsalPreviewFault, readRehearsalPreviewFault } from '../../scripts/lib/rehearsal-preview-fault.mjs';
import { verifyVersionedCmsReaders } from '../../.github/scripts/cms-deploy-compatibility.mjs';
import { DEV_TARGETS } from '../../scripts/assert-dev-cms-targets.mjs';
import { rehearsalAdminProvider } from '../helpers/rehearsal-admin-provider';
import { PREVIEW_BOUNDARIES } from '../../scripts/lib/public-release-rehearsal.mjs';
import { ADMIN_PROVIDER_OPERATIONS } from '../../scripts/lib/paired-admin-provider-operation.mjs';
import targets from '../../functions/lib/publication-target.js';

const require = createRequire(import.meta.url), api = require('../../functions/lib/cms-preview-pair.js');
const protocol = require('../../functions/lib/public-release-pair.js'), work = require('../../functions/lib/public-release-pair-work.js');
const { createVersionedCmsReaderHandler, readerIdentities } = require('../../functions/lib/cms-versioned-reader.js');
const db = isolatedFirestore('rehearsal-preview-reader-proof');
const actor = { uid: 'fixture-staff', principal: { id: 'fixture-staff', grants: [{ role: 'admin' }] } };
const oldPair = releasePair(), newPair = releasePair('b', 'b'.repeat(40)), publicSelector = releaseSelector();
const originalDeployment = '44444444-4444-4444-8444-444444444444';
const functions = [{ name: 'projects/njpbs-site-dev/locations/us-central1/functions/cmsPreviewStatus', state: 'ACTIVE' }];
let fixture: ReturnType<typeof bridgeFixture>, server: Server, directory: string, packet: any, admin: any, handle: any;
let deployment: string, providerCalls: Array<{ url: string; method: string }>;
let installed: any, nativePreview: Awaited<ReturnType<typeof previewProviderFixture>>, runtime: any, qualification: any;
let rendererInput: any, healthRequest: any;
let bridgeTransport: any, bridgeInstallCommon: any, bridgeCandidates: any;
let readerProvidersAvailable = true, privateReadsAvailable = true;
let requestMutation: (() => Promise<void>) | null = null;
async function mutateAtRequest() { if (requestMutation) await requestMutation(); }
const liveState = async () => (await db.doc('system/rehearsalReaderFixture').get()).data();
const readset = async ({ transaction }: any) => api.digest((await transaction.get(db.doc('system/rehearsalReaderFixture'))).data());
const options = () => ({ firestore: db, packet, retainedState: fixture.state,
  bridgeOperationId: fixture.request.operationId, admin });

async function readerHttp() {
  const handlers = Object.fromEntries([1, 2].map(version => {
    const endpoint = async (req: any, res: any) => {
      const row = fixture.request.cases.find(value => value.body.fixtureCase === req.body.fixtureCase)!;
      return res.status(200).json({ fixtureCase: row.body.fixtureCase, immutableSource: row.pairDigest });
    };
    return [version, createVersionedCmsReaderHandler({ firestore: db, readers: fixture.request.readers, version,
      handlers: { cmsGetPublicPage: endpoint, cmsGetPublishedSettings: endpoint, cmsPreviewStatus: endpoint, cmsReadPairCurrentCodeV2: endpoint },
      authenticate: async () => actor, edge: { readSecret: () => 'fixture-edge', logger: { warn() {}, error() {} } } })];
  }));
  let origin: string;
  const gateway = createCmsReaderBridge({ targets: [1, 2].map(version => ({ version: version as 1 | 2,
    functionsUrl: `https://us-central1-njpbs-site-dev.cloudfunctions.net/readerV${version}`,
    gatewayReaderDigest: readerIdentities(fixture.request.readers).cmsApi })), projectId: 'njpbs-site-dev',
    readEdgeSecret: () => 'fixture-edge', verifyToken: async () => ({ uid: 'fixture-staff' }),
    request: (url, init) => fetch(origin + new URL(String(url)).pathname, init) });
  server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks), path = incoming.url!;
      if (path.startsWith('/api/cms/')) {
        const result = await gateway(new Request('https://dev-api.example.org' + path, { method: 'POST',
          headers: incoming.headers as Record<string, string>, body: bytes }), {
          requestId: '33333333-3333-4333-8333-333333333333', clientIp: '203.0.113.9' });
        if (!result) throw new Error('Unknown test route');
        outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
      } else {
        const res = { statusCode: 200, headersSent: false, set(key: string, value: string) { outgoing.setHeader(key, value); return res; },
          status(code: number) { res.statusCode = code; return res; }, json(value: unknown) {
            res.headersSent = true; outgoing.statusCode = res.statusCode; outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify(value)); return res;
          } };
        await handlers[Number(path.at(-1))]({ method: incoming.method, headers: incoming.headers, is: () => true, body: JSON.parse(bytes.toString()) }, res);
      }
    })().catch(() => { outgoing.writeHead(503); outgoing.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No owned reader listener');
  origin = `http://127.0.0.1:${address.port}`;
  return createCmsReaderReplayTransport({ projectId: db.projectId, targets: { functions: { 1: origin + '/readerV1', 2: origin + '/readerV2' },
    cmsApi: { 1: origin + '/api/cms/v1/reader', 2: origin + '/api/cms/v2/reader' } }, readStaffToken: async () => 'fixture-staff',
    readEdgeSecret: async () => 'fixture-edge', allowLocalEmulator: true });
}

beforeAll(async () => {
  fixture = bridgeFixture(Date.now() - 1000); deployment = originalDeployment; providerCalls = [];
  nativePreview = await previewProviderFixture({ environment: 'development' });
  const nativePreviewRequest = nativePreview.request;
  nativePreview.request = async (raw: any, init: any = {}) => {
    await mutateAtRequest();
    if (!privateReadsAvailable && (init.method ?? 'GET') === 'GET') throw new Error('Fixture private read unavailable');
    return nativePreviewRequest(raw, init);
  };
  const legacy = { schemaVersion: 1, phase: 'ready', rendererSha: 'a'.repeat(40), serializerId: 'cloudflare-preview' };
  await db.doc(api.SELECTOR_PATH).set(legacy);
  rendererInput = { sourceSha: nativePreview.descriptor.rendererSha, trustedWorkflowSha: 'e'.repeat(40), runId: '300', runAttempt: 1,
    inputFingerprint: nativePreview.prepared.bundleDigest, configurationFingerprint: nativePreview.prepared.configurationDigest };
  const resourceRequest = { operationId: 'preview-reader-resources', expectedRuntimeDigest: api.digest(legacy), expectedCandidatePointerDigest: null,
    bootstrapPublicPair: protocol.publicReleasePairReference(oldPair), candidate: rendererInput };
  installed = await installPrivatePreviewPair({ firestore: db, prepared: nativePreview.prepared, request: resourceRequest,
    readToken: () => 'fixture-preview', readSecret: () => 'fixture-binding', fetchImpl: nativePreview.request, dryRun: false });
  fixture.state.previewPairs[1] = installed.resource.pair;
  fixture.state.publicPairs = [oldPair, newPair].map(pair => ({ pairDigest: protocol.publicReleaseDigest(pair),
    requirements: { ...fixture.state.previewPairs[0].requirements } }));
  fixture.state.publicSelectorDigest = protocol.publicReleaseDigest(publicSelector);
  const scopes = { publicOld: fixture.state.publicPairs[0].pairDigest, publicNew: fixture.state.publicPairs[1].pairDigest,
    previewOld: api.digest(fixture.state.previewPairs[0]), previewNew: api.digest(fixture.state.previewPairs[1]) };
  for (const row of fixture.request.cases) {
    row.pairDigest = scopes[row.scope as keyof typeof scopes];
    row.expected.bodyDigest = bodyDigest(Buffer.from(JSON.stringify({ fixtureCase: row.body.fixtureCase, immutableSource: row.pairDigest })));
  }
  fixture.request.expectedStateDigest = api.digest(fixture.state);
  fixture.request.readers.functions.providerIdentities = functionsInventoryIdentity(functions);
  fixture.request.readers.cmsApi.providerIdentities = { script: DEV_TARGETS.CMS_API_WORKER, deploymentId: originalDeployment, versionId: "77777777-7777-4777-8777-777777777777" };
  // Initial installed environment is fixture input. The proof/session and
  // candidate/live-reader/bridge receipt owners below run their real SDK CAS.
  await db.doc('system/publicDeployment').set(publicSelector);
  for (const pair of [oldPair, newPair]) await db.doc(work.publicReleasePairPath(pair.pairId)).set(pair);
  for (const pair of fixture.state.previewPairs) await api.registerPair(db, pair);
  await db.doc('system/rehearsalReaderFixture').set(fixture.state);
  directory = await mkdtemp(join(tmpdir(), 'rehearsal-reader-artifact-'));
  await writeFile(join(directory, 'index.html'), '<html>Retained fixture Admin</html>');
  await writeFile(join(directory, 'admin-status.json'), JSON.stringify({ schemaVersion: 2, status: 'current', environment: 'Development',
    build: { revision: 'b'.repeat(40) } }));
  const prepared = await preparePairedAdminArtifact({ directory, environment: 'development', sourceSha: 'b'.repeat(40) });
  admin = { authorized: true, prepared, target: { environment: 'development', accountId: DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID,
    projectId: 'njpbs-site-dev', pagesProjectId: '33333333-3333-4333-8333-333333333333', branch: 'main', configurationDigest: 'c'.repeat(64) },
  readCloudflareToken: async () => 'fixture-cloudflare', readGoogleToken: async () => 'fixture-google', readAccessHeaders: async () => ({}),
  fetchImpl: async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    if (!readerProvidersAvailable) throw new Error('Fixture reader provider unavailable');
    providerCalls.push({ url: url.origin + url.pathname, method: init.method ?? 'GET' });
    if (url.origin === 'https://cloudfunctions.googleapis.com' && url.pathname === '/v2/projects/njpbs-site-dev/locations/us-central1/functions') {
      return Response.json({ functions });
    }
    if (url.origin === 'https://api.cloudflare.com' && url.pathname.endsWith('/workers/scripts/template-dev-cms-api/deployments')) {
      return Response.json({ success: true, result: { deployments: [{ id: deployment, versions: [{ version_id: "77777777-7777-4777-8777-777777777777", percentage: 100 }] }] } });
    }
    throw new Error('Unexpected test provider destination');
  } };
  const http = createPairedAdminPagesHttp(admin), readProviders = () => http.readLiveReaderIdentities();
  const common = { firestore: db, request: fixture.request, readLiveState: liveState, readProviders,
    readRetainedCases: async () => structuredClone(fixture.request.cases), assertStateInTransaction: readset };
  bridgeInstallCommon = common;
  const candidates: any = {}; bridgeCandidates = candidates;
  for (const [index, component] of ['functions', 'cmsApi'].entries()) {
    const reader = fixture.request.readers[component as 'functions' | 'cmsApi'];
    const input = { component, sourceSha: reader.sourceSha, trustedWorkflowSha: 'e'.repeat(40), runId: String(100 + index), runAttempt: 1,
      inputFingerprint: reader.inputFingerprint, configurationFingerprint: reader.configurationFingerprint };
    await startCandidateReceipt(db, input);
    const candidate = await verifyCandidateReceipt(db, input, { collect: async () => (await readProviders())[component] });
    // Use the actual preceding schema-one receipt owners before installing
    // schema two; do not seed a synthetic completed-reader receipt.
    await startReceipt(db, { ...input, ...(component === 'functions' ? { previewRendererSha: fixture.state.previewPairs[0].rendererSha } : {}) });
    // These retained readers use fixture SHAs, outside the local Git object
    // database, and predate the optional Page reader source descriptor.
    await completeReceipt(db, { ...input, providerIdentities: candidate.mutation.providerIdentities },
      { readPageReaderSource: async () => null });
    candidates[component] = { ...input, supported: reader.supported };
  }
  await db.doc(api.SELECTOR_PATH).set(previewSelector(...fixture.state.previewPairs));
  await db.doc(api.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, component: 'renderer', state: 'complete',
    pairId: fixture.state.previewPairs[0].pairId, selectorDigest: api.digest(previewSelector(...fixture.state.previewPairs)),
    lastComplete: rendererCandidate(fixture.state.previewPairs[0], Date.now()).mutation });
  bridgeTransport = await readerHttp();
  await proveCmsReaderBridge({ ...common, transport: bridgeTransport });
  await installCmsReaderBridge({ ...common, candidates, commitReader: commitLiveReaderReceipt });
  packet = { schemaVersion: 1, projectId: db.projectId, emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    oldPair, newPair, previewPairs: { old: fixture.state.previewPairs[0], new: fixture.state.previewPairs[1] } };
  handle = await prepareRehearsalPreviewReaders(options());
  const pointer = (await db.doc(`cmsPreviewPairCandidatePointers/${installed.resource.pair.pairId}`).get()).data();
  healthRequest = { ...resourceRequest, operationId: 'preview-reader-health',
    expectedRuntimeDigest: api.digest(previewSelector(...fixture.state.previewPairs)), expectedCandidatePointerDigest: api.digest(pointer) };
  runtime = await prepareRehearsalPreviewRuntime({ firestore: db, readers: handle, prepared: nativePreview.prepared,
    resourceOperationId: resourceRequest.operationId, request: healthRequest, readToken: () => 'fixture-preview',
    readSecret: () => 'fixture-binding', fetchImpl: nativePreview.request, authorized: true });
}, 20_000);
afterAll(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('uses the real installed proof, original attempt and current provider readback without any provider write', async () => {
  const adapter = rehearsalPreviewReaderAdapter(handle);
  const result = await verifyVersionedCmsReaders({ ...adapter, cmsSourceSha: 'b'.repeat(40) });
  expect(result.candidateSourceSha).toBe('b'.repeat(40)); expect(result.replays.functions).toMatch(/^[a-f0-9]{64}$/);
  const proof = await adapter.provePrivate(fixture.state.previewPairs[1]);
  expect(proof.pairDigest).toBe(api.digest(fixture.state.previewPairs[1]));
  const record = (await db.doc(`${BRIDGE_PROOFS}/${fixture.request.operationId}`).get()).data()!;
  expect(proof.replays.functionsOld).toBe(protocol.publicReleaseDigest(record.proof.results.filter((row: any) => row.component === 'functions' && ['publicOld', 'previewOld'].includes(row.scope))));
  expect(providerCalls.every(call => call.method === 'GET')).toBe(true);
});
it('permits a routine verification-time refresh while binding the current full reader digest', async () => {
  const ref = db.doc(`${api.READER_RECEIPTS}/functions`), original = (await ref.get()).data()!;
  try {
    await ref.update({ 'lastComplete.verifiedAt': new Date().toISOString() });
    const adapter = rehearsalPreviewReaderAdapter(handle), state = await adapter.readLiveState();
    const reader = api.currentReader(state.readers.functions, 'functions');
    const evidence = await adapter.replayDeployedReader({ component: 'functions', reader, state });
    expect(evidence.readerDigest).toBe(api.digest(reader));
    expect((await db.doc(`${BRIDGE_PROOFS}/${fixture.request.operationId}`).get()).data()!.proof.readers.functions.verifiedAt)
      .toBe(fixture.request.readers.functions.verifiedAt);
  } finally { await ref.set(original); }
});
it('refuses current public-source drift instead of reusing an older completed reader proof', async () => {
  const ref = db.doc('system/publicDeployment');
  try {
    await ref.update({ 'contentHead.contextSequence': 1 });
    await expect(rehearsalPreviewReaderAdapter(handle).readLiveState()).rejects.toThrow();
  } finally { await ref.set(publicSelector); }
});
it('refuses actual provider drift even when the stored reader receipt has not changed', async () => {
  deployment = '55555555-5555-4555-8555-555555555555';
  try { await expect(rehearsalPreviewReaderAdapter(handle).readLiveState()).rejects.toThrow(); }
  finally { deployment = originalDeployment; }
});
it.each(['incomplete-attempt', 'different-record'])('refuses %s instead of treating installed shape as an original proof', async kind => {
  const path = kind === 'incomplete-attempt' ? `${BRIDGE_ATTEMPTS}/${fixture.request.operationId}` : `${BRIDGE_PROOFS}/${fixture.request.operationId}`;
  const ref = db.doc(path), original = (await ref.get()).data()!;
  try {
    await ref.update(kind === 'incomplete-attempt' ? { state: 'uncertain' } : { 'proof.requestDigest': '0'.repeat(64) });
    await expect(rehearsalPreviewReaderAdapter(handle).readLiveState()).rejects.toThrow();
  } finally { await ref.set(original); }
});
it('uses the original SDK readset guard inside a transaction and refuses a later public-source change without writing', async () => {
  const ref = db.doc('system/publicDeployment'), marker = db.doc('system/rehearsalReaderMarker');
  try {
    await ref.update({ 'contentHead.contextSequence': 2 });
    await expect(db.runTransaction(async transaction => {
      await assertRehearsalPreviewReadersCurrent(handle, db, transaction); transaction.create(marker, { unexpected: true });
    })).rejects.toThrow();
    expect((await marker.get()).exists).toBe(false);
  } finally { await ref.set(publicSelector); }
});
it('rejects copied handles, changed attested requirements and invalid clocks before another provider request', async () => {
  expect(() => rehearsalPreviewReaderAdapter({ ...handle })).toThrow();
  const before = providerCalls.length;
  const changed = structuredClone(fixture.state); changed.publicPairs[0].requirements.settings = 2;
  await expect(prepareRehearsalPreviewReaders({ ...options(), retainedState: changed })).rejects.toThrow();
  await expect(prepareRehearsalPreviewReaders({ ...options(), now: () => Number.NaN })).rejects.toThrow();
  expect(providerCalls).toHaveLength(before);
});
it('refuses an expired original proof and a production target', async () => {
  await expect(prepareRehearsalPreviewReaders({ ...options(), now: () => Date.now() + 300_001 })).rejects.toThrow();
  await expect(prepareRehearsalPreviewReaders({ ...options(), admin: { ...admin, target: { ...admin.target, environment: 'production', projectId: 'njpbs-site' } } })).rejects.toThrow();
});

it('qualifies through the actual installed owner without retiming its verified renderer candidate or resource assignments', async () => {
  const ref = db.doc('cmsDeploymentCandidates/renderer-300-1'), before = await ref.get();
  expect(await startCandidateReceipt(db, { ...rendererInput, component: 'renderer' })).toEqual(before.data());
  expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  qualification = await qualifyRehearsalPreviewRuntime(runtime, { operationId: 'preview-reader-rollout',
    expectedSelectorDigest: healthRequest.expectedRuntimeDigest });
  const after = await ref.get();
  expect(after.data()).toEqual(before.data()); expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
  const pointer = (await db.doc(`cmsPreviewPairCandidatePointers/${installed.resource.pair.pairId}`).get()).data()!;
  expect(pointer.candidateDigest).toBe(api.digest(before.data()));
  expect(nativePreview.state.writes).toEqual(['identity', 'version', 'deployment', 'container', 'schedule']);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(previewSelector(...fixture.state.previewPairs));
});

async function reserveDefaultRollout(operationId: string) {
  let attemptDigest: string | undefined;
  const unavailable = createPrivatePreviewPairProvider({ prepared: nativePreview.prepared, operationDigest: installed.resource.planDigest,
    readToken: () => 'fixture-preview', readSecret: () => 'fixture-binding', fetchImpl: async () => { throw new Error('Fixture readback unavailable'); } });
  const input = { firestore: db, pair: installed.resource.pair, operationId, expectedSelectorDigest: healthRequest.expectedRuntimeDigest,
    candidate: rendererInput, adapter: { ...rehearsalPreviewReaderAdapter(handle),
      deployPrivate: async (_pair: any, attempt: any) => {
        attemptDigest = attempt.attemptDigest;
        await qualifyPrivatePreviewPair({ firestore: db, prepared: nativePreview.prepared, resourceOperationId: installed.resource.plan.operationId,
          request: healthRequest, readToken: () => 'fixture-preview', readSecret: () => 'fixture-binding', fetchImpl: nativePreview.request });
      }, readback: async () => {
        await inspectPrivatePreviewPair({ provider: unavailable, prepared: nativePreview.prepared, versionId: installed.resource.pair.workerVersion });
        throw new Error('Unexpected successful fixture readback');
      } } };
  await expect(deployPreviewPairRuntime({ ...input, qualificationRequestDigest: undefined })).rejects.toThrow('candidate_readback');
  return { input, attemptDigest, row: (await db.doc(`cmsPreviewPairRollouts/${operationId}`).get()).data()! };
}

it('keeps the main identity and attempt digest when the optional qualification binding is undefined', async () => {
  const { row, attemptDigest } = await reserveDefaultRollout('preview-reader-default-identity');
  const mainIdentity = { pairDigest: api.digest(installed.resource.pair), expectedSelectorDigest: healthRequest.expectedRuntimeDigest, candidate: rendererInput };
  expect(row.identity).toEqual(mainIdentity);
  expect(api.digest(row.identity)).toBe(api.digest(mainIdentity));
  expect(attemptDigest).toBe(api.digest(mainIdentity));
});
it('refuses a different optional qualification digest on the same retained native rollout', async () => {
  const { input } = await reserveDefaultRollout('preview-reader-default-conflict');
  const before = await db.doc(`cmsPreviewPairRollouts/${input.operationId}`).get();
  await expect(deployPreviewPairRuntime({ ...input, qualificationRequestDigest: '9'.repeat(64) })).rejects.toThrow('Preview rollout attempt conflicts');
  expect((await before.ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
});

it('refuses adopting another health request through the same retained rollout operation', async () => {
  const healthRef = db.doc(`cmsPreviewPrivateHealth/${healthRequest.operationId}`), originalHealth = (await healthRef.get()).data()!;
  const refs = [db.doc(api.SELECTOR_PATH), db.doc(api.RENDERER_RECEIPT_PATH)], before = await db.getAll(...refs);
  const operationId = 'preview-reader-reused-health', switchRef = db.doc(`${api.SWITCHES}/${operationId}`);
  const pointer = (await db.doc(`cmsPreviewPairCandidatePointers/${installed.resource.pair.pairId}`).get()).data();
  const request = { ...healthRequest, operationId: 'preview-reader-health-alternate', expectedCandidatePointerDigest: api.digest(pointer) };
  const input = { firestore: db, readers: handle, prepared: nativePreview.prepared, resourceOperationId: installed.resource.plan.operationId,
    request, readToken: () => 'fixture-preview', readSecret: () => 'fixture-binding', fetchImpl: nativePreview.request, authorized: true };
  const other = await prepareRehearsalPreviewRuntime(input);
  await qualifyPrivatePreviewPair(input);
  let refusal: string | null = null;
  try {
    await healthRef.update({ completedAt: new Date(Date.now() - 300_001).toISOString() });
    try {
      const borrowed = await qualifyRehearsalPreviewRuntime(other, { operationId: qualification.operationId,
        expectedSelectorDigest: request.expectedRuntimeDigest });
      await selectRehearsalPreviewRuntime(other, { ...borrowed, operationId });
    } catch (error: any) { refusal = error.message; }
    expect(refusal).toBe('Preview rollout attempt conflicts');
    const after = await db.getAll(...refs);
    after.forEach((row, index) => expect(row.updateTime!.isEqual(before[index].updateTime!)).toBe(true));
    expect((await switchRef.get()).exists).toBe(false);
  } finally {
    await healthRef.set(originalHealth);
    const after = await db.getAll(...refs);
    for (const [index, row] of after.entries()) if (!row.updateTime!.isEqual(before[index].updateTime!)) await row.ref.set(before[index].data()!);
    if ((await switchRef.get()).exists) await switchRef.delete();
  }
});

it('rejects changed native renderer readback before recording private replay or retiming the retained candidate', async () => {
  const candidateRef = db.doc('cmsDeploymentCandidates/renderer-300-1'), before = await candidateRef.get();
  const proofs = (await db.collection(api.PROOFS).get()).size;
  let drift = false;
  const request = async (url: string, init: any) => {
    const response = await nativePreview.request(url, init);
    if (drift && (init?.method ?? 'GET') === 'GET' && new URL(url).pathname.endsWith('/deployments')) {
      const body = await response.json(); body.result.deployments[0].id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      return Response.json(body);
    }
    return response;
  };
  const provider = createPrivatePreviewPairProvider({ prepared: nativePreview.prepared, operationDigest: installed.resource.planDigest,
    readToken: () => 'fixture-preview', readSecret: () => 'fixture-binding', fetchImpl: request });
  const adapter = { ...rehearsalPreviewReaderAdapter(handle),
    deployPrivate: async () => {
      await qualifyPrivatePreviewPair({ firestore: db, prepared: nativePreview.prepared, resourceOperationId: installed.resource.plan.operationId,
        request: healthRequest, readToken: () => 'fixture-preview', readSecret: () => 'fixture-binding', fetchImpl: nativePreview.request });
      drift = true;
    },
    readback: async () => {
      const { pair, evidence } = await inspectPrivatePreviewPair({ provider, prepared: nativePreview.prepared, versionId: installed.resource.pair.workerVersion });
      return { pairId: pair.pairId, rendererSha: pair.rendererSha, serializerId: pair.serializerId, workerName: pair.workerName,
        applicationName: pair.applicationName, workerVersion: pair.workerVersion, imageDigest: pair.imageDigest,
        applicationId: evidence.container.applicationId, workerDeploymentId: evidence.deployment.deploymentId, workerId: evidence.worker.workerId,
        namespaceId: evidence.namespace.namespaceId, bundleDigest: nativePreview.prepared.bundleDigest,
        configurationDigest: nativePreview.prepared.configurationDigest };
    } };
  await expect(deployPreviewPairRuntime({ firestore: db, pair: installed.resource.pair, operationId: 'preview-reader-readback-drift',
    expectedSelectorDigest: healthRequest.expectedRuntimeDigest, candidate: rendererInput, adapter })).rejects.toThrow('candidate_readback');
  const after = await candidateRef.get();
  expect(after.data()).toEqual(before.data()); expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
  expect((await db.collection(api.PROOFS).get()).size).toBe(proofs);
  expect((await db.doc('cmsPreviewPairRollouts/preview-reader-readback-drift').get()).data()!.state).toBe('reserved');
});

it('aborts the owning selection transaction on the original installed readset guard with no selector or receipt writes', async () => {
  const selectorRef = db.doc(api.SELECTOR_PATH), rendererRef = db.doc(api.RENDERER_RECEIPT_PATH), publicRef = db.doc('system/publicDeployment');
  const before = await db.getAll(selectorRef, rendererRef);
  try {
    await publicRef.update({ 'contentHead.contextSequence': 3 });
    await expect(api.selectPair(db, qualification, undefined, { assertCurrentInTransaction: ({ firestore, transaction }: any) =>
      assertRehearsalPreviewReadersCurrent(handle, firestore, transaction) })).rejects.toThrow('reader proof refused');
    const after = await db.getAll(selectorRef, rendererRef);
    after.forEach((row, index) => {
      expect(row.data()).toEqual(before[index].data()); expect(row.updateTime!.isEqual(before[index].updateTime!)).toBe(true);
    });
    expect((await db.doc(`${api.SWITCHES}/${qualification.operationId}`).get()).exists).toBe(false);
  } finally { await publicRef.set(publicSelector); }
});

it('keeps the existing five-minute candidate bound after the verified receipt is reused', async () => {
  const candidateRef = db.doc('cmsDeploymentCandidates/renderer-300-1'), original = await candidateRef.get();
  const before = await db.getAll(db.doc(api.SELECTOR_PATH), db.doc(api.RENDERER_RECEIPT_PATH));
  try {
    await candidateRef.update({ 'mutation.completedAt': new Date(Date.now() - 300_001).toISOString() });
    const stale = await candidateRef.get();
    expect(await startCandidateReceipt(db, { ...rendererInput, component: 'renderer' })).toEqual(stale.data());
    expect((await candidateRef.get()).updateTime!.isEqual(stale.updateTime!)).toBe(true);
    await expect(api.selectPair(db, qualification)).rejects.toThrow();
    const after = await db.getAll(db.doc(api.SELECTOR_PATH), db.doc(api.RENDERER_RECEIPT_PATH));
    after.forEach((row, index) => expect(row.updateTime!.isEqual(before[index].updateTime!)).toBe(true));
    expect((await db.doc(`${api.SWITCHES}/${qualification.operationId}`).get()).exists).toBe(false);
  } finally { await candidateRef.set(original.data()!); }
});

it('retains the original failed readback and refuses to skip its missing health receipt on a reserved rollout retry', async () => {
  const pointer = (await db.doc(`cmsPreviewPairCandidatePointers/${installed.resource.pair.pairId}`).get()).data();
  const request = { ...healthRequest, operationId: 'preview-reader-health-recovery', expectedCandidatePointerDigest: api.digest(pointer),
    candidate: { ...rendererInput, runId: '301' } };
  const fault = createRehearsalPreviewFault({ boundary: 'preview-rollout', projectId: db.projectId,
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, prepared: nativePreview.prepared, fetchImpl: nativePreview.request, authorized: true });
  const input = { firestore: db, readers: handle, prepared: nativePreview.prepared, resourceOperationId: installed.resource.plan.operationId,
    request, readToken: () => 'fixture-preview', readSecret: () => 'fixture-binding', fetchImpl: fault.fetch, signal: fault.signal, authorized: true };
  const recovery = await prepareRehearsalPreviewRuntime(input);
  const action = { operationId: 'preview-reader-recovery-rollout', expectedSelectorDigest: request.expectedRuntimeDigest };
  const proofCount = (await db.collection(api.PROOFS).get()).size;
  armRehearsalPreviewFault(fault);
  await expect(qualifyRehearsalPreviewRuntime(recovery, action)).rejects.toThrow('private_deployment');
  expect(readRehearsalPreviewFault(fault)).toMatchObject({ boundary: 'preview-rollout', dispatched: false });
  expect((await db.doc(`cmsPreviewPrivateHealth/${request.operationId}`).get()).exists).toBe(false);
  await expect(qualifyRehearsalPreviewRuntime(recovery, action)).rejects.toThrow('candidate_readback');
  expect((await db.doc('cmsDeploymentCandidates/renderer-301-1').get()).data()!.state).toBe('candidate');
  expect((await db.collection(api.PROOFS).get()).size).toBe(proofCount);
  // Explicit recovery uses the SAME native health owner/request and already
  // assigned resources. It does not rerun a resource install or replace IDs.
  await qualifyPrivatePreviewPair({ ...input, fetchImpl: nativePreview.request });
  await expect(qualifyRehearsalPreviewRuntime(recovery, action)).resolves.toHaveProperty('proofDigest');
  expect(nativePreview.state.writes).toEqual(['identity', 'version', 'deployment', 'container', 'schedule']);
});

it('refuses an expired original health receipt even while the renderer candidate and reader proof remain fresh', async () => {
  const ref = db.doc(`cmsPreviewPrivateHealth/${healthRequest.operationId}`), original = (await ref.get()).data()!;
  const selectorRef = db.doc(api.SELECTOR_PATH), rendererRef = db.doc(api.RENDERER_RECEIPT_PATH);
  const before = await db.getAll(selectorRef, rendererRef), operationId = 'preview-reader-stale-health';
  const switchRef = db.doc(`${api.SWITCHES}/${operationId}`);
  try {
    await ref.update({ completedAt: new Date(Date.now() - 300_001).toISOString() });
    await expect(selectRehearsalPreviewRuntime(runtime, { ...qualification, operationId })).rejects.toThrow('preview binding refused');
    const after = await db.getAll(selectorRef, rendererRef);
    after.forEach((row, index) => expect(row.updateTime!.isEqual(before[index].updateTime!)).toBe(true));
    expect((await switchRef.get()).exists).toBe(false);
  } finally {
    await ref.set(original);
    // Keep later integration cases isolated if the regression is reintroduced.
    const after = await db.getAll(selectorRef, rendererRef);
    for (const [index, row] of after.entries()) if (!row.updateTime!.isEqual(before[index].updateTime!)) await row.ref.set(before[index].data()!);
    if ((await switchRef.get()).exists) await switchRef.delete();
  }
});

it('refuses a qualification borrowed from another handle with a different original health request', async () => {
  const healthRef = db.doc(`cmsPreviewPrivateHealth/${healthRequest.operationId}`), originalHealth = (await healthRef.get()).data()!;
  const refs = [db.doc(api.SELECTOR_PATH), db.doc(api.RENDERER_RECEIPT_PATH)], before = await db.getAll(...refs);
  const operationId = 'preview-reader-cross-health', switchRef = db.doc(`${api.SWITCHES}/${operationId}`);
  const pointer = (await db.doc(`cmsPreviewPairCandidatePointers/${installed.resource.pair.pairId}`).get()).data();
  const request = { ...healthRequest, operationId: 'preview-reader-health-other', expectedCandidatePointerDigest: api.digest(pointer),
    candidate: { ...rendererInput, runId: '302' } };
  const other = await prepareRehearsalPreviewRuntime({ firestore: db, readers: handle, prepared: nativePreview.prepared,
    resourceOperationId: installed.resource.plan.operationId, request, readToken: () => 'fixture-preview',
    readSecret: () => 'fixture-binding', fetchImpl: nativePreview.request, authorized: true });
  const ownProof = await qualifyRehearsalPreviewRuntime(other, { operationId: 'preview-reader-other-rollout',
    expectedSelectorDigest: request.expectedRuntimeDigest });
  expect(ownProof.proofDigest).not.toBe(qualification.proofDigest);
  try {
    await healthRef.update({ completedAt: new Date(Date.now() - 300_001).toISOString() });
    await expect(selectRehearsalPreviewRuntime(other, { ...qualification, operationId })).rejects.toThrow('preview binding refused');
    const after = await db.getAll(...refs);
    after.forEach((row, index) => expect(row.updateTime!.isEqual(before[index].updateTime!)).toBe(true));
    expect((await switchRef.get()).exists).toBe(false);
  } finally {
    await healthRef.set(originalHealth);
    // Repair only the owned initial world if the regression makes selection.
    const after = await db.getAll(...refs);
    for (const [index, row] of after.entries()) if (!row.updateTime!.isEqual(before[index].updateTime!)) await row.ref.set(before[index].data()!);
    if ((await switchRef.get()).exists) await switchRef.delete();
  }
});

it('selects through the real guarded owner once and retains its exact original receipt on retry', async () => {
  const initial = previewSelector(...fixture.state.previewPairs);
  const result = await selectRehearsalPreviewRuntime(runtime, qualification);
  expect(result.selector).toMatchObject({ selectedPairId: installed.resource.pair.pairId,
    recoveryPairId: initial.selectedPairId, epoch: initial.epoch + 1 });
  expect(await selectRehearsalPreviewRuntime(runtime, qualification)).toEqual(result);
  expect((await db.doc(api.RENDERER_RECEIPT_PATH).get()).data()!.lastComplete)
    .toEqual((await db.doc('cmsDeploymentCandidates/renderer-300-1').get()).data()!.mutation);
  expect(nativePreview.state.writes).toEqual(['identity', 'version', 'deployment', 'container', 'schedule']);
});

it.each(['provider', 'public-source', 'health-age'])(
  'returns the exact committed switch receipt on retry despite later %s drift', async drift => {
    const original = await api.selectPair(db, qualification), publicRef = db.doc('system/publicDeployment');
    const healthRef = db.doc(`cmsPreviewPrivateHealth/${healthRequest.operationId}`);
    const publicBefore = (await publicRef.get()).data()!, healthBefore = (await healthRef.get()).data()!;
    const refs = [db.doc(api.SELECTOR_PATH), db.doc(api.RENDERER_RECEIPT_PATH), db.doc(`${api.SWITCHES}/${qualification.operationId}`)];
    const before = await db.getAll(...refs);
    try {
      if (drift === 'provider') deployment = '55555555-5555-4555-8555-555555555555';
      if (drift === 'public-source') await publicRef.update({ 'contentHead.contextSequence': 99 });
      if (drift === 'health-age') await healthRef.update({ completedAt: new Date(Date.now() - 300_001).toISOString() });
      expect(await api.selectPair(db, qualification)).toEqual(original);
      expect(await selectRehearsalPreviewRuntime(runtime, qualification)).toEqual(original);
      await expect(selectRehearsalPreviewRuntime(runtime, { ...qualification, proofDigest: '0'.repeat(64) })).rejects.toThrow();
      const after = await db.getAll(...refs);
      after.forEach((row, index) => expect(row.updateTime!.isEqual(before[index].updateTime!)).toBe(true));
    } finally { deployment = originalDeployment; await publicRef.set(publicBefore); await healthRef.set(healthBefore); }
  });

describe.sequential('actual six-boundary SDK and native provider composition', () => {
  let actions: Awaited<ReturnType<typeof createRehearsalPreviewActions>>, pages: Awaited<ReturnType<typeof rehearsalAdminProvider>>;
  const runId = 'rehearsal-preview-six';
  let adminReadable = true;
  async function resetOldWorld() {
    const initial = previewSelector(...fixture.state.previewPairs);
    await db.doc(api.SELECTOR_PATH).set(initial);
    await db.doc(api.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, component: 'renderer', state: 'complete',
      pairId: initial.selectedPairId, selectorDigest: api.digest(initial), lastComplete: rendererCandidate(fixture.state.previewPairs[0], Date.now()).mutation });
  }
  beforeAll(async () => {
    // Start this separate isolated scenario from its specified installed OLD
    // world. All resource/reader/proof owners above remain real and unchanged.
    await resetOldWorld();
    const serializerId = targets.publicationTarget('development').serializerId;
    await db.doc('system/cmsPublicationRuntime').set({ schemaVersion: 1, phase: 'ready', commitSha: publicSelector.activeCommitSha, serializerId,
      cloud: { phase: 'ready', commitSha: publicSelector.activeCommitSha, serializerId } });
    pages = await rehearsalAdminProvider({ directory, candidateArtifact: admin.prepared, functions, cmsApiDeployment: originalDeployment });
    const nativeAdminRequest = pages.admin.fetchImpl;
    pages.admin.fetchImpl = async (raw: string, init: any = {}) => {
      await mutateAtRequest();
      if (!adminReadable && new URL(raw).origin === 'https://api.cloudflare.com') throw new Error('Fixture Pages baseline unavailable');
      return nativeAdminRequest(raw, init);
    };
    await db.doc('cmsDeploymentReceipts/adminManifest').set({ schemaVersion: 1, state: 'complete',
      lastComplete: { manifestDigest: pages.admin.baseline.artifact.manifestDigest } });
    actions = await createRehearsalPreviewActions(runtime, { runId, admin: pages.admin, authorized: true });
  });
  it('refuses an out-of-order run and an incomplete original intent without a new provider action', async () => {
    const otherId = 'rehearsal-preview-unknown';
    const refs = [db.doc(api.SELECTOR_PATH), db.doc(api.RENDERER_RECEIPT_PATH)], before = await db.getAll(...refs);
    expect(before[0].data()!.selectedPairId).toBe(fixture.state.previewPairs[0].pairId);
    const other = await createRehearsalPreviewActions(runtime, { runId: otherId, admin: pages.admin, authorized: true });
    await expect(other.execute({ boundary: 'admin-assets', actionId: `${otherId}-preview-admin-assets` })).rejects.toThrow('Rehearsal preview action order refused');
    expect((await db.doc(`publicReleaseRehearsalPreview/${otherId}/intents/admin-assets`).get()).exists).toBe(false);
    const intentRef = db.doc(`publicReleaseRehearsalPreview/${otherId}/intents/functions`);
    await intentRef.create({ schemaVersion: 1, originalIntent: true });
    await expect(other.execute({ boundary: 'functions', actionId: `${otherId}-preview-functions` })).rejects.toThrow('Rehearsal private preview binding refused');
    const after = await db.getAll(...refs);
    after.forEach((row, index) => expect(row.updateTime!.isEqual(before[index].updateTime!)).toBe(true));
    expect(pages.calls.every(call => call.method === 'GET')).toBe(true);
    expect((await db.collection(`publicReleaseRehearsalPreview/${otherId}/results`).get()).empty).toBe(true);
    expect(nativePreview.state.writes).toHaveLength(5);
  });

  it('refuses an Admin candidate identical to its served baseline before any provider read or intent', async () => {
    const identical = await rehearsalAdminProvider({ directory, candidateArtifact: pages.admin.prepared,
      servedArtifact: pages.admin.prepared, functions, cmsApiDeployment: originalDeployment });
    const before = await actions.inspect('functions');
    const refusal = await createRehearsalPreviewActions(runtime, { runId: 'rehearsal-identical-admin', authorized: true,
      admin: identical.admin }).then(() => null, error => error.message);
    expect(refusal).toBe('Rehearsal private preview binding refused');
    expect(identical.calls).toHaveLength(0);
    expect((await db.collection('publicReleaseRehearsalPreview/rehearsal-identical-admin/intents').get()).empty).toBe(true);
    const { observedAt: beforeAt, ...beforeAuthority } = before;
    const { observedAt: afterAt, ...afterAuthority } = await actions.inspect('functions');
    expect(afterAuthority).toEqual(beforeAuthority);
    expect(Date.parse(afterAt)).toBeGreaterThanOrEqual(Date.parse(beforeAt));
  });

  // #4178: one actual six-boundary SDK sequence, including read-only recovery
  // and exact repeated replies. This is a new integration case, not a retry.
  it('records all six original outcomes, preserves OLD until selection and keeps NEW through both Admin failures', async () => {
    const originalAdmin = await db.doc('cmsDeploymentReceipts/adminManifest').get();
    for (const [index, boundary] of PREVIEW_BOUNDARIES.entries()) {
      const request = { boundary, actionId: `${runId}-preview-${boundary}` };
      if (['preview-selection', 'pre-selection-cancellation', 'admin-assets'].includes(boundary)) {
        for (const unavailable of ['reader', 'private']) {
          const before = await actions.inspect(boundary);
          readerProvidersAvailable = unavailable !== 'reader'; privateReadsAvailable = unavailable !== 'private';
          try {
            await expect(actions.execute(request)).rejects.toThrow();
            expect((await db.doc(`publicReleaseRehearsalPreview/${runId}/intents/${boundary}`).get()).exists).toBe(false);
            const { observedAt: beforeAt, ...beforeAuthority } = before;
            const { observedAt: afterAt, ...afterAuthority } = await actions.inspect(boundary);
            expect(afterAuthority).toEqual(beforeAuthority);
            expect(Date.parse(afterAt)).toBeGreaterThanOrEqual(Date.parse(beforeAt));
            expect((await db.doc(api.SELECTOR_PATH).get()).data()!.selectedPairId).toBe(fixture.state.previewPairs[0].pairId);
          } finally { readerProvidersAvailable = true; privateReadsAvailable = true; }
        }
      }
      if (boundary === 'admin-assets') {
        const before = await actions.inspect(boundary);
        adminReadable = false;
        try {
          await expect(actions.execute(request)).rejects.toThrow();
          expect((await db.doc(`publicReleaseRehearsalPreview/${runId}/intents/${boundary}`).get()).exists).toBe(false);
          const { observedAt: beforeAt, ...beforeAuthority } = before;
          const { observedAt: afterAt, ...afterAuthority } = await actions.inspect(boundary);
          expect(afterAuthority).toEqual(beforeAuthority);
          expect(Date.parse(afterAt)).toBeGreaterThanOrEqual(Date.parse(beforeAt));
          expect((await db.doc(api.SELECTOR_PATH).get()).data()!.selectedPairId).toBe(fixture.state.previewPairs[0].pairId);
        } finally { adminReadable = true; }
      }
      const result = await actions.execute(request);
      expect(result.state).toBe('complete'); expect(result.intent.boundary).toBe(boundary);
      expect(result.after.previewSelector.selectedPairId).toBe(fixture.state.previewPairs[index < 4 ? 0 : 1].pairId);
      expect(await actions.execute(request)).toEqual(result);
      expect(await actions.completedBoundaries()).toEqual(PREVIEW_BOUNDARIES.slice(0, index + 1));
      if (index === 2) {
        const prefix = await createRehearsalPreviewActions(runtime, { runId, admin: pages.admin, authorized: true });
        expect(await prefix.completedBoundaries()).toEqual(PREVIEW_BOUNDARIES.slice(0, index + 1));
        expect(await prefix.execute(request)).toEqual(result);
      }
      const currentAdmin = await db.doc('cmsDeploymentReceipts/adminManifest').get();
      expect(currentAdmin.data()).toEqual(originalAdmin.data()); expect(currentAdmin.updateTime!.isEqual(originalAdmin.updateTime!)).toBe(true);
      if (index < 4) {
        expect(result.after.records[api.SELECTOR_PATH]).toEqual(result.before.records[api.SELECTOR_PATH]);
        expect(result.after.records[api.RENDERER_RECEIPT_PATH]).toEqual(result.before.records[api.RENDERER_RECEIPT_PATH]);
      } else {
        const op = result.intent.adminOperationId;
        expect((await db.doc(`cmsAdminManifestAttempts/${op}`).get()).data()).toMatchObject({ state: 'not_written', request: { operationId: op } });
        expect((await db.doc(`${ADMIN_PROVIDER_OPERATIONS}/${op}`).get()).data()).toMatchObject({ state: 'fenced', deploymentId: null });
      }
    }
    expect(nativePreview.state.writes).toEqual(['identity', 'version', 'deployment', 'container', 'schedule']);
    expect(pages.calls.every(call => call.method === 'GET')).toBe(true);
    expect((await db.collection(`publicReleaseRehearsalPreview/${runId}/results`).get()).size).toBe(6);
    const resumed = await createRehearsalPreviewActions(runtime, { runId, admin: pages.admin, authorized: true });
    expect(await resumed.completedBoundaries()).toEqual(PREVIEW_BOUNDARIES);
    const saved = await db.doc(`publicReleaseRehearsalPreview/${runId}/results/cancellation`).get();
    const manifest = (await db.doc(`publicReleaseRehearsalPreview/${runId}/manifests/cancellation`).get()).data()!;
    expect(manifest.resultVersion).toEqual({ seconds: saved.updateTime!.seconds, nanoseconds: saved.updateTime!.nanoseconds });
    const { digest, ...sealed } = manifest;
    expect(digest).toBe(api.digest(sealed));
    expect(await resumed.execute({ boundary: 'cancellation', actionId: `${runId}-preview-cancellation` })).toEqual(saved.data());
  }, 20_000);
  it.each(['health', 'candidate', 'rollout', 'attempt', 'journal', 'journal-rewrite'])(
    'refuses missing or rewritten original %s evidence on a completed retry', async kind => {
      await resetOldWorld();
      const retryRunId = `rehearsal-retry-${kind}`;
      const replay = await createRehearsalPreviewActions(runtime, { runId: retryRunId, admin: pages.admin, authorized: true });
      let completed: any;
      for (const boundary of PREVIEW_BOUNDARIES) completed = await replay.execute({ boundary, actionId: `${retryRunId}-preview-${boundary}` });
      const paths = { health: `cmsPreviewPrivateHealth/${healthRequest.operationId}`,
        candidate: `cmsDeploymentCandidates/renderer-${rendererInput.runId}-${rendererInput.runAttempt}`,
        rollout: `cmsPreviewPairRollouts/${completed.intent.rolloutOperationId}`,
        attempt: `cmsAdminManifestAttempts/${completed.intent.adminOperationId}`,
        journal: `${ADMIN_PROVIDER_OPERATIONS}/${completed.intent.adminOperationId}`,
        'journal-rewrite': `${ADMIN_PROVIDER_OPERATIONS}/${completed.intent.adminOperationId}` };
      const ref = db.doc(paths[kind as keyof typeof paths]), original = await ref.get();
      expect(original.exists).toBe(true); expect(completed.after.records[ref.path].exists).toBe(true);
      try {
        if (kind === 'journal-rewrite') {
          // A Firestore no-op set can retain updateTime. Make two actual
          // commits, ending with the same original data and a newer identity.
          await ref.update({ rehearsalAuditMutation: 'temporary' });
          await ref.set(original.data()!);
          expect((await ref.get()).updateTime!.isEqual(original.updateTime!)).toBe(false);
        } else await ref.delete();
        await expect(replay.execute({ boundary: 'cancellation', actionId: `${retryRunId}-preview-cancellation` }))
          .rejects.toThrow('Rehearsal private preview binding refused');
        expect(pages.calls.every(call => call.method === 'GET')).toBe(true);
        expect(nativePreview.state.writes).toHaveLength(5);
      } finally { await ref.set(original.data()!); }
    }, 20_000);


  async function startAuditRun(suffix: string, count = 0, ownedRuntime = runtime) {
    await resetOldWorld();
    const id = `audit-${suffix}`;
    const runner = await createRehearsalPreviewActions(ownedRuntime, { runId: id, admin: pages.admin, authorized: true });
    const results = [];
    for (const boundary of PREVIEW_BOUNDARIES.slice(0, count)) results.push(await runner.execute({ boundary, actionId: `${id}-preview-${boundary}` }));
    return { id, runner, results };
  }
  async function rewrite(ref: any) {
    const original = await ref.get();
    expect(original.exists).toBe(true);
    await ref.update({ rehearsalAuditMutation: 'temporary' });
    await ref.set(original.data()!);
    expect((await ref.get()).updateTime!.isEqual(original.updateTime!)).toBe(false);
  }
  it.each(PREVIEW_BOUNDARIES)('refuses restored controls before the %s boundary instead of taking a new baseline', async boundary => {
    const { id, runner } = await startAuditRun(`gap-${boundary}`, PREVIEW_BOUNDARIES.indexOf(boundary));
    const controls = db.doc('system/cmsPublicationRuntime'), original = (await controls.get()).data()!;
    await controls.update({ phase: 'paused', 'cloud.phase': 'paused' }); await controls.set(original);
    expect(await runner.execute({ boundary, actionId: `${id}-preview-${boundary}` }).then(() => null, error => error.message)).toMatch(/Rehearsal/);
    expect((await db.doc(`publicReleaseRehearsalPreview/${id}/intents/${boundary}`).get()).exists).toBe(false);
  }, 20_000);

  it.each(['intent', 'baseline', 'chain', 'fresh'])('refuses %s evidence gaps at the final completed-boundary audit', async kind => {
    const { id, runner, results } = await startAuditRun(`final-${kind}`, 6);
    const boundary = PREVIEW_BOUNDARIES[0], base = `publicReleaseRehearsalPreview/${id}`;
    const result = structuredClone(results[0]);
    if (kind === 'intent') await db.doc(`${base}/intents/${boundary}`).delete();
    if (kind === 'baseline') {
      result.intent.baselineDigest = '0'.repeat(64);
      await db.doc(`${base}/intents/${boundary}`).set(result.intent);
      await db.doc(`${base}/results/${boundary}`).set(result);
    }
    if (kind === 'chain') {
      for (const snapshot of [result.before, result.failed, result.after]) snapshot.records['system/cmsPublicationRuntime'].updateTime = '1:1';
      result.intent.baselineDigest = api.digest(result.before);
      await db.doc(`${base}/intents/${boundary}`).set(result.intent);
      await db.doc(`${base}/results/${boundary}`).set(result);
    }
    if (kind === 'fresh') await rewrite(db.doc('system/cmsPublicationRuntime'));
    expect(await runner.completedBoundaries().then(() => null, error => error.message)).toMatch(/Rehearsal/);
  }, 20_000);

  it.each(['health', 'candidate', 'rollout', 'writer', 'selector', 'renderer'])(
    'refuses an in-action %s rewrite across an actual provider read', async kind => {
      const boundary = kind === 'selector' || kind === 'renderer' ? 'admin-assets' : 'preview-selection';
      const { id, runner, results } = await startAuditRun(`inside-${kind}`, PREVIEW_BOUNDARIES.indexOf(boundary));
      const paths: Record<string, string> = { health: `cmsPreviewPrivateHealth/${healthRequest.operationId}`,
        candidate: `cmsDeploymentCandidates/renderer-${rendererInput.runId}-${rendererInput.runAttempt}`,
        rollout: `cmsPreviewPairRollouts/${results.at(-1)!.intent.rolloutOperationId}`,
        writer: 'cmsAdminManifestState/writer', selector: api.SELECTOR_PATH, renderer: api.RENDERER_RECEIPT_PATH };
      // A prior Admin scenario supplied the writer; its native shape stays fixed.
      if (!(await db.doc(paths[kind]).get()).exists) throw new Error('Required original evidence absent');
      let mutated = false;
      requestMutation = async () => { requestMutation = null; await rewrite(db.doc(paths[kind])); mutated = true; };
      try {
        expect(await runner.execute({ boundary, actionId: `${id}-preview-${boundary}` }).then(() => null, error => error.message)).toMatch(/Rehearsal/);
        expect(mutated).toBe(true);
        expect((await db.doc(`${api.SWITCHES}/${results.at(-1)!.intent.selectionOperationId}`).get()).exists).toBe(false);
        expect((await db.doc(`publicReleaseRehearsalPreview/${id}/results/${boundary}`).get()).exists).toBe(false);
      } finally { requestMutation = null; }
    }, 20_000);

  it.each(['bridge-proof', 'bridge-attempt', 'preview-proof', 'reader-window', 'billing'])(
    'captures %s identity and refuses a restored rewrite on completed retry', async kind => {
      const paths: Record<string, string> = { 'bridge-proof': `${BRIDGE_PROOFS}/${fixture.request.operationId}`,
        'bridge-attempt': `${BRIDGE_ATTEMPTS}/${fixture.request.operationId}`,
        'reader-window': `cmsReaderSessionWindows/${require('../../functions/lib/cms-reader-session.js').readerSessionDigest(fixture.request.readers.functions)}`, billing: 'system/billing' };
      // Optional dependent records need a stable presence for a rewrite probe.
      if (kind === 'billing' && !(await db.doc(paths[kind]).get()).exists) await db.doc(paths[kind]).create({ disabled: false });
      if (kind === 'reader-window') {
        await resetOldWorld();
        await require('../../functions/lib/cms-reader-session.js').openSession(db, { reader: fixture.request.readers.functions,
          principalId: actor.uid, sessionId: '66666666-6666-4666-8666-666666666666', ttlMs: 60_000 });
      }
      const { id, runner, results } = await startAuditRun(`dependency-${kind}`, 6);
      const rollout = (await db.doc(`cmsPreviewPairRollouts/${results[1].intent.rolloutOperationId}`).get()).data()!;
      paths['preview-proof'] = `${api.PROOFS}/${rollout.proofDigest}`;
      const ref = db.doc(paths[kind]);
      expect(results.at(-1)!.after.records[ref.path]?.exists).toBe(true);
      await rewrite(ref);
      expect(await runner.execute({ boundary: 'cancellation', actionId: `${id}-preview-cancellation` }).then(() => null, error => error.message)).toMatch(/Rehearsal/);
    }, 20_000);
  it('refuses a restored control during completed retry provider preflight', async () => {
    const { id, runner } = await startAuditRun('retry-preflight-gap', 6);
    let mutated = false;
    requestMutation = async () => { requestMutation = null; await rewrite(db.doc('system/cmsPublicationRuntime')); mutated = true; };
    try {
      const error = await runner.execute({ boundary: 'cancellation', actionId: `${id}-preview-cancellation` })
        .then(() => null, error => error.message);
      expect(mutated).toBe(true);
      expect(error).toMatch(/Rehearsal/);
    } finally { requestMutation = null; }
  }, 20_000);
  it('completes all native boundaries with the largest accepted queue roster', async () => {
    const refs = Array.from({ length: 200 }, (_, index) => db.doc(`cmsPreviewQueue/audit-capacity-${index}`));
    const batch = db.batch();
    refs.forEach(ref => batch.create(ref, { previewPairId: fixture.state.previewPairs[0].pairId, status: 'success' }));
    await batch.commit();
    try {
      const { runner, results } = await startAuditRun('capacity', 6);
      expect(await runner.completedBoundaries()).toEqual(PREVIEW_BOUNDARIES);
      expect(results.at(-1)!.after.queued.count).toBe(200);
    } finally { const cleanup = db.batch(); refs.forEach(ref => cleanup.delete(ref)); await cleanup.commit(); }
  }, 20_000);
  it.each([...PREVIEW_BOUNDARIES, 'failed-snapshot'])('rejects altered %s fault evidence on retry and final audit', async kind => {
    const boundary = kind === 'failed-snapshot' ? 'functions' : kind;
    const { id, runner } = await startAuditRun(`witness-${kind}`, PREVIEW_BOUNDARIES.indexOf(boundary) + 1);
    const ref = db.doc(`publicReleaseRehearsalPreview/${id}/results/${boundary}`);
    const result = (await ref.get()).data()!;
    if (kind === 'failed-snapshot') result.failed = null;
    else result.witness = null;
    await ref.set(result);
    const retry = await runner.execute({ boundary, actionId: `${id}-preview-${boundary}` }).then(() => null, error => error.message);
    const audit = await runner.completedBoundaries().then(() => null, error => error.message);
    expect(retry).toMatch(/Rehearsal/); expect(audit).toMatch(/Rehearsal/);
  }, 20_000);
  it('keeps queue SDK identities in the compact inventory seal', async () => {
    const ref = db.doc('cmsPreviewQueue/audit-restored-queue');
    await ref.create({ previewPairId: fixture.state.previewPairs[0].pairId, status: 'success' });
    try {
      const { id, runner } = await startAuditRun('compact-queue', 1);
      await rewrite(ref);
      expect(await runner.execute({ boundary: 'preview-rollout', actionId: `${id}-preview-preview-rollout` })
        .then(() => null, error => error.message)).toMatch(/Rehearsal/);
    } finally { await ref.delete(); }
  }, 20_000);
  it.each(['old', 'new'])('audits the original %s public pair on final completion', async side => {
    const { runner } = await startAuditRun(`public-${side}`, 6);
    const pair = side === 'old' ? oldPair : newPair, ref = db.doc(work.publicReleasePairPath(pair.pairId));
    const original = (await ref.get()).data()!;
    try {
      await ref.delete();
      expect(await rehearsalPreviewReaderAdapter(handle).readLiveState().then(() => null, error => error.message)).toMatch(/protocol|refused/);
      expect(await runner.completedBoundaries().then(() => null, error => error.message)).toMatch(/Rehearsal/);
    } finally { await ref.set(original); }
  }, 20_000);
  it.each(['delete', 'rewrite', 'recreate'])('refuses a %s of its original baseline after completion', async kind => {
    const { id, runner } = await startAuditRun(`baseline-${kind}`, 6);
    const ref = db.doc(`publicReleaseRehearsalPreview/${id}`), original = (await ref.get()).data()!;
    if (kind === 'rewrite') await rewrite(ref);
    else { await ref.delete(); if (kind === 'recreate') await ref.create(original); }
    expect(await runner.completedBoundaries().then(() => null, error => error.message)).toMatch(/Rehearsal/);
    expect(await runner.execute({ boundary: 'cancellation', actionId: `${id}-preview-cancellation` }).then(() => null, error => error.message)).toMatch(/Rehearsal/);
    expect(await createRehearsalPreviewActions(runtime, { runId: id, admin: pages.admin, authorized: true })
      .then(() => null, error => error.message)).toMatch(/Rehearsal/);
  }, 20_000);
  it.each(['intents', 'results'])('rejects a same-content recreation of original %s', async collection => {
    const { id, runner } = await startAuditRun(`seal-${collection}`, 6);
    const ref = db.doc(`publicReleaseRehearsalPreview/${id}/${collection}/cancellation`), original = await ref.get();
    await ref.delete(); await ref.create(original.data()!);
    expect((await ref.get()).updateTime!.isEqual(original.updateTime!)).toBe(false);
    expect(await runner.completedBoundaries().then(() => null, error => error.message)).toMatch(/Rehearsal/);
    expect(await runner.execute({ boundary: 'cancellation', actionId: `${id}-preview-cancellation` }).then(() => null, error => error.message)).toMatch(/Rehearsal/);
    expect(await createRehearsalPreviewActions(runtime, { runId: id, admin: pages.admin, authorized: true })
      .then(() => null, error => error.message)).toMatch(/Rehearsal/);
  }, 20_000);

  it.each(['digest', 'missing'])('refuses a %s boundary manifest without repeating effects', async kind => {
    const { id, runner } = await startAuditRun(`manifest-${kind}`, 6);
    const ref = db.doc(`publicReleaseRehearsalPreview/${id}/manifests/cancellation`);
    const original = (await ref.get()).data()!;
    await ref.delete();
    if (kind === 'digest') await ref.create({ ...original, digest: '0'.repeat(64) });
    const writes = [...nativePreview.state.writes], calls = pages.calls.length;
    expect(await runner.completedBoundaries().then(() => null, error => error.message)).toMatch(/Rehearsal/);
    expect(await runner.execute({ boundary: 'cancellation', actionId: `${id}-preview-cancellation` })
      .then(() => null, error => error.message)).toMatch(/Rehearsal/);
    expect(await createRehearsalPreviewActions(runtime, { runId: id, admin: pages.admin, authorized: true })
      .then(() => null, error => error.message)).toMatch(/Rehearsal/);
    expect(nativePreview.state.writes).toEqual(writes);
    expect(pages.calls.slice(calls).every(call => call.method === 'GET')).toBe(true);
  }, 20_000);

  it('covers every actual SDK read during the six actions and final audit', async () => {
    await resetOldWorld();
    const reads = new Set<string>(), originals = new WeakMap<object, any>();
    const unwrap = (value: any) => originals.get(value) ?? value;
    const observe = (value: any) => {
      for (const row of Array.isArray(value) ? value : value.docs ?? [value]) if (row.ref?.path) reads.add(row.ref.path);
      return value;
    };
    const builders = new Set(['doc', 'collection', 'collectionGroup', 'where', 'orderBy', 'limit', 'limitToLast', 'offset', 'select', 'startAt', 'startAfter', 'endAt', 'endBefore', 'withConverter']);
    const wrap = (target: any): any => {
      const proxy = new Proxy(target, { get(object, key) {
        const value = Reflect.get(object, key);
        if (typeof value !== 'function') return value;
        if (key === 'runTransaction') return (callback: any, ...args: any[]) => value.call(object, (transaction: any) => callback(wrap(transaction)), ...args);
        if (key === 'get' || key === 'getAll') return async (...args: any[]) => observe(await value.apply(object, args.map(unwrap)));
        if (builders.has(String(key))) return (...args: any[]) => wrap(value.apply(object, args.map(unwrap)));
        return (...args: any[]) => value.apply(object, args.map(unwrap));
      } });
      originals.set(proxy, target); return proxy;
    };
    const firestore = wrap(db);
    const readers = await prepareRehearsalPreviewReaders({ ...options(), firestore });
    const owned = await prepareRehearsalPreviewRuntime({ firestore, readers, prepared: nativePreview.prepared,
      resourceOperationId: installed.resource.plan.operationId, request: healthRequest, readToken: () => 'fixture-preview',
      readSecret: () => 'fixture-binding', fetchImpl: nativePreview.request, authorized: true });
    const id = 'audit-recorded-readset';
    const runner = await createRehearsalPreviewActions(owned, { runId: id, admin: pages.admin, authorized: true });
    reads.clear();
    for (const boundary of PREVIEW_BOUNDARIES) await runner.execute({ boundary, actionId: `${id}-preview-${boundary}` });
    expect(await runner.completedBoundaries()).toEqual(PREVIEW_BOUNDARIES);
    const audit = await runner.inspect('cancellation');
    const missing = [...reads].filter(path => !Object.hasOwn(audit.records, path)).sort();
    expect(missing).toEqual([]);
  }, 20_000);
  it.each(['proof', 'attempt'])('uses the refreshed handle original bridge %s in its audit', async kind => {
    await resetOldWorld();
    const request = { ...fixture.request, operationId: `reader-audit-refresh-${kind}` };
    await proveCmsReaderBridge({ ...bridgeInstallCommon, request, transport: bridgeTransport });
    await installCmsReaderBridge({ ...bridgeInstallCommon, request, candidates: bridgeCandidates, commitReader: commitLiveReaderReceipt });
    const identity = (await db.doc(`${BRIDGE_PROOFS}/${require('../../functions/lib/cms-reader-bridge-proof.js').cmsReaderBridgeProofKey(request.readers)}`).get()).data()!;
    expect(identity.proof.operationId).toBe(fixture.request.operationId);
    const readers = await prepareRehearsalPreviewReaders({ ...options(), bridgeOperationId: request.operationId });
    const owned = await prepareRehearsalPreviewRuntime({ firestore: db, readers, prepared: nativePreview.prepared,
      resourceOperationId: installed.resource.plan.operationId, request: healthRequest, readToken: () => 'fixture-preview',
      readSecret: () => 'fixture-binding', fetchImpl: nativePreview.request, authorized: true });
    const { runner } = await startAuditRun(`refresh-${kind}`, 6, owned);
    const ref = db.doc(`${kind === 'proof' ? BRIDGE_PROOFS : BRIDGE_ATTEMPTS}/${request.operationId}`), original = (await ref.get()).data()!;
    try {
      await ref.delete();
      expect(await rehearsalPreviewReaderAdapter(readers).readLiveState().then(() => null, error => error.message)).toMatch(/refused|unavailable|changed/);
      expect(await runner.completedBoundaries().then(() => null, error => error.message)).toMatch(/Rehearsal/);
    } finally { await ref.set(original); }
  }, 20_000);
});
