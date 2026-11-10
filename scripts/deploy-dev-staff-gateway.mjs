import { repositoryMatches } from "./lib/repository-identity.mjs";
import { devAccessOrigin } from "./lib/deployment-settings.mjs";
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyDevPublicWorkerPrivate } from './lib/dev-private-worker.mjs';
import targetContract from '../functions/lib/publication-target.js';

const ACCOUNT = (process.env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID ?? "");
const WORKER = 'njpbs-dev-staff-sites';
const OLD_WORKER = 'njpbs-staff-sites';
const PATTERN = 'dev-public.example.org/*';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[a-f0-9]{32}$/;
const CONFIG = 'workers/wrangler.staff-sites.dev.jsonc';
const SHADOW_CONFIG = 'workers/wrangler.shadow-posts.jsonc';
const PUBLIC_TARGET = targetContract.publicationTarget('development');
const PUBLIC_WORKER = PUBLIC_TARGET.workerName;
const RETIRED_SECRETS = ['DEV_PAGES_ACCESS_CLIENT_ID', 'DEV_PAGES_ACCESS_CLIENT_SECRET'];
const PATHS = ['/', '/_publication.json', '/_home-sources.json',
  '/posts/nj-pbs-announces-six-staff-appointments/', '/posts/_shadow-assets/_astro/'];
const REDIRECT_BODY = '<html><head><title>302 Found</title></head><body><center><h1>302 Found</h1></center><hr><center>cloudflare</center></body></html>';

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

// Publication checks the exact sealed SHA. Gateway maintenance validates the
// same dev-only shape without requiring its source to equal the public source.
export function assertDevPublicWorkerBindings(bindings, rendererSha) {
  requireState(Array.isArray(bindings) && [3, 4, 5, 6, 7, 8, 9, 10].includes(bindings.length) &&
    new Set(bindings.map(binding => binding?.name)).size === bindings.length &&
    bindings.every(binding => ['ASSETS', 'CMS_API', 'NO_BUILD_POST_RENDERER_SHA', 'NO_BUILD_PAGE_RENDERER_SHA', 'NO_BUILD_CODE_POST_RENDERER_SHA', 'NO_BUILD_RECORD_RENDERER_SHA', 'DATA_HUB_PUBLIC', 'DATA_FIGURE_VERSION', 'ELECTION_RESULTS_VERSION', 'DURABLE_POST_WITHDRAWALS'].includes(binding?.name)),
  'Dev public Worker must have the exact reader bindings');
  const assets = bindings.find(binding => binding?.name === 'ASSETS');
  const api = bindings.find(binding => binding?.name === 'CMS_API');
  const renderer = bindings.find(binding => binding?.name === 'NO_BUILD_POST_RENDERER_SHA');
  const withdrawals = bindings.find(binding => binding?.name === 'DURABLE_POST_WITHDRAWALS');
  const pageRenderer = bindings.find(binding => binding?.name === 'NO_BUILD_PAGE_RENDERER_SHA');
  const optionalRenderers = bindings.filter(binding => ['NO_BUILD_CODE_POST_RENDERER_SHA', 'NO_BUILD_RECORD_RENDERER_SHA'].includes(binding?.name));
  const dataHub = bindings.find(binding => binding?.name === 'DATA_HUB_PUBLIC');
  const electionResultsVersion = bindings.find(binding => binding?.name === 'ELECTION_RESULTS_VERSION');
  const dataFigureVersion = bindings.find(binding => binding?.name === 'DATA_FIGURE_VERSION');
  requireState(assets?.type === 'assets' && api?.type === 'service' &&
    api.service === 'template-dev-cms-api' && api.entrypoint === 'PublicContentEntrypoint' &&
    (api.environment === undefined || api.environment === 'production') &&
    renderer?.type === 'plain_text' && /^[a-f0-9]{40}$/.test(renderer.text ?? '') &&
    (rendererSha === undefined || renderer.text === rendererSha) &&
    (!withdrawals || withdrawals.type === 'r2_bucket' && withdrawals.bucket_name === 'njpbs-dev-cms-publication') &&
    optionalRenderers.every(binding => binding.type === 'plain_text' && (binding.text === '' || binding.text === renderer.text)) &&
    (!dataHub || dataHub.type === 'plain_text' && ['0', '1'].includes(dataHub.text)) &&
    (!pageRenderer || pageRenderer.type === 'plain_text' && pageRenderer.text === renderer.text) &&
    (!electionResultsVersion || electionResultsVersion.type === 'plain_text' && ['0', '1', '2'].includes(electionResultsVersion.text)) &&
    (!dataFigureVersion || dataFigureVersion.type === 'plain_text' && dataFigureVersion.text === '1'),
  'Dev public Worker must have the exact reader bindings');
}

