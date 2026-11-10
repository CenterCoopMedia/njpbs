import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { configurePublicReleaseIngress, configurePublicReleaseSlot } from "../configure-public-release-ingress.mjs";
import { cloudflarePrivatePairProvider, privateWorkerMetadata } from "./public-release-private-provider.mjs";
import { PRIVATE_PREFLIGHT_ATTEMPTS } from "./private-pair-preflight-caller.mjs";
import { privatePublicReleasePlanPairs } from "./private-public-release-install-plan.mjs";

const refuse = () => { throw new Error("Private public-slot target was refused"); };
const requireValue = value => { if (!value) refuse(); };
const same = (left, right) => requireValue(protocol.publicReleaseDigest(left) === protocol.publicReleaseDigest(right));
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value ?? "");
const actions = ["create", "upload", "private-subdomain", "deploy"];

/** Reconstruct the original upload configuration. Only the provider-learned
 * public version and its derived reader receipt may differ from the template. */
export function privatePublicReleaseSlotTarget({ pair: input, installPlan: plan }) {
  const development = Object.hasOwn(plan ?? {}, "developmentIngress");
  protocol.exact(plan, ["schemaVersion", "operationId", "accountId", "ingressName", "oldPair", "newPair", "slotEnabled", "readerOrigins", "readerAccess", "slotBundleDigest", "ingressBundleDigest", ...development ? ["developmentIngress"] : []]);
  requireValue([1, 2].includes(plan.schemaVersion) && /^[A-Za-z0-9_-]{1,128}$/.test(plan.operationId ?? "") &&
    protocol.digest(plan.slotBundleDigest) && protocol.digest(plan.ingressBundleDigest));
  for (const key of ["slotEnabled", "readerOrigins", "readerAccess"]) requireValue(Array.isArray(plan[key]) && plan[key].length === 2);
  requireValue(plan.readerOrigins[0] !== plan.readerOrigins[1]);
  const pair = protocol.parsePublicReleasePair(input);
  const templates = privatePublicReleasePlanPairs(plan);
  if (development && (plan.developmentIngress !== true || templates[0].environment !== "development" ||
      plan.slotEnabled.some(value => value !== true) || plan.readerAccess.some(value => value?.enabled !== true))) refuse();
  configurePublicReleaseIngress({ oldPair: templates[0], newPair: templates[1], accountId: plan.accountId, ingressName: plan.ingressName, developmentIngress: development });
  const configs = templates.map((template, index) => configurePublicReleaseSlot({ pair: template, accountId: plan.accountId,
    readerOrigin: plan.readerOrigins[index], readerAccess: plan.readerAccess[index], slotEnabled: plan.slotEnabled[index] }));
  const index = templates.findIndex(template => template.pairId === pair.pairId);
  requireValue(index !== -1);
  const template = templates[index], config = configs[index];
  same(pair, { ...template, publicWorker: { ...template.publicWorker, versionId: pair.publicWorker.versionId },
    readerReceiptDigest: pair.readerReceiptDigest });
  const deployment = { schemaVersion: 1, environment: pair.environment, service: pair.publicWorker.service,
    versionId: pair.publicWorker.versionId, commitSha: pair.commitSha, origin: plan.readerOrigins[index], contractDigest: pair.readerContractDigest };
  requireValue(protocol.publicReleaseDigest(deployment) === pair.readerReceiptDigest);
  const portableConfig = { ...config }; delete portableConfig.main;
  const planDigest = protocol.publicReleaseDigest({ config: portableConfig, sourceDigest: plan.slotBundleDigest });
  const tag = protocol.publicReleaseDigest({ attemptId: plan.operationId, planDigest });
  return protocol.freeze({ pair, config, sourceDigest: plan.slotBundleDigest, planDigest, tag,
    attemptId: plan.operationId, installPlanDigest: protocol.publicReleaseDigest(plan) });
}

