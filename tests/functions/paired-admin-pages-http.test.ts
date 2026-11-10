import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { preparePairedAdminArtifact, pairedAdminArtifactContents } from '../../scripts/lib/paired-admin-pages-artifact.mjs';
import { createPairedAdminPagesHttp, createPairedAdminPagesProvider } from '../../scripts/lib/paired-admin-pages-provider.mjs';
import { DEV_TARGETS } from '../../scripts/assert-dev-cms-targets.mjs';

const api = createRequire(import.meta.url)('../../functions/lib/cms-preview-pair.js');
const sourceSha = 'a'.repeat(40), oldId = '11111111-1111-4111-8111-111111111111';
const newId = '22222222-2222-4222-8222-222222222222', projectId = '33333333-3333-4333-8333-333333333333';
const googleId = '44444444-4444-4444-8444-444444444444';
const project = { id: projectId, name: 'template-dev-admin', production_branch: 'main',
  deployment_configs: { production: { compatibility_date: '2026-07-09' } }, canonical_deployment: { id: oldId } };
const configurationDigest = api.digest({ id: project.id, name: project.name, production_branch: project.production_branch,
  production: project.deployment_configs.production });
const target = { environment: 'development', accountId: DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID, pagesProjectId: projectId,
  projectId: DEV_TARGETS.FIREBASE_PROJECT_ID, branch: 'main', configurationDigest };
const request = { operationId: 'preview-admin', operationDigest: 'b'.repeat(64), manifestDigest: '' };
let root: string, artifact: any, calls: any[], credentials: number;
const answer = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { headers: { 'content-type': 'application/json' } });
const deployment = (overrides: any = {}) => ({ id: newId, project_id: projectId, project_name: 'template-dev-admin', environment: 'production',
  deployment_trigger: { metadata: { branch: 'main', commit_hash: sourceSha,
    commit_message: `njpbs-paired-admin:${request.operationId}:${request.operationDigest}:${request.manifestDigest}` } },
  latest_stage: { name: 'deploy', status: 'success' }, is_skipped: false, ...overrides });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paired-admin-http-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html>Admin</html>');
  await writeFile(join(root, 'assets', 'app.js'), 'export const version = 1;');
  await writeFile(join(root, 'admin-status.json'), JSON.stringify({ schemaVersion: 2, status: 'current',
    environment: 'Development', build: { revision: sourceSha } }));
  artifact = await preparePairedAdminArtifact({ directory: root, sourceSha, environment: 'development' });
  request.manifestDigest = artifact.manifestDigest;
  calls = []; credentials = 0;
});
afterEach(async () => rm(root, { recursive: true, force: true }));

function transport(handler: (url: string, options: any) => Promise<Response>, extra: any = {}) {
  return createPairedAdminPagesHttp({ target, prepared: artifact, authorized: true,
    readCloudflareToken: async () => { credentials++; return 'fixture-provider-token'; },
    readGoogleToken: async () => 'fixture-google-token', readAccessHeaders: async () => ({ 'CF-Access-Client-Id': 'fixture-access' }),
    fetchImpl: async (url: string, options: any) => { calls.push({ url, ...options }); return handler(url, options); }, ...extra });
}

