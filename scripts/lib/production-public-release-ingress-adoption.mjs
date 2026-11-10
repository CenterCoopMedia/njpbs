import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import pins from "../../functions/lib/cms-publication-runtime-control.js";
import { compilePrivateWorker } from "../install-private-public-release.mjs";
import { oldIngressConfiguration, identity, checkVersion, originalInstall } from "./public-release-old-ingress-operator.mjs";
import { oldIngressRateControlTarget, readReviewedIngressRateControls, assertReviewedCmsRpcRateControl } from "./public-release-old-ingress-rate-control.mjs";
import { privatePublicReleaseSlotTarget, readPrivatePublicReleaseSlotProvider } from "./private-public-release-slot-target.mjs";
import { privateInstallLedger } from "./public-release-private-install-ledger.mjs";
import { cloudflarePrivatePairProvider, privateWorkerMetadata } from "./public-release-private-provider.mjs";
import { operatorCloudflareApi } from "./public-release-private-bridge-operator.mjs";
import { openProductionInstallSdk } from "./production-install-binding.mjs";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  operatorCredentialStream } from "./public-release-operator-io.mjs";
const { require: native } = createRequire(new URL("../../site/package.json", import.meta.url))("tsx/cjs/api");
const resume = native("../../site/scripts/public-release-bootstrap-logged-resume.ts", import.meta.url);
const hash = protocol.publicReleaseDigest, same = (a, b) => hash(a) === hash(b);
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? "");
const base = "system/publicReleasePrivateInstalls";

export function productionIngressAdoptionConfiguration(raw) {
  protocol.exact(raw, ["schemaVersion", "kind", "operatorCommitSha", "operationId", "oldIngressPacket", "resumeAttempt", "adoptIngress"]);
  const old = oldIngressConfiguration(raw.oldIngressPacket), resumed = resume.parseBootstrapResumeAttempt(raw.resumeAttempt);
  if (raw.schemaVersion !== 1 || raw.kind !== "production-public-release-ingress-adoption" ||
      !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? "") || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(raw.operationId ?? "") ||
      typeof raw.adoptIngress !== "boolean" || old.packet.enableOldIngress !== true || !same(resumed.bootstrap, old.attempt) ||
      old.packet.route.zoneId !== (process.env.CLOUDFLARE_PUBLIC_ZONE_ID ?? "") || old.packet.route.routeId !== (process.env.CLOUDFLARE_PUBLIC_ROUTE_ID ?? "") ||
      [old.packet.operationId, old.packet.installPlan.operationId, old.attempt.operationId, resumed.operationId].includes(raw.operationId) ||
      old.packet.installPlan.slotEnabled.some(value => value !== true)) refuse();
  // Only this separately invoked boundary removes OLD's restriction. The
  // compiled ingress, rate limiter, services, pairs and storage stay identical.
  const config = { ...old.config, vars: { ...old.config.vars, PUBLIC_PAIR_BOOTSTRAP_ID: "", PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED: "true" } };
  return { ...old, packet: protocol.freeze(structuredClone(raw)), oldPacket: old.packet, resumed, config };
}