/** GET-only provider readback. Reuse the transport, never its installer: no
 * create, upload, subdomain update or deployment effect is sent here. */
export async function readPrivatePublicReleaseSlotProvider({ target, readToken, fetchImpl = fetch, signal }) {
  try {
    signal?.throwIfAborted();
    const { pair, config, tag } = target, name = config.name;
    const provider = cloudflarePrivatePairProvider({ accountId: config.account_id, credential: readToken, fetcher: fetchImpl });
    const worker = await provider.worker(name, signal);
    requireValue(worker?.name === name && /^[a-f0-9]{32}$/.test(worker.id ?? "") &&
      worker.tags?.length === 1 && worker.tags[0] === `private-pair:${tag}` &&
      worker.subdomain?.enabled === false && worker.subdomain.previews_enabled === false);
    const versions = await provider.versions(name, signal);
    requireValue(versions.length === 1 && versions[0].id === pair.publicWorker.versionId &&
      versions[0].annotations?.["workers/message"] === `private-pair:${tag}`);
    const version = await provider.version(name, pair.publicWorker.versionId, signal);
    requireValue(Array.isArray(version.resources?.bindings) && version.id === pair.publicWorker.versionId &&
      version.annotations?.["workers/message"] === `private-pair:${tag}`);
    const bindings = version.resources.bindings.map(binding => {
      const normalized = { ...binding };
      if (normalized.type === "service" && normalized.environment === "production") delete normalized.environment;
      return normalized;
    }).sort((left, right) => left.name.localeCompare(right.name, "en"));
    const metadata = privateWorkerMetadata(config, tag), runtime = version.resources.script_runtime;
    same(bindings, metadata.bindings);
    requireValue(runtime?.compatibility_date === metadata.compatibility_date);
    same(runtime.compatibility_flags, metadata.compatibility_flags);
    const deployment = await provider.deployment(name, signal);
    requireValue(uuid(deployment?.id) && deployment.annotations?.["workers/message"] === `private-pair:${tag}` &&
      deployment.versions?.length === 1 && deployment.versions[0].version_id === pair.publicWorker.versionId &&
      deployment.versions[0].percentage === 100);
    requireValue(await provider.sourceDigest(name, signal) === target.sourceDigest);
    await provider.assertNoPublicRoutes(name, signal);
    const exposure = await provider.subdomain(name, signal);
    requireValue(exposure.enabled === false && exposure.previews_enabled === false);
    // Catch a deployment change during the module/configuration/private reads.
    same(await provider.deployment(name, signal), deployment);
    signal?.throwIfAborted();
    return protocol.freeze({ workerId: worker.id, versionId: version.id, deploymentId: deployment.id,
      sourceDigest: target.sourceDigest, configurationDigest: protocol.publicReleaseDigest(metadata), private: true });
  } catch { refuse(); }
}

