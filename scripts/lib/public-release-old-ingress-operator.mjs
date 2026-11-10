import { createHash } from "node:crypto";
import protocol from "../../functions/lib/public-release-pair.js";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import work from "../../functions/lib/public-release-pair-work.js";
import targets from "../../functions/lib/publication-target.js";
import { configurePublicReleaseIngress } from "../configure-public-release-ingress.mjs";
import { compilePrivateWorker } from "../install-private-public-release.mjs";
import { privatePublicReleaseSlotTarget, readPrivatePublicReleaseSlotProvider } from "./private-public-release-slot-target.mjs";
import { privateInstallLedger } from "./public-release-private-install-ledger.mjs";
import { cloudflarePrivatePairProvider, privateWorkerMetadata } from "./public-release-private-provider.mjs";
import { operatorCloudflareApi } from "./public-release-private-bridge-operator.mjs";
import { oldIngressRateControlTarget, readReviewedIngressRateControls, assertReviewedCmsRpcRateControl } from "./public-release-old-ingress-rate-control.mjs";
import { readClosedInitialIngressAuthority } from "./public-release-bootstrap-ingress-authority.mjs";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";
const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? ""), hash = protocol.publicReleaseDigest, same = (a, b) => hash(a) === hash(b);
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? "");
export function oldIngressConfiguration(raw) {
  const enabled = Object.hasOwn(raw ?? {}, "enableOldIngress");
  protocol.exact(raw, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "providerCredentialRef", "operationId", "bootstrapAttempt",
    "installPlan", "originalIngressVersionId", "originalIngressDeploymentId", "route", ...enabled ? ["enableOldIngress"] : []]);
  const attempt = bootstrap.parseBootstrapAttempt(raw.bootstrapAttempt), target = targets.publicationTarget(attempt.currentPair.environment);
  // Development retains the staff Access gateway on its canonical route. Its
  // adoption needs that owner's separate binding, never a public route swap.
  if (target.environment !== "production") refuse();
  parseOperatorCredentialIdentity(raw.credentialIdentity, target.environment);
  if (raw.schemaVersion !== 1 || raw.kind !== "old-only-ingress-operator" || !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? "") ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(raw.operationId ?? "") || !/^pass:\/\/[A-Za-z0-9/_-]{1,200}$/.test(raw.providerCredentialRef ?? "") ||
      !uuid(raw.originalIngressVersionId) || !uuid(raw.originalIngressDeploymentId) || enabled && typeof raw.enableOldIngress !== "boolean") refuse();
  const plan = raw.installPlan;
  for (const pair of [attempt.currentPair, attempt.recoveryPair]) privatePublicReleaseSlotTarget({ pair, installPlan: plan });
  if (plan.accountId !== account || plan.slotEnabled[0] !== true) refuse();
  const route = raw.route; protocol.exact(route, ["zoneId", "routeId", "pattern", "legacyWorker", "legacyVersionId", "legacyDeploymentId"]);
  if (!/^[a-f0-9]{32}$/.test(route.zoneId ?? "") || !/^[a-f0-9]{32}$/.test(route.routeId ?? "") || route.pattern !== `${target.origin}/*` ||
      route.legacyWorker !== target.workerName || !uuid(route.legacyVersionId) || !uuid(route.legacyDeploymentId)) refuse();
  const original = configurePublicReleaseIngress({ oldPair: attempt.currentPair, newPair: attempt.recoveryPair, accountId: account, ingressName: plan.ingressName });
  const config = { ...original, vars: { ...original.vars, PUBLIC_PAIR_INGRESS_ENABLED: String(raw.enableOldIngress ?? false) } };
  // The bootstrap pair restriction is always OLD, including the enabled version.
  if (config.vars.PUBLIC_PAIR_BOOTSTRAP_ID !== attempt.currentPair.pairId) refuse();
  return { packet: protocol.freeze(structuredClone(raw)), attempt, original, config, target };
}
export function identity(packet, original, rateControlDigest) {
  const { main, ...portable } = original;
  const originalDigest = hash({ config: portable, sourceDigest: packet.installPlan.ingressBundleDigest });
  const planDigest = hash({ packet, rateControlDigest }), tag = hash({ operationId: packet.operationId, planDigest });
  return { planDigest, tag, originalDigest, originalTag: hash({ attemptId: packet.installPlan.operationId, planDigest: originalDigest }), worker: `bootstrap-ingress:${original.name}` };
}
export function checkVersion(version, config, tag, expectedVersionId) {
  const metadata = privateWorkerMetadata(config, tag);
  const bindings = version.resources?.bindings?.map(binding => {
    const row = { ...binding }; if (row.type === "service" && row.environment === "production") delete row.environment; return row;
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (version.id !== expectedVersionId || version.annotations?.["workers/message"] !== `private-pair:${tag}` || !same(bindings, metadata.bindings) ||
      version.resources?.script_runtime?.compatibility_date !== metadata.compatibility_date ||
      !same(version.resources?.script_runtime?.compatibility_flags, metadata.compatibility_flags)) refuse();
}
export async function originalInstall(firestore, packet, original, id, provider, signal) {
  const base = "system/publicReleasePrivateInstalls", workerKey = hash({ worker: original.name }), actions = ["create", "upload", "private-subdomain", "deploy"];
  const seal = { schemaVersion: 1, attemptId: packet.installPlan.operationId, worker: original.name, planDigest: id.originalDigest };
  const [plan, owner, ...rows] = await firestore.runTransaction(tx => tx.getAll(firestore.doc(`${base}/plans/${packet.installPlan.operationId}`),
    firestore.doc(`${base}/workers/${workerKey}`), ...actions.flatMap(action => [
      firestore.doc(`${base}/attempts/${packet.installPlan.operationId}/steps/${workerKey}-${action}`),
      firestore.doc(`${base}/attempts/${packet.installPlan.operationId}/readbacks/${workerKey}-${action}`)])));
  if (!same(plan.data(), { schemaVersion: 1, attemptId: packet.installPlan.operationId, planDigest: hash(packet.installPlan) }) || !same(owner.data(), seal)) refuse();
  for (const [i, action] of actions.entries()) {
    if (!same(rows[i * 2].data(), { ...seal, action })) refuse();
    const receipt = rows[i * 2 + 1].data(); protocol.exact(receipt, [...Object.keys(seal), "action", "result"]);
    if (!same({ ...receipt, result: null }, { ...seal, action, result: null })) refuse();
  }
  const worker = await provider.worker(original.name, signal);
  if (!worker || !same(rows[1].data().result, { workerId: worker.id, name: original.name, tag: id.originalTag }) ||
      worker.name !== original.name || !same(worker.tags, [`private-pair:${id.originalTag}`]) ||
      !same(rows[3].data().result, { versionId: packet.originalIngressVersionId }) || !same(rows[5].data().result, { private: true }) ||
      !same(rows[7].data().result, { versionId: packet.originalIngressVersionId, deploymentId: packet.originalIngressDeploymentId })) refuse();
  checkVersion(await provider.version(original.name, packet.originalIngressVersionId, signal), original, id.originalTag, packet.originalIngressVersionId);
  const exposure = await provider.subdomain(original.name, signal);
  if (exposure.enabled !== false || exposure.previews_enabled !== false) refuse();
}
export async function enableOldPublicReleaseIngress({ firestore, packet: raw, readToken, fetchImpl, signal, readback = false }) {
  const { packet, attempt, original, config } = oldIngressConfiguration(raw);
  work.assertPublicReleasePairDatabase(firestore, attempt.currentPair);
  const source = await compilePrivateWorker(config.main);
  if (createHash("sha256").update(source).digest("hex") !== packet.installPlan.ingressBundleDigest) refuse();
  const api = operatorCloudflareApi({ readToken, fetchImpl, signal });
  const provider = cloudflarePrivatePairProvider({ accountId: account, credential: readToken, fetcher: fetchImpl });
  const ledger = privateInstallLedger(firestore), name = original.name, base = "system/publicReleasePrivateInstalls";
  const oldTarget = privatePublicReleaseSlotTarget({ pair: attempt.currentPair, installPlan: packet.installPlan });
  const rateTarget = oldIngressRateControlTarget({ packet, attempt, original, config, oldTarget });
  const readRateControls = () => readReviewedIngressRateControls({ firestore, target: rateTarget, signal });
  const rateControls = await readRateControls(), id = identity(packet, original, rateControls.digest);
  const authority = async () => {
    const held = await readClosedInitialIngressAuthority({ firestore, attempt, signal }), current = await readRateControls();
    if (current.digest !== rateControls.digest) refuse();
    await assertReviewedCmsRpcRateControl({ evidence: current, api });
    return { ...held, rateControlDigest: current.digest };
  };
  const first = readback ? null : await authority();
  const oldSlot = () => readPrivatePublicReleaseSlotProvider({ target: oldTarget, readToken, fetchImpl, signal });
  await oldSlot();
  const guard = async () => { if (!same(await authority(), first)) refuse(); };
  const routeRead = async () => {
    const zone = await api(`/zones/${packet.route.zoneId}`);
    if (zone?.id !== packet.route.zoneId || zone.name !== "njpbs.org" || zone.account?.id !== account) refuse();
    const route = await api(`/zones/${packet.route.zoneId}/workers/routes/${packet.route.routeId}`);
    if (route?.id !== packet.route.routeId || route.pattern !== packet.route.pattern || ![packet.route.legacyWorker, name].includes(route.script)) refuse();
    const domains = await api(`/accounts/${account}/workers/domains`), routes = await api(`/zones/${packet.route.zoneId}/workers/routes`);
    if (!Array.isArray(domains) || domains.some(row => row.service === name) || !Array.isArray(routes) ||
        routes.some(row => row.script === name && (row.id !== packet.route.routeId || row.pattern !== packet.route.pattern))) refuse();
    return { id: route.id, pattern: route.pattern, script: route.script };
  };
  const uploaded = async () => {
    const versions = await provider.versions(name, signal);
    if (!versions.some(row => row.id === packet.originalIngressVersionId) || versions.some(row => row.id !== packet.originalIngressVersionId && row.annotations?.["workers/message"] !== `private-pair:${id.tag}`)) refuse();
    const matches = versions.filter(row => row.annotations?.["workers/message"] === `private-pair:${id.tag}`);
    if (matches.length !== 1 || !uuid(matches[0].id)) refuse();
    checkVersion(await provider.version(name, matches[0].id, signal), config, id.tag, matches[0].id);
    return { versionId: matches[0].id };
  };
  if (readback) {
    const plan = (await firestore.doc(`${base}/plans/${packet.operationId}`).get()).data();
    if (!plan) return { operationId: packet.operationId, original: false, complete: false };
    if (!same(plan, { schemaVersion: 1, attemptId: packet.operationId, planDigest: id.planDigest })) refuse();
    await originalInstall(firestore, packet, original, id, provider, signal);
    const version = await uploaded(), active = await provider.deployment(name, signal), route = await routeRead();
    if (!uuid(active?.id) || active.versions?.length !== 1 || active.versions[0].percentage !== 100 ||
        !(active.id === packet.originalIngressDeploymentId && active.versions[0].version_id === packet.originalIngressVersionId ||
        active.annotations?.["workers/message"] === `private-pair:${id.tag}` && active.versions[0].version_id === version.versionId)) refuse();
    const complete = active.annotations?.["workers/message"] === `private-pair:${id.tag}` && active.versions[0].version_id === version.versionId && route.script === name;
    return { operationId: packet.operationId, original: true, historical: true, complete, versionId: version.versionId,
      deploymentId: active?.id, selectedVersionId: active?.versions?.[0]?.version_id, route };
  }
  if (packet.enableOldIngress !== true) refuse();
  await originalInstall(firestore, packet, original, id, provider, signal);
  const ownerKey = hash({ worker: id.worker });
  const [owner, deployClaim] = await firestore.runTransaction(tx => tx.getAll(firestore.doc(`${base}/workers/${ownerKey}`),
    firestore.doc(`${base}/attempts/${packet.operationId}/steps/${ownerKey}-enable-deploy`)));
  const ownSeal = { schemaVersion: 1, attemptId: packet.operationId, worker: id.worker, planDigest: id.planDigest };
  if (owner.exists && !same(owner.data(), ownSeal) || deployClaim.exists && !owner.exists) refuse();
  const current = await provider.deployment(name, signal);
  const originalActive = current?.id === packet.originalIngressDeploymentId &&
    same(current.versions, [{ version_id: packet.originalIngressVersionId, percentage: 100 }]) && current.annotations?.["workers/message"] === `private-pair:${id.originalTag}`;
  if (!uuid(current?.id) || !originalActive && (!deployClaim.exists || current?.annotations?.["workers/message"] !== `private-pair:${id.tag}` ||
      !same(current.versions, [{ version_id: (await uploaded()).versionId, percentage: 100 }]))) refuse();
  const route = await routeRead();
  if (route.script === packet.route.legacyWorker) {
    const prior = await api(`/accounts/${account}/workers/scripts/${packet.route.legacyWorker}/deployments`), rows = prior.deployments ?? prior;
    if (!Array.isArray(rows) || rows[0]?.id !== packet.route.legacyDeploymentId || !same(rows[0]?.versions, [{ version_id: packet.route.legacyVersionId, percentage: 100 }])) refuse();
  }
  await guard(); await ledger.bindAttempt(packet.operationId, id.planDigest);
  const step = (action, effect, observe) => ledger.once({ attemptId: packet.operationId, worker: id.worker, planDigest: id.planDigest, action, effect, observe });
  await guard();
  const version = await step("enable-upload", () => provider.upload(name, privateWorkerMetadata(config, id.tag), source, signal), uploaded);
  await guard();
  const deployed = async () => {
    const row = await provider.deployment(name, signal);
    if (!uuid(row?.id) || row.annotations?.["workers/message"] !== `private-pair:${id.tag}` || !same(row.versions, [{ version_id: version.versionId, percentage: 100 }]) ||
        await provider.sourceDigest(name, signal) !== packet.installPlan.ingressBundleDigest) refuse();
    return { deploymentId: row.id, versionId: version.versionId };
  };
  const deployment = await step("enable-deploy", () => provider.deploy(name, version.versionId, id.tag, signal), deployed);
  await guard();
  const beforeRoute = await routeRead(), routeKey = hash({ worker: id.worker });
  const routeClaim = (await firestore.doc(`${base}/attempts/${packet.operationId}/steps/${routeKey}-enable-route`).get()).exists;
  if (!routeClaim && beforeRoute.script !== packet.route.legacyWorker) refuse();
  await oldSlot(); await guard();
  const selected = await step("enable-route", () => api(`/zones/${packet.route.zoneId}/workers/routes/${packet.route.routeId}`, {
    method: "PUT", body: { pattern: packet.route.pattern, script: name } }), async () => {
    const row = await routeRead(); if (row.script !== name) refuse(); return row;
  });
  await guard(); await oldSlot(); if (!same(await deployed(), deployment)) refuse();
  return { operationId: packet.operationId, complete: true, oldPairId: attempt.currentPair.pairId, ...deployment, route: selected, authority: first,
    admissionResumed: false, terminalPublicationProof: false };
}
export async function runOldIngressOperator(args, { readToken = operatorCredentialStream(0), readServiceAccount = operatorCredentialStream(3),
  openDatabase = openOperatorDatabase, fetchImpl = fetch, signal } = {}) {
  const options = parseOperatorArgs(args), { packet, attempt, config } = oldIngressConfiguration(await readOperatorPacket(options));
  signal?.throwIfAborted(); assertOperatorSource(packet.operatorCommitSha);
  const source = await compilePrivateWorker(config.main);
  if (createHash("sha256").update(source).digest("hex") !== packet.installPlan.ingressBundleDigest) refuse();
  if (options.mode === "plan") return { mode: "plan", enableOldIngress: packet.enableOldIngress ?? false, oldPairId: attempt.currentPair.pairId,
    authorityReads: 0, authorityWrites: 0, providerWrites: 0 };
  if (options.mode === "apply" && packet.enableOldIngress !== true) refuse();
  const accountCredential = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  signal?.throwIfAborted(); const connection = await openDatabase(accountCredential);
  try { signal?.throwIfAborted(); return { mode: options.mode, ...await enableOldPublicReleaseIngress({ firestore: connection.firestore, packet,
    readToken, fetchImpl, signal, readback: options.mode === "readback" }) }; }
  finally { await connection.close(); }
}
