import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import protocol from '../../functions/lib/public-release-pair.js';
import bootstrap from '../../functions/lib/public-release-bootstrap.js';
import { configurePublicReleaseIngress } from '../configure-public-release-ingress.mjs';
import { compilePrivateWorker } from '../install-private-public-release.mjs';
import { privatePublicReleaseSlotTarget, readPrivatePublicReleaseSlotProvider } from './private-public-release-slot-target.mjs';
import { cloudflarePrivatePairProvider, privateWorkerMetadata, PrivateProviderNotSent } from './public-release-private-provider.mjs';
import { privateInstallLedger } from './public-release-private-install-ledger.mjs';
import { readClosedInitialIngressAuthority } from './public-release-bootstrap-ingress-authority.mjs';
import { parseOperatorCredentialIdentity, operatorRefused as refuse } from './public-release-operator-io.mjs';
const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? ""), worker = 'njpbs-dev-staff-sites';
const hash = protocol.publicReleaseDigest, same = (a, b) => hash(a) === hash(b);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value ?? '');
const normalize = bindings => bindings.map(binding => {
  const value = { ...binding }; if (value.type === 'service' && value.environment === 'production') delete value.environment;
  return value;
}).sort((a, b) => a.name.localeCompare(b.name, 'en'));
export function developmentGatewayConfiguration(raw) {
  protocol.exact(raw, ['schemaVersion', 'kind', 'operatorCommitSha', 'operationId', 'credentialIdentity', 'providerCredentialRef',
    'bootstrapAttempt', 'installPlan', 'gateway', 'ingress']);
  if (raw.schemaVersion !== 1 || raw.kind !== 'development-public-release-gateway' || !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? '') ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(raw.operationId ?? '') || !/^pass:\/\/[A-Za-z0-9/_-]{1,200}$/.test(raw.providerCredentialRef ?? '')) refuse();
  const attempt = bootstrap.parseBootstrapAttempt(raw.bootstrapAttempt);
  if ([attempt.currentPair, attempt.recoveryPair].some(pair => pair.environment !== 'development')) refuse();
  parseOperatorCredentialIdentity(raw.credentialIdentity, 'development');
  const plan = raw.installPlan;
  if (plan?.accountId !== account || plan.developmentIngress !== true) refuse();
  const slots = [attempt.currentPair, attempt.recoveryPair].map(pair => privatePublicReleaseSlotTarget({ pair, installPlan: plan }));
  const ingress = configurePublicReleaseIngress({ oldPair: attempt.currentPair, newPair: attempt.recoveryPair,
    accountId: account, ingressName: plan.ingressName, developmentIngress: true });
  protocol.exact(raw.ingress, ['versionId', 'deploymentId']);
  const gateway = raw.gateway;
  protocol.exact(gateway, ['versionId', 'deploymentId', 'sourceDigest', 'audience', 'zoneId', 'routeId', 'applicationId', 'policiesDigest']);
  if (![gateway.versionId, gateway.deploymentId, gateway.applicationId, raw.ingress.versionId, raw.ingress.deploymentId].every(uuid) ||
      ![gateway.sourceDigest, gateway.audience, gateway.policiesDigest].every(protocol.digest) ||
      ![gateway.zoneId, gateway.routeId].every(value => /^[a-f0-9]{32}$/.test(value ?? ''))) refuse();
  const config = { main_module: 'index.mjs', compatibility_date: '2026-09-08', compatibility_flags: ['nodejs_compat'],
    bindings: normalize([{ name: 'DEV_ACCESS_AUDIENCE', type: 'plain_text', text: gateway.audience },
      { name: 'DEV_STAFF_ACCESS', type: 'service', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { name: 'DEV_PUBLIC', type: 'service', service: ingress.name }]),
    observability: { enabled: true, head_sampling_rate: 1 } };
  return { packet: protocol.freeze(structuredClone(raw)), attempt, ingress, slots, config };
}

/** The original private installer owns ingress creation; this only reads its
 * four original claims/readbacks and exact immutable installed configuration. */
