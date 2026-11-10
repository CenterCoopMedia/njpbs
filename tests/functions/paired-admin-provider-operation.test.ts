import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { pair, receipt, selector, candidate } from '../helpers/cms-preview-pairs.js';
import { publishPairedAdminManifest } from '../../scripts/lib/cms-preview-pair-release.mjs';
import { functionsInventoryIdentity } from '../../scripts/lib/cms-component-receipt.mjs';
import { createPairedAdminOperationJournal, ADMIN_PROVIDER_OPERATIONS } from '../../scripts/lib/paired-admin-provider-operation.mjs';
import { preparePairedAdminArtifact, pairedAdminArtifactContents } from '../../scripts/lib/paired-admin-pages-artifact.mjs';
import { createPairedAdminPagesProvider } from '../../scripts/lib/paired-admin-pages-provider.mjs';
import { DEV_TARGETS } from '../../scripts/assert-dev-cms-targets.mjs';

const api = createRequire(import.meta.url)('../../functions/lib/cms-preview-pair.js');
const db = isolatedFirestore('paired-admin-provider-operation');
const hex = (letter: string) => letter.repeat(64);
const ownerRef = db.doc('cmsAdminManifestAttempts/preview-admin'), lockRef = db.doc('cmsAdminManifestState/writer');
const journal = () => createPairedAdminOperationJournal({ firestore: db, targetDigest: hex('c'), artifactDigest: hex('d') });
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paired-admin-sdk-'));
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, db);
});
afterEach(async () => rm(root, { recursive: true, force: true }));
async function grant() {
  const request = { operationId: 'preview-admin', manifestDigest: hex('a'), expectedProviderReceiptDigest: hex('b') };
  const evidence = { previewSelectorDigest: hex('c'), readerDigests: { functions: hex('d'), cmsApi: hex('e') } };
  const bound = { request, evidence, previousAdminDigest: hex('f') };
  const operationDigest = api.digest(bound);
  await ownerRef.set({ schemaVersion: 2, ...bound, operationDigest, state: 'reserved' });
  await lockRef.set({ schemaVersion: 2, state: 'reserved', operationId: request.operationId, requestDigest: api.digest(request) });
  return { ...request, operationDigest };
}
it('requires the actual original owner and writer binding before any provider intent', async () => {
  const request = await grant(); await lockRef.update({ operationId: 'preview-another' });
  await expect(journal().reserve(request)).rejects.toThrow();
  expect((await db.collection(ADMIN_PROVIDER_OPERATIONS).get()).empty).toBe(true);
});
it('issues one permission under a real SDK transaction race', async () => {
  const request = await grant(), own = journal();
  await own.reserve(request);
  const result = await Promise.allSettled([own.issue(request), own.issue(request)]);
  expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter(row => row.status === 'rejected')).toHaveLength(1);
  expect(await own.reconcile(request)).toMatchObject({ outcome: 'uncertain', providerSettled: false });
});
it.each([false, true])('permanently fences a late publisher, initially reserved=%s', async reserved => {
  const request = await grant(), own = journal();
  if (reserved) await own.reserve(request);
  expect(await own.reconcile(request)).toMatchObject({ outcome: 'not_written', providerSettled: true });
  expect((await own.reserve(request)).state).toBe('fenced');
  await expect(own.issue(request)).rejects.toThrow();
});
it('refuses changed artifacts and operation identity without replacing the original attempt', async () => {
  const request = await grant(), own = journal(); await own.reserve(request);
  const before = (await db.doc(`${ADMIN_PROVIDER_OPERATIONS}/${request.operationId}`).get()).data();
  await expect(createPairedAdminOperationJournal({ firestore: db, targetDigest: hex('c'), artifactDigest: hex('e') }).reserve(request)).rejects.toThrow();
  await expect(own.issue({ ...request, operationDigest: hex('e') })).rejects.toThrow();
  expect((await db.doc(`${ADMIN_PROVIDER_OPERATIONS}/${request.operationId}`).get()).data()).toEqual(before);
});
it('settles only the exact issued deployment and preserves the one original proof', async () => {
  const request = await grant(), own = journal(), proof = { deploymentId: '11111111-1111-4111-8111-111111111111', providerReceiptDigest: hex('e') };
  await own.reserve(request); await expect(own.terminal(request, 'uploaded', proof)).rejects.toThrow();
  await own.issue(request); await own.terminal(request, 'uploaded', proof);
  expect(await own.reconcile(request)).toMatchObject({ ...proof, outcome: 'uploaded', providerSettled: true });
  await expect(own.terminal(request, 'uploaded', { ...proof, providerReceiptDigest: hex('f') })).rejects.toThrow();
});
it('retains an assigned deployment id before final readback and refuses another id', async () => {
  const request = await grant(), own = journal(), id = '11111111-1111-4111-8111-111111111111';
  await own.reserve(request); await own.issue(request); await own.assigned(request, id);
  expect(await own.reconcile(request)).toMatchObject({ outcome: 'uncertain', deploymentId: id, providerSettled: false });
  await expect(own.assigned(request, '22222222-2222-4222-8222-222222222222')).rejects.toThrow();
});
it('permits only the original unsent grant to fence an issued operation', async () => {
  const request = await grant(), own = journal(); await own.reserve(request);
  const permission = await own.issue(request);
  await expect(own.fenceUnsent({ ...permission })).rejects.toThrow();
  expect(await own.fenceUnsent(permission)).toMatchObject({ outcome: 'not_written', providerSettled: true });
  await expect(own.issue(request)).rejects.toThrow();
});
it('revokes the unsent grant synchronously at dispatch', async () => {
  const request = await grant(), own = journal(); await own.reserve(request);
  const permission = await own.issue(request); own.dispatched(permission);
  await expect(own.fenceUnsent(permission)).rejects.toThrow();
  expect(await own.reconcile(request)).toMatchObject({ outcome: 'uncertain', providerSettled: false });
});

