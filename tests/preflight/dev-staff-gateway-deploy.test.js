import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run, verifySignedOut, assertDevPublicWorkerBindings } from '../../scripts/deploy-dev-staff-gateway.mjs';

const account = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const zone = 'a'.repeat(32);
const routeId = 'b'.repeat(32);
const versionId = '11111111-2222-3333-4444-555555555555';
const worker = 'njpbs-dev-staff-sites';
const workerPath = `/accounts/${account}/workers/scripts/${worker}`;
const publicPath = `/accounts/${account}/workers/scripts/template-dev-public`;
const routePath = `/zones/${zone}/workers/routes`;
const audience = 'c'.repeat(64);
const sha = 'd'.repeat(40);
const publicBindings = [
  { type: 'assets', name: 'ASSETS' },
  { type: 'service', name: 'CMS_API', service: 'template-dev-cms-api', entrypoint: 'PublicContentEntrypoint', environment: 'production' },
  { type: 'plain_text', name: 'NO_BUILD_POST_RENDERER_SHA', text: sha },
];
it('accepts only an optional Page renderer sealed to the same dev source', () => {
  const page = { type: 'plain_text', name: 'NO_BUILD_PAGE_RENDERER_SHA', text: sha };
  const dataFigures = { type: 'plain_text', name: 'DATA_FIGURE_VERSION', text: '1' };
  expect(() => assertDevPublicWorkerBindings([...publicBindings, page], sha)).not.toThrow();
  expect(() => assertDevPublicWorkerBindings([...publicBindings, page, dataFigures], sha)).not.toThrow();
  const withdrawals = { type: 'r2_bucket', name: 'DURABLE_POST_WITHDRAWALS', bucket_name: 'njpbs-dev-cms-publication' };
  expect(() => assertDevPublicWorkerBindings([...publicBindings, withdrawals], sha)).not.toThrow();
  expect(() => assertDevPublicWorkerBindings([...publicBindings, page, withdrawals], sha)).not.toThrow();
  expect(() => assertDevPublicWorkerBindings([...publicBindings, page, { ...withdrawals, bucket_name: 'production-bucket' }], sha))
    .toThrow('exact reader bindings');
  for (const wrong of [{ ...page, text: 'e'.repeat(40) }, { ...page, type: 'secret_text' }, { ...page, name: 'unknown' }]) {
    expect(() => assertDevPublicWorkerBindings([...publicBindings, wrong], sha)).toThrow('exact reader bindings');
  }
  expect(() => assertDevPublicWorkerBindings([...publicBindings, page, { ...dataFigures, text: '2' }], sha))
    .toThrow('exact reader bindings');
});
const staffHeaders = {
  'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
};
const publicHost = new URL('https://dev-public.example.org').hostname;
const parentDomain = publicHost.split('.').slice(1).join('.');
const login = 'https://fixture.cloudflareaccess.com/cdn-cgi/access/login/dev-public.example.org?token=fixture-private';
// Synthetic existing development shadow route.
const shadowRoute = { id: '1'.repeat(32), pattern: 'https://dev-public.example.org/posts/*', script: 'njpbs-shadow-posts' };