async function readRegisteredTarget(firestore, target, rollout, preflightOperationId) {
  const { pair, attemptId, planDigest } = target, base = work.publicReleasePairPath(pair.pairId);
  const namespace = "system/publicReleasePrivateInstalls", workerKey = protocol.publicReleaseDigest({ worker: pair.publicWorker.service });
  return firestore.runTransaction(async transaction => {
    const paths = [work.PAIRS, base, `${base}/controls/runtime`, "system/billing", `${base}/rollouts/publisher`,
      `${namespace}/plans/${attemptId}`, `${namespace}/workers/${workerKey}`,
      ...actions.map(action => `${namespace}/attempts/${attemptId}/steps/${workerKey}-${action}`),
      ...actions.map(action => `${namespace}/attempts/${attemptId}/readbacks/${workerKey}-${action}`),
      `${PRIVATE_PREFLIGHT_ATTEMPTS}/${preflightOperationId}`];
    const [registry, registered, control, billing, verified, plan, owner, ...operations] =
      (await transaction.getAll(...paths.map(path => firestore.doc(path)))).map(row => row.data());
    const original = operations.pop();
    protocol.exact(registry, ["schemaVersion", "pairIds"]);
    requireValue(registry.schemaVersion === 2 && Array.isArray(registry.pairIds) && registry.pairIds.length <= 8 &&
      new Set(registry.pairIds).size === registry.pairIds.length && registry.pairIds.includes(pair.pairId));
    same(protocol.parsePublicReleasePair(registered), pair);
    protocol.exact(control, ["schemaVersion", "pairId", "status"]);
    requireValue(control.schemaVersion === 2 && control.pairId === pair.pairId && ["candidate", "retained"].includes(control.status) && billing?.disabled !== true);
    if (control.status === "retained") {
      // Retention can replay a completed original RPC, never request fresh
      // ephemeral authority. The shared caller validates its entire receipt.
      requireValue(original?.schemaVersion === 1 && original.state === "complete" &&
        original.request?.kind === "reader-installation" && original.request.operationId === preflightOperationId &&
        original.request.workerName === pair.publicWorker.service && original.request.workerVersion === pair.publicWorker.versionId);
      same(original.request.identity, pair);
    }
    same(verified, { schemaVersion: 2, pairId: pair.pairId, pairDigest: protocol.publicReleaseDigest(pair), state: "verified",
      readbackDigest: protocol.publicReleaseDigest(rollout) });
    same(plan, { schemaVersion: 1, attemptId, planDigest: target.installPlanDigest });
    const seal = { schemaVersion: 1, attemptId, worker: pair.publicWorker.service, planDigest };
    same(owner, seal);
    const receipts = Object.fromEntries(actions.map((action, index) => {
      same(operations[index], { ...seal, action });
      const receipt = operations[index + actions.length];
      protocol.exact(receipt, [...Object.keys(seal), "action", "result"]);
      same(receipt, { ...seal, action, result: receipt.result });
      return [action, receipt.result];
    }));
    return protocol.freeze({ pair, control, receipts });
  });
}

/** Original-attempt, registry and rollout checks bracket real provider reads.
 * The digest contains observed facts; it is never the caller's expected digest. */
export async function inspectPrivatePublicReleaseSlotTarget({ firestore, target, rollout, preflightOperationId, readToken, fetchImpl = fetch, signal }) {
  try {
    requireValue(/^[a-z0-9][a-z0-9-]{0,79}$/.test(preflightOperationId ?? ""));
    work.assertPublicReleasePairDatabase(firestore, target.pair);
    const before = await readRegisteredTarget(firestore, target, rollout, preflightOperationId);
    const observed = await readPrivatePublicReleaseSlotProvider({ target, readToken, fetchImpl, signal });
    requireValue(rollout.publicService === target.pair.publicWorker.service && rollout.publicWorkerVersionId === observed.versionId &&
      rollout.publicDeploymentId === observed.deploymentId && rollout.publicTrafficPercent === 100);
    same(before.receipts.create, { workerId: observed.workerId, name: target.config.name, tag: target.tag });
    same(before.receipts.upload, { versionId: observed.versionId });
    same(before.receipts["private-subdomain"], { private: true });
    same(before.receipts.deploy, { deploymentId: observed.deploymentId, versionId: observed.versionId });
    same(await readRegisteredTarget(firestore, target, rollout, preflightOperationId), before);
    // Candidate -> retained is an allowed lifecycle change, not new code or a
    // new preflight attempt. Both reads still require an allowed current state.
    const evidence = { schemaVersion: 1, kind: "private-public-release-slot-target", installPlanDigest: target.installPlanDigest,
      planDigest: target.planDigest, registered: { pair: before.pair, receipts: before.receipts }, provider: observed, rollout };
    return protocol.freeze({ evidence, installedTargetDigest: protocol.publicReleaseDigest(evidence) });
  } catch { refuse(); }
}
