import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployDevPreviewGateways, formatDevPreviewGatewayFailure, verifyDevPreviewAccessReady } from '../scripts/deploy-dev-preview-gateways.mjs';

// Synthetic targets exercise independent preview gateways. Network envelopes
// follow Cloudflare's Worker versions/domain API.
// https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/
const host = 'dev-preview.example.org';
const account = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const zone = '1'.repeat(32);
const sha = 'a'.repeat(40);
const audience = 'b'.repeat(64);
const privateWorker = 'template-dev-cms-preview';
const staffWorker = 'template-dev-preview-staff-sites';
const deployment = '11111111-1111-4111-8111-111111111111';
const version = '22222222-2222-4222-8222-222222222222';
const environment = () => ({ CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012", GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'CenterCoopMedia/njpbs', GITHUB_REPOSITORY_ID: '1442374012',
  GITHUB_WORKFLOW_REF: 'CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main',
  DEPLOY_SHA: sha, GITHUB_WORKFLOW_SHA: sha, GITHUB_SHA: sha, GITHUB_ACTOR: 'fixture-owner', GITHUB_TRIGGERING_ACTOR: 'fixture-owner', RUNNER_ENVIRONMENT: 'github-hosted',
  CMS_DEV_PUBLISH_ENABLED: 'false', CMS_DEV_ACCESS_ORIGIN: 'https://fixture.cloudflareaccess.com', CLOUDFLARE_ACCOUNT_ID: account, DEV_PREVIEW_ACCESS_AUDIENCE: audience,
  CMS_DEV_RELEASE_PREVIEW_RENDERER: 'true', CMS_DEPLOY_OWNER: 'fixture-owner',
  CLOUDFLARE_API_TOKEN: 'fixture-token', PATH: process.env.PATH, HOME: process.env.HOME });

function provider(drift = '') {
  let staged = 0;
  const writes: Array<{ pathname: string; body: unknown }> = [];
  const workers = new Map<string, Record<string, unknown>>();
  const domains: Array<Record<string, unknown>> = [];
  const dns: Array<Record<string, unknown>> = [];
  const routes: Array<Record<string, unknown>> = [];
  const unrelatedDomain = { id: 'c'.repeat(32), hostname: 'example.test', service: 'unrelated-fixture', environment: 'production' };
  domains.push(unrelatedDomain);
  if (drift === 'owned-routine') {
    domains.push({ id: 'f'.repeat(40), hostname: host, service: staffWorker, zone_id: zone, zone_name: 'njpbs.org',
      environment: 'production', enabled: true, previews_enabled: false });
    dns.push({ id: 'd'.repeat(32), name: host, type: 'AAAA', content: '100::', proxied: true });
    workers.set(privateWorker, {});
    workers.set(staffWorker, {});
  }
  if (drift === 'existing-dns') dns.push({ id: 'd'.repeat(32), name: host, type: 'CNAME', content: 'example.test', proxied: true });
  if (drift === 'wildcard-route') routes.push({ id: 'e'.repeat(32), pattern: `https://*.${host.split('.').slice(1).join('.')}/*`, script: 'unrelated-fixture' });
  if (drift === 'existing-domain') domains.push({ id: 'f'.repeat(32), hostname: host, service: 'unrelated-fixture' });
  const apiBindings = Object.entries({ CMS_DEPLOYMENT_ENVIRONMENT: 'development', FIREBASE_PROJECT_ID: 'njpbs-site-dev',
    ADMIN_ORIGIN: 'https://dev-admin.example.org', FUNCTIONS_ORIGIN: 'https://us-central1-njpbs-site-dev.cloudfunctions.net' })
    .map(([name, text]) => ({ type: 'plain_text', name, text }));
  function bindings(worker: string) {
    return worker === privateWorker ? [{ name: 'PREVIEWS', type: 'r2_bucket', bucket_name: 'template-dev-cms-previews' }] : [
      { name: 'DEV_ACCESS_AUDIENCE', type: 'plain_text', text: audience },
      { name: 'CMS_DEV_ACCESS_ORIGIN', type: 'plain_text', text: 'https://fixture.cloudflareaccess.com' },
      { name: 'DEV_STAFF_ACCESS', type: 'service', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { name: 'DEV_PREVIEW', type: 'service', service: privateWorker },
    ];
  }
  const fetchImpl = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (url.origin === `https://${host}`) {
      expect(init.credentials).toBe('omit');
      return drift === 'anonymous-content' ? new Response('<html>private content</html>') :
        new Response(null, { status: 302, headers: { location: `https://fixture.cloudflareaccess.com/cdn-cgi/access/login/${host}` } });
    }
    expect(url.origin).toBe('https://api.cloudflare.com');
    expect(init.redirect).toBe('error');
    const pathname = url.pathname.replace('/client/v4', '');
    let result: unknown;
    if (pathname === '/zones') result = [{ id: zone, name: 'njpbs.org', account: { id: account } }];
    else if (pathname === `/zones/${zone}/workers/routes`) {
      result = drift === 'route-race' && staged === 2 ? [...routes, { id: 'e'.repeat(32), pattern: 'example.test/*', script: 'other' }] : routes;
    } else if (pathname === `/zones/${zone}/dns_records`) result = dns;
    else if (pathname === `/accounts/${account}/workers/domains`) {
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        writes.push({ pathname, body });
        const attached = { ...body, id: 'f'.repeat(40) };
        domains.push(attached);
        dns.push({ id: 'd'.repeat(32), name: host, type: 'AAAA', content: '100::', proxied: true });
        result = attached;
      } else result = domains;
    } else if (pathname === `/accounts/${account}/workers/scripts/template-dev-cms-api/settings`) result = { bindings: apiBindings };
    else {
      const match = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/(.+)$/.exec(pathname);
      expect(match).not.toBeNull();
      const worker = match![1];
      expect([privateWorker, staffWorker]).toContain(worker);
      const suffix = match![2];
      if (suffix === 'settings') {
        if (!workers.has(worker)) return new Response(null, { status: 404 });
        result = { bindings: bindings(worker) };
      } else if (suffix === 'subdomain') result = { enabled: drift === 'public-subdomain', previews_enabled: false };
      else if (suffix === 'deployments') result = { deployments: [{ id: deployment, versions: [{ version_id: version, percentage: 100 }] }] };
      else if (suffix === `versions/${version}`) result = { id: version, metadata: { source: 'wrangler' },
        annotations: { 'workers/tag': drift === 'wrong-source' ? 'c'.repeat(40) : sha },
        resources: { bindings: bindings(worker) } };
      else throw new Error('Unexpected fixture endpoint');
    }
    return Response.json({ success: true, result });
  };
  const spawn = (_command: string, args: string[], options: { env: Record<string, string> }) => {
    const filename = args[args.indexOf('--config') + 1];
    const config = JSON.parse(readFileSync(filename, 'utf8'));
    expect(existsSync(config.main)).toBe(true);
    expect(config.routes).toBeUndefined();
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(options.env).not.toHaveProperty('CMS_DEV_ACCESS_CLIENT_SECRET');
    workers.set(config.name, config);
    staged++;
    return { status: 0 };
  };
  return { fetchImpl, spawn, writes, domains, dns, hasPublicOrigin: async () => dns.length > 0, staged: () => staged };
}