// Only fake the Cloudflare HTTP and Wrangler process boundaries. Response shapes
// follow Cloudflare's route, settings, deployment and version APIs and Wrangler
// 4.134.0's fetchLatestDeployments/fetchVersion consumers. No cloud call is made.
function fixture(options = {}) {
  const calls = [];
  let routes = [
    { id: routeId, pattern: 'dev-public.example.org/*', script: options.owner ?? 'njpbs-staff-sites' },
    { id: 'e'.repeat(32), pattern: 'preview.njpbs.org/*', script: 'njpbs-staff-sites' },
    { id: 'f'.repeat(32), pattern: 'njpbs.org/*', script: 'njpbs-production' },
    ...(options.extraRoutes ?? []),
  ];
  let routeReads = 0;
  let temp;
  let deployed = false;
  const bindings = options.bindings ?? [
    { type: 'service', name: 'DEV_PUBLIC', service: 'template-dev-public', environment: 'production' },
    { type: 'plain_text', name: 'DEV_ACCESS_AUDIENCE', text: audience },
    { type: 'plain_text', name: 'CMS_DEV_ACCESS_ORIGIN', text: 'https://fixture.cloudflareaccess.com' },
    { type: 'service', name: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint', environment: 'production' },
  ];
  const env = { CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012",
    PATH: process.env.PATH, HOME: process.env.HOME,
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'CenterCoopMedia/njpbs', GITHUB_SHA: sha,
    GATEWAY_MODE: 'stage', GATEWAY_VERSION_ID: versionId,
    GATEWAY_PREREQUISITES_VERIFIED: 'true', CMS_DEV_PUBLISH_ENABLED: 'false',
    CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'fixture-token-not-a-secret',
    DEV_ACCESS_AUDIENCE: audience, CMS_DEV_ACCESS_ORIGIN: 'https://fixture.cloudflareaccess.com', ...options.env,
  };
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://dev-public.example.org/')) {
      expect(init.redirect).toBe('manual');
      expect(init.credentials).toBe('omit');
      expect(init.headers).toBeUndefined();
      calls.push({ anonymous: url });
      if (options.refusalFails) return new Response('private fixture', { status: 200 });
      return new Response('', { status: 302, headers: { location: login } });
    }
    expect(init.headers.Authorization).toBe('Bearer fixture-token-not-a-secret');
    expect(init.redirect).toBe('error');
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (options.apiFailure === path) return new Response(JSON.stringify({ success: false }), { status: 403 });
    let result;
    if (path.startsWith('/zones?')) result = [{ id: zone, name: 'njpbs.org', account: { id: account } }];
    else if (path === routePath && init.method === 'GET') {
      routeReads++;
      if (options.race && routeReads === 2) routes[0].script = 'unexpected-worker';
      result = routes;
    } else if (path === `${routePath}/${routeId}` && init.method === 'PUT') {
      if (options.uncertainWrite) throw new Error('fixture response includes sensitive data');
      if (!options.badReadback) routes[0].script = worker;
      if (options.previewChanged) routes[1].script = worker;
      if (options.shadowChange === 'removed') routes = routes.filter(r => r.id !== shadowRoute.id);
      else if (options.shadowChange) Object.assign(routes.find(r => r.id === shadowRoute.id), options.shadowChange);
      result = routes[0];
    } else if (path === `/accounts/${account}/workers/scripts/template-dev-cms-api/settings`) {
      result = { bindings: Object.entries({
        CMS_DEPLOYMENT_ENVIRONMENT: 'development', FIREBASE_PROJECT_ID: options.project ?? 'njpbs-site-dev',
        FUNCTIONS_ORIGIN: 'https://us-central1-njpbs-site-dev.cloudfunctions.net', ADMIN_ORIGIN: 'https://dev-admin.example.org',
      }).map(([name, text]) => ({ name, text, type: 'plain_text' })) };
    } else if (path === `${publicPath}/settings`) result = { bindings: options.publicBindings ?? publicBindings };
    else if (path === `${publicPath}/subdomain`) result = { enabled: options.originPublicUrl ?? false, previews_enabled: options.originPreviewUrl ?? false };
    else if (path === `/accounts/${account}/workers/domains?service=template-dev-public`) result = options.domains ?? [];
    else if (path === `${workerPath}/deployments`) {
      result = { deployments: [{ id: '22222222-3333-4444-5555-666666666666', versions: [{ version_id: options.activeVersion ?? versionId, percentage: options.percentage ?? 100 }] }] };
    } else if (path === `${workerPath}/versions/${versionId}`) {
      result = { id: versionId, annotations: { 'workers/message': `dev-staff-gateway:${options.source ?? sha}` }, resources: { bindings } };
    } else if (path === `${workerPath}/settings`) result = { bindings: (!deployed && options.initialBindings) || options.settingsBindings || bindings };
    else if (path === `${workerPath}/subdomain`) result = { enabled: options.publicUrl ?? false, previews_enabled: options.previewUrl ?? false };
    else throw new Error(`Unexpected API boundary: ${init.method} ${path}`);
    return new Response(JSON.stringify({ success: true, result }));
  };
  const spawn = (command, args, opts) => {
    temp = args[args.indexOf('--config') + 1];
    const config = JSON.parse(readFileSync(temp, 'utf8'));
    expect(existsSync(resolve(dirname(temp), config.main))).toBe(true);
    calls.push({ command, args, config });
    expect(config.name).toBe(worker);
    expect(config.routes).toEqual([]);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.services).toEqual([
      { binding: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { binding: 'DEV_PUBLIC', service: 'template-dev-public' },
    ]);
    expect(args).toContain(`DEV_ACCESS_AUDIENCE:${audience}`);
    expect(args).toContain(`dev-staff-gateway:${sha}`);
    expect(opts.env.WRANGLER_WRITE_LOGS).toBe('false');
    expect(opts.env.GITHUB_TOKEN).toBeUndefined();
    deployed = true;
    if (options.stageRouteChanged) routes[0].script = worker;
    if (options.deployRouteChanged) routes[1].script = 'unexpected-worker';
    return { status: options.deployFailure ? 1 : 0,
      stdout: `${options.noVersionOutput ? '' : `Current Version ID: ${versionId}\n`}fixture-private-output`,
      stderr: 'fixture-private-error' };
  };
  return { calls, execute: () => run({ env, fetchImpl, spawn }), routes: () => routes,
    mutations: () => calls.filter(c => c.command || c.method && c.method !== 'GET'),
    tempExists: () => temp && existsSync(temp) };
}

