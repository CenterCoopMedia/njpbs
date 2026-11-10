import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { installPrivateWorker } from '../../scripts/lib/public-release-private-provider.mjs';
import { compilePrivateWorker } from '../../scripts/install-private-public-release.mjs';
import { privateInstallLedger } from '../../scripts/lib/public-release-private-install-ledger.mjs';
import { readOnlyBootstrapFirestore } from '../../scripts/lib/public-release-bootstrap-preflight.mjs';
import { readRehearsalPrivateWorker } from '../../scripts/lib/rehearsal-private-worker-readback.mjs';
import { createRehearsalOperatorAccess } from '../../scripts/lib/rehearsal-operator-access.mjs';
import protocol from '../../functions/lib/public-release-pair.js';

const firestore = isolatedFirestore('rehearsal-operator-access');
const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32), domainId = 'c'.repeat(32);
const versionId = '11111111-1111-4111-8111-111111111111', deploymentId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333', policyId = '44444444-4444-4444-8444-444444444444';
const serviceTokenId = '55555555-5555-4555-8555-555555555555';
const workerName = 'njpbs-private-operator-development', hostname = 'dev-pair-operator-rehearsal.njpbs.org';
const origin = `https://${hostname}`, audience = 'd'.repeat(64), clientId = 'operator123.access';
const attemptId = 'original-operator-rehearsal', attemptPlanDigest = protocol.publicReleaseDigest({ kind: 'local-operator-boundary' });
const config = { name: workerName, main: 'workers/src/private-pair-operator-worker.ts', account_id: accountId,
  compatibility_date: '2026-07-09', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false, routes: [],
  vars: { PAIR_PRIVATE_HTTP_ENABLED: 'true', PAIR_PRIVATE_ORIGIN: origin, PAIR_ACCESS_AUDIENCE: audience,
    PAIR_ACCESS_CLIENT_ID: clientId, PAIR_PROOF_ORIGIN: 'https://dev-public.example.org',
    PAIR_READER_ACCESS_JSON: JSON.stringify([{ audience: 'e'.repeat(64), clientId: 'readerA.access' }, { audience: 'f'.repeat(64), clientId: 'readerB.access' }]) },
  r2_buckets: [], services: [{ binding: 'PAIR_INGRESS_PROOF', service: 'njpbs-private-ingress-development', entrypoint: 'PublicReleaseIngressProofEntrypoint' }] };
let source: Uint8Array, provider: any, worker: any, version: any, deployed: any, domainAttached: boolean;
let domains: any[], routes: any[], app: any, policies: any[], token: any, access: any, fetchImpl: any;
beforeAll(async () => { source = await compilePrivateWorker('workers/src/private-pair-operator-worker.ts'); });
beforeEach(async () => {
  await firestore.recursiveDelete(firestore.collection('system'));
  worker = version = deployed = undefined; domainAttached = false;
  provider = {
    worker: vi.fn(async () => worker ?? null),
    create: vi.fn(async (name, tag) => { worker = { id: 'f'.repeat(32), name, tags: [`private-pair:${tag}`], subdomain: { enabled: false, previews_enabled: false } }; }),
    versions: vi.fn(async () => version ? [version] : []),
    upload: vi.fn(async (_name, metadata) => { version = { id: versionId, annotations: metadata.annotations,
      resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } }; return versionId; }),
    version: vi.fn(async () => version), deployment: vi.fn(async () => deployed ?? null),
    deploy: vi.fn(async (_name, id, tag) => { deployed = { id: deploymentId, versions: [{ version_id: id, percentage: 100 }], annotations: { 'workers/message': `private-pair:${tag}` } }; }),
    subdomain: vi.fn(async () => ({ enabled: false, previews_enabled: false })), disableSubdomain: vi.fn(async () => {}),
    assertNoPublicRoutes: vi.fn(async () => { if (domainAttached) throw new Error('A custom domain exists'); }),
    sourceDigest: vi.fn(async () => createHash('sha256').update(source).digest('hex')),
    preflight: vi.fn(async () => { throw new Error('Never warm the runtime'); }), wake: vi.fn(async () => { throw new Error('Never start the runtime'); }),
  };
  const ledger = privateInstallLedger(firestore);
  await ledger.bindAttempt(attemptId, attemptPlanDigest);
  await installPrivateWorker({ ledger, provider, attemptId, config, source, dryRun: false });
  // External provider boundary only: attach the approved hostname and policy
  // after the original native install. No SDK receipt is fabricated or edited.
  domainAttached = true;
  domains = [{ id: domainId, hostname, service: workerName, zone_id: zoneId, environment: 'production', enabled: true, previews_enabled: false }];
  routes = [];
  app = { id: applicationId, type: 'self_hosted', domain: hostname, aud: audience, self_hosted_domains: [hostname] };
  policies = [{ id: policyId, decision: 'non_identity', include: [{ service_token: { token_id: serviceTokenId } }], exclude: [], require: [], precedence: 1 }];
  token = { id: serviceTokenId, client_id: clientId, enabled: true, expires_at: '2099-01-01T00:00:00.000Z', duration: '8760h' };
  const replies = new Map([
    [`/accounts/${accountId}/workers/domains`, () => domains],
    [`/zones?account.id=${accountId}&page=1&per_page=50`, () => [{ id: zoneId }]],
    [`/zones/${zoneId}/workers/routes`, () => routes],
    [`/accounts/${accountId}/access/apps/${applicationId}`, () => app],
    [`/accounts/${accountId}/access/apps/${applicationId}/policies?page=1&per_page=100`, () => policies],
    [`/accounts/${accountId}/access/service_tokens/${serviceTokenId}`, () => token],
  ]);
  fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
    expect(options.method).toBe('GET'); expect(options.redirect).toBe('error');
    expect(url.startsWith('https://api.cloudflare.com/client/v4/')).toBe(true);
    const value = replies.get(url.slice('https://api.cloudflare.com/client/v4'.length));
    if (!value) throw new Error('Unexpected provider endpoint');
    const result = value();
    return Response.json({ success: true, result, ...Array.isArray(result) ? { result_info: { page: 1, total_pages: 1, total_count: result.length } } : {} });
  });
  access = createRehearsalOperatorAccess({ target: { accountId, workerName, versionId, origin, audience, clientId,
    domainId, zoneId, applicationId, policyId, serviceTokenId }, readToken: async () => 'fixture-provider-read-token', fetchImpl, authorized: true });
  for (const method of Object.values(provider) as any[]) method.mockClear();
});
const input = () => ({
  firestore: readOnlyBootstrapFirestore(firestore), provider, attemptId, attemptPlanDigest,
  versionId, config, source });