async function resumedOldAuthority(firestore, parsed, signal) {
  const { attempt, resumed } = parsed, pairs = [attempt.currentPair, attempt.recoveryPair];
  const receipt = await resume.readBootstrapResumeReceipt({ firestore, attempt: resumed });
  if (!receipt) refuse();
  return firestore.runTransaction(async tx => {
    signal?.throwIfAborted();
    const paths = ["system/publicDeployment", "system/publicReleaseAdmissions/controls/bootstrapFence",
      "system/publicDeployment/releaseWriter/fence", "system/publicReleaseAdmissions/controls/adoption", "system/publicReleaseChangeLog",
      "system/cmsPublicationRuntime", "system/billing", `system/publicDeployment/bootstrapSelectors/${attempt.operationId}`,
      ...pairs.flatMap(pair => [work.publicReleasePairPath(pair.pairId), `${work.publicReleasePairPath(pair.pairId)}/controls/runtime`])];
    const rows = await tx.getAll(...paths.map(path => firestore.doc(path))), values = rows.map(row => row.data() ?? null);
    const root = protocol.parseStoredPublicReleaseSelector(values[0]), runtime = pins.parseCmsPublicationRuntimeControl(values[5]);
    if (root.epoch !== 1 || root.switchOperationId !== attempt.operationId || root.priorSelectorDigest !== attempt.expectedSourceDigest ||
        root.admittedContractDigest !== attempt.admittedContractDigest || !same(root.selectedPair, protocol.publicReleasePairReference(pairs[0])) ||
        !same(root.recoveryPair, protocol.publicReleasePairReference(pairs[1])) || values[1]?.status !== "open" ||
        values[1].resumeReceiptDigest !== hash(receipt) || rows[2].exists || !same(values[3], receipt.adoption) ||
        !same(values[3], { schemaVersion: 2, enabled: true }) || !same(values[4], receipt.producer) || values[4]?.enabled !== true ||
        !same(values[4].pair, root.selectedPair) || values[6]?.disabled === true || hash(values[7]) !== receipt.bootstrapReceiptDigest ||
        values[7]?.attemptDigest !== hash(attempt) || [runtime, runtime.cloud].some(pin => pin?.phase !== "ready" ||
          pin.commitSha !== pairs[0].commitSha || pin.serializerId !== "cloudflare-publisher")) refuse();
    for (const [i, pair] of pairs.entries()) if (!same(protocol.parsePublicReleasePair(values[8 + i * 2]), pair) ||
        !same(values[9 + i * 2], { schemaVersion: 2, pairId: pair.pairId, status: "retained" })) refuse();
    // Content may advance while staff publish. Adoption never freezes or writes
    // a content head; a different code epoch, control or original receipt stops it.
    return { resumeDigest: hash(receipt), controlsDigest: hash(values.slice(1, 6)), pairsDigest: hash(values.slice(8)),
      bootstrapReceiptDigest: hash(values[7]) };
  }, { readOnly: true });
}

/** Immutable provider effects use the native original-attempt ledger. No route,
 * selector, admission, credential grant or recovery object is written here. */
