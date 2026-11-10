import { devAccessOrigin } from "./deployment-settings.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import protocol from "../../functions/lib/public-release-pair.js";
import { configurePublicReleaseIngress, configurePrivatePairReaderGateway } from "../configure-public-release-ingress.mjs";
import { compilePrivateWorker } from "../install-private-public-release.mjs";
import { privateInstallLedger } from "./public-release-private-install-ledger.mjs";
import { cloudflarePrivatePairProvider, installPrivateWorker, privateWorkerMetadata, PrivateProviderNotSent } from "./public-release-private-provider.mjs";
import { parsePrivateAccessPacket, installPrivatePairAccess } from "./public-release-private-access-operator.mjs";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? "");
const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
export function parsePrivateBridgePacket(value) {
  const enabled = Object.hasOwn(value ?? {}, "enabled");
  protocol.exact(value, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "providerCredentialRef", "operationId",
    "accessPacket", "accessReadback", "pairs", "ingressName", "zoneId", "role", "workerName", "sourceDigest", ...enabled ? ["enabled"] : []]);
  const access = parsePrivateAccessPacket(value.accessPacket), environment = access.environment;
  parseOperatorCredentialIdentity(value.credentialIdentity, environment);
  if (value.schemaVersion !== 1 || value.kind !== "private-pair-bridge-operator" || !/^[a-f0-9]{40}$/.test(value.operatorCommitSha ?? "") ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.operationId ?? "") || !/^pass:\/\/[A-Za-z0-9/_-]{1,200}$/.test(value.providerCredentialRef ?? "") ||
      !/^[a-f0-9]{32}$/.test(value.zoneId ?? "") || !/^[a-f0-9]{64}$/.test(value.sourceDigest ?? "") ||
      !/^njpbs-private-ingress-[a-z0-9-]{1,30}$/.test(value.ingressName ?? "") ||
      !["old-reader", "new-reader", "operator"].includes(value.role) || enabled && typeof value.enabled !== "boolean" ||
      !Array.isArray(value.pairs) || value.pairs.length !== 2) refuse();
  const pairs = value.pairs.map(protocol.parsePublicReleasePair);
  if (pairs.some(pair => pair.environment !== environment) || pairs[0].pairId === pairs[1].pairId) refuse();
  const prefix = value.role === "operator" ? "operator" : "reader";
  if (!new RegExp(`^njpbs-private-${prefix}-[a-z0-9-]{1,40}$`).test(value.workerName ?? "")) refuse();
  const wrapped = value.accessReadback, hasMode = Object.hasOwn(wrapped ?? {}, "mode");
  protocol.exact(wrapped, ["original", "operationId", "packetDigest", "targets", ...hasMode ? ["mode"] : []]);
  if (hasMode && wrapped.mode !== "readback") refuse();
  const { mode: _mode, ...readback } = wrapped;
  if (readback.original !== true || readback.operationId !== access.operationId || readback.packetDigest !== protocol.publicReleaseDigest(access) ||
      !Array.isArray(readback.targets) || readback.targets.length !== 3) refuse();
  for (const [index, row] of readback.targets.entries()) {
    protocol.exact(row, ["role", "origin", "clientId", "applicationId", "audience", "name", "domain", "policy", "original"]);
    if (row.original !== true || row.role !== access.targets[index].role || row.origin !== access.targets[index].origin ||
        row.clientId !== access.targets[index].clientId || !uuid(row.applicationId) || !/^[a-f0-9]{64}$/.test(row.audience ?? "") ||
        row.domain !== new URL(row.origin).hostname) refuse();
    protocol.exact(row.policy, ["policyId", "policyDigest"]);
    if (!uuid(row.policy.policyId) || !/^[a-f0-9]{64}$/.test(row.policy.policyDigest ?? "")) refuse();
  }
  if (new Set(readback.targets.map(row => row.audience)).size !== 3) refuse();
  return protocol.freeze(structuredClone({ ...value, accessReadback: readback, pairs }));
}
export function privateBridgeConfiguration(raw) {
  const packet = parsePrivateBridgePacket(raw), readers = packet.accessReadback.targets, enabled = packet.enabled ?? false;
  const index = ["old-reader", "new-reader", "operator"].indexOf(packet.role), target = readers[index];
  let config;
  if (index < 2) {
    config = configurePrivatePairReaderGateway({ pair: packet.pairs[index], accountId: account, readerOrigin: target.origin,
      gatewayName: packet.workerName, enabled });
    // The existing uploader stays completely private; the separate, journaled
    // domain attach happens only after Access and provider readbacks agree.
    config = { ...config, routes: [], r2_buckets: [] };
  } else {
    config = { name: packet.workerName, account_id: account,
      main: fileURLToPath(new URL("../../workers/src/private-pair-operator-worker.ts", import.meta.url)),
      compatibility_date: "2026-07-09", compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false, routes: [], r2_buckets: [],
      vars: { PAIR_PRIVATE_HTTP_ENABLED: String(enabled), PAIR_PRIVATE_ORIGIN: target.origin, PAIR_ACCESS_AUDIENCE: target.audience,
        PAIR_ACCESS_CLIENT_ID: target.clientId, CMS_DEV_ACCESS_ORIGIN: enabled ? devAccessOrigin() : "", PAIR_READER_ACCESS_JSON: JSON.stringify(readers.slice(0, 2).map(row => ({ audience: row.audience, clientId: row.clientId }))),
        PAIR_PROOF_ORIGIN: packet.pairs[0].environment === "production" ? "https://njpbs.org" : "https://dev-public.example.org" },
      services: [{ binding: "PAIR_INGRESS_PROOF", service: packet.ingressName, entrypoint: "PublicReleaseIngressProofEntrypoint" }] };
  }
  return { packet, config, target };
}
/** Narrow bounded API primitive used only by reviewed fixed-path operators.
 * Credentials and provider error envelopes never enter evidence or errors. */
