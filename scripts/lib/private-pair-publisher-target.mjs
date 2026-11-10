import protocol from "../../functions/lib/public-release-pair.js";
import ownership from "../../functions/lib/public-release-pair-work.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import { createPrivatePairPublisherProvider, PrivatePairProviderError } from "./private-pair-publisher-provider.mjs";

const operations = ["identity", "version", "deployment", "container"];
const placeholder = "00000000-0000-0000-0000-000000000000";
function requireValue(value) {
  if (!value) throw new PrivatePairProviderError("installed-target-mismatch");
}
function same(left, right) { requireValue(protocol.publicReleaseDigest(left) === protocol.publicReleaseDigest(right)); }
function identity(pair) {
  return { pairId: pair.pairId, commitSha: pair.commitSha, environment: pair.environment,
    journalNamespace: pair.publisher.journalNamespace };
}

async function readInstalledState(firestore, plan, operations) {
  const pairPath = ownership.publicReleasePairPath(plan.pairTemplate.pairId);
  const uploadPath = rollout.publicReleasePairUploadPath(plan.pairTemplate.pairId);
  const planDigest = protocol.publicReleaseDigest(plan);
  return firestore.runTransaction(async transaction => {
    const rows = await transaction.getAll(...[
      ownership.PAIRS, pairPath, `${pairPath}/controls/runtime`, uploadPath,
      "system/publicReleasePairUploads", "system/billing",
      ...operations.map(operation => `${uploadPath}/operations/${operation}`),
    ].map(path => firestore.doc(path)));
    const [registry, rawPair, control, upload, index, billing, ...attempts] = rows.map(row => row.data());
    protocol.exact(registry, ["schemaVersion", "pairIds"]);
    requireValue(registry.schemaVersion === 2 && Array.isArray(registry.pairIds) && registry.pairIds.length <= 8 &&
      new Set(registry.pairIds).size === registry.pairIds.length && registry.pairIds.includes(plan.pairTemplate.pairId));
    const pair = protocol.parsePublicReleasePair(rawPair);
    requireValue(pair.publisher.workerVersionId !== placeholder && billing?.disabled !== true);
    if (plan.schemaVersion === 2) same(pair, { ...plan.pairTemplate, publisher: { ...plan.pairTemplate.publisher, workerVersionId: pair.publisher.workerVersionId } });
    else {
      const completion = (await transaction.get(firestore.doc(rollout.publicReleasePairUploadCompletionPath(pair.pairId)))).data();
      requireValue(completion?.schemaVersion === 1 && completion.planDigest === planDigest);
      same(completion.pair, pair);
    }
    protocol.exact(control, ["schemaVersion", "pairId", "status"]);
    requireValue(control.schemaVersion === 2 && control.pairId === pair.pairId && ["candidate", "retained"].includes(control.status));
    protocol.exact(index, ["schemaVersion", "plans"]);
    requireValue(index.schemaVersion === 2 && Array.isArray(index.plans) && index.plans.length <= 8);
    const plans = index.plans.map(rollout.parsePublicReleasePairUploadPlan);
    requireValue(new Set(plans.map(item => item.pairTemplate.pairId)).size === plans.length);
    same(plans.find(item => item.pairTemplate.pairId === pair.pairId), plan);
    protocol.exact(upload, ["schemaVersion", "pairId", "planDigest", "state", "workerVersionId", "readbackDigest"]);
    requireValue(upload.schemaVersion === 2 && upload.pairId === pair.pairId && upload.planDigest === planDigest &&
      upload.state === "uploaded" && upload.workerVersionId === pair.publisher.workerVersionId && protocol.digest(upload.readbackDigest));
    const receipts = Object.fromEntries(operations.map((operation, offset) => {
      const row = attempts[offset];
      protocol.exact(row, ["schemaVersion", "pairId", "planDigest", "operation", "requestDigest", "state", "readbackDigest"]);
      requireValue(row.schemaVersion === 2 && row.pairId === pair.pairId && row.planDigest === planDigest && row.operation === operation &&
        row.state === "verified" && protocol.digest(row.requestDigest) && protocol.digest(row.readbackDigest));
      return [operation, row];
    }));
    // Unrelated registry members and routing counts are not part of this target.
    return protocol.freeze({ pair, control, upload, operations: receipts });
  });
}