async function composition(mode = 'complete') {
  const old = pair('old'), next = pair('new', 'b'), selected = selector(next, old), now = Date.now();
  await api.registerPair(db, old); await api.registerPair(db, next);
  await db.doc(api.SELECTOR_PATH).set(selected);
  await db.doc(api.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, state: 'complete', component: 'renderer',
    pairId: next.pairId, selectorDigest: api.digest(selected), lastComplete: candidate(next, now).mutation });
  const functions = [{ name: 'projects/njpbs-site-dev/locations/us-central1/functions/cmsPreviewStatus', state: 'ACTIVE' }];
  const cmsApiId = '44444444-4444-4444-8444-444444444444';
  for (const component of ['functions', 'cmsApi']) {
    const value = receipt(component, now);
    value.lastComplete.providerIdentities = component === 'functions' ? functionsInventoryIdentity(functions)
      : { script: DEV_TARGETS.CMS_API_WORKER, deploymentId: cmsApiId, versionId: '77777777-7777-4777-8777-777777777777' };
    await db.collection(api.READER_RECEIPTS).doc(component).set(value);
  }
  const originalAdmin = { schemaVersion: 1, state: 'complete', lastComplete: { manifestDigest: hex('a') } };
  await db.doc('cmsDeploymentReceipts/adminManifest').set(originalAdmin);
  const packages: any[] = [];
  for (const [side, sha] of [['old', 'a'], ['new', 'b']]) {
    const directory = join(root, side); await mkdir(directory);
    await writeFile(join(directory, 'index.html'), `<html>${side}</html>`);
    await writeFile(join(directory, 'admin-status.json'), JSON.stringify({ schemaVersion: 2, status: 'current', environment: 'Development', build: { revision: sha.repeat(40) } }));
    packages.push(await preparePairedAdminArtifact({ directory, sourceSha: sha.repeat(40), environment: 'development' }));
  }
  const oldId = '11111111-1111-4111-8111-111111111111', nextId = '22222222-2222-4222-8222-222222222222';
  const project = { id: '33333333-3333-4333-8333-333333333333', name: 'template-dev-admin', production_branch: 'main',
    deployment_configs: { production: { compatibility_date: '2026-07-09' } } };
  const target = { environment: 'development', accountId: DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID, pagesProjectId: project.id,
    projectId: DEV_TARGETS.FIREBASE_PROJECT_ID, branch: 'main', configurationDigest: '' };
  // The configuration preimage is the provider project grammar, not a result
  // captured from the new adapter.
  target.configurationDigest = api.digest({ id: project.id, name: project.name, production_branch: project.production_branch,
    production: project.deployment_configs.production });
  let active = oldId, writes = 0, warmRead = true; const deployments = new Map<string, any>();
  const controller = new AbortController();
  const row = (id: string, hash: string, message = '') => ({ id, project_id: project.id, project_name: project.name,
    environment: 'production', deployment_trigger: { metadata: { branch: 'main', commit_hash: hash, commit_message: message } },
    latest_stage: { name: 'deploy', status: 'success' }, is_skipped: false });
  deployments.set(oldId, row(oldId, 'a'.repeat(40)));
  const answer = (result: unknown) => new Response(JSON.stringify({ success: true, result }));
  const adapter = createPairedAdminPagesProvider({ firestore: db, baseline: { deploymentId: oldId, artifact: packages[0] },
    prepared: packages[1], target, authorized: true, allowLocalEmulator: true,
    readCloudflareToken: async () => {
      if (['credential-before-send', 'cancel-before-send'].includes(mode) &&
          (await db.doc(`${ADMIN_PROVIDER_OPERATIONS}/preview-admin`).get()).data()?.state === 'issued') {
        if (mode === 'credential-before-send') throw new Error('fixture locked credential store');
        controller.abort();
        return new Promise<string>(() => {});
      }
      return 'fixture-provider';
    }, readGoogleToken: async () => 'fixture-google', readAccessHeaders: async () => ({}),
    fetchImpl: async (raw: string, options: any) => {
      const url = new URL(raw);
      if (url.hostname === 'cloudfunctions.googleapis.com') return new Response(JSON.stringify({ functions }));
      if (url.pathname.endsWith(`/workers/scripts/${DEV_TARGETS.CMS_API_WORKER}/deployments`)) return answer({ deployments: [{ id: cmsApiId, versions: [{ version_id: '77777777-7777-4777-8777-777777777777', percentage: 100 }] }] });
      if (url.hostname === 'dev-admin.example.org') {
        const file = pairedAdminArtifactContents(packages[active === oldId ? 0 : 1]).files.find((file: any) => file.path === (url.pathname === '/' ? '/index.html' : url.pathname));
        return new Response(file!.bytes, { headers: { 'content-type': file!.contentType } });
      }
      if (url.pathname.endsWith('/upload-token')) return answer({ jwt: 'fixture-upload' });
      if (url.pathname.startsWith('/client/v4/pages/assets/')) {
        if (mode === 'asset-failure') throw new Error('fixture asset failure');
        return answer({});
      }
      if (url.pathname.endsWith('/deployments') && options.method === 'POST') {
        writes++;
        if (!['absent', 'http-error'].includes(mode)) {
          const nextRow = row(nextId, options.body.get('commit_hash'), options.body.get('commit_message'));
          if (mode === 'failed') nextRow.latest_stage = { name: 'build', status: 'failure', ended_on: new Date().toISOString() } as any;
          if (mode === 'pending-cancel') nextRow.latest_stage = { name: 'deploy', status: 'active', ended_on: null } as any;
          deployments.set(nextId, nextRow);
          if (!['failed', 'pending-cancel'].includes(mode)) active = nextId;
        }
        if (mode === 'http-error') return new Response(JSON.stringify({ success: false, errors: [{ code: 8000000 }] }), { status: 500 });
        if (['lost', 'absent'].includes(mode)) throw new Error('fixture lost response');
        return answer({ id: nextId });
      }
      if (url.pathname.endsWith('/deployments') && url.search) return new Response(JSON.stringify({ success: true,
        result: [...deployments.values()], result_info: { page: 1, per_page: 100, total_pages: 1 } }));
      if (url.pathname.includes('/deployments/')) {
        const id = url.pathname.split('/').at(-1)!, value = deployments.get(id);
        if (id === nextId && mode === 'pending-cancel') controller.abort();
        if (id === nextId && mode === 'complete' && warmRead) {
          warmRead = false; return answer({ ...value, latest_stage: { name: 'deploy', status: 'active' } });
        }
        return answer(value);
      }
      return answer({ ...project, canonical_deployment: { id: active } });
    } });
  const initial = await adapter.readActiveManifest();
  const request = { operationId: 'preview-admin', manifestDigest: packages[1].manifestDigest,
    expectedProviderReceiptDigest: initial.providerReceiptDigest };
  return { adapter, request, selected, originalAdmin, controller, writes: () => writes };
}