export function operatorCloudflareApi({ readToken, fetchImpl = fetch, signal }) {
  return async (path, { method = "GET", body } = {}) => {
    let token;
    try {
    if (method !== "GET" && fetchImpl === fetch && ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]
      .some(key => Object.hasOwn(process.env, key))) refuse();
    signal?.throwIfAborted(); token = await readToken(); signal?.throwIfAborted();
    } catch { throw new PrivateProviderNotSent(); }
    let response;
    try { response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, { method, redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { refuse(); }
    const reader = response.body?.getReader(); if (!reader) refuse();
    let size = 0; const chunks = [];
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length; if (size > 256 * 1024) refuse(); chunks.push(chunk.value); }
    } finally { await reader.cancel().catch(() => {}); }
    if (!response.ok) refuse();
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { refuse(); }
    if (value.success !== true || !Object.hasOwn(value, "result")) refuse();
    if (Array.isArray(value.result) && (value.result.length >= 100 || value.result_info?.total_pages > 1 || value.result_info?.total_count > value.result.length)) refuse();
    return value.result;
  };
}
function originalIdentity(packet, config, source) {
  const { main, ...portable } = config;
  const planDigest = protocol.publicReleaseDigest({ config: portable, sourceDigest: hash(source) });
  return { planDigest, tag: protocol.publicReleaseDigest({ attemptId: packet.operationId, planDigest }) };
}
/** No ledger.once in recovery: observations cannot create missing claims. */
async function readOriginalBridge({ firestore, packet, config, source, provider, api, target }) {
  const { planDigest, tag } = originalIdentity(packet, config, source), key = protocol.publicReleaseDigest({ worker: config.name });
  const base = "system/publicReleasePrivateInstalls", seal = { schemaVersion: 1, attemptId: packet.operationId, worker: config.name, planDigest };
  const actions = ["create", "upload", "private-subdomain", "deploy"];
  const [plan, owner, ...rows] = await firestore.runTransaction(tx => tx.getAll(firestore.doc(`${base}/plans/${packet.operationId}`),
    firestore.doc(`${base}/workers/${key}`),
    ...actions.flatMap(action => [firestore.doc(`${base}/attempts/${packet.operationId}/steps/${key}-${action}`),
      firestore.doc(`${base}/attempts/${packet.operationId}/readbacks/${key}-${action}`)])));
  if (!same(plan.data(), { schemaVersion: 1, attemptId: packet.operationId, planDigest: protocol.publicReleaseDigest(packet) }) ||
      !same(owner.data(), seal)) refuse();
  for (const [i, action] of actions.entries()) {
    if (!same(rows[i * 2].data(), { ...seal, action })) refuse();
    const receipt = rows[i * 2 + 1].data(); protocol.exact(receipt, [...Object.keys(seal), "action", "result"]);
    if (!same({ ...receipt, result: null }, { ...seal, action, result: null })) refuse();
  }
  const worker = await provider.worker(config.name), deployment = await provider.deployment(config.name), metadata = privateWorkerMetadata(config, tag);
  if (!worker || worker.name !== config.name || worker.tags?.length !== 1 || worker.tags[0] !== `private-pair:${tag}` ||
      !same(rows[1].data().result, { workerId: worker.id, name: config.name, tag }) || deployment?.versions?.length !== 1 ||
      !uuid(deployment.id) || deployment.versions[0].percentage !== 100 || deployment.annotations?.["workers/message"] !== `private-pair:${tag}`) refuse();
  const versionId = deployment.versions[0].version_id, version = await provider.version(config.name, versionId);
  const normalized = version.resources?.bindings?.map(binding => {
    const row = { ...binding }; if (row.type === "service" && row.environment === "production") delete row.environment; return row;
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (!same(rows[3].data().result, { versionId }) || !same(rows[5].data().result, { private: true }) ||
      !same(rows[7].data().result, { versionId, deploymentId: deployment.id }) || version.id !== versionId ||
      version.annotations?.["workers/message"] !== `private-pair:${tag}` || !same(normalized, metadata.bindings) ||
      version.resources?.script_runtime?.compatibility_date !== metadata.compatibility_date ||
      !same(version.resources?.script_runtime?.compatibility_flags, metadata.compatibility_flags) ||
      await provider.sourceDigest(config.name) !== packet.sourceDigest) refuse();
  const subdomain = await provider.subdomain(config.name); if (subdomain.enabled !== false || subdomain.previews_enabled !== false) refuse();
  const domains = await api(`/accounts/${account}/workers/domains`);
  if (!Array.isArray(domains)) refuse();
  const ours = domains.filter(row => row.service === config.name || row.hostname === target.domain);
  if (ours.length > 1 || ours.length === 1 && (ours[0].service !== config.name || ours[0].hostname !== target.domain ||
      ours[0].zone_id !== packet.zoneId || ours[0].zone_name !== "njpbs.org" || ours[0].environment !== "production" ||
      ours[0].enabled !== true || ours[0].previews_enabled !== false || !/^(?:[a-f0-9]{32}|[a-f0-9]{40})$/.test(ours[0].id ?? ""))) refuse();
  return { planDigest, sourceDigest: packet.sourceDigest, versionId, deploymentId: deployment.id, domain: ours[0] ? { id: ours[0].id, hostname: target.domain, service: config.name } : null };
}
/** The proof service name is never authority. Reconstruct its original
 * disabled or explicit development configuration from the actual pair identities, then verify the original
 * immutable install owner, all four claims/receipts and current provider bytes. */
export async function assertOriginalProofIngress({ firestore, packet, provider, config, source, signal }) {
  const base = "system/publicReleasePrivateInstalls", key = protocol.publicReleaseDigest({ worker: config.name });
  const owner = (await firestore.doc(`${base}/workers/${key}`).get()).data();
  protocol.exact(owner, ["schemaVersion", "attemptId", "worker", "planDigest"]);
  if (owner.schemaVersion !== 1 || owner.worker !== config.name || !/^[A-Za-z0-9_-]{1,128}$/.test(owner.attemptId ?? "")) refuse();
  // The immutable install owner chooses the configuration, never the bridge
  // packet's enabled flag or a currently mutable provider setting. Production
  // keeps its original disabled/OLD-pinned reconstruction only.
  const candidates = [config];
  if (packet.pairs[0].environment === "development") candidates.push(configurePublicReleaseIngress({
    oldPair: packet.pairs[0], newPair: packet.pairs[1], accountId: account, ingressName: packet.ingressName, developmentIngress: true }));
  const matched = candidates.filter(candidate => originalIdentity({ operationId: owner.attemptId }, candidate, source).planDigest === owner.planDigest);
  if (matched.length !== 1) refuse();
  config = matched[0];
  const { planDigest, tag } = originalIdentity({ operationId: owner.attemptId }, config, source);
  const actions = ["create", "upload", "private-subdomain", "deploy"];
  const [plan, latest, ...rows] = await firestore.runTransaction(tx => tx.getAll(firestore.doc(`${base}/plans/${owner.attemptId}`),
    firestore.doc(`${base}/workers/${key}`), ...actions.flatMap(action => [
      firestore.doc(`${base}/attempts/${owner.attemptId}/steps/${key}-${action}`),
      firestore.doc(`${base}/attempts/${owner.attemptId}/readbacks/${key}-${action}`)])));
  protocol.exact(plan.data(), ["schemaVersion", "attemptId", "planDigest"]);
  if (plan.data().schemaVersion !== 1 || plan.data().attemptId !== owner.attemptId || !protocol.digest(plan.data().planDigest) || !same(latest.data(), owner)) refuse();
  for (const [i, action] of actions.entries()) {
    if (!same(rows[i * 2].data(), { ...owner, action })) refuse();
    const receipt = rows[i * 2 + 1].data(); protocol.exact(receipt, [...Object.keys(owner), "action", "result"]);
    if (!same({ ...receipt, result: null }, { ...owner, action, result: null })) refuse();
  }
  const worker = await provider.worker(config.name, signal), deployment = await provider.deployment(config.name, signal);
  if (!worker || worker.name !== config.name || !same(worker.tags, [`private-pair:${tag}`]) ||
      !same(rows[1].data().result, { workerId: worker.id, name: config.name, tag }) || !uuid(deployment?.id) ||
      deployment.versions?.length !== 1 || deployment.versions[0].percentage !== 100 || deployment.annotations?.["workers/message"] !== `private-pair:${tag}`) refuse();
  const versionId = deployment.versions[0].version_id, version = await provider.version(config.name, versionId, signal), metadata = privateWorkerMetadata(config, tag);
  const bindings = version.resources?.bindings?.map(binding => {
    const row = { ...binding }; if (row.type === "service" && row.environment === "production") delete row.environment; return row;
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (!same(rows[3].data().result, { versionId }) || !same(rows[5].data().result, { private: true }) ||
      !same(rows[7].data().result, { versionId, deploymentId: deployment.id }) || version.id !== versionId ||
      version.annotations?.["workers/message"] !== `private-pair:${tag}` || !same(bindings, metadata.bindings) ||
      version.resources?.script_runtime?.compatibility_date !== metadata.compatibility_date ||
      !same(version.resources?.script_runtime?.compatibility_flags, metadata.compatibility_flags) ||
      await provider.sourceDigest(config.name, signal) !== hash(source)) refuse();
  const subdomain = await provider.subdomain(config.name, signal);
  if (subdomain.enabled !== false || subdomain.previews_enabled !== false) refuse();
}
async function assertOriginalDomain(firestore, packet, key, seal, domain) {
  if (!domain) return;
  const base = `system/publicReleasePrivateInstalls/attempts/${packet.operationId}`;
  const [claim, receipt] = await firestore.runTransaction(tx => tx.getAll(firestore.doc(`${base}/steps/${key}-domain`),
    firestore.doc(`${base}/readbacks/${key}-domain`)));
  if (!same(claim.data(), seal) || !same(receipt.data(), { ...seal, result: domain })) refuse();
}
export async function installPrivatePairBridge({ firestore, packet: raw, readToken, fetchImpl, signal, readback = false }) {
  const { packet, config, target } = privateBridgeConfiguration(raw), source = await compilePrivateWorker(config.main);
  if (hash(source) !== packet.sourceDigest) refuse();
  // The real Access original-attempt reader rechecks all three applications,
  // token identities and exact machine-only policies before and after I/O.
  const access = () => installPrivatePairAccess({ firestore, packet: packet.accessPacket, readToken, fetchImpl, signal, readback: true });
  if (!same(await access(), packet.accessReadback)) refuse();
  const provider = cloudflarePrivatePairProvider({ accountId: account, credential: readToken, fetcher: fetchImpl });
  const api = operatorCloudflareApi({ readToken, fetchImpl, signal }), ledger = privateInstallLedger(firestore);
  const ingressConfig = packet.role === "operator" ? configurePublicReleaseIngress({ oldPair: packet.pairs[0], newPair: packet.pairs[1],
    accountId: account, ingressName: packet.ingressName }) : null;
  const ingressSource = ingressConfig ? await compilePrivateWorker(ingressConfig.main) : null;
  const ingress = async () => { if (ingressConfig) await assertOriginalProofIngress({ firestore, packet, provider,
    config: ingressConfig, source: ingressSource, signal }); };
  await ingress();
  const base = "system/publicReleasePrivateInstalls", key = protocol.publicReleaseDigest({ worker: config.name });
  const domainStep = firestore.doc(`${base}/attempts/${packet.operationId}/steps/${key}-domain`);
  const claim = await domainStep.get(), claimed = claim.exists && claim.data().notSent !== true;
  const domainSeal = { schemaVersion: 1, attemptId: packet.operationId, worker: config.name,
    planDigest: originalIdentity(packet, config, source).planDigest, action: "domain" };
  if (claim.exists && !same(claim.data(), domainSeal) && !same(claim.data(), { ...domainSeal, notSent: true })) refuse();
  if (!readback && !claimed) {
    const zone = await api(`/zones/${packet.zoneId}`);
    if (zone?.id !== packet.zoneId || zone.name !== "njpbs.org" || zone.account?.id !== account) refuse();
    await ledger.bindAttempt(packet.operationId, protocol.publicReleaseDigest(packet));
    await installPrivateWorker({ ledger, provider, attemptId: packet.operationId, config, source, dryRun: false, signal });
  }
  await ingress();
  let original = await readOriginalBridge({ firestore, packet, config, source, provider, api, target });
  if (readback && claimed && packet.enabled === true && !original.domain || packet.enabled !== true && original.domain) refuse();
  if (!readback && packet.enabled === true) {
    const { planDigest } = original;
    if (!claimed) {
      if (original.domain) refuse();
      const dns = await api(`/zones/${packet.zoneId}/dns_records?name=${encodeURIComponent(target.domain)}&per_page=100&page=1`);
      if (!Array.isArray(dns) || dns.length) refuse();
      if (!same(await access(), packet.accessReadback)) refuse();
    }
    await ledger.once({ attemptId: packet.operationId, worker: config.name, planDigest, action: "domain", effect: async () => {
      await api(`/accounts/${account}/workers/domains`, { method: "PUT", body: { environment: "production", hostname: target.domain,
        service: config.name, zone_id: packet.zoneId, zone_name: "njpbs.org", enabled: true, previews_enabled: false } });
    }, observe: async () => {
      original = await readOriginalBridge({ firestore, packet, config, source, provider, api, target });
      if (!original.domain) refuse(); return original.domain;
    } });
  }
  if (!same(await access(), packet.accessReadback)) refuse();
  original = await readOriginalBridge({ firestore, packet, config, source, provider, api, target });
  await assertOriginalDomain(firestore, packet, key, domainSeal, original.domain);
  await ingress();
  return { operationId: packet.operationId, role: packet.role, enabled: packet.enabled ?? false,
    domainClaimState: original.domain ? "observed" : claim.exists && claim.data().notSent === true ? "known-not-sent" : "not-requested", ...original };
}
export async function runPrivateBridgeOperator(args, { readToken = operatorCredentialStream(0), readServiceAccount = operatorCredentialStream(3),
  openDatabase = openOperatorDatabase, fetchImpl = fetch, signal } = {}) {
  const options = parseOperatorArgs(args), packet = parsePrivateBridgePacket(await readOperatorPacket(options));
  signal?.throwIfAborted(); assertOperatorSource(packet.operatorCommitSha);
  const { config } = privateBridgeConfiguration(packet), source = await compilePrivateWorker(config.main);
  if (hash(source) !== packet.sourceDigest) refuse();
  if (options.mode === "plan") return { mode: "plan", role: packet.role, enabled: packet.enabled ?? false, sourceDigest: packet.sourceDigest, providerWrites: 0, authorityReads: 0, authorityWrites: 0 };
  const accountCredential = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  signal?.throwIfAborted(); const connection = await openDatabase(accountCredential);
  try { signal?.throwIfAborted(); return { mode: options.mode, ...await installPrivatePairBridge({ firestore: connection.firestore, packet,
    readToken, fetchImpl, signal, readback: options.mode === "readback" }) }; }
  finally { await connection.close(); }
}
