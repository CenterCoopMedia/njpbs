import { createHash } from "node:crypto";
import protocol from "../../functions/lib/public-release-pair.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { compilePrivateWorker } from "../install-private-public-release.mjs";
import { configurePublicReleaseIngress } from "../configure-public-release-ingress.mjs";
import { privatePublicReleasePlanPairs } from "./private-public-release-install-plan.mjs";
import { privatePublicReleaseSlotTarget, readPrivatePublicReleaseSlotProvider } from "./private-public-release-slot-target.mjs";

const refuse = () => { throw new Error("Private pair completion was refused; reconcile the original attempt"); };
const digest = protocol.publicReleaseDigest;
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value ?? "");

/** GET-only provider verification followed by a create-only completion seal and
 * the existing immutable registration owner. No provider installer is invoked. */
export async function completePrivatePairPublisherInstall({ firestore, plan: input, installPlan, readToken,
  fetchImpl = fetch, signal, authorized = false, compile = compilePrivateWorker }) {
  if (authorized !== true || signal?.aborted) refuse();
  const plan = rollout.parsePublicReleasePairUploadPlan(input);
  if (plan.schemaVersion !== 3 || installPlan?.schemaVersion !== 2 || installPlan.operationId !== plan.slotInstall.operationId ||
      installPlan.accountId !== plan.accountId) refuse();
  const templates = privatePublicReleasePlanPairs(installPlan);
  const selected = templates.findIndex(pair => pair.pairId === plan.pairTemplate.pairId);
  if (selected === -1 || installPlan.readerOrigins?.[selected] !== plan.slotInstall.readerOrigin) refuse();
  work.assertPublicReleasePairDatabase(firestore, templates[selected]);
  const versionFor = async name => {
    const key = digest({ worker: name });
    const row = (await firestore.doc(`system/publicReleasePrivateInstalls/attempts/${installPlan.operationId}/readbacks/${key}-upload`).get()).data();
    if (!uuid(row?.result?.versionId)) refuse();
    return row.result.versionId;
  };
  const pairs = [];
  for (const [index, template] of templates.entries()) {
    const versionId = await versionFor(template.publicWorker.service);
    pairs.push(protocol.parsePublicReleasePair({ ...template, publicWorker: { ...template.publicWorker, versionId },
      readerReceiptDigest: digest({ schemaVersion: 1, environment: template.environment, service: template.publicWorker.service,
        versionId, commitSha: template.commitSha, origin: installPlan.readerOrigins[index], contractDigest: template.readerContractDigest }) }));
  }
  const targets = pairs.map(pair => privatePublicReleaseSlotTarget({ pair, installPlan }));
  const ingress = configurePublicReleaseIngress({ oldPair: pairs[0], newPair: pairs[1], accountId: installPlan.accountId,
    ingressName: installPlan.ingressName, developmentIngress: Object.hasOwn(installPlan, "developmentIngress") });
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  if (hash(await compile(targets[0].config.main)) !== installPlan.slotBundleDigest ||
      hash(await compile(ingress.main)) !== installPlan.ingressBundleDigest) refuse();
  const observed = [];
  for (const target of targets) observed.push(await readPrivatePublicReleaseSlotProvider({ target, readToken, fetchImpl, signal }));
  const slot = targets[selected];
  const slotObserved = observed[selected];
  const config = { ...ingress }; delete config.main;
  const planDigest = digest({ config, sourceDigest: installPlan.ingressBundleDigest });
  const tag = digest({ attemptId: installPlan.operationId, planDigest });
  const ingressVersion = await versionFor(ingress.name);
  // The shared provider verifier reads config.name and this actual UUID only;
  // the ingress is never represented or persisted as a registered pair.
  const ingressObserved = await readPrivatePublicReleaseSlotProvider({ target: { config: ingress,
    pair: { publicWorker: { versionId: ingressVersion } }, sourceDigest: installPlan.ingressBundleDigest, tag }, readToken, fetchImpl, signal });
  const member = (name, planDigest, tag, observed) => ({ name, planDigest, tag,
    workerId: observed.workerId, versionId: observed.versionId, deploymentId: observed.deploymentId });
  const installation = { operationId: installPlan.operationId, installPlanDigest: digest(installPlan),
    slot: member(slot.config.name, slot.planDigest, slot.tag, slotObserved),
    ingress: member(ingress.name, planDigest, tag, ingressObserved) };
  signal?.throwIfAborted();
  await rollout.completePublicReleasePairUpload({ firestore, plan, pair: pairs[selected], installation });
  signal?.throwIfAborted();
  const result = await work.registerPublicReleasePair({ firestore, pair: pairs[selected] });
  return { schemaVersion: 1, kind: "private-pair-first-install-completion", ...result,
    planDigest: digest(plan), installation, publicSelectionChanged: false, publicationSuccess: false };
}
