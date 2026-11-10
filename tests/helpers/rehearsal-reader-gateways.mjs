import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installPrivatePairAccess } from '../../scripts/lib/public-release-private-access-operator.mjs';
import { installPrivatePairBridge, privateBridgeConfiguration } from '../../scripts/lib/public-release-private-bridge-operator.mjs';
import { compilePrivateWorker } from '../../scripts/install-private-public-release.mjs';
import { privateInstallLedger } from '../../scripts/lib/public-release-private-install-ledger.mjs';
import { cloudflarePrivatePairProvider, installPrivateWorker } from '../../scripts/lib/public-release-private-provider.mjs';
import protocol from '../../functions/lib/public-release-pair.js';

export const gatewayFixtureAccount = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const gatewayFixtureOrigins = ['https://dev-pair-reader-census-old.njpbs.org', 'https://dev-pair-reader-census-new.njpbs.org'];
const uuid = index => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** Actual native Access/gateway installer and compiled gateway bytes. Only
 * the external Cloudflare HTTP boundary is synthetic; SDK identity stays the
 * genuine isolated demo project. This grants no deployed reader readiness.
 */
export async function rehearsalReaderGatewaysFixture(firestore, pairs) {
  const operatorCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const zoneId = '2'.repeat(32), apps = [], policies = new Map(), domains = [], workers = new Map();
  let writes = 0;
  const accessPacket = { schemaVersion: 1, kind: 'private-pair-access-operator', operatorCommitSha,
    environment: 'development', operationId: 'census-reader-access', accountId: gatewayFixtureAccount,
    credentialIdentity: { projectId: 'njpbs-site-dev', clientEmail: 'fixture-operator@njpbs-site-dev.iam.gserviceaccount.com',
      privateKeyId: 'b'.repeat(40), secretRef: 'pass://fixture/development-sdk' },
    providerCredentialRef: 'pass://fixture/provider-read-write', targets: ['old-reader', 'new-reader', 'operator'].map((role, index) => ({
      role, origin: gatewayFixtureOrigins[index] ?? 'https://dev-pair-operator-census.njpbs.org', serviceTokenId: uuid(index + 1),
      clientId: `synthetic${index}.access`, credentialRef: `pass://fixture/access-role-${index}` })) };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input)), path = url.pathname.replace('/client/v4', ''), method = init.method ?? 'GET';
    if (url.origin !== 'https://api.cloudflare.com' || init.redirect !== 'error') throw new Error('Unexpected synthetic provider origin');
    if (method !== 'GET') writes++;
    const reply = result => Response.json({ success: true, result });
    if (path.includes('/access/')) {
      if (path.includes('/service_tokens/')) {
        const target = accessPacket.targets.find(row => path.endsWith(row.serviceTokenId));
        return reply({ id: target.serviceTokenId, client_id: target.clientId, enabled: true, expires_at: '2099-01-01T00:00:00Z' });
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (path.endsWith('/apps')) {
          const value = { ...body, id: uuid(10 + apps.length), aud: String(apps.length + 1).repeat(64) };
          apps.push(value); policies.set(value.id, []); return reply(value);
        }
        const values = policies.get(path.split('/').at(-2)), value = { ...body, id: uuid(20 + apps.length) };
        values.push(value); return reply(value);
      }
      return reply(path.endsWith('/apps') ? apps : policies.get(path.split('/').at(-2)) ?? []);
    }
    if (path === `/zones/${zoneId}`) return reply({ id: zoneId, name: 'njpbs.org', account: { id: gatewayFixtureAccount } });
    if (path.includes('/dns_records') || path.endsWith('/workers/routes')) return reply([]);
    if (path === '/zones') return reply([{ id: zoneId }]);
    if (path.endsWith('/workers/domains')) {
      if (method === 'PUT') {
        const value = { ...JSON.parse(String(init.body)), id: String(domains.length + 1).repeat(40) }; domains.push(value); return reply(value);
      }
      return reply(domains);
    }
    if (path.endsWith('/workers/workers')) {
      const worker = { ...JSON.parse(String(init.body)), id: String(workers.size + 1).repeat(32) };
      workers.set(worker.name, { worker, version: null, deployment: null, source: new Uint8Array() }); return reply(worker);
    }
    const name = path.match(/\/(?:scripts|workers\/workers)\/([^/]+)/)?.[1], state = workers.get(name);
    if (path.includes('/workers/workers/')) return state ? reply(state.worker) : new Response(null, { status: 404 });
    if (path.endsWith('/versions')) {
      if (method === 'POST') {
        const form = init.body, metadata = JSON.parse(await form.get('metadata').text());
        state.source = new Uint8Array(await form.get('index.mjs').arrayBuffer());
        state.version = { id: uuid(30 + [...workers.keys()].indexOf(name)), annotations: metadata.annotations,
          resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date,
            compatibility_flags: metadata.compatibility_flags } } }; return reply(state.version);
      }
      return reply({ items: state?.version ? [{ id: state.version.id, annotations: state.version.annotations }] : [] });
    }
    if (path.includes('/versions/')) return reply(state.version);
    if (path.endsWith('/deployments')) {
      if (method === 'POST') { state.deployment = { ...JSON.parse(String(init.body)), id: uuid(40 + [...workers.keys()].indexOf(name)) }; return reply(state.deployment); }
      return reply(state?.deployment ? [state.deployment] : []);
    }
    if (path.endsWith('/subdomain')) return reply({ enabled: false, previews_enabled: false });
    if (path.endsWith('/content/v2')) return new Response(state.source, { headers: { 'content-type': 'application/javascript' } });
    throw new Error('Unexpected synthetic provider request');
  };
  const io = { firestore, readToken: async () => 'synthetic-provider-token', fetchImpl };
  await installPrivatePairAccess({ ...io, packet: accessPacket });
  const accessReadback = await installPrivatePairAccess({ ...io, packet: accessPacket, readback: true }), packets = [];
  for (const [index, role] of ['old-reader', 'new-reader'].entries()) {
    const packet = { schemaVersion: 1, kind: 'private-pair-bridge-operator', operatorCommitSha,
      credentialIdentity: accessPacket.credentialIdentity, providerCredentialRef: accessPacket.providerCredentialRef,
      operationId: `census-gateway-${index}`, accessPacket, accessReadback, pairs,
      ingressName: 'njpbs-private-ingress-census', zoneId, role, workerName: `njpbs-private-reader-census-${index}`,
      sourceDigest: '0'.repeat(64), enabled: true };
    const { config } = privateBridgeConfiguration(packet), source = await compilePrivateWorker(config.main);
    packet.sourceDigest = createHash('sha256').update(source).digest('hex');
    // The real CF write transport refuses all emulator modes. Preserve it;
    // supply only its external provider boundary to the actual native owner.
    const reads = cloudflarePrivatePairProvider({ accountId: gatewayFixtureAccount, credential: io.readToken, fetcher: fetchImpl });
    const provider = { ...reads,
      async create(name, tag) {
        writes++; const worker = { id: String(workers.size + 1).repeat(32), name, tags: [`private-pair:${tag}`],
          subdomain: { enabled: false, previews_enabled: false } };
        workers.set(name, { worker, version: null, deployment: null, source: new Uint8Array() }); return worker;
      },
      async upload(name, metadata, bytes) {
        writes++; const state = workers.get(name);
        state.source = Uint8Array.from(bytes);
        state.version = { id: uuid(30 + [...workers.keys()].indexOf(name)), annotations: metadata.annotations,
          resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date,
            compatibility_flags: metadata.compatibility_flags } } }; return state.version.id;
      },
      async disableSubdomain() { writes++; },
      async deploy(name, versionId, tag) {
        writes++; workers.get(name).deployment = { id: uuid(40 + [...workers.keys()].indexOf(name)),
          versions: [{ version_id: versionId, percentage: 100 }], annotations: { 'workers/message': `private-pair:${tag}` } };
      },
    };
    const ledger = privateInstallLedger(firestore);
    await ledger.bindAttempt(packet.operationId, protocol.publicReleaseDigest(packet));
    const installed = await installPrivateWorker({ ledger, provider, attemptId: packet.operationId, config, source, dryRun: false });
    const target = packet.accessReadback.targets[index], hostname = new URL(target.origin).hostname;
    await ledger.once({ attemptId: packet.operationId, worker: packet.workerName, planDigest: installed.planDigest, action: 'domain',
      effect: () => fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${gatewayFixtureAccount}/workers/domains`, {
        method: 'PUT', redirect: 'error', body: JSON.stringify({ environment: 'production', hostname, service: packet.workerName,
          zone_id: zoneId, zone_name: 'njpbs.org', enabled: true, previews_enabled: false }) }),
      observe: async () => {
        const row = domains.find(row => row.hostname === hostname && row.service === packet.workerName);
        if (!row) throw new Error('Original fixture domain unavailable');
        return { id: row.id, hostname, service: packet.workerName };
      } });
    await installPrivatePairBridge({ ...io, packet, readback: true }); packets.push(packet);
  }
  return { packets, io, domains, workers, providerWrites: () => writes };
}