it('tags and verifies the selected gateway pin after trusted main advances', async () => {
  const boundary = provider();
  const env = { ...environment(), GITHUB_SHA: 'c'.repeat(40), GITHUB_WORKFLOW_SHA: 'c'.repeat(40) };
  const receipt = await deployDevPreviewGateways({ ...boundary, env, log: () => undefined });
  expect(receipt.sourceSha).toBe(sha);
  expect(receipt.trustedWorkflowSha).toBe(env.GITHUB_SHA);
  expect(receipt.gateways.every(gateway => gateway.sourceSha === sha)).toBe(true);
});

describe('safe dev gateway release failure diagnostics', () => {
  it.each([
    { endpoint: '/zones', phase: 'zone' },
    { endpoint: `/zones/${zone}/workers/routes`, phase: 'inventory-routes' },
    { endpoint: `/accounts/${account}/workers/domains`, phase: 'inventory-domains' },
    ...[privateWorker, staffWorker].flatMap(worker => [
      { endpoint: `/accounts/${account}/workers/scripts/${worker}/settings`, phase: `worker-settings:${worker}` },
      { endpoint: `/accounts/${account}/workers/scripts/${worker}/subdomain`, phase: `worker-subdomain:${worker}`, drift: 'owned-routine' },
      { endpoint: `/accounts/${account}/workers/scripts/${worker}/deployments`, phase: `collect:${worker}` },
      { endpoint: `/accounts/${account}/workers/scripts/${worker}/deployments`, phase: `final-identity:${worker}`, occurrence: 2 },
    ]),
    { endpoint: `/accounts/${account}/workers/scripts/template-dev-cms-api/settings`, phase: 'api-settings' },
    { endpoint: `/accounts/${account}/workers/domains`, phase: 'attach-domain', method: 'PUT' },
    { endpoint: `/zones/${zone}/workers/routes`, phase: 'staged-inventory-routes', occurrence: 2 },
    { endpoint: `/accounts/${account}/workers/domains`, phase: 'attached-inventory-domains', occurrence: 3 },
    { endpoint: `/zones/${zone}/workers/routes`, phase: 'final-inventory-routes', occurrence: 4 },
  ])('names $phase and emits only HTTP status and numeric provider codes', async ({ endpoint, phase, drift, method = 'GET', occurrence = 1 }) => {
    const boundary = provider(drift);
    const logs: string[] = [];
    let matches = 0;
    const error = await deployDevPreviewGateways({ ...boundary, env: environment(), log: line => logs.push(line),
      fetchImpl: async (input: string, init: RequestInit) => {
        if (new URL(input).pathname === `/client/v4${endpoint}` && init.method === method && ++matches === occurrence) {
          return Response.json({ success: false, errors: [
            { code: 10000, message: 'fixture-private-provider-message' },
            { code: 'fixture-token', message: 'fixture-header-value' },
            { code: 10001 }, { code: -1 }, { code: 1.5 }, { code: Number.MAX_SAFE_INTEGER + 1 }, null,
          ], result: { hostname: 'private.example.test', id: zone, token: 'fixture-token' } }, { status: 403 });
        }
        return boundary.fetchImpl(input, init);
      },
    }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(formatDevPreviewGatewayFailure(error)).toBe(
      `Dev preview gateway release failed at ${phase} (403/10000,10001); raw details withheld`);
    expect(logs).toEqual([]);
  });

  it.each([200, 502])('keeps HTTP %s without leaking malformed provider JSON', async status => {
    const error = await deployDevPreviewGateways({ env: environment(),
      fetchImpl: async () => new Response('fixture-private-provider-body', { status }),
    }).catch(error => error);
    expect(formatDevPreviewGatewayFailure(error)).toBe(
      `Dev preview gateway release failed at zone (${status}/none); raw details withheld`);
  });

  it('reports numeric provider codes on a failed HTTP 200 envelope', async () => {
    const error = await deployDevPreviewGateways({ env: environment(), fetchImpl: async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: 'fixture-private-provider-message' }] }),
    }).catch(error => error);
    expect(formatDevPreviewGatewayFailure(error)).toBe(
      'Dev preview gateway release failed at zone (200/10000); raw details withheld');
  });

  it('withholds network exception text and untrusted exception metadata', async () => {
    const error = await deployDevPreviewGateways({ env: environment(), fetchImpl: async () => {
      throw Object.assign(new TypeError('fixture-token private.example.test'), { status: 403, codes: [10000] });
    } }).catch(error => error);
    expect(formatDevPreviewGatewayFailure(error)).toBe(
      'Dev preview gateway release failed at zone (unknown/none); raw details withheld');
    expect(formatDevPreviewGatewayFailure(new Error('fixture-token'))).toBe(
      'Dev preview gateway release failed at inputs (unknown/none); raw details withheld');
  });

  it.each([false, true])('names a failed private Wrangler deployment without stale HTTP status (throw=%s)', async throws => {
    const boundary = provider();
    const error = await deployDevPreviewGateways({ ...boundary, env: environment(), spawn: () => {
      if (throws) throw new Error('fixture-token private.example.test');
      return { status: 1, stderr: 'fixture-private-provider-body' };
    } }).catch(error => error);
    expect(formatDevPreviewGatewayFailure(error)).toBe(
      `Dev preview gateway release failed at wrangler-deploy:${privateWorker} (unknown/none); raw details withheld`);
    expect(boundary.writes).toEqual([]);
  });

  it('names public-origin and Access checks without leaking DNS, redirect or body text', async () => {
    const dns = await deployDevPreviewGateways({ ...provider(), env: environment(), hasPublicOrigin: async () => {
      throw new Error('fixture-private-DNS-error');
    } }).catch(error => error);
    expect(formatDevPreviewGatewayFailure(dns)).toBe(
      'Dev preview gateway release failed at public-origin (unknown/none); raw details withheld');
    const access = await deployDevPreviewGateways({ ...provider('anonymous-content'), env: environment() }).catch(error => error);
    expect(formatDevPreviewGatewayFailure(access)).toBe(
      'Dev preview gateway release failed at access-ready (unknown/none); raw details withheld');
  });

  it('prints exactly one safe failure line from the CLI', () => {
    const preload = `globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 10000,
      message: 'fixture-private-provider-message' }], result: { token: 'fixture-token' } }, { status: 403 });`;
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      'scripts/deploy-dev-preview-gateways.mjs', path.join(tmpdir(), 'gwdiag-fixture-receipt.json')], {
      env: { ...environment(), CMS_DEV_CLOUDFLARE_ACCOUNT_ID: account }, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Dev preview gateway release failed at zone (403/10000); raw details withheld\n');
  });
});