export async function readDevelopmentIngressInstall({ firestore, packet, ingress, provider, signal }) {
  const { main: _main, ...portable } = ingress, plan = packet.installPlan;
  const planDigest = hash({ config: portable, sourceDigest: plan.ingressBundleDigest });
  const tag = hash({ attemptId: plan.operationId, planDigest }), key = hash({ worker: ingress.name });
  const seal = { schemaVersion: 1, attemptId: plan.operationId, worker: ingress.name, planDigest };
  const base = 'system/publicReleasePrivateInstalls', actions = ['create', 'upload', 'private-subdomain', 'deploy'];
  const values = await firestore.runTransaction(async tx => (await tx.getAll(
    firestore.doc(`${base}/plans/${plan.operationId}`), firestore.doc(`${base}/workers/${key}`),
    ...actions.flatMap(action => [firestore.doc(`${base}/attempts/${plan.operationId}/steps/${key}-${action}`),
      firestore.doc(`${base}/attempts/${plan.operationId}/readbacks/${key}-${action}`)]))).map(row => row.data()));
  if (!same(values[0], { schemaVersion: 1, attemptId: plan.operationId, planDigest: hash(plan) }) || !same(values[1], seal)) refuse();
  const parent = await provider.worker(ingress.name, signal);
  if (!parent || parent.name !== ingress.name || !/^[a-f0-9]{32}$/.test(parent.id ?? '') || !same(parent.tags, [`private-pair:${tag}`])) refuse();
  const results = [{ workerId: parent.id, name: ingress.name, tag }, { versionId: packet.ingress.versionId }, { private: true }, packet.ingress];
  actions.forEach((action, i) => {
    if (!same(values[2 + i * 2], { ...seal, action }) || !same(values[3 + i * 2], { ...seal, action, result: results[i] })) refuse();
  });
  const deployment = await provider.deployment(ingress.name, signal);
  if (!same(deployment?.versions, [{ version_id: packet.ingress.versionId, percentage: 100 }]) || deployment.id !== packet.ingress.deploymentId ||
      deployment.annotations?.['workers/message'] !== `private-pair:${tag}`) refuse();
  const version = await provider.version(ingress.name, packet.ingress.versionId, signal), metadata = privateWorkerMetadata(ingress, tag);
  if (version.id !== packet.ingress.versionId || !same(normalize(version.resources?.bindings ?? []), metadata.bindings) ||
      version.annotations?.['workers/message'] !== `private-pair:${tag}` ||
      version.resources?.script_runtime?.compatibility_date !== metadata.compatibility_date ||
      !same(version.resources?.script_runtime?.compatibility_flags, metadata.compatibility_flags) ||
      await provider.sourceDigest(ingress.name, signal) !== plan.ingressBundleDigest) refuse();
  await provider.assertNoPublicRoutes(ingress.name, signal);
  const exposure = await provider.subdomain(ingress.name, signal);
  if (exposure.enabled !== false || exposure.previews_enabled !== false || !same(await provider.deployment(ingress.name, signal), deployment)) refuse();
  return { planDigest, versionId: version.id, deploymentId: deployment.id };
}

/** Provider transport fixed to the existing development gateway. No route,
 * domain, Access, secret, Worker create or subdomain writer is exposed. */
export function developmentGatewayProvider({ readToken, fetchImpl = fetch, signal }) {
  const root = `/accounts/${account}/workers/scripts/${worker}`;
  async function api(path, { method = 'GET', body, raw = false } = {}) {
    let token;
    try {
      if (method !== 'GET' && fetchImpl === fetch && ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'].some(key => Object.hasOwn(process.env, key))) refuse();
      signal?.throwIfAborted(); token = await readToken(); signal?.throwIfAborted();
    }
    catch { throw new PrivateProviderNotSent(); }
    let response;
    try { response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, { method, redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) }); }
    catch { refuse(); }
    if (!response.ok) { await response.body?.cancel(); refuse(); }
    const reader = response.body?.getReader(); if (!reader) refuse();
    const chunks = []; let size = 0;
    try { for (;;) { const row = await reader.read(); if (row.done) break;
      size += row.value.length; if (size > 1024 * 1024) refuse(); chunks.push(row.value);
    } } finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks);
    if (raw) return { bytes, type: response.headers.get('content-type') ?? '' };
    let value; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { refuse(); }
    if (value.success !== true || !Object.hasOwn(value, 'result') || value.result_info?.total_pages > 1 ||
        Array.isArray(value.result) && (value.result.length >= 100 || value.result_info?.total_count > value.result.length)) refuse();
    return value.result;
  }
  return {
    api,
    async upload(metadata, source) {
      const form = new FormData(); form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.set('index.mjs', new Blob([source], { type: 'application/javascript+module' }), 'index.mjs');
      return api(`${root}/versions`, { method: 'POST', body: form });
    },
    deploy: (versionId, tag) => api(`${root}/deployments`, { method: 'POST', body: { strategy: 'percentage',
      versions: [{ version_id: versionId, percentage: 100 }], annotations: { 'workers/message': tag } } }),
    version: id => { if (!uuid(id)) refuse(); return api(`${root}/versions/${id}`); },
    async versions() { const value = await api(`${root}/versions?page=1&per_page=100`), rows = value.items ?? value;
      if (!Array.isArray(rows) || rows.length >= 100) refuse(); return rows; },
    async deployment() { const value = await api(`${root}/deployments`), rows = value.deployments ?? value;
      if (!Array.isArray(rows)) refuse(); return rows[0]; },
    exposure: () => api(`${root}/subdomain`),
    async sourceDigest() {
      const { bytes, type } = await api(`${root}/content/v2`, { raw: true });
      if (type.startsWith('multipart/form-data')) {
        const form = await new Response(bytes, { headers: { 'content-type': type } }).formData(), main = form.get('index.mjs');
        if (!(main instanceof Blob) || [...form.keys()].filter(key => key !== 'metadata').join() !== 'index.mjs') refuse();
        return sha(new Uint8Array(await main.arrayBuffer()));
      }
      if (!/^(?:application\/(?:javascript|octet-stream)|text\/javascript)(?:;|$)/.test(type)) refuse(); return sha(bytes);
    },
  };
}