/** Recheck actual immutable bytes, every required install operation, private
 * ingress and registration. This function performs GETs and database reads only.
 * Its digest is suitable for the shared private caller's target guard; it is not
 * runtime health, qualification or permission to publish.
 */
export async function inspectPrivatePairPublisherTarget({ firestore, plan: input, prepared, readToken, fetchImpl = fetch }) {
  try {
    const plan = rollout.parsePublicReleasePairUploadPlan(input);
    const candidate = rollout.publicReleasePairUploadCandidate(plan);
    ownership.assertPublicReleasePairDatabase(firestore, candidate);
    requireValue(prepared?.accountId === plan.accountId && prepared.applicationName === plan.pairTemplate.publisher.application &&
      prepared.imageReference === plan.imageReference && prepared.bundleDigest === plan.bundleDigest &&
      prepared.configurationDigest === plan.configurationDigest);
    same(prepared.pairIdentity, identity(candidate));
    const provider = createPrivatePairPublisherProvider({ prepared, readToken, fetchImpl });
    const installedOperations = [...operations, ...prepared.continuationEnabled === true ? ["trigger"] : []];
    const before = await readInstalledState(firestore, plan, installedOperations);
    const versionId = before.pair.publisher.workerVersionId;
    const worker = await provider.readWorkerIdentity();
    requireValue(worker !== null);
    const version = { ...await provider.readVersion({ versionId }) }; delete version.namespaceId;
    const deployment = await provider.readDeployment({ versionId });
    const namespace = await provider.readNamespace({ versionId });
    const applications = (await provider.listContainerApplications()).filter(row => row.publisherApplication === prepared.applicationName);
    requireValue(applications.length === 1);
    const application = await provider.readContainerApplication({ applicationId: applications[0].applicationId, namespaceId: namespace.namespaceId });
    const privacy = await provider.readPrivateInventory();
    const trigger = prepared.continuationEnabled === true ? await provider.readOriginalTrigger({ versionId }) : null;
    requireValue(prepared.continuationEnabled !== true || trigger !== null);
    const planDigest = protocol.publicReleaseDigest(plan);
    const requests = {
      identity: { name: prepared.applicationName, workersDev: false, previewUrls: false },
      version: { bundleDigest: plan.bundleDigest, configurationDigest: plan.configurationDigest },
      deployment: { workerVersionId: versionId, trafficPercent: 100 },
      container: { namespaceId: namespace.namespaceId, imageReference: plan.imageReference, instanceType: "standard-2", maxInstances: 1 },
      ...trigger ? { trigger: { workerVersionId: versionId, schedules: [{ cron: "* * * * *" }] } } : {},
    };
    const readbacks = { identity: worker, version, deployment, container: application, ...trigger ? { trigger } : {} };
    for (const operation of installedOperations) {
      requireValue(before.operations[operation].requestDigest === protocol.publicReleaseDigest({ planDigest, operation, request: requests[operation] }));
      requireValue(before.operations[operation].readbackDigest === protocol.publicReleaseDigest(readbacks[operation]));
    }
    requireValue(before.upload.readbackDigest === protocol.publicReleaseDigest({ planDigest,
      publisherApplication: version.publisherApplication, workerVersionId: versionId, bundleDigest: version.bundleDigest,
      configurationDigest: version.configurationDigest, imageDigest: version.imageDigest }));
    same(await readInstalledState(firestore, plan, installedOperations), before);
    const evidence = { schemaVersion: 1, kind: "private-pair-publisher-target", planDigest, pair: before.pair,
      control: before.control, worker, version, deployment, namespace, application, ...trigger ? { trigger } : {},
      privateIngress: { publisherApplication: privacy.publisherApplication, subdomain: privacy.subdomain, private: privacy.private } };
    return protocol.freeze({ pair: before.pair, identity: identity(before.pair),
      installedTargetDigest: protocol.publicReleaseDigest(evidence), evidence });
  } catch (error) {
    if (error instanceof PrivatePairProviderError) throw error;
    throw new PrivatePairProviderError("installed-target-readback-failed");
  }
}