describe('isolated dev exact-preview gateway release', () => {
  it('stages private Workers and attaches only the new reviewed hostname with safe identity readback', async () => {
    const boundary = provider();
    const receipt = await deployDevPreviewGateways({ ...boundary, env: environment(), log: () => undefined });
    expect(boundary.writes).toEqual([{ pathname: `/accounts/${account}/workers/domains`, body: {
      hostname: host, service: staffWorker, zone_id: zone, zone_name: 'njpbs.org', environment: 'production',
      enabled: true, previews_enabled: false,
    } }]);
    expect(receipt).toMatchObject({ environment: 'development', host, sourceSha: sha,
      signedOutRefusalVerified: true, unrelatedRoutesAndDomainsUnchanged: true });
    expect(receipt.gateways.map((entry: { worker: string }) => entry.worker)).toEqual([privateWorker, staffWorker]);
    expect(boundary.domains[0].hostname).toBe('example.test');
    expect(JSON.stringify(receipt)).not.toContain('fixture-token');
  });
  it.each(['existing-dns', 'wildcard-route', 'existing-domain'])('refuses %s before any deployment or hostname mutation', async drift => {
    const boundary = provider(drift);
    await expect(deployDevPreviewGateways({ ...boundary, env: environment(), log: () => undefined })).rejects.toThrow();
    expect(boundary.staged()).toBe(0);
    expect(boundary.writes).toEqual([]);
  });
  it.each(['route-race', 'public-subdomain', 'wrong-source'])('refuses staged provider drift %s before hostname attachment', async drift => {
    const boundary = provider(drift);
    await expect(deployDevPreviewGateways({ ...boundary, env: environment(), log: () => undefined })).rejects.toThrow();
    expect(boundary.writes).toEqual([]);
  });
  it('does not attest success when signed-out reads expose content', async () => {
    const boundary = provider('anonymous-content');
    await expect(deployDevPreviewGateways({ ...boundary, env: environment(), log: () => undefined })).rejects.toThrow();
  });
  it('refreshes only existing owned gateways during a routine deploy with publication active', async () => {
    const boundary = provider('owned-routine');
    const receipt = await deployDevPreviewGateways({ ...boundary,
      env: { ...environment(), CMS_DEV_RELEASE_PREVIEW_RENDERER: 'false', CMS_DEV_PUBLISH_ENABLED: 'true' }, log: () => undefined });
    expect(receipt.signedOutRefusalVerified).toBe(true);
    expect(boundary.writes).toEqual([]);
    expect(boundary.staged()).toBe(2);
  });
  it('refuses hostname creation on the default routine path', async () => {
    const boundary = provider();
    await expect(deployDevPreviewGateways({ ...boundary,
      env: { ...environment(), CMS_DEV_RELEASE_PREVIEW_RENDERER: 'false', CMS_DEV_PUBLISH_ENABLED: 'true' }, log: () => undefined })).rejects.toThrow();
    expect(boundary.staged()).toBe(0);
    expect(boundary.writes).toEqual([]);
  });
  it.each([{ CMS_DEV_PUBLISH_ENABLED: 'true' }, { GITHUB_REF: 'refs/heads/feature' },
    { CLOUDFLARE_ACCOUNT_ID: 'other-account' }, { RUNNER_ENVIRONMENT: 'self-hosted' }])('rejects an unapproved release tuple %j', async delta => {
    const boundary = provider();
    await expect(deployDevPreviewGateways({ ...boundary, env: { ...environment(), ...delta }, log: () => undefined })).rejects.toThrow();
    expect(boundary.staged()).toBe(0);
    expect(boundary.writes).toEqual([]);
  });
});