export async function bindDevelopmentPublicReleaseGateway({ firestore, packet: raw, provider, ingressProvider, readToken,
  fetchImpl, signal, readback = false, compile = compilePrivateWorker }) {
  const { packet, attempt, ingress, slots, config } = developmentGatewayConfiguration(raw);
  if (firestore.projectId !== 'njpbs-site-dev' && !/^demo-[a-z0-9-]+$/.test(firestore.projectId ?? '')) refuse();
  provider ??= developmentGatewayProvider({ readToken, fetchImpl, signal });
  ingressProvider ??= cloudflarePrivatePairProvider({ accountId: account, credential: readToken, fetcher: fetchImpl });
  const source = await compile(fileURLToPath(new URL('../../workers/src/staff-site-dev-worker.ts', import.meta.url)));
  const sourceDigest = sha(source), planDigest = hash({ packet, config, sourceDigest }), tag = `dev-pair-gateway:${planDigest}`;
  const metadata = { ...config, annotations: { 'workers/message': tag, 'workers/triggered_by': 'version_upload' } };
  const ledger = privateInstallLedger(firestore), owner = `development-gateway:${worker}`;
  const base = 'system/publicReleasePrivateInstalls', ownerKey = hash({ worker: owner });
  const inspectIngress = () => readDevelopmentIngressInstall({ firestore, packet, ingress, provider: ingressProvider, signal });
  const inspectBoundary = async () => {
    signal?.throwIfAborted();
    const gateway = packet.gateway;
    const zone = await provider.api(`/zones/${gateway.zoneId}`);
    const routes = await provider.api(`/zones/${gateway.zoneId}/workers/routes`);
    const domains = await provider.api(`/accounts/${account}/workers/domains`);
    if (zone.id !== gateway.zoneId || zone.name !== 'njpbs.org' || zone.account?.id !== account || !Array.isArray(routes) || !Array.isArray(domains) ||
        routes.filter(row => row.script === worker).length !== 1 || routes.some(row => row.script === ingress.name) ||
        !routes.some(row => row.id === gateway.routeId && row.pattern === 'dev-public.example.org/*' && row.script === worker) ||
        domains.some(row => [worker, ingress.name].includes(row.service))) refuse();
    const app = await provider.api(`/accounts/${account}/access/apps/${gateway.applicationId}`);
    const policies = await provider.api(`/accounts/${account}/access/apps/${gateway.applicationId}/policies`);
    if (app.id !== gateway.applicationId || app.domain !== 'dev-public.example.org' || app.aud !== gateway.audience ||
        !Array.isArray(policies) || !policies.length || policies.some(row => row.decision === 'bypass') || hash(policies) !== gateway.policiesDigest) refuse();
    const exposed = await provider.exposure(); if (exposed.enabled !== false || exposed.previews_enabled !== false) refuse();
    return hash({ routes, domains, app, policies });
  };
  const checkVersion = (version, expected, id, annotation) => {
    if (version.id !== id || annotation && version.annotations?.['workers/message'] !== annotation ||
        !same(normalize(version.resources?.bindings ?? []), expected.bindings) ||
        version.resources?.script_runtime?.compatibility_date !== expected.compatibility_date ||
        !same(version.resources?.script_runtime?.compatibility_flags, expected.compatibility_flags)) refuse();
  };
  const uploaded = async () => {
    const matches = (await provider.versions()).filter(row => row.annotations?.['workers/message'] === tag);
    if (matches.length !== 1 || !uuid(matches[0].id)) refuse();
    checkVersion(await provider.version(matches[0].id), metadata, matches[0].id, tag);
    return { versionId: matches[0].id };
  };
  const selected = async () => {
    const version = await uploaded(), active = await provider.deployment();
    if (!uuid(active?.id) || active.annotations?.['workers/message'] !== tag || !same(active.versions, [{ version_id: version.versionId, percentage: 100 }]) ||
        await provider.sourceDigest() !== sourceDigest) refuse();
    return { ...version, deploymentId: active.id };
  };
  await inspectIngress();
  if (readback) {
    const plan = (await firestore.doc(`${base}/plans/${packet.operationId}`).get()).data();
    if (!plan) return { original: false, complete: false, operationId: packet.operationId };
    if (!same(plan, { schemaVersion: 1, attemptId: packet.operationId, planDigest })) refuse();
    const ownerSeal = { schemaVersion: 1, attemptId: packet.operationId, worker: owner, planDigest };
    if (!same((await firestore.doc(`${base}/workers/${ownerKey}`).get()).data(), ownerSeal)) refuse();
    const rows = await firestore.getAll(...['upload', 'deploy'].flatMap(action => [
      firestore.doc(`${base}/attempts/${packet.operationId}/steps/${ownerKey}-${action}`),
      firestore.doc(`${base}/attempts/${packet.operationId}/readbacks/${ownerKey}-${action}`)]));
    const outcome = await selected();
    for (const [i, action] of ['upload', 'deploy'].entries()) {
      const seal = { schemaVersion: 1, attemptId: packet.operationId, worker: owner, planDigest, action };
      const result = action === 'upload' ? { versionId: outcome.versionId } : outcome;
      if (!same(rows[i * 2].data(), seal) || !same(rows[i * 2 + 1].data(), { ...seal, result })) refuse();
    }
    await inspectBoundary(); return { original: true, complete: true, operationId: packet.operationId, ...outcome };
  }
  const authority = await readClosedInitialIngressAuthority({ firestore, attempt, signal }), boundary = await inspectBoundary();
  const guard = async () => {
    if (!same(await readClosedInitialIngressAuthority({ firestore, attempt, signal }), authority) || await inspectBoundary() !== boundary) refuse();
    await inspectIngress();
    for (const slot of slots) await readPrivatePublicReleaseSlotProvider({ target: slot, readToken, fetchImpl, signal });
  };
  const prior = await provider.deployment();
  const original = prior?.id === packet.gateway.deploymentId && same(prior?.versions, [{ version_id: packet.gateway.versionId, percentage: 100 }]);
  if (!original && prior?.annotations?.['workers/message'] !== tag) refuse();
  const claims = await firestore.getAll(...['upload', 'deploy'].map(action => firestore.doc(`${base}/attempts/${packet.operationId}/steps/${ownerKey}-${action}`)));
  if ((await provider.versions()).some(row => row.annotations?.['workers/message'] === tag) && !claims[0].exists || !original && !claims[1].exists) refuse();
  const originalConfig = { ...config, bindings: config.bindings.map(row => row.name === 'DEV_PUBLIC' ? { ...row, service: 'template-dev-public' } : row) };
  checkVersion(await provider.version(packet.gateway.versionId), originalConfig, packet.gateway.versionId);
  if (original && await provider.sourceDigest() !== packet.gateway.sourceDigest) refuse();
  await guard(); await ledger.bindAttempt(packet.operationId, planDigest);
  const once = (action, effect, observe) => ledger.once({ attemptId: packet.operationId, worker: owner, planDigest, action,
    effect: async () => {
      try { await guard(); } catch { throw new PrivateProviderNotSent(); }
      return effect();
    }, observe });
  const version = await once('upload', () => provider.upload(metadata, source), uploaded);
  await guard();
  const outcome = await once('deploy', () => provider.deploy(version.versionId, tag), selected);
  await guard(); if (!same(await selected(), outcome)) refuse();
  return { original: true, complete: true, operationId: packet.operationId, ...outcome };
}
