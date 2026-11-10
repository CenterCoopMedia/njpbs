import { repositoryMatches } from "./lib/repository-identity.mjs";
import { devAccessOrigin, deploymentOwner } from "./lib/deployment-settings.mjs";
import { devDeploySourceSha } from "./lib/dev-deploy-source.mjs";
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { Resolver } from 'node:dns/promises';

const ACCOUNT = (process.env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID ?? "");
const HOST = 'dev-preview.example.org';
const PRIVATE = 'template-dev-cms-preview';
const STAFF = 'template-dev-preview-staff-sites';
const ID = /^[a-f0-9]{32}$/;
// Accept only the supported 32- and 40-character lowercase hex domain IDs.
const DOMAIN_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{40})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ROOT = new URL('../', import.meta.url);

class DevPreviewGatewayReleaseError extends Error {
  constructor({ phase, status, codes = [] }) {
    const http = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'unknown';
    const numericCodes = codes.filter(code => Number.isSafeInteger(code) && code >= 0).join(',') || 'none';
    super(`Dev preview gateway release failed at ${phase} (${http}/${numericCodes}); raw details withheld`);
  }
}

export function formatDevPreviewGatewayFailure(error) {
  return error instanceof DevPreviewGatewayReleaseError ? error.message :
    new DevPreviewGatewayReleaseError({ phase: 'inputs' }).message;
}

async function publicHostnameHasRecords() {
  const resolver = new Resolver({ timeout: 5_000, tries: 1 });
  const answers = await Promise.all(['resolve4', 'resolve6', 'resolveCname'].map(async method => {
    try { return await resolver[method](HOST); }
    catch (error) {
      if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return [];
      throw new Error('Dev preview public DNS lookup refused');
    }
  }));
  return answers.some(records => records.length > 0);
}

function requireState(value) {
  if (!value) throw new Error('Dev preview gateway contract refused');
}

function matchesHost(pattern) {
  requireState(typeof pattern === 'string');
  const host = pattern.replace(/^https?:\/\//, '').split('/')[0];
  const matcher = new RegExp(`^${host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  return matcher.test(HOST);
}

function verifyBindings(bindings, worker, audience, allowPrevious = false) {
  requireState(Array.isArray(bindings) && new Set(bindings.map(b => b.name)).size === bindings.length);
  if (worker === PRIVATE) {
    requireState(bindings.length === 1 && bindings[0].type === 'r2_bucket' &&
      bindings[0].name === 'PREVIEWS' && bindings[0].bucket_name === 'template-dev-cms-previews');
  } else {
    const prior = allowPrevious && !bindings.some(b => b.name === "CMS_DEV_ACCESS_ORIGIN");
    requireState(bindings.length === (prior ? 3 : 4) &&
      bindings.some(b => b.type === 'plain_text' && b.name === 'DEV_ACCESS_AUDIENCE' && b.text === audience) &&
      (prior || bindings.some(b => b.type === 'plain_text' && b.name === 'CMS_DEV_ACCESS_ORIGIN' && b.text === devAccessOrigin())) &&
      bindings.some(b => b.type === 'service' && b.name === 'DEV_STAFF_ACCESS' &&
        b.service === 'template-dev-cms-api' && b.entrypoint === 'StaffSiteEntrypoint' &&
        (!b.environment || b.environment === 'production')) &&
      bindings.some(b => b.type === 'service' && b.name === 'DEV_PREVIEW' && b.service === PRIVATE &&
        !b.entrypoint && (!b.environment || b.environment === 'production')));
  }
}

function verifyDomain(domain, zoneId) {
  // The current provider schema explicitly includes these two safety fields:
  // https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/
  requireState(DOMAIN_ID.test(domain?.id ?? '') && domain.hostname === HOST && domain.service === STAFF &&
    domain.zone_id === zoneId && domain.zone_name === 'njpbs.org' && domain.environment === 'production' &&
    domain.enabled === true && domain.previews_enabled === false);
}

// #2957: custom-domain DNS/TLS provisioning is asynchronous. Retry only
// transport/provisioning failures for five minutes; content or foreign login
// redirects are never accepted. Network and clock are the test boundaries.
export async function verifyDevPreviewAccessReady(fetchImpl = fetch, { now = Date.now, wait = sleep } = {}) {
  const deadline = now() + 300_000;
  while (true) {
    let ready = true;
    for (const pathname of ['/', '/__cms-session', '/previews/denied/index.html']) {
      let response;
      try {
        response = await fetchImpl(`https://${HOST}${pathname}`, {
          redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30_000),
        });
      } catch { ready = false; break; }
      await response.body?.cancel();
      if ([404, 421, 502, 503, 504, 525, 526, 530].includes(response.status)) { ready = false; break; }
      let location;
      try { location = new URL(response.headers.get('location') ?? 'https://invalid.example'); }
      catch { throw new Error('Dev preview Access refusal differs'); }
      requireState(response.status === 302 && location.origin === devAccessOrigin() &&
        location.pathname === `/cdn-cgi/access/login/${HOST}` && !location.username && !location.password &&
        ![...response.headers.keys()].some(name => name.startsWith('x-njpbs-')));
    }
    if (ready) return;
    requireState(now() < deadline);
    await wait(Math.min(10_000, deadline - now()));
  }
}