describe('isolated dev gateway deployment boundary', () => {
  it('accepts the exact dev withdrawal bucket before updating the private gateway', async () => {
    const f = fixture({ owner: worker, publicBindings: [...publicBindings,
      { name: 'DURABLE_POST_WITHDRAWALS', type: 'r2_bucket', bucket_name: 'njpbs-dev-cms-publication' }],
      env: { GATEWAY_MODE: 'update', GATEWAY_VERSION_ID: '' } });
    await f.execute();
    expect(f.mutations()).toHaveLength(1);
  });
  it.each([
    { name: 'OTHER_BUCKET', type: 'r2_bucket', bucket_name: 'njpbs-dev-cms-publication' },
    { name: 'DURABLE_POST_WITHDRAWALS', type: 'r2_bucket', bucket_name: 'njpbs-cms-publication' },
    { name: 'DURABLE_POST_WITHDRAWALS', type: 'plain_text', text: 'njpbs-dev-cms-publication' },
    { name: 'DURABLE_POST_WITHDRAWALS', type: 'r2_bucket' },
  ])('refuses an unexpected dev withdrawal binding before mutations: %j', async binding => {
    const f = fixture({ owner: worker, publicBindings: [...publicBindings, binding], env: { GATEWAY_MODE: 'update' } });
    await expect(f.execute()).rejects.toThrow(/exact reader bindings/);
    expect(f.mutations()).toEqual([]);
  });
  it('refuses duplicate dev withdrawal bindings before mutations', async () => {
    const binding = { name: 'DURABLE_POST_WITHDRAWALS', type: 'r2_bucket', bucket_name: 'njpbs-dev-cms-publication' };
    const f = fixture({ owner: worker, publicBindings: [...publicBindings, binding, { ...binding }], env: { GATEWAY_MODE: 'update' } });
    await expect(f.execute()).rejects.toThrow(/exact reader bindings/);
    expect(f.mutations()).toEqual([]);
  });
  it('updates an isolated owner with private service bindings while preserving every route', async () => {
    const f = fixture({ owner: worker, env: { GATEWAY_MODE: 'update', GATEWAY_VERSION_ID: '' } });
    const before = structuredClone(f.routes());
    await f.execute();
    expect(f.routes()).toEqual(before);
    expect(f.mutations()).toHaveLength(1);
    expect(f.mutations()[0].command).toBe('node_modules/.bin/wrangler');
    expect(f.mutations()[0].config.routes).toEqual([]);
    expect(f.tempExists()).toBe(false);
  });

  it('migrates the token-bound gateway and permits only its retired secrets until cleanup', async () => {
    const initialBindings = [
      { type: 'secret_text', name: 'DEV_PAGES_ACCESS_CLIENT_ID' },
      { type: 'secret_text', name: 'DEV_PAGES_ACCESS_CLIENT_SECRET' },
      { type: 'plain_text', name: 'DEV_ACCESS_AUDIENCE', text: audience },
      { type: 'service', name: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
    ];
    const f = fixture({ owner: worker, initialBindings,
      bindings: [...initialBindings, { type: 'plain_text', name: 'CMS_DEV_ACCESS_ORIGIN', text: 'https://fixture.cloudflareaccess.com' },
        { type: 'service', name: 'DEV_PUBLIC', service: 'template-dev-public' }],
      env: { GATEWAY_MODE: 'update' } });
    await f.execute();
    expect(f.mutations()).toHaveLength(1);
  });

  it.each([
    { publicBindings: [] },
    { publicBindings: [{ type: 'service', name: 'ASSETS', service: 'njpbs-production' }] },
    { publicBindings: [{ type: 'assets', name: 'ASSETS' }, { type: 'secret_text', name: 'unexpected' }] },
    { publicBindings: publicBindings.map(binding => binding.name === 'CMS_API' ? { ...binding, service: 'njpbs-cms-api' } : binding) },
    { publicBindings: publicBindings.map(binding => binding.name === 'CMS_API' ? { ...binding, entrypoint: 'StaffSiteEntrypoint' } : binding) },
    { publicBindings: publicBindings.map(binding => binding.name === 'CMS_API' ? { ...binding, environment: 'development' } : binding) },
    { publicBindings: publicBindings.map(binding => binding.name === 'NO_BUILD_POST_RENDERER_SHA' ? { ...binding, text: '' } : binding) },
    { publicBindings: [...publicBindings, { type: 'secret_text', name: 'unexpected' }] },
    { originPublicUrl: true }, { originPreviewUrl: true },
    { domains: [{ service: 'template-dev-public', hostname: 'public.example.test' }] },
    { extraRoutes: [{ id: '3'.repeat(32), pattern: 'public.example.test/*', script: 'template-dev-public' }] },
  ])('requires the private dev reader before any deployment: %j', async options => {
    const f = fixture({ ...options, owner: worker, env: { GATEWAY_MODE: 'update' } });
    await expect(f.execute()).rejects.toThrow(/Dev public Worker/);
    expect(f.mutations()).toEqual([]);
  });

  it.each([
    [{ type: 'plain_text', name: 'DEV_ACCESS_AUDIENCE', text: audience },
    { type: 'plain_text', name: 'CMS_DEV_ACCESS_ORIGIN', text: 'https://fixture.cloudflareaccess.com' },
      { type: 'service', name: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { type: 'secret_text', name: 'DEV_PAGES_ACCESS_CLIENT_ID' },
      { type: 'secret_text', name: 'DEV_PAGES_ACCESS_CLIENT_SECRET' }],
    [{ type: 'plain_text', name: 'DEV_ACCESS_AUDIENCE', text: audience },
    { type: 'plain_text', name: 'CMS_DEV_ACCESS_ORIGIN', text: 'https://fixture.cloudflareaccess.com' },
      { type: 'service', name: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { type: 'service', name: 'DEV_PUBLIC', service: 'njpbs-production' }],
  ])('refuses a deployed legacy or production origin binding', async (...bindings) => {
    const f = fixture({ bindings });
    await expect(f.execute()).rejects.toThrow(/exact dev-only/);
    expect(f.mutations().filter(change => change.method)).toEqual([]);
  });

  it.each([
    { type: 'secret_text', name: 'unrelated-secret' },
    { type: 'service', name: 'PRODUCTION', service: 'njpbs-production' },
    { type: 'service', name: 'DEV_PUBLIC', service: 'template-dev-public' },
  ])('refuses unexpected or duplicate gateway bindings: %j', async extra => {
    const bindings = [
      { type: 'plain_text', name: 'DEV_ACCESS_AUDIENCE', text: audience },
    { type: 'plain_text', name: 'CMS_DEV_ACCESS_ORIGIN', text: 'https://fixture.cloudflareaccess.com' },
      { type: 'service', name: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { type: 'service', name: 'DEV_PUBLIC', service: 'template-dev-public' }, extra,
    ];
    const f = fixture({ bindings });
    await expect(f.execute()).rejects.toThrow(/exact dev-only/);
    expect(f.mutations().filter(change => change.method)).toEqual([]);
  });

  it.each([
    { owner: 'njpbs-staff-sites' },
    { extraRoutes: [{ ...shadowRoute }] },
    { settingsBindings: [] },
    { race: true },
  ])('refuses an unsafe update before deployment: %j', async options => {
    const f = fixture({ owner: worker, ...options, env: { GATEWAY_MODE: 'update' } });
    await expect(f.execute()).rejects.toThrow();
    expect(f.mutations()).toEqual([]);
  });

  it('reports an update failure when another route changes during deployment', async () => {
    const f = fixture({ owner: worker, deployRouteChanged: true, env: { GATEWAY_MODE: 'update' } });
    await expect(f.execute()).rejects.toThrow(/Routes changed/);
    expect(f.mutations()).toHaveLength(1);
    expect(f.mutations()[0].command).toBe('node_modules/.bin/wrangler');
    expect(f.tempExists()).toBe(false);
  });

  it('stages a verified version without changing any zone routes and removes its temporary config', async () => {
    const f = fixture({ env: { GATEWAY_MODE: 'stage' } });
    await f.execute();
    expect(f.mutations()).toHaveLength(1);
    expect(f.mutations()[0].command).toBe('node_modules/.bin/wrangler');
    expect(f.routes()[0].script).toBe('njpbs-staff-sites');
    expect(f.tempExists()).toBe(false);
  });

  it('rejects the retired transfer mode before any network call or deployment', async () => {
    const f = fixture({ env: { GATEWAY_MODE: 'transfer' } });
    await expect(f.execute()).rejects.toThrow('Transfer is disabled; use guard-dev-routing-change.mjs');
    expect(f.calls).toEqual([]);
    expect(f.mutations()).toEqual([]);
  });

  it.each(['stage'])('admits the exact shadow route during %s and leaves it unchanged', async mode => {
    const f = fixture({ env: { GATEWAY_MODE: mode }, extraRoutes: [{ ...shadowRoute }] });
    const before = structuredClone(f.routes());
    await f.execute();
    expect(f.routes()).toEqual(before.map(r => r.id === routeId && mode === 'transfer' ? { ...r, script: worker } : r));
    expect(f.mutations()).toHaveLength(1);
    if (mode === 'stage') expect(f.mutations()[0].config.routes).toEqual([]);
    else expect(f.mutations()[0]).toEqual({ path: `${routePath}/${routeId}`, method: 'PUT', body: { pattern: 'dev-public.example.org/*', script: worker } });
  });

  it.each(['unexpected-worker', worker, null, undefined])('refuses the shadow route with owner %s before staging', async script => {
    for (const mode of ['stage']) {
      const f = fixture({ env: { GATEWAY_MODE: mode }, extraRoutes: [{ ...shadowRoute, script }] });
      await expect(f.execute()).rejects.toThrow(/overlapping/);
      expect(f.mutations()).toEqual([]);
    }
  });

  it.each(['dev-public.example.org/posts/*', 'http://dev-public.example.org/posts/*', 'https://dev-public.example.org/posts*',
    'https://dev-public.example.org/posts/other/*', 'https://dev-public.example.org/*', `https://*.${parentDomain}/posts/*`,
    `https://${publicHost.toUpperCase()}/posts/*`])('refuses shadow pattern variant %s', async pattern => {
    const f = fixture({ extraRoutes: [{ ...shadowRoute, pattern }] });
    await expect(f.execute()).rejects.toThrow(/overlapping/);
    expect(f.mutations()).toEqual([]);
  });

  it('still refuses a second isolated gateway route alongside the shadow route', async () => {
    const f = fixture({ extraRoutes: [{ ...shadowRoute }, { id: '2'.repeat(32), pattern: 'other.njpbs.org/*', script: worker }] });
    await expect(f.execute()).rejects.toThrow(/overlapping/);
    expect(f.mutations()).toEqual([]);
  });

  it('refuses duplicate shadow routes', async () => {
    const f = fixture({ extraRoutes: [{ ...shadowRoute }, { ...shadowRoute, id: '2'.repeat(32) }] });
    await expect(f.execute()).rejects.toThrow(/at most one coexisting shadow route/);
    expect(f.mutations()).toEqual([]);
  });

  it.each([
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'other/repo' }, { GATEWAY_MODE: 'anything' },
    { GATEWAY_MODE: 'transfer' }, { GATEWAY_PREREQUISITES_VERIFIED: 'false' },
    { CMS_DEV_PUBLISH_ENABLED: 'true' }, { DEV_ACCESS_AUDIENCE: '' },
    { CLOUDFLARE_ACCOUNT_ID: 'f'.repeat(32) }, { CLOUDFLARE_API_TOKEN: '' },
  ])('refuses an unsafe dispatch context before any network call: %j', async env => {
    const f = fixture({ env });
    await expect(f.execute()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it.each(['stage'])('refuses %s after transfer instead of removing or taking back routes', async mode => {
    const f = fixture({ owner: worker, env: { GATEWAY_MODE: mode } });
    await expect(f.execute()).rejects.toThrow(/required owner/);
    expect(f.mutations()).toEqual([]);
  });

  it.each(['https://dev-public.example.org/posts/*', 'dev-public.example.org/assets/*', `*.${parentDomain}/*`, 'https://dev-public.example.org/*'])('refuses overlapping route %s even without an owner', async pattern => {
    const f = fixture({ extraRoutes: [{ id: '1'.repeat(32), pattern }] });
    await expect(f.execute()).rejects.toThrow(/overlapping/);
    expect(f.mutations()).toEqual([]);
  });

  it.each([
    { owner: 'unexpected-worker' }, { project: 'njpbs-site' },
    { activeVersion: '99999999-2222-3333-4444-555555555555' }, { percentage: 50 },
    { source: 'e'.repeat(40) }, { bindings: [] }, { settingsBindings: [] },
    { publicUrl: true }, { previewUrl: true }, { race: true }, { refusalFails: true },
    { apiFailure: `${workerPath}/deployments` },
  ])('fails closed during staging without changing any route: %j', async options => {
    const f = fixture(options);
    await expect(f.execute()).rejects.toThrow();
    expect(f.mutations().filter(change => change.method)).toEqual([]);
  });

  it.each([{ deployFailure: true }, { stageRouteChanged: true }])('cleans up after a failed stage and never transfers: %j', async options => {
    const f = fixture({ ...options, env: { GATEWAY_MODE: 'stage' } });
    await expect(f.execute()).rejects.toThrow();
    expect(f.tempExists()).toBe(false);
    expect(f.mutations()).toHaveLength(1);
  });

  it.each([false, true])('retains safe reconciliation IDs after a failed deploy, missing CLI version=%s', async noVersionOutput => {
    const f = fixture({ deployFailure: true, noVersionOutput, env: { GATEWAY_MODE: 'stage' } });
    let failure;
    try { await f.execute(); } catch (error) { failure = error.message; }
    expect(failure).toContain('Unverified deployment: 22222222-3333-4444-5555-666666666666');
    expect(failure).toContain(versionId);
    expect(failure).not.toMatch(/fixture-private|fixture-token/);
    expect(f.mutations()).toHaveLength(1);
    expect(f.tempExists()).toBe(false);
  });

  it('preserves failure and cleans up when deployment readback is also unavailable', async () => {
    const f = fixture({ deployFailure: true, noVersionOutput: true,
      apiFailure: `${workerPath}/deployments`, env: { GATEWAY_MODE: 'stage' } });
    await expect(f.execute()).rejects.toThrow('Dev gateway staging failed. Inspect deployment state before retrying; no transfer attempted.');
    expect(f.mutations()).toHaveLength(1);
    expect(f.tempExists()).toBe(false);
  });

  it('retains the staged version in the summary when a later verification fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-gateway-summary-'));
    try {
      const summary = join(dir, 'summary');
      const f = fixture({ percentage: 50, env: { GATEWAY_MODE: 'stage', GITHUB_STEP_SUMMARY: summary } });
      await expect(f.execute()).rejects.toThrow(/100 percent/);
      const text = readFileSync(summary, 'utf8');
      expect(text).toContain(`Unverified staged version: ${versionId}`);
      expect(text).toContain(`source: ${sha}`);
      expect(text).not.toMatch(/fixture-private|fixture-token|stage verified/);
      expect(f.mutations()).toHaveLength(1);
      expect(f.tempExists()).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('signed-out refusal contract', () => {
  const check = (status, body, headers = {}) => verifySignedOut(async () => new Response(body, { status, headers }));
  it.each([401, 403])('accepts the exact private gateway %s refusal', async status => {
    await expect(check(status, status === 401 ? 'Unauthorized' : 'Site access unavailable', staffHeaders)).resolves.toBeUndefined();
  });
  it.each(['', '<html>\n<head><title>302 Found</title></head>\n<body>\n<center><h1>302 Found</h1></center>\n<hr><center>cloudflare</center>\n</body>\n</html>\n'])('accepts the known Access redirect shape', async body => {
    await expect(check(302, body, { location: login })).resolves.toBeUndefined();
  });
  it.each([200, 204, 301, 307, 404, 503])('rejects status %s', async status => {
    await expect(check(status, status === 204 ? null : '', { location: login })).rejects.toThrow(/Signed-out/);
  });
  it.each([401, 403, 302])('rejects content and renderer evidence even with status %s', async status => {
    for (const body of ['<article>Private</article>', 'body {color:red}', 'export default 1', 'x'.repeat(17000)]) {
      await expect(check(status, body, { ...staffHeaders, location: login })).rejects.toThrow(/Signed-out/);
    }
    await expect(check(status, status === 401 ? 'Unauthorized' : status === 403 ? 'Site access unavailable' : '', {
      ...staffHeaders, location: login, 'x-njpbs-renderer-sha': sha,
    })).rejects.toThrow(/Signed-out/);
  });
  it.each(['https://fixture.cloudflareaccess.com.evil.test/', 'https://fixture.cloudflareaccess.com@evil.test/',
    'http://fixture.cloudflareaccess.com/cdn-cgi/access/login/dev-public.example.org',
    'https://fixture.cloudflareaccess.com/wrong', 'https://admin.njpbs.org/', 'not a URL'])('rejects an unrelated redirect %s', async location => {
    await expect(check(302, '', { location })).rejects.toThrow(/Signed-out/);
  });
  it('rejects generic edge refusals, missing privacy headers and transport failures', async () => {
    await expect(check(403, 'Forbidden', staffHeaders)).rejects.toThrow(/Signed-out/);
    await expect(check(401, 'Unauthorized')).rejects.toThrow(/Signed-out/);
    await expect(verifySignedOut(async () => { throw new Error('private response'); })).rejects.toThrow('Signed-out refusal failed for /');
  });
});