it('seals actual files, freezes metadata and excludes private Pages files from the public map', async () => {
  await writeFile(join(root, '_headers'), '/*\n  Cache-Control: no-store\n');
  const sealed = await preparePairedAdminArtifact({ directory: root, sourceSha, environment: 'development' });
  expect(sealed.manifestDigest).not.toBe(artifact.manifestDigest);
  expect(Object.isFrozen(sealed.publicMembers)).toBe(true);
  expect(sealed.publicMembers.some((row: any) => row.path === '/_headers')).toBe(false);
  await writeFile(join(root, 'index.html'), 'changed after preparation');
  const content = pairedAdminArtifactContents(sealed);
  expect(content.files.find((row: any) => row.path === '/index.html').bytes.toString()).toBe('<html>Admin</html>');
  content.files[0].bytes.fill(0);
  expect(pairedAdminArtifactContents(sealed).files[0].bytes.some((byte: number) => byte !== 0)).toBe(true);
});
it('refuses symlinks, a wrong revision and a production package without the private worker', async () => {
  await expect(preparePairedAdminArtifact({ directory: root, sourceSha: 'f'.repeat(40), environment: 'development' })).rejects.toThrow();
  await expect(preparePairedAdminArtifact({ directory: root, sourceSha, environment: 'production' })).rejects.toThrow();
  await symlink(join(root, 'index.html'), join(root, 'leak.html'));
  await expect(preparePairedAdminArtifact({ directory: root, sourceSha, environment: 'development' })).rejects.toThrow();
});
it('deterministically seals the production worker and carries its exact private bindings in the native multipart', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'paired-admin-worker-test-'));
  try {
    const workerModulePath = join(scratch, 'worker.js');
    await writeFile(workerModulePath, 'export default {fetch: () => new Response("fixture")};');
    await writeFile(join(root, 'admin-status.json'), JSON.stringify({ schemaVersion: 2, status: 'current',
      environment: 'Production', build: { revision: sourceSha } }));
    const first = await preparePairedAdminArtifact({ directory: root, sourceSha, environment: 'production', workerModulePath });
    const second = await preparePairedAdminArtifact({ directory: root, sourceSha, environment: 'production', workerModulePath });
    expect(first.manifestDigest).toBe(second.manifestDigest);
    const http = transport(async (_url, options) => {
      const bundle = options.body.get('_worker.bundle');
      const form = await new Response(bundle, { headers: { 'content-type': bundle.type } }).formData();
      const metadata = JSON.parse(String(form.get('metadata')));
      expect(metadata.main_module).toBe('worker.js');
      expect(metadata.bindings).toEqual([{ name: 'STAFF_ACCESS', type: 'service', service: 'njpbs-cms-api', entrypoint: 'StaffSiteEntrypoint' },
        { name: 'GUIDE_VIDEOS', type: 'r2_bucket', bucket_name: 'njpbs-admin-guide' }]);
      return answer({ id: newId });
    }, { target: { ...target, environment: 'production', projectId: 'njpbs-site' }, prepared: first });
    expect(await http.createDeployment({ ...request, manifestDigest: first.manifestDigest })).toBe(newId);
    expect(calls).toHaveLength(1);
    const before = process.env.FIRESTORE_EMULATOR_HOST;
    try {
      process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:19999';
      expect(() => createPairedAdminPagesProvider({ firestore: { projectId: 'njpbs-site' },
        target: { ...target, environment: 'production', projectId: 'njpbs-site' }, prepared: first,
        baseline: { deploymentId: oldId, artifact: first }, authorized: true, allowLocalEmulator: true,
        readCloudflareToken: async () => 'fixture', readGoogleToken: async () => 'fixture', readAccessHeaders: async () => ({}),
        fetchImpl: async () => answer({}) })).toThrow();
    } finally { if (before === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = before; }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
it('reopens the original actual compiler output without rewriting it, and refuses changed retained input', async () => {
  const sealRoot = await mkdtemp(join(tmpdir(), 'paired-admin-reentry-'));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  try {
    const source = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    await writeFile(join(root, 'admin-status.json'), JSON.stringify({ schemaVersion: 2, status: 'current',
      environment: 'Production', build: { revision: source } }));
    const seal = join(sealRoot, 'original');
    const args = [join(repo, 'scripts/prepare-paired-admin-pages.mjs'), 'production', source, root, seal];
    const run = () => JSON.parse(execFileSync(process.execPath, args, { cwd: repo, env: { PATH: process.env.PATH }, encoding: 'utf8' }));
    const first = run(), bundle = await readFile(join(seal, 'worker.bundle')), metadata = await readFile(join(seal, 'sealed.json'));
    const before = (await stat(join(seal, 'worker.bundle'))).mtimeMs;
    expect(run()).toEqual(first);
    expect((await stat(join(seal, 'worker.bundle'))).mtimeMs).toBe(before);
    expect(await readFile(join(seal, 'worker.bundle'))).toEqual(bundle);
    await writeFile(join(root, 'index.html'), 'changed input');
    expect(run).toThrow();
    expect(await readFile(join(seal, 'sealed.json'))).toEqual(metadata);
    expect(await readFile(join(seal, 'worker.bundle'))).toEqual(bundle);
  } finally { await rm(sealRoot, { recursive: true, force: true }); }
});
it.each([{ authorized: false }, { target: { ...target, projectId: 'njpbs-site' } }, { target: { ...target, branch: 'preview' } },
  { target: { ...target, origin: 'https://untrusted.example.test' } }, { target: { ...target, pagesProjectId: undefined } },
  { target: { ...target, accountId: [target.accountId] } }])(
  'refuses an unbound/changed target or artifact before credentials', extra => {
    expect(() => transport(async () => answer({}), extra)).toThrow();
    expect(credentials).toBe(0); expect(calls).toHaveLength(0);
  });
it('refuses a structurally valid copy of the sealed handle before credentials', () => {
  const copy = structuredClone(artifact);
  expect(copy.environment).toBe(target.environment);
  expect(() => transport(async () => answer({}), { prepared: copy })).toThrow();
  expect(credentials).toBe(0); expect(calls).toHaveLength(0);
});
it('uploads immutable content-addressed assets without selecting any deployment', async () => {
  const http = transport(async url => url.endsWith('/upload-token') ? answer({ jwt: 'fixture-upload-jwt' }) : answer({}));
  await http.uploadAssets();
  expect(calls.filter(row => row.method === 'POST')).toHaveLength(artifact.publicMembers.length + 1);
  expect(calls.some(row => new URL(row.url).pathname.endsWith('/deployments'))).toBe(false);
  const upload = calls.find(row => row.url.endsWith('/pages/assets/upload'));
  const row = JSON.parse(upload.body)[0];
  const file = artifact.publicMembers[0];
  expect(row.key).toBe(file.hash);
  expect(row.metadata.contentType).toBe(file.contentType);
  expect(Buffer.from(row.value, 'base64').length).toBe(file.size);
  expect(upload.headers.authorization).toBe('Bearer fixture-upload-jwt');
});
it('sends exactly one native deployment POST with the sealed manifest and operation metadata', async () => {
  const http = transport(async (_url, options) => {
    expect(options.redirect).toBe('error');
    expect(options.body.get('branch')).toBe('main');
    expect(options.body.get('commit_hash')).toBe(sourceSha);
    expect(options.body.get('commit_message')).toContain(request.operationDigest);
    expect(JSON.parse(options.body.get('manifest'))).toEqual(Object.fromEntries(artifact.publicMembers.map((row: any) => [row.path, row.hash])));
    return answer({ id: newId });
  });
  expect(await http.createDeployment(request)).toBe(newId);
  expect(calls).toHaveLength(1);
});
it.each(['lost response', 'provider error'])('does not repeat the deployment POST after %s', async reason => {
  const http = transport(async () => {
    if (reason === 'lost response') throw new Error('fixture-private-error');
    return new Response(JSON.stringify({ success: false, errors: [{ code: 8000000, message: 'fixture-private-error' }] }), { status: 500 });
  });
  await expect(http.createDeployment(request)).rejects.toThrow('Paired Admin provider refused');
  expect(calls).toHaveLength(1);
});
it.each(['credential-failure', 'cancelled'])('marks a %s before native fetch as unsent', async kind => {
  const controller = new AbortController();
  const http = transport(async () => answer({ id: newId }), { readCloudflareToken: async () => {
    if (kind === 'credential-failure') throw new Error('fixture locked credential store');
    controller.abort(); return 'fixture-token';
  } });
  await expect(http.createDeployment(request, controller.signal)).rejects.toMatchObject({ code: 'deployment-not-sent' });
  expect(calls).toHaveLength(0);
});
it('checks the actual canonical project/configuration and refuses changed settings', async () => {
  expect(await transport(async () => answer(project)).activeId()).toBe(oldId);
  await expect(transport(async () => answer({ ...project, production_branch: 'other' })).activeId()).rejects.toThrow();
});
it('recovers one exact operation through complete inventory and independent deployment readback', async () => {
  const http = transport(async url => url.includes('?') ? new Response(JSON.stringify({ success: true, result: [deployment()],
    result_info: { page: 1, per_page: 100, total_pages: 1 } })) : answer(deployment()));
  expect(await http.findDeployment(request)).toMatchObject({ outcome: 'uploaded',
    proof: { deploymentId: newId, providerReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(calls.every(row => row.method === 'GET')).toBe(true);
});
it('waits read-only for a normal asynchronous deployment after sending one POST', async () => {
  let reads = 0;
  const http = transport(async (_url, options) => options.method === 'POST' ? answer({ id: newId })
    : answer(deployment({ latest_stage: ++reads === 1 ? { name: 'initialize', status: 'success' } : { name: 'deploy', status: 'success' } })));
  const id = await http.createDeployment(request);
  expect(await http.waitForDeployment(id, request)).toMatchObject({ outcome: 'uploaded', proof: { deploymentId: newId } });
  expect(reads).toBeGreaterThan(1);
  expect(calls.filter(row => row.method === 'POST')).toHaveLength(1);
});
it('accepts documented provider string ids and proves exact terminal failure through GET only', async () => {
  const id = 'f64788e9-fccd-4d4a-a28a-cb84f88f6';
  const http = transport(async () => answer(deployment({ id, latest_stage: { name: 'build', status: 'failure',
    ended_on: '2026-10-29T02:00:00.123456Z' } })));
  expect(await http.waitForDeployment(id, request)).toMatchObject({ outcome: 'failed', proof: { deploymentId: id } });
  expect(calls.every(row => row.method === 'GET')).toBe(true);
});
it('ends a nonterminal wait at the existing 30-second bound without a failed proof', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
  });
  try {
    const http = transport(async () => answer(deployment({ latest_stage: { name: 'deploy', status: 'active', ended_on: null } })));
    const refused = expect(http.waitForDeployment(newId, request)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_001); await refused;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(row => row.method === 'GET')).toBe(true);
  } finally { timeout.mockRestore(); vi.useRealTimers(); }
});
it.each(['empty', 'duplicate', 'truncated', 'wrong-source', 'count-mismatch'])('keeps %s recovery uncertain without a deployment write', async kind => {
  const http = transport(async () => new Response(JSON.stringify({ success: true,
    result: kind === 'empty' ? [] : kind === 'duplicate' ? [deployment(), deployment()] : [deployment(kind === 'wrong-source'
      ? { deployment_trigger: { metadata: { branch: 'main', commit_hash: 'f'.repeat(40), commit_message: deployment().deployment_trigger.metadata.commit_message } } } : {})],
    result_info: kind === 'truncated' ? { page: 1, per_page: 100 } : { page: 1, per_page: 100, total_pages: 1,
      ...(kind === 'count-mismatch' ? { total_count: 100 } : {}) } })));
  await expect(http.findDeployment(request)).rejects.toThrow();
  expect(calls.every(row => row.method === 'GET')).toBe(true);
});
it('refuses a changing provider inventory without another mutation', async () => {
  let reads = 0;
  const http = transport(async () => new Response(JSON.stringify({ success: true,
    result: [deployment({ id: ++reads === 1 ? newId : oldId })], result_info: { page: 1, per_page: 100, total_pages: 1 } })));
  await expect(http.findDeployment(request)).rejects.toThrow();
  expect(calls.every(row => row.method === 'GET')).toBe(true);
});
it.each(['exact', 'changed-byte', 'changed-selection'])('checks native exact HTTP bytes and surrounding selection: %s', async kind => {
  let projects = 0;
  const files = pairedAdminArtifactContents(artifact).files;
  const http = transport(async url => {
    if (url.startsWith('https://api.cloudflare.com/')) {
      projects++;
      return answer({ ...project, canonical_deployment: { id: kind === 'changed-selection' && projects > 1 ? newId : oldId } });
    }
    const path = new URL(url).pathname, file = files.find((row: any) => row.path === (path === '/' ? '/index.html' : path));
    expect(file).toBeDefined();
    return new Response(kind === 'changed-byte' ? 'wrong' : file!.bytes, { headers: { 'content-type': file!.contentType } });
  });
  if (kind === 'exact') await expect(http.verifyActiveBytes(artifact, oldId)).resolves.toBeUndefined();
  else await expect(http.verifyActiveBytes(artifact, oldId)).rejects.toThrow();
});
it('reads Functions and CMS API identities from the exact dev providers', async () => {
  const http = transport(async (url, options) => {
    if (url.startsWith('https://cloudfunctions.googleapis.com/')) {
      expect(url).toContain('/projects/njpbs-site-dev/locations/us-central1/functions');
      expect(options.headers.authorization).toBe('Bearer fixture-google-token');
      return new Response(JSON.stringify({ functions: [{ name: 'projects/njpbs-site-dev/locations/us-central1/functions/cmsPreviewStatus', state: 'ACTIVE' }] }));
    }
    expect(url).toContain('/workers/scripts/template-dev-cms-api/deployments');
    return answer({ deployments: [{ id: googleId, versions: [{ version_id: newId, percentage: 100 }] }] });
  });
  expect(await http.readLiveReaderIdentities()).toMatchObject({ functions: { region: 'us-central1', activeCount: '1' },
    cmsApi: { script: 'template-dev-cms-api', deploymentId: googleId, versionId: newId } });
});
