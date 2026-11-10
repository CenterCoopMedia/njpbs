import protocol from '../../functions/lib/public-release-pair.js';

const prepared = new WeakMap();
const refuse = () => { throw new Error('Rehearsal operator Access readback refused'); };
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value ?? '');
const hexId = value => /^[a-f0-9]{32}$/.test(value ?? '');
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);

export function parseRehearsalOperatorAccessTarget(value) {
  protocol.exact(value, ['accountId', 'workerName', 'versionId', 'origin', 'audience', 'clientId',
    'domainId', 'zoneId', 'applicationId', 'policyId', 'serviceTokenId']);
  const url = new URL(value.origin);
  if (!hexId(value.accountId) || !/^(?:[a-f0-9]{32}|[a-f0-9]{40})$/.test(value.domainId ?? '') || !hexId(value.zoneId) || !uuid(value.versionId) ||
      ![value.applicationId, value.policyId, value.serviceTokenId].every(uuid) ||
      !/^njpbs-private-operator-[a-z0-9-]{1,40}$/.test(value.workerName ?? '') ||
      url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password ||
      !/^dev-pair-operator-[a-z0-9][a-z0-9-]{0,39}\.njpbs\.org$/.test(url.hostname) ||
      !protocol.digest(value.audience) || !/^[A-Za-z0-9]+\.access$/.test(value.clientId ?? '')) refuse();
  return protocol.freeze({ ...value });
}

/** New read-only role, separate from slot/ingress zero-route policy. It cannot
 * attach a hostname, change Access, install a Worker or invoke its runtime.
 * Original compiled Worker/SDK evidence is checked by the private read owner.
 * API contracts: developers.cloudflare.com/api/resources/workers/subresources/domains/;
 * zero_trust/subresources/access/subresources/{applications,service_tokens}/.
 */
export function createRehearsalOperatorAccess({ target, readToken, fetchImpl = fetch, authorized = false }) {
  if (authorized !== true || typeof readToken !== 'function' || typeof fetchImpl !== 'function' ||
      process.env.FIRESTORE_EMULATOR_HOST !== undefined && fetchImpl === fetch) refuse();
  target = parseRehearsalOperatorAccessTarget(target);
  const handle = Object.freeze({});
  prepared.set(handle, { target, readToken, fetchImpl });
  return handle;
}

async function bounded(work, signal) {
  signal.throwIfAborted(); let abort;
  const canceled = new Promise((_, reject) => { abort = () => reject(new Error('Operator read expired')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([work, canceled]); }
  finally { signal.removeEventListener('abort', abort); }
}
async function request(context, path, signal) {
  let response, reader;
  try {
    const token = await bounded(Promise.resolve().then(context.readToken), signal);
    signal.throwIfAborted();
    const pending = Promise.resolve(context.fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal }));
    void pending.then(value => { if (signal.aborted) void value.body?.cancel().catch(() => {}); }, () => {});
    response = await bounded(pending, signal);
    if (!response.ok || !response.body) refuse();
    reader = response.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.byteLength; if (size > 256 * 1024) refuse(); chunks.push(value);
    }
    const envelope = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (envelope?.success !== true || envelope.result == null) refuse();
    return envelope;
  } finally { if (reader) void reader.cancel().catch(() => {}); else void response?.body?.cancel().catch(() => {}); }
}
function list(envelope, limit) {
  const rows = envelope.result, info = envelope.result_info;
  if (!Array.isArray(rows) || rows.length >= limit || info?.total_pages > 1 || info?.page > 1 ||
      info?.total_count !== undefined && info.total_count !== rows.length) refuse();
  return rows;
}

/** Every call performs fresh control-plane GETs. The opaque handle binds only
 * the named target; neither JSON nor a prior digest can certify privacy. */
export async function assertRehearsalOperatorAccessCurrent(handle, identity, callerSignal) {
  try {
    const context = prepared.get(handle), target = context?.target;
    if (!context || identity.accountId !== target.accountId || identity.workerName !== target.workerName || identity.versionId !== target.versionId) refuse();
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(callerSignal ? [callerSignal] : [])]);
    const account = `/accounts/${target.accountId}`, origin = new URL(target.origin);
    const domains = list(await request(context, `${account}/workers/domains`, signal), 1000);
    const matching = domains.filter(row => row.service === target.workerName);
    if (matching.length !== 1) refuse();
    const domain = matching[0];
    if (domain.id !== target.domainId || domain.hostname !== origin.hostname || domain.zone_id !== target.zoneId ||
        domain.enabled !== true || domain.previews_enabled !== false || ![undefined, 'production'].includes(domain.environment)) refuse();
    const zones = list(await request(context, `/zones?account.id=${target.accountId}&page=1&per_page=50`, signal), 50);
    if (!zones.some(zone => zone.id === target.zoneId) || zones.some(zone => !hexId(zone.id))) refuse();
    for (const zone of zones) {
      const routes = list(await request(context, `/zones/${zone.id}/workers/routes`, signal), 1000);
      if (routes.some(row => row.script === target.workerName)) refuse();
    }
    const app = (await request(context, `${account}/access/apps/${target.applicationId}`, signal)).result;
    if (app.id !== target.applicationId || app.type !== 'self_hosted' || app.domain !== origin.hostname || app.aud !== target.audience ||
        app.self_hosted_domains !== undefined && !same(app.self_hosted_domains, [origin.hostname])) refuse();
    const policies = list(await request(context, `${account}/access/apps/${target.applicationId}/policies?page=1&per_page=100`, signal), 100);
    const policy = policies[0];
    if (policies.length !== 1 || policy.id !== target.policyId || policy.decision !== 'non_identity' ||
        !same(policy.include, [{ service_token: { token_id: target.serviceTokenId } }]) ||
        !same(policy.exclude, []) || !same(policy.require, []) || policy.approval_required === true ||
        policy.isolation_required === true || policy.purpose_justification_required === true) refuse();
    const token = (await request(context, `${account}/access/service_tokens/${target.serviceTokenId}`, signal)).result;
    // GET's ServiceToken schema and response example include enabled. Require
    // observed true; an omitted optional field cannot certify active identity.
    // https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/get/
    if (token.id !== target.serviceTokenId || token.client_id !== target.clientId || token.enabled !== true ||
        token.leak_reported_at || token.leak_report_url || Object.hasOwn(token, 'client_secret') ||
        !(token.duration === 'forever' && token.expires_at == null || Number.isFinite(Date.parse(token.expires_at)) && Date.parse(token.expires_at) > Date.now() + 60_000)) refuse();
    signal.throwIfAborted();
    return Object.freeze({ receiptDigest: protocol.publicReleaseDigest({ kind: 'rehearsal-operator-access', target,
      domain: { id: domain.id, hostname: domain.hostname, service: domain.service, zoneId: domain.zone_id },
      application: { id: app.id, type: app.type, domain: app.domain, aud: app.aud },
      policy: { id: policy.id, decision: policy.decision, include: policy.include, exclude: policy.exclude, require: policy.require },
      token: { id: token.id, clientId: token.client_id, enabled: true, expiresAt: token.expires_at ?? null, duration: token.duration ?? null },
      zones: zones.map(zone => zone.id).sort() }) });
  } catch { return refuse(); }
}
