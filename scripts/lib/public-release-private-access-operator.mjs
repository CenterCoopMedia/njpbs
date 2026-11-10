import protocol from "../../functions/lib/public-release-pair.js";
import targets from "../../functions/lib/publication-target.js";
import { privateInstallLedger } from "./public-release-private-install-ledger.mjs";
import { PrivateProviderNotSent } from "./public-release-private-provider.mjs";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";

const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const secretRef = value => typeof value === "string" && /^pass:\/\/[A-Za-z0-9/_-]{1,200}$/.test(value);
export function parsePrivateAccessPacket(value) {
  protocol.exact(value, ["schemaVersion", "kind", "operatorCommitSha", "environment", "operationId", "accountId", "credentialIdentity", "providerCredentialRef", "targets"]);
  if (value.schemaVersion !== 1 || value.kind !== "private-pair-access-operator" || !/^[a-f0-9]{40}$/.test(value.operatorCommitSha ?? "") ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.operationId ?? "") || value.accountId !== accountId || !secretRef(value.providerCredentialRef) ||
      !Array.isArray(value.targets) || value.targets.length !== 3) refuse();
  parseOperatorCredentialIdentity(value.credentialIdentity, value.environment);
  for (const [index, target] of value.targets.entries()) {
    protocol.exact(target, ["role", "origin", "serviceTokenId", "clientId", "credentialRef"]);
    if (target.role !== ["old-reader", "new-reader", "operator"][index] || !uuid(target.serviceTokenId) ||
        !/^[A-Za-z0-9]+\.access$/.test(target.clientId ?? "") || !secretRef(target.credentialRef)) refuse();
    const prefix = value.environment === "development" ? "dev-" : "";
    const kind = index === 2 ? "operator" : "reader";
    if (!new RegExp(`^https://${prefix}pair-${kind}-[a-z0-9][a-z0-9-]{0,39}\\.njpbs\\.org$`).test(target.origin ?? "")) refuse();
  }
  for (const key of ["origin", "serviceTokenId", "clientId", "credentialRef"]) if (new Set(value.targets.map(row => row[key])).size !== 3) refuse();
  return protocol.freeze(structuredClone(value));
}
/** Fixed provider origin/account, bounded envelopes, no redirect, raw response
 * logging, service-token creation, secret read, update, delete or route effect. */