// The same refusal contract as #3001. Never print headers, bodies or login URLs.
export async function verifySignedOut(fetchImpl = fetch) {
  for (const path of PATHS) {
    let refused = false;
    try {
      const response = await fetchImpl(`https://dev-public.example.org${path}`, {
        redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30000),
      });
      // Read a bounded body in memory, including on a refusal status.
      const reader = response.body?.getReader();
      let size = 0;
      const chunks = [];
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            requireState(size <= 16384, 'Signed-out response exceeded the refusal limit');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel(); }
      }
      const body = Buffer.concat(chunks).toString('utf8').trim();
      const headers = response.headers;
      const contentEvidence = [...headers.keys()].some(name => name.startsWith('x-njpbs-'));
      if (!contentEvidence && response.status === 302) {
        const location = new URL(headers.get('location'));
        refused = location.origin === devAccessOrigin() &&
          !location.username && !location.password &&
          location.pathname === '/cdn-cgi/access/login/dev-public.example.org' &&
          (body === '' || body.replace(/\s+</g, '<') === REDIRECT_BODY);
      } else if (!contentEvidence && [401, 403].includes(response.status)) {
        refused = headers.get('cache-control') === 'private, no-store' &&
          headers.get('x-robots-tag') === 'noindex, nofollow, noarchive' &&
          headers.get('referrer-policy') === 'no-referrer' &&
          headers.get('x-content-type-options') === 'nosniff' &&
          body === (response.status === 401 ? 'Unauthorized' : 'Site access unavailable');
      }
    } catch { /* Transport and malformed responses fail closed; no raw diagnostics. */ }
    requireState(refused, `Signed-out refusal failed for ${path}`);
  }
}

function routeSnapshot(routes) {
  requireState(Array.isArray(routes) && routes.every(route => ID.test(route.id) &&
    typeof route.pattern === 'string'), 'Invalid authoritative route list');
  return JSON.stringify(routes.map(({ id, pattern, script }) => ({ id, pattern, script }))
    .sort((a, b) => a.id.localeCompare(b.id)));
}