it('composes actual Admin ownership with the native provider and keeps NEW selected', async () => {
  const setup = await composition();
  expect((await publishPairedAdminManifest(db, setup.request, setup.adapter)).state).toBe('complete');
  expect((await publishPairedAdminManifest(db, setup.request, setup.adapter)).state).toBe('complete');
  expect(setup.writes()).toBe(1);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(setup.selected);
});
it('recovers a lost deployment response through the original attempt without another POST', async () => {
  const setup = await composition('lost');
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('reconcile');
  expect((await ownerRef.get()).data()!.state).toBe('uncertain');
  expect((await publishPairedAdminManifest(db, setup.request, setup.adapter)).state).toBe('complete');
  expect(setup.writes()).toBe(1);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(setup.selected);
});
it.each(['absent', 'http-error'])('keeps an unmatched issued %s uncertain, preserving NEW, prior Admin and the writer lock', async mode => {
  const setup = await composition(mode);
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('reconcile');
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('journal unavailable');
  expect(setup.writes()).toBe(1);
  expect((await lockRef.get()).data()!.state).toBe('reserved');
  expect((await db.doc('cmsDeploymentReceipts/adminManifest').get()).data()).toEqual(setup.originalAdmin);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(setup.selected);
});
it('settles an exact provider failure while preserving NEW and the last-complete Admin bytes', async () => {
  const setup = await composition('failed'), live = db.doc('cmsDeploymentReceipts/adminManifest');
  const before = await live.get(), bytes = Buffer.from(JSON.stringify(before.data()));
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('reconcile');
  const provider = (await db.doc(`${ADMIN_PROVIDER_OPERATIONS}/preview-admin`).get()).data()!;
  expect(provider.state).toBe('failed'); expect(provider.deploymentId).toBe('22222222-2222-4222-8222-222222222222');
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('provider_deployment_failed');
  expect((await ownerRef.get()).data()).toMatchObject({ state: 'settled', settlementReason: 'provider_deployment_failed' });
  expect((await lockRef.get()).data()!.state).toBe('settled');
  const after = await live.get();
  expect(Buffer.from(JSON.stringify(after.data()))).toEqual(bytes);
  expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(setup.selected);
  expect(setup.writes()).toBe(1);
});
it.each(['wrong-manifest', 'missing-receipt'])('refuses a failed external %s reply before any owner write', async kind => {
  const setup = await composition('failed');
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('reconcile');
  const row = (await db.doc(`${ADMIN_PROVIDER_OPERATIONS}/preview-admin`).get()).data()!;
  // The external operation-reply boundary supplies malformed wire data. The
  // actual SDK owner, lock, selector and last-complete rows must not change.
  const reply: any = { ...row.binding.request, outcome: 'failed', providerSettled: true, providerReceiptDigest: row.providerReceiptDigest };
  if (kind === 'wrong-manifest') reply.manifestDigest = hex('f'); else delete reply.providerReceiptDigest;
  const refs = [ownerRef, lockRef, db.doc(api.SELECTOR_PATH), db.doc('cmsDeploymentReceipts/adminManifest')];
  const before = await db.getAll(...refs);
  await expect(publishPairedAdminManifest(db, setup.request, { reconcileOperation: async () => reply })).rejects.toThrow('identity disagrees');
  const after = await db.getAll(...refs);
  after.forEach((value, index) => {
    expect(value.data()).toEqual(before[index].data());
    expect(value.updateTime!.isEqual(before[index].updateTime!)).toBe(true);
  });
});
it('keeps a cancelled nonterminal GET uncertain rather than manufacturing a failed outcome', async () => {
  const setup = await composition('pending-cancel');
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter, setup.controller.signal)).rejects.toThrow('reconcile');
  expect((await db.doc(`${ADMIN_PROVIDER_OPERATIONS}/preview-admin`).get()).data()).toMatchObject({ state: 'issued',
    deploymentId: '22222222-2222-4222-8222-222222222222', providerReceiptDigest: null });
  expect((await lockRef.get()).data()!.state).toBe('reserved');
  expect((await db.doc('cmsDeploymentReceipts/adminManifest').get()).data()).toEqual(setup.originalAdmin);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(setup.selected);
  expect(setup.writes()).toBe(1);
});
it('fences a pre-deployment asset failure without changing NEW or last-complete Admin', async () => {
  const setup = await composition('asset-failure');
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('reconcile');
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('fenced before upload');
  expect(setup.writes()).toBe(0);
  expect((await lockRef.get()).data()!.state).toBe('not_written');
  expect((await db.doc('cmsDeploymentReceipts/adminManifest').get()).data()).toEqual(setup.originalAdmin);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(setup.selected);
});
it('refuses cancellation before permission with no provider intent or selection change', async () => {
  const setup = await composition(), controller = new AbortController(); controller.abort();
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter, controller.signal)).rejects.toThrow();
  expect(setup.writes()).toBe(0);
  expect((await db.collection(ADMIN_PROVIDER_OPERATIONS).get()).empty).toBe(true);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(setup.selected);
});
it.each(['credential-before-send', 'cancel-before-send'])('fences an actual issued %s failure and releases only that original writer', async mode => {
  const setup = await composition(mode);
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter, setup.controller.signal)).rejects.toThrow('reconcile');
  expect(setup.writes()).toBe(0);
  expect((await db.doc(`${ADMIN_PROVIDER_OPERATIONS}/preview-admin`).get()).data()!.state).toBe('fenced');
  await expect(publishPairedAdminManifest(db, setup.request, setup.adapter)).rejects.toThrow('fenced before upload');
  expect((await lockRef.get()).data()!.state).toBe('not_written');
  expect((await db.doc('cmsDeploymentReceipts/adminManifest').get()).data()).toEqual(setup.originalAdmin);
  expect((await db.doc(api.SELECTOR_PATH).get()).data()).toEqual(setup.selected);
});