export function privateAccessProvider({ readToken, fetchImpl = fetch, signal }) {
  const request = async (path, body) => {
    let token;
    try {
    signal?.throwIfAborted();
    if (body && ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"].some(key => Object.hasOwn(process.env, key))) {
      // Tests substitute only fetch; their real SDK project is demo-only. The
      // actual operator opener refuses all emulator variables before this point.
      // No production transport may be invoked from an emulator process.
      if (fetchImpl === fetch) refuse();
    }
    token = await readToken(); signal?.throwIfAborted();
    } catch { throw new PrivateProviderNotSent(); }
    let response;
    try { response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/access${path}`, {
      method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal }); } catch { refuse(); }
    const reader = response.body?.getReader(); if (!reader) refuse();
    let size = 0; const chunks = [];
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length; if (size > 256 * 1024) refuse(); chunks.push(chunk.value); }
    } finally { await reader.cancel().catch(() => {}); }
    if (!response.ok) refuse();
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { refuse(); }
    if (value.success !== true || !Object.hasOwn(value, "result")) refuse();
    if (Array.isArray(value.result) && (value.result.length >= 100 || value.result_info?.total_pages > 1 ||
        value.result_info?.total_count > value.result.length)) refuse();
    return value.result;
  };
  const apps = async () => { const rows = await request("/apps?per_page=100&page=1"); if (!Array.isArray(rows)) refuse(); return rows; };
  const policies = async id => { if (!uuid(id)) refuse(); const rows = await request(`/apps/${id}/policies?per_page=100&page=1`); if (!Array.isArray(rows)) refuse(); return rows; };
  return { apps, policies,
    token: async id => { if (!uuid(id)) refuse(); const row = await request(`/service_tokens/${id}`);
      if (row?.id !== id || row.enabled !== undefined && row.enabled !== true || !/^[A-Za-z0-9]+\.access$/.test(row.client_id ?? "") || !(Date.parse(row.expires_at) > Date.now())) refuse();
      return { id: row.id, clientId: row.client_id }; },
    createApp: body => request("/apps", body),
    createPolicy: (id, body) => { if (!uuid(id)) refuse(); return request(`/apps/${id}/policies`, body); },
  };
}
function description(packet, target) {
  const digest = protocol.publicReleaseDigest({ packet, target }), name = `njpbs-pair-${target.role}-${digest.slice(0, 24)}`;
  const domain = new URL(target.origin).hostname;
  const app = { name, domain, type: "self_hosted", session_duration: "15m", app_launcher_visible: false, auto_redirect_to_identity: false };
  const policy = { name, decision: "non_identity", precedence: 1, include: [{ service_token: { token_id: target.serviceTokenId } }], exclude: [], require: [] };
  return { digest, name, domain, app, policy, worker: `access:${domain}` };
}
function applicationOverlaps(row, hostname) {
  if (row.self_hosted_domains !== undefined && !Array.isArray(row.self_hosted_domains) ||
      row.destinations !== undefined && !Array.isArray(row.destinations)) refuse();
  const names = [row.domain, ...(row.self_hosted_domains ?? []),
    ...(row.destinations ?? []).filter(destination => destination.type === "public").map(destination => destination.uri)];
  return names.filter(value => value !== undefined).some(value => {
    if (typeof value !== "string") refuse();
    const normalized = value.toLowerCase().replace(/^https?:\/\//, ""), domain = normalized.split("/")[0];
    if (domain === hostname.toLowerCase()) return true;
    const pattern = domain.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return domain.includes("*") && new RegExp(`^${pattern}$`).test(hostname.toLowerCase());
  });
}
function appReceipt(row, expected) {
  if (!row || !uuid(row.id) || !/^[a-f0-9]{64}$/.test(row.aud ?? "") ||
      Object.entries(expected.app).some(([key, value]) => row[key] !== value) ||
      row.self_hosted_domains?.length && !same(row.self_hosted_domains, [expected.domain])) refuse();
  return { applicationId: row.id, audience: row.aud, name: row.name, domain: row.domain };
}
function policyReceipt(rows, expected) {
  if (rows.length !== 1 || !uuid(rows[0].id) || Object.entries(expected.policy).some(([key, value]) => !same(rows[0][key], value))) refuse();
  return { policyId: rows[0].id, policyDigest: protocol.publicReleaseDigest(expected.policy) };
}
function assertDatabase(firestore, environment) {
  if (/^demo-[a-z0-9-]+$/.test(firestore.projectId ?? "") && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) return;
  targets.assertPublicationDatabase(firestore, targets.publicationTarget(environment));
}
export async function installPrivatePairAccess({ firestore, packet: raw, readToken, fetchImpl, signal, readback = false }) {
  const packet = parsePrivateAccessPacket(raw); assertDatabase(firestore, packet.environment);
  const provider = privateAccessProvider({ readToken, fetchImpl, signal }), ledger = privateInstallLedger(firestore);
  const packetDigest = protocol.publicReleaseDigest(packet), namespace = "system/publicReleasePrivateInstalls";
  if (!readback) await ledger.bindAttempt(packet.operationId, packetDigest);
  else {
    const plan = (await firestore.doc(`${namespace}/plans/${packet.operationId}`).get()).data();
    if (!plan) return { original: false, targets: [] };
    if (!same(plan, { schemaVersion: 1, attemptId: packet.operationId, planDigest: packetDigest })) refuse();
  }
  const results = [];
  for (const target of packet.targets) {
    signal?.throwIfAborted();
    const expected = description(packet, target), key = protocol.publicReleaseDigest({ worker: expected.worker });
    const seal = { schemaVersion: 1, attemptId: packet.operationId, worker: expected.worker, planDigest: expected.digest };
    const paths = ["access-app", "access-policy"].map(action => `${namespace}/attempts/${packet.operationId}/steps/${key}-${action}`);
    const [owner, appStep, policyStep, ...receipts] = await firestore.runTransaction(tx => tx.getAll(firestore.doc(`${namespace}/workers/${key}`),
      ...paths.map(path => firestore.doc(path)), ...["access-app", "access-policy"].map(action =>
        firestore.doc(`${namespace}/attempts/${packet.operationId}/readbacks/${key}-${action}`))));
    const steps = [appStep, policyStep];
    if (receipts.some((receipt, index) => receipt.exists && (!steps[index].exists || steps[index].data().notSent === true))) refuse();
    if (owner.exists && !same(owner.data(), seal) || steps.some(row => row.exists) && !owner.exists) refuse();
    for (const [index, step] of steps.entries()) if (step.exists &&
      !same(step.data(), { ...seal, action: ["access-app", "access-policy"][index] }) &&
      !same(step.data(), { ...seal, action: ["access-app", "access-policy"][index], notSent: true })) refuse();
    if (readback && (!steps[0].exists || steps[0].data().notSent === true)) {
      results.push({ role: target.role, original: false, ...steps[0].exists ? { notSent: true } : {} }); continue;
    }
    if (!same(await provider.token(target.serviceTokenId), { id: target.serviceTokenId, clientId: target.clientId })) refuse();
    const observed = async () => {
      const matches = (await provider.apps()).filter(row => row.name === expected.name || applicationOverlaps(row, expected.domain));
      if (matches.length !== 1) refuse(); return appReceipt(matches[0], expected);
    };
    if (readback) {
      const application = await observed();
      if (!same(receipts[0].data(), { ...seal, action: "access-app", result: application })) refuse();
      const policyNotSent = steps[1].exists && steps[1].data().notSent === true;
      const policies = await provider.policies(application.applicationId);
      if ((!steps[1].exists || policyNotSent) && policies.length) refuse();
      const policy = steps[1].exists && !policyNotSent ? policyReceipt(policies, expected) : null;
      if (policy && !same(receipts[1].data(), { ...seal, action: "access-policy", result: policy })) refuse();
      results.push({ role: target.role, original: true, origin: target.origin, clientId: target.clientId, ...application, policy,
        ...policyNotSent ? { policyNotSent: true } : {}, ...!steps[1].exists ? { policyUnclaimed: true } : {} }); continue;
    }
    if (!steps[0].exists || steps[0].data().notSent === true) {
      // Refuse foreign or overlapping applications before recording authority.
      if ((await provider.apps()).some(row => row.name === expected.name || applicationOverlaps(row, expected.domain))) refuse();
    }
    const application = await ledger.once({ attemptId: packet.operationId, worker: expected.worker, planDigest: expected.digest,
      action: "access-app", effect: () => provider.createApp(expected.app), observe: observed });
    // Complete the read-only precheck before reserving a one-shot POST. A
    // transient GET failure must leave the original policy grant unconsumed.
    if ((!steps[1].exists || steps[1].data().notSent === true) && (await provider.policies(application.applicationId)).length) refuse();
    const policy = await ledger.once({ attemptId: packet.operationId, worker: expected.worker, planDigest: expected.digest,
      action: "access-policy", effect: () => provider.createPolicy(application.applicationId, expected.policy),
      observe: async () => policyReceipt(await provider.policies(application.applicationId), expected) });
    if (!same(await observed(), application) || !same(policyReceipt(await provider.policies(application.applicationId), expected), policy)) refuse();
    results.push({ role: target.role, origin: target.origin, clientId: target.clientId, ...application, policy });
  }
  return { original: true, operationId: packet.operationId, packetDigest, targets: results };
}
export async function runPrivateAccessOperator(args, { readToken = operatorCredentialStream(0), readServiceAccount = operatorCredentialStream(3),
  openDatabase = openOperatorDatabase, fetchImpl = fetch, signal } = {}) {
  const options = parseOperatorArgs(args); signal?.throwIfAborted();
  const packet = parsePrivateAccessPacket(await readOperatorPacket(options)); assertOperatorSource(packet.operatorCommitSha);
  if (options.mode === "plan") return { mode: "plan", authorityReads: 0, authorityWrites: 0, providerWrites: 0,
    targets: packet.targets.map(row => ({ role: row.role, origin: row.origin, clientId: row.clientId })) };
  const account = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  signal?.throwIfAborted(); const connection = await openDatabase(account);
  try { signal?.throwIfAborted(); return { mode: options.mode, ...await installPrivatePairAccess({ firestore: connection.firestore, packet,
    readToken, fetchImpl, signal, readback: options.mode === "readback" }) }; }
  finally { await connection.close(); }
}