function devRoute(routes, owner, shadowConfig) {
  routeSnapshot(routes);
  const matches = routes.filter(route => route.pattern === PATTERN);
  requireState(matches.length === 1 && matches[0].script === owner,
    'Expected one dev route with the required owner; stop and reconcile');
  const shadowRoutes = routes.filter(route => route.pattern === shadowConfig.routes[0].pattern &&
    route.script === shadowConfig.name);
  requireState(shadowRoutes.length <= 1, 'Expected at most one coexisting shadow route');
  // Include scheme-qualified and wildcard hosts. Reject overlaps conservatively,
  // except the exact checked-in shadow route. Worker-less routes still refuse.
  for (const route of routes) {
    if (route.id === matches[0].id || route === shadowRoutes[0]) continue;
    const host = route.pattern.replace(/^https?:\/\//, '').split('/')[0];
    const matcher = new RegExp(`^${host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    requireState(!matcher.test('dev-public.example.org') && route.script !== WORKER,
      'An overlapping dev route or another isolated gateway route needs separate review');
  }
  return matches[0];
}

function verifyBindings(bindings, audience, allowLegacy = false) {
  requireState(Array.isArray(bindings), 'Missing gateway bindings');
  // Wrangler can retain old secrets. They are unused; the coordinator removes
  // only these two after cutover. No other unexpected binding is accepted.
  const retired = bindings.filter(b => b.type === 'secret_text' && RETIRED_SECRETS.includes(b.name));
  const current = bindings.filter(b => !retired.includes(b));
  const publicBinding = current.find(b => b.name === 'DEV_PUBLIC');
  const legacy = allowLegacy && !publicBinding && retired.length === 2;
  const prior = allowLegacy && publicBinding && !current.some(b => b.name === "CMS_DEV_ACCESS_ORIGIN");
  requireState(new Set(bindings.map(b => b.name)).size === bindings.length &&
    current.length === (legacy ? 2 : prior ? 3 : 4) &&
    current.some(b => b.type === 'plain_text' && b.name === 'DEV_ACCESS_AUDIENCE' && b.text === audience) &&
    (legacy || prior || current.some(b => b.type === 'plain_text' && b.name === 'CMS_DEV_ACCESS_ORIGIN' && b.text === devAccessOrigin())) &&
    current.some(b => b.type === 'service' && b.name === 'DEV_STAFF_ACCESS' &&
      b.service === 'template-dev-cms-api' && b.entrypoint === 'StaffSiteEntrypoint' &&
      (!b.environment || b.environment === 'production')) &&
    (legacy || (publicBinding?.type === 'service' && publicBinding.service === PUBLIC_WORKER &&
      !publicBinding.entrypoint && (!publicBinding.environment || publicBinding.environment === 'production'))),
  'Deployed gateway must have the verified audience and exact dev-only service bindings');
}

// Read-only transfer preflight shared with the restore guard. No deployment or
// route write is allowed here; the caller supplies the approved staged identity.
export async function verifyGuardedRouteTarget({ api, routePath, routeId, owner,
  versionId, sourceSha, audience, expectedRoutes }) {
  requireState(UUID.test(versionId ?? '') && /^[a-f0-9]{40}$/.test(sourceSha ?? '') &&
    /^[a-f0-9]{64}$/.test(audience ?? ''), 'Missing approved staged gateway identity');
  const routes = await api(routePath);
  const route = devRoute(routes, owner, { name: 'njpbs-shadow-posts',
    routes: [{ pattern: 'https://dev-public.example.org/posts/*' }] });
  requireState(route.id === routeId, 'Dev route identity changed');
  if (expectedRoutes) requireState(routeSnapshot(routes) === routeSnapshot(expectedRoutes),
    'Zone routes changed during the guarded transfer');
  const apiSettings = await api(`/accounts/${ACCOUNT}/workers/scripts/template-dev-cms-api/settings`);
  for (const [name, value] of Object.entries({
    CMS_DEPLOYMENT_ENVIRONMENT: 'development', FIREBASE_PROJECT_ID: 'njpbs-site-dev',
    FUNCTIONS_ORIGIN: 'https://us-central1-njpbs-site-dev.cloudfunctions.net',
    ADMIN_ORIGIN: 'https://dev-admin.example.org',
  })) {
    const matches = apiSettings.bindings?.filter(binding => binding.name === name);
    requireState(matches?.length === 1 && matches[0].type === 'plain_text' && matches[0].text === value,
      'Dev CMS API deployment tuple mismatch');
  }
  const workerPath = `/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
  const versions = (await api(`${workerPath}/deployments`)).deployments?.[0]?.versions;
  requireState(versions?.length === 1 && versions[0].version_id === versionId && versions[0].percentage === 100,
    'Expected the approved staged version at 100 percent traffic');
  const version = await api(`${workerPath}/versions/${versionId}`);
  requireState(version.id === versionId &&
    version.annotations?.['workers/message'] === `dev-staff-gateway:${sourceSha}`,
  'Staged gateway version does not match the reviewed source');
  verifyBindings(version.resources?.bindings, audience);
  verifyBindings((await api(`${workerPath}/settings`)).bindings, audience);
  const subdomain = await api(`${workerPath}/subdomain`);
  requireState(subdomain.enabled === false && subdomain.previews_enabled === false,
    'Gateway public URLs must remain disabled');
  const publicSettings = await api(`/accounts/${ACCOUNT}/workers/scripts/${PUBLIC_WORKER}/settings`);
  assertDevPublicWorkerBindings(publicSettings.bindings);
  await verifyDevPublicWorkerPrivate(api, routes);
  return routes;
}

export async function run({ env = process.env, fetchImpl = fetch, spawn = spawnSync } = {}) {
  devAccessOrigin(env);
  requireState(env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    repositoryMatches(env.GITHUB_REPOSITORY, env) && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''),
  'This operator requires the main-only workflow dispatch context');
  requireState(env.GATEWAY_PREREQUISITES_VERIFIED === 'true' &&
    ['', 'false'].includes(env.CMS_DEV_PUBLISH_ENABLED ?? ''),
  'Hold dev writers, drain old runs, verify runbook prerequisites, and keep dev publication disabled');
  const mode = env.GATEWAY_MODE;
  // Route transfers now require the bounded restore guard, including callers
  // dispatching an older workflow that still offers this input (#3100).
  requireState(mode !== 'transfer', 'Transfer is disabled; use guard-dev-routing-change.mjs');
  requireState(['stage', 'update'].includes(mode), 'Select stage or update');
  const initialOwner = mode === 'update' ? WORKER : OLD_WORKER;
  const deploymentLabel = mode === 'update' ? 'update' : 'staging';
  const audience = env.DEV_ACCESS_AUDIENCE;
  requireState(/^[a-f0-9]{32}$/.test(ACCOUNT) && /^[a-f0-9]{64}$/.test(audience ?? '') && env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT &&
    env.CLOUDFLARE_API_TOKEN, 'Missing verified dev audience or scoped Cloudflare configuration');
  // Only deployment parses JSONC. Read-only guard imports need no npm packages.
  const { default: ts } = await import('typescript');
  const parsed = ts.parseConfigFileTextToJson(CONFIG, readFileSync(CONFIG, 'utf8'));
  const config = parsed.config;
  const keys = ['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags',
    'workers_dev', 'preview_urls', 'routes', 'vars', 'services', 'observability'];
  requireState(!parsed.error && config && Object.keys(config).every(key => keys.includes(key)) &&
    config.name === WORKER && config.main === 'src/staff-site-dev-worker.ts' &&
    config.workers_dev === false && config.preview_urls === false &&
    JSON.stringify(config.routes) === JSON.stringify([{ pattern: PATTERN, zone_name: 'njpbs.org' }]) &&
    JSON.stringify(config.vars) === JSON.stringify({ DEV_ACCESS_AUDIENCE: '', CMS_DEV_ACCESS_ORIGIN: '' }) &&
    JSON.stringify(config.services) === JSON.stringify([
      { binding: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { binding: 'DEV_PUBLIC', service: PUBLIC_WORKER },
    ]), 'Unexpected dev gateway config; review before deploying');
  const parsedShadow = ts.parseConfigFileTextToJson(SHADOW_CONFIG, readFileSync(SHADOW_CONFIG, 'utf8'));
  const shadowConfig = parsedShadow.config;
  requireState(!parsedShadow.error && shadowConfig?.name === 'njpbs-shadow-posts' &&
    JSON.stringify(shadowConfig.routes) === JSON.stringify([
      { pattern: 'https://dev-public.example.org/posts/*', zone_name: 'njpbs.org' },
    ]), 'Unexpected shadow route config; review before deploying');

  async function api(path, method = 'GET', data) {
    let response, body;
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        ...(data ? { body: JSON.stringify(data) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      body = await response.json();
    } catch { throw new Error('Cloudflare request failed; reconcile before retrying'); }
    requireState(response.ok && body.success === true, 'Cloudflare request refused; reconcile before retrying');
    return body.result;
  }
  const zones = await api(`/zones?name=njpbs.org&account.id=${ACCOUNT}`);
  requireState(Array.isArray(zones) && zones.length === 1 && ID.test(zones[0].id) &&
    zones[0].name === 'njpbs.org' && zones[0].account?.id === ACCOUNT, 'Expected the configured account and zone');
  const routePath = `/zones/${zones[0].id}/workers/routes`;
  const initialRoutes = await api(routePath);
  const initialRoute = devRoute(initialRoutes, initialOwner, shadowConfig);
  if (mode === 'update') requireState(!initialRoutes.some(r => r.pattern === shadowConfig.routes[0].pattern),
    'Remove the shadow route before updating the dev origin transport');
  const initialSnapshot = routeSnapshot(initialRoutes);
  const workerPath = `/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
  const apiSettings = await api(`/accounts/${ACCOUNT}/workers/scripts/template-dev-cms-api/settings`);
  for (const [name, value] of Object.entries({
    CMS_DEPLOYMENT_ENVIRONMENT: 'development', FIREBASE_PROJECT_ID: 'njpbs-site-dev',
    FUNCTIONS_ORIGIN: 'https://us-central1-njpbs-site-dev.cloudfunctions.net',
    ADMIN_ORIGIN: 'https://dev-admin.example.org',
  })) {
    const matches = apiSettings.bindings?.filter(b => b.name === name);
    requireState(matches?.length === 1 && matches[0].type === 'plain_text' && matches[0].text === value,
      'Dev CMS API deployment tuple mismatch');
  }
  const publicPath = `/accounts/${ACCOUNT}/workers/scripts/${PUBLIC_WORKER}`;
  async function verifyPrivatePublicWorker(routes) {
    const settings = await api(`${publicPath}/settings`);
    assertDevPublicWorkerBindings(settings.bindings);
    await verifyDevPublicWorkerPrivate(api, routes);
  }
  await verifyPrivatePublicWorker(initialRoutes);
  await verifySignedOut(fetchImpl);
  let versionId;
  if (mode === 'stage' || mode === 'update') {
    // Permit the known old transport only before the migration deployment.
    if (mode === 'update') verifyBindings((await api(`${workerPath}/settings`)).bindings, audience, true);
    // Pinned Wrangler skips route publication for routes: []. Existing routes
    // still target this script; avoid its bulk route replacement on updates.
    const stagingRoutes = await api(routePath);
    requireState(routeSnapshot(stagingRoutes) === initialSnapshot,
      'Routes changed before staging; stop and reconcile');
    devRoute(stagingRoutes, initialOwner, shadowConfig);
    const temp = `workers/wrangler.staff-sites.dev.staging-${process.pid}.json`;
    writeFileSync(temp, JSON.stringify({ ...config, routes: [], vars: { ...config.vars, CMS_DEV_ACCESS_ORIGIN: devAccessOrigin(env) } }), { flag: 'wx', mode: 0o600 });
    try {
      const result = spawn('node_modules/.bin/wrangler', [
        'deploy', '--config', temp, '--var', `DEV_ACCESS_AUDIENCE:${audience}`,
        '--message', `dev-staff-gateway:${env.GITHUB_SHA}`,
      ], { encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: env.PATH, HOME: env.HOME, CI: 'true',
          CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' } });
      // Wrangler output may contain bindings; only emit the validated version ID.
      versionId = /Current Version ID:\s*([a-f0-9-]{36})(?:\s|$)/.exec(result.stdout)?.[1];
      if (result.status !== 0) {
        let evidence = UUID.test(versionId ?? '') ? `Wrangler reported version: ${versionId}. ` : '';
        // A later trigger failure can follow a successful upload/deployment.
        // Read only identifiers; neither raw CLI errors nor API payloads are safe logs.
        try {
          const latest = (await api(`${workerPath}/deployments`)).deployments?.[0];
          const active = latest?.versions?.map(v => v.version_id);
          if (UUID.test(latest?.id ?? '') && active?.length && active.every(id => UUID.test(id))) {
            evidence += `Unverified deployment: ${latest.id}; versions: ${active.join(', ')}. `;
          }
        } catch { /* Preserve the original failure when read-only reconciliation is unavailable. */ }
        const failure = `Dev gateway ${deploymentLabel} failed. ${evidence}Inspect deployment state before retrying; no transfer attempted.`;
        if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${failure}\n`);
        throw new Error(failure);
      }
      requireState(UUID.test(versionId ?? ''), 'No deployed version ID; reconcile before proceeding');
      const staged = `Unverified ${mode === 'update' ? 'updated' : 'staged'} version: ${versionId}; source: ${env.GITHUB_SHA}. Deployment and route checks still pending.\n`;
      console.log(staged);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, staged);
    } finally { rmSync(temp, { force: true }); }
  }
  async function verifyVersion() {
    const deployments = await api(`${workerPath}/deployments`);
    const versions = deployments.deployments?.[0]?.versions;
    requireState(versions?.length === 1 && versions[0].version_id === versionId && versions[0].percentage === 100,
      'Expected the staged version at 100 percent traffic');
    const version = await api(`${workerPath}/versions/${versionId}`);
    requireState(version.id === versionId &&
      version.annotations?.['workers/message'] === `dev-staff-gateway:${env.GITHUB_SHA}`,
    'Staged gateway version does not match this reviewed source');
    verifyBindings(version.resources?.bindings, audience);
    verifyBindings((await api(`${workerPath}/settings`)).bindings, audience);
    const subdomain = await api(`${workerPath}/subdomain`);
    requireState(subdomain.enabled === false && subdomain.previews_enabled === false,
      'workers.dev and version preview URLs must remain disabled');
  }
  await verifyVersion();
  const before = await api(routePath);
  requireState(routeSnapshot(before) === initialSnapshot, 'Routes changed during verification; stop and reconcile');
  const route = devRoute(before, initialOwner, shadowConfig);
  requireState(route.id === initialRoute.id, 'Dev route identity changed');
  const after = await api(routePath);
  devRoute(after, mode === 'stage' ? OLD_WORKER : WORKER, shadowConfig);
  requireState(routeSnapshot(after) === routeSnapshot(before), 'Route readback mismatch; preserve the gate and reconcile');
  await verifyVersion();
  await verifyPrivatePublicWorker(after);
  await verifySignedOut(fetchImpl);
  const receipt = `Dev gateway ${mode} verified\nSource: ${env.GITHUB_SHA}\nVersion: ${versionId}\n` +
    `Route ID: ${route.id}\nOwner: ${mode === 'stage' ? OLD_WORKER : WORKER}\n` +
    (after.some(r => r.pattern === shadowConfig.routes[0].pattern) ?
      `Coexisting route unchanged: ${shadowConfig.routes[0].pattern} -> ${shadowConfig.name}; shadow admission and origin verification remain separate.\n` : '') +
    `Audience and exact dev-only service bindings verified; dev public Worker private. Retired origin secrets, if retained, require coordinator cleanup.\n` +
    `Signed-out refusal verified; authenticated staff and publisher proof remains separate.\n` +
    `Verified at: ${new Date().toISOString()}\n`;
  console.log(receipt);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, receipt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