// Only this new custom hostname can be attached. Existing routes and DNS owners
// are read before staging and again immediately before attachment; none is moved.
export async function deployDevPreviewGateways(options = {}) {
  // Keep diagnostics local to this release; never retain raw error details.
  const diagnostic = { phase: 'inputs', status: undefined, codes: [] };
  try { return await releaseDevPreviewGateways(options, diagnostic); }
  catch { throw new DevPreviewGatewayReleaseError(diagnostic); }
}

async function releaseDevPreviewGateways({ env = process.env, fetchImpl = fetch,
  spawn = spawnSync, log = console.log, hasPublicOrigin = publicHostnameHasRecords } = {}, diagnostic) {
  function setPhase(phase) {
    diagnostic.phase = phase;
    diagnostic.status = undefined;
    diagnostic.codes = [];
  }
  devAccessOrigin(env);
  const owner = deploymentOwner(env);
  const sourceSha = devDeploySourceSha(env);
  const releasing = env.CMS_DEV_RELEASE_PREVIEW_RENDERER === 'true';
  requireState(env.GITHUB_REF === 'refs/heads/main' && repositoryMatches(env.GITHUB_REPOSITORY, env) &&
    env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/.github/workflows/cms-dev-deploy.yml@refs/heads/main` &&
    env.GITHUB_ACTOR === owner && env.GITHUB_TRIGGERING_ACTOR === owner &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') &&
    ['true', 'false'].includes(env.CMS_DEV_RELEASE_PREVIEW_RENDERER) &&
    (!releasing || env.CMS_DEV_PUBLISH_ENABLED === 'false') && ID.test(ACCOUNT) && env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT &&
    /^[a-f0-9]{64}$/.test(env.DEV_PREVIEW_ACCESS_AUDIENCE ?? '') && env.CLOUDFLARE_API_TOKEN);
  const audience = env.DEV_PREVIEW_ACCESS_AUDIENCE;
  async function api(suffix, method = 'GET', body, missing = false) {
    diagnostic.status = undefined;
    diagnostic.codes = [];
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4${suffix}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      diagnostic.status = response.status;
      if (missing && response.status === 404) { await response.body?.cancel(); return null; }
      const data = await response.json();
      diagnostic.codes = Array.isArray(data?.errors) ? data.errors.map(error => error?.code)
        .filter(code => Number.isSafeInteger(code) && code >= 0) : [];
      requireState(response.ok && data.success === true &&
        (!data.result_info || !data.result_info.total_pages || data.result_info.total_pages <= 1));
      return data.result;
    } catch { throw new Error('Dev preview provider request refused; raw details withheld'); }
  }
  const base = `/accounts/${ACCOUNT}/workers`;
  setPhase('zone');
  const zones = await api(`/zones?name=njpbs.org&account.id=${ACCOUNT}`);
  requireState(Array.isArray(zones) && zones.length === 1 && zones[0].name === 'njpbs.org' &&
    zones[0].account?.id === ACCOUNT && ID.test(zones[0].id));
  const zone = zones[0].id;
  async function inventory(phase = 'inventory') {
    setPhase(`${phase}-routes`);
    const routes = await api(`/zones/${zone}/workers/routes`);
    setPhase(`${phase}-domains`);
    const domains = await api(`${base}/domains?per_page=100`);
    setPhase(`${phase}-owner-check`);
    requireState(Array.isArray(routes) && Array.isArray(domains) && domains.length < 100 &&
      !routes.some(route => matchesHost(route.pattern) || [PRIVATE, STAFF].includes(route.script)) &&
      !domains.some(domain => domain.service === PRIVATE || (domain.service === STAFF && domain.hostname !== HOST)));
    const owned = domains.filter(domain => domain.hostname === HOST);
    requireState(owned.length <= 1);
    if (owned.length) verifyDomain(owned[0], zone);
    return { routes, domains, owned: owned[0] ?? null };
  }
  const initial = await inventory();
  setPhase('owner-check');
  // Routine deploys can refresh an already-owned gateway, never create a host.
  requireState(releasing || initial.owned);
  // DNS API readback is unavailable with the approved deployment credential.
  // For a new host, refuse any publicly resolving origin and let the
  // provider reject a hidden existing owner; never request a forced overwrite.
  if (!initial.owned) {
    setPhase('public-origin');
    requireState(!await hasPublicOrigin());
  }
  for (const worker of [PRIVATE, STAFF]) {
    setPhase(`worker-settings:${worker}`);
    const settings = await api(`${base}/scripts/${worker}/settings`, 'GET', undefined, true);
    if (settings) {
      verifyBindings(settings.bindings, worker, audience, true);
      setPhase(`worker-subdomain:${worker}`);
      const subdomain = await api(`${base}/scripts/${worker}/subdomain`);
      requireState(subdomain.enabled === false && subdomain.previews_enabled === false);
    } else requireState(worker !== STAFF || !initial.owned);
  }
  // The shared dev API must already expose the dev project and staff RPC.
  setPhase('api-settings');
  const apiSettings = await api(`${base}/scripts/template-dev-cms-api/settings`);
  for (const [name, text] of Object.entries({ CMS_DEPLOYMENT_ENVIRONMENT: 'development',
    FIREBASE_PROJECT_ID: 'njpbs-site-dev', ADMIN_ORIGIN: 'https://dev-admin.example.org',
    FUNCTIONS_ORIGIN: 'https://us-central1-njpbs-site-dev.cloudfunctions.net' })) {
    requireState(apiSettings.bindings?.filter(b => b.name === name && b.type === 'plain_text' && b.text === text).length === 1);
  }
  setPhase('config');
  const { default: ts } = await import('typescript');
  const readConfig = file => {
    const parsed = ts.parseConfigFileTextToJson(file, readFileSync(new URL(file, ROOT), 'utf8'));
    requireState(!parsed.error && parsed.config);
    return parsed.config;
  };
  const privateConfig = readConfig('workers/wrangler.preview.dev.jsonc');
  const staffConfig = readConfig('workers/wrangler.staff-preview.dev.jsonc');
  const commonKeys = ['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags',
    'workers_dev', 'preview_urls', 'observability'];
  requireState(Object.keys(privateConfig).every(key => [...commonKeys, 'r2_buckets'].includes(key)) &&
    Object.keys(staffConfig).every(key => [...commonKeys, 'routes', 'vars', 'services'].includes(key)) &&
    privateConfig.name === PRIVATE && privateConfig.main === './src/preview-worker.ts' &&
    privateConfig.workers_dev === false && privateConfig.preview_urls === false && !privateConfig.routes && !privateConfig.route &&
    isDeepStrictEqual(privateConfig.r2_buckets, [{ binding: 'PREVIEWS', bucket_name: 'template-dev-cms-previews' }]) &&
    staffConfig.name === STAFF && staffConfig.main === 'src/dev-preview-staff-worker.ts' &&
    staffConfig.workers_dev === false && staffConfig.preview_urls === false &&
    isDeepStrictEqual(staffConfig.routes, [{ pattern: HOST, custom_domain: true }]) &&
    isDeepStrictEqual(staffConfig.vars, { DEV_ACCESS_AUDIENCE: '', CMS_DEV_ACCESS_ORIGIN: '' }) &&
    isDeepStrictEqual(staffConfig.services, [
      { binding: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { binding: 'DEV_PREVIEW', service: PRIVATE },
    ]));
  async function collect(worker, phase = 'collect') {
    setPhase(`${phase}:${worker}`);
    const deployments = await api(`${base}/scripts/${worker}/deployments`);
    const active = deployments.deployments?.[0];
    requireState(UUID.test(active?.id ?? '') && active.versions?.length === 1 &&
      active.versions[0].percentage === 100 && UUID.test(active.versions[0].version_id));
    const version = await api(`${base}/scripts/${worker}/versions/${active.versions[0].version_id}`);
    requireState(version.id === active.versions[0].version_id && version.annotations?.['workers/tag'] === sourceSha);
    verifyBindings(version.resources?.bindings, worker, audience);
    const subdomain = await api(`${base}/scripts/${worker}/subdomain`);
    requireState(subdomain.enabled === false && subdomain.previews_enabled === false);
    return { worker, deploymentId: active.id, versionId: version.id, sourceSha };
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'njpbs-dev-preview-gateways-'));
  try {
    const identities = [];
    for (const config of [privateConfig, staffConfig]) {
      setPhase(`config:${config.name}`);
      const filename = path.join(directory, `${config.name}.json`);
      // Stage without any route publication; the one reviewed custom-domain
      // write below creates only this hostname's managed DNS record.
      // Omit routes entirely: Wrangler must preserve a custom domain managed
      // separately. An explicit [] reconciles that existing domain away.
      writeFileSync(filename, JSON.stringify({ ...config, main: new URL(config.main, new URL('workers/', ROOT)).pathname,
        routes: undefined, ...(config.name === STAFF ? { vars: { DEV_ACCESS_AUDIENCE: audience, CMS_DEV_ACCESS_ORIGIN: devAccessOrigin(env) } } : {}) }),
      { flag: 'wx', mode: 0o600 });
      setPhase(`wrangler-deploy:${config.name}`);
      const result = spawn(new URL('node_modules/.bin/wrangler', ROOT).pathname,
        ['deploy', '--config', filename, '--tag', sourceSha], {
          stdio: 'ignore', timeout: 300_000,
          env: { PATH: env.PATH, HOME: env.HOME, CI: 'true', CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
            CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' },
        });
      requireState(result.status === 0);
      identities.push(await collect(config.name));
    }
    const staged = await inventory('staged-inventory');
    requireState(isDeepStrictEqual(staged, initial));
    if (!initial.owned) {
      setPhase('public-origin');
      requireState(!await hasPublicOrigin());
      setPhase('attach-domain');
      const attached = await api(`${base}/domains`, 'PUT', { hostname: HOST, service: STAFF,
        zone_id: zone, zone_name: 'njpbs.org', environment: 'production', enabled: true, previews_enabled: false });
      verifyDomain(attached, zone);
    }
    const after = await inventory('attached-inventory');
    requireState(after.owned && isDeepStrictEqual(after.routes, initial.routes) &&
      isDeepStrictEqual(after.domains.filter(d => d.hostname !== HOST), initial.domains.filter(d => d.hostname !== HOST)));
    // Require the outer Access refusal after bounded TLS/DNS provisioning.
    // No OTP, login URL, headers or body is logged.
    setPhase('access-ready');
    await verifyDevPreviewAccessReady(fetchImpl);
    const final = await inventory('final-inventory');
    requireState(final.owned?.id === after.owned.id && isDeepStrictEqual(final.routes, initial.routes) &&
      isDeepStrictEqual(final.domains.filter(d => d.hostname !== HOST), initial.domains.filter(d => d.hostname !== HOST)));
    for (const identity of identities) requireState(isDeepStrictEqual(await collect(identity.worker, 'final-identity'), identity));
    const receipt = { schemaVersion: 1, environment: 'development', host: HOST,
      sourceSha, trustedWorkflowSha: env.GITHUB_SHA, gateways: identities, customDomainId: final.owned.id,
      signedOutRefusalVerified: true, unrelatedRoutesAndDomainsUnchanged: true, verifiedAt: new Date().toISOString() };
    log('Dev exact-preview gateways verified; signed-out reads refused');
    return receipt;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let phase = 'inputs';
  try {
    const [receiptPath] = process.argv.slice(2);
    requireState(process.argv.length === 3 && path.isAbsolute(receiptPath ?? ''));
    const receipt = await deployDevPreviewGateways();
    phase = 'receipt';
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    console.error(error instanceof DevPreviewGatewayReleaseError ? formatDevPreviewGatewayFailure(error) :
      new DevPreviewGatewayReleaseError({ phase }).message);
    process.exitCode = 1;
  }
}