export async function adoptProductionPublicReleaseIngress({ firestore, packet: raw, readToken, fetchImpl = fetch, signal,
  mode = "apply" }) {
  const parsed = productionIngressAdoptionConfiguration(raw), { packet, oldPacket, attempt, original, config } = parsed;
  if (!["plan", "apply", "readback"].includes(mode)) refuse();
  if (mode === "plan") return { mode, adoptIngress: packet.adoptIngress, authorityReads: 0, authorityWrites: 0, providerWrites: 0 };
  if (mode === "apply" && packet.adoptIngress !== true) refuse();
  work.assertPublicReleasePairDatabase(firestore, attempt.currentPair); signal?.throwIfAborted();
  const source = await compilePrivateWorker(config.main), sourceDigest = createHash("sha256").update(source).digest("hex");
  if (sourceDigest !== oldPacket.installPlan.ingressBundleDigest) refuse();
  const api = operatorCloudflareApi({ readToken, fetchImpl, signal });
  const provider = cloudflarePrivatePairProvider({ accountId: oldPacket.installPlan.accountId, credential: readToken, fetcher: fetchImpl });
  const targets = [attempt.currentPair, attempt.recoveryPair].map(pair => privatePublicReleaseSlotTarget({ pair, installPlan: oldPacket.installPlan }));
  const old = oldIngressConfiguration(oldPacket);
  const rateTarget = oldIngressRateControlTarget({ ...old, oldTarget: targets[0] });
  const rate = await readReviewedIngressRateControls({ firestore, target: rateTarget, signal });
  const predecessor = identity(oldPacket, original, rate.digest), name = original.name;
  const { main: _main, ...portable } = config;
  const planDigest = hash({ packet, rateControlDigest: rate.digest, configuration: portable, sourceDigest });
  const tag = hash({ operationId: packet.operationId, planDigest }), worker = `adopted-ingress:${name}`, key = hash({ worker });
  const seal = { schemaVersion: 1, attemptId: packet.operationId, worker, planDigest };
  await originalInstall(firestore, oldPacket, original, predecessor, provider, signal);
  // All three original enable claims AND receipts must exist; provider state
  // alone cannot turn a partially completed route swap into an adoption grant.
  const oldKey = hash({ worker: predecessor.worker }), oldSeal = { schemaVersion: 1, attemptId: oldPacket.operationId,
    worker: predecessor.worker, planDigest: predecessor.planDigest };
  const previous = await firestore.runTransaction(async tx => {
    const actions = ["enable-upload", "enable-deploy", "enable-route"];
    const rows = await tx.getAll(firestore.doc(`${base}/plans/${oldPacket.operationId}`), firestore.doc(`${base}/workers/${oldKey}`),
      ...actions.flatMap(action => [firestore.doc(`${base}/attempts/${oldPacket.operationId}/steps/${oldKey}-${action}`),
        firestore.doc(`${base}/attempts/${oldPacket.operationId}/readbacks/${oldKey}-${action}`)]));
    if (!same(rows[0].data(), { schemaVersion: 1, attemptId: oldPacket.operationId, planDigest: predecessor.planDigest }) || !same(rows[1].data(), oldSeal)) refuse();
    for (const [i, action] of actions.entries()) {
      if (!same(rows[2 + i * 2].data(), { ...oldSeal, action }) || !same({ ...rows[3 + i * 2].data(), result: null }, { ...oldSeal, action, result: null })) refuse();
    }
    const version = rows[3].data().result, deployment = rows[5].data().result, route = rows[7].data().result;
    if (!uuid(version?.versionId) || !uuid(deployment?.deploymentId) || deployment.versionId !== version.versionId ||
        !same(route, { id: oldPacket.route.routeId, pattern: oldPacket.route.pattern, script: name })) refuse();
    return { versionId: version.versionId, deploymentId: deployment.deploymentId };
  }, { readOnly: true });
  checkVersion(await provider.version(name, previous.versionId, signal), old.config, predecessor.tag, previous.versionId);
  const routeRead = async () => {
    const zone = await api(`/zones/${oldPacket.route.zoneId}`), route = await api(`/zones/${oldPacket.route.zoneId}/workers/routes/${oldPacket.route.routeId}`);
    if (zone?.id !== oldPacket.route.zoneId || zone.name !== "njpbs.org" || zone.account?.id !== config.account_id ||
        !same({ id: route?.id, pattern: route?.pattern, script: route?.script }, { id: oldPacket.route.routeId, pattern: "https://njpbs.org/*", script: name })) refuse();
    const domains = await api(`/accounts/${config.account_id}/workers/domains`), zones = await api(`/zones?account.id=${config.account_id}&page=1&per_page=50`);
    if (!Array.isArray(domains) || domains.some(row => row.service === name) || !Array.isArray(zones) || zones.length >= 50) refuse();
    for (const row of zones) {
      if (!/^[a-f0-9]{32}$/.test(row.id ?? "")) refuse();
      const routes = await api(`/zones/${row.id}/workers/routes`);
      if (!Array.isArray(routes) || routes.some(item => item.script === name && (row.id !== oldPacket.route.zoneId ||
          item.id !== route.id || item.pattern !== route.pattern))) refuse();
    }
    const exposure = await provider.subdomain(name, signal);
    if (exposure.enabled !== false || exposure.previews_enabled !== false) refuse();
    return { id: route.id, pattern: route.pattern, script: route.script };
  };
  const slots = () => Promise.all(targets.map(target => readPrivatePublicReleaseSlotProvider({ target, readToken, fetchImpl, signal })));
  const uploaded = async (optional = false) => {
    const versions = await provider.versions(name, signal), matches = versions.filter(row => row.annotations?.["workers/message"] === `private-pair:${tag}`);
    if (versions.some(row => ![oldPacket.originalIngressVersionId, previous.versionId].includes(row.id) && row.annotations?.["workers/message"] !== `private-pair:${tag}`) || matches.length > 1) refuse();
    if (!matches.length && optional) return null;
    if (matches.length !== 1 || !uuid(matches[0].id)) refuse();
    checkVersion(await provider.version(name, matches[0].id, signal), config, tag, matches[0].id);
    return { versionId: matches[0].id };
  };
  const selected = async version => {
    const deployment = await provider.deployment(name, signal);
    if (!uuid(deployment?.id)) refuse();
    const prior = deployment.id === previous.deploymentId && deployment.annotations?.["workers/message"] === `private-pair:${predecessor.tag}` &&
      same(deployment.versions, [{ version_id: previous.versionId, percentage: 100 }]);
    const adopted = version && deployment.annotations?.["workers/message"] === `private-pair:${tag}` && same(deployment.versions, [{ version_id: version.versionId, percentage: 100 }]);
    if (!prior && !adopted || await provider.sourceDigest(name, signal) !== sourceDigest) refuse();
    return { deploymentId: deployment.id, versionId: deployment.versions[0].version_id, adopted: Boolean(adopted) };
  };
  const originals = await firestore.runTransaction(tx => tx.getAll(firestore.doc(`${base}/plans/${packet.operationId}`),
    firestore.doc(`${base}/workers/${key}`), ...["adopt-upload", "adopt-deploy"].map(action => firestore.doc(`${base}/attempts/${packet.operationId}/steps/${key}-${action}`))));
  if (originals[0].exists && !same(originals[0].data(), { schemaVersion: 1, attemptId: packet.operationId, planDigest }) ||
      originals[1].exists && (!originals[0].exists || !same(originals[1].data(), seal))) refuse();
  for (const [i, action] of ["adopt-upload", "adopt-deploy"].entries()) if (originals[i + 2].exists &&
      (!originals[1].exists || !same(originals[i + 2].data(), { ...seal, action }) &&
        !same(originals[i + 2].data(), { ...seal, action, notSent: true }))) refuse();
  const version = await uploaded(true), deployment = await selected(version), route = await routeRead();
  if (version && !originals[2].exists || deployment.adopted && !originals[3].exists) refuse();
  await slots();
  if (mode === "readback") {
    await assertReviewedCmsRpcRateControl({ evidence: rate, api });
    // Read-only G6 gate: configuration evidence is current even though it grants
    // no selector/publication authority. Recheck deployment after external reads.
    if (!same(await selected(version), deployment)) refuse();
    return { mode, operationId: packet.operationId, original: originals[0].exists,
      historical: true, complete: originals[0].exists && deployment.adopted, ...deployment, route,
      configurationDigest: hash(portable), sourceDigest, pairsDigest: hash([attempt.currentPair, attempt.recoveryPair]), rateControlDigest: rate.digest,
      recoveryCaptureEnabled: deployment.adopted, liveCaptureObserved: false, terminalPublicationProof: false };
  }
  const first = await resumedOldAuthority(firestore, parsed, signal);
  const guard = async () => {
    signal?.throwIfAborted();
    if (!same(await resumedOldAuthority(firestore, parsed, signal), first) ||
        (await readReviewedIngressRateControls({ firestore, target: rateTarget, signal })).digest !== rate.digest) refuse();
    await assertReviewedCmsRpcRateControl({ evidence: rate, api }); await routeRead(); await slots(); await selected(await uploaded(true));
  };
  const ledger = privateInstallLedger(firestore);
  await guard(); await ledger.bindAttempt(packet.operationId, planDigest);
  const step = (action, effect, observe) => ledger.once({ attemptId: packet.operationId, worker, planDigest, action, effect, observe });
  const next = await step("adopt-upload", () => provider.upload(name, privateWorkerMetadata(config, tag), source, signal), uploaded);
  await guard();
  const deployed = async () => { const row = await selected(next); if (!row.adopted) refuse(); return { deploymentId: row.deploymentId, versionId: next.versionId }; };
  const result = await step("adopt-deploy", () => provider.deploy(name, next.versionId, tag, signal), deployed);
  await guard(); if (!same(await deployed(), result)) refuse();
  return { mode, operationId: packet.operationId, complete: true, ...result, route, rateControlDigest: rate.digest,
    recoveryCaptureEnabled: true, liveCaptureObserved: false, terminalPublicationProof: false, selectorChanged: false };
}

export async function runProductionIngressAdoption(args, { readToken = operatorCredentialStream(0), openSdk = openProductionInstallSdk,
  fetchImpl = fetch, signal = AbortSignal.timeout(120_000) } = {}) {
  const options = parseOperatorArgs(args), packet = await readOperatorPacket(options), parsed = productionIngressAdoptionConfiguration(packet);
  assertOperatorSource(packet.operatorCommitSha);
  if (options.mode === "plan") return adoptProductionPublicReleaseIngress({ packet, mode: "plan" });
  if (options.mode === "apply" && packet.adoptIngress !== true) refuse();
  const connection = await openSdk(parsed.oldPacket.credentialIdentity, 3);
  try { return await adoptProductionPublicReleaseIngress({ firestore: connection.firestore, packet, readToken, fetchImpl, signal, mode: options.mode }); }
  finally { await connection.close(); }
}