describe('bounded custom-domain provisioning readiness (#2957)', () => {
  it('waits through DNS/TLS and transient provider failures before requiring all Access refusals', async () => {
    let time = 0, calls = 0;
    const network = async () => {
      calls++;
      if (calls === 1) throw new TypeError('fixture DNS/TLS provisioning');
      if (calls === 2) return new Response(null, { status: 525 });
      return new Response(null, { status: 302, headers: { location: `https://fixture.cloudflareaccess.com/cdn-cgi/access/login/${host}` } });
    };
    await verifyDevPreviewAccessReady(network, { now: () => time, wait: async ms => { time += ms; } });
    expect(time).toBe(20_000);
    expect(calls).toBe(5);
  });
  it('expires after the documented five-minute window without a successful receipt', async () => {
    let time = 0;
    await expect(verifyDevPreviewAccessReady(async () => new Response(null, { status: 503 }), {
      now: () => time, wait: async ms => { time += ms; },
    })).rejects.toThrow();
    expect(time).toBe(300_000);
  });
  it.each([200, 301, 401, 403])('refuses unexpected status %s immediately', async status => {
    await expect(verifyDevPreviewAccessReady(async () => new Response(null, { status }), {
      wait: async () => { throw new Error('Unexpected retry'); },
    })).rejects.toThrow();
  });
});