const read = (operatorAccess = access, selectedVersion = versionId) => readRehearsalPrivateWorker({
  ...input(), versionId: selectedVersion, operatorAccess });

it('verifies real compiled operator bytes and original SDK claims with the exact routed Access binding, without warming', async () => {
  await expect(readRehearsalPrivateWorker(input())).rejects.toThrow(); // The original zero-route rule still refuses it.
  const before = await firestore.doc(`system/publicReleasePrivateInstalls/plans/${attemptId}`).get();
  const result = await read(); expect(result.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  expect((await before.ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(12); // Two fresh six-GET privacy observations.
  for (const name of ['create', 'upload', 'deploy', 'disableSubdomain', 'preflight', 'wake']) expect(provider[name]).not.toHaveBeenCalled();
  expect((await firestore.doc('system/publicDeployment').get()).exists).toBe(false);
});
it.each(['domain', 'extra-domain', 'route', 'audience', 'bypass', 'broad-policy', 'token', 'disabled', 'expired'])(
  'refuses provider %s drift while preserving original SDK evidence', async fault => {
    if (fault === 'domain') domains[0].hostname = 'wrong.njpbs.org';
    if (fault === 'extra-domain') domains.push({ ...domains[0], id: 'e'.repeat(32), hostname: 'public.njpbs.org' });
    if (fault === 'route') routes.push({ id: 'e'.repeat(32), pattern: 'public.njpbs.org/*', script: workerName });
    if (fault === 'audience') app.aud = '0'.repeat(64);
    if (fault === 'bypass') policies[0].decision = 'bypass';
    if (fault === 'broad-policy') policies.push({ ...policies[0], id: '66666666-6666-4666-8666-666666666666' });
    if (fault === 'token') token.client_id = 'different.access';
    if (fault === 'disabled') token.enabled = false;
    if (fault === 'expired') token.expires_at = '2000-01-01T00:00:00.000Z';
    const before = await firestore.doc(`system/publicReleasePrivateInstalls/plans/${attemptId}`).get();
    await expect(read()).rejects.toThrow();
    expect((await before.ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
    expect(provider.upload).not.toHaveBeenCalled(); expect(provider.wake).not.toHaveBeenCalled();
  });
it('refuses serialized or cross-version privacy handles', async () => {
  await expect(read(JSON.parse(JSON.stringify(access)))).rejects.toThrow();
  await expect(read(access, '77777777-7777-4777-8777-777777777777')).rejects.toThrow();
});
