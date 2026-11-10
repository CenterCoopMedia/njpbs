import protocol from '../../functions/lib/public-release-pair.js';
import rollout from '../../functions/lib/public-release-pair-rollout.js';

const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Installed publisher completion refused'); };

/** This projection checks offline inputs only; it supplies no installation
 * authority. Schema-three authority additionally requires its immutable seal. */
export function matchesInstalledPublisherIntent(plan, pair) {
  if (plan.schemaVersion !== 3) return same(pair, { ...plan.pairTemplate,
    publisher: { ...plan.pairTemplate.publisher, workerVersionId: pair.publisher.workerVersionId } });
  rollout.parsePublicReleasePairUploadPlan(plan);
  const { readerReceiptDigest, publicWorker, publisher, ...stable } = pair;
  const { versionId, ...slot } = publicWorker;
  const { workerVersionId, ...publisherTemplate } = publisher;
  return same(plan.pairTemplate, { ...stable, publicWorker: slot, publisher: publisherTemplate }) &&
    versionId !== workerVersionId && readerReceiptDigest === protocol.publicReleaseDigest({ schemaVersion: 1,
      environment: pair.environment, service: publicWorker.service, versionId, commitSha: pair.commitSha,
      origin: plan.slotInstall.readerOrigin, contractDigest: pair.readerContractDigest });
}

export function assertInstalledPublisherCompletion(plan, pair, row) {
  if (plan.schemaVersion !== 3) return null;
  if (!row?.exists || !row.createTime.isEqual(row.updateTime)) refuse();
  const value = row.data();
  protocol.exact(value, ['schemaVersion', 'planDigest', 'pair', 'installation']);
  protocol.exact(value.installation, ['operationId', 'installPlanDigest', 'slot', 'ingress']);
  if (value.schemaVersion !== 1 || value.planDigest !== protocol.publicReleaseDigest(plan) ||
      !same(protocol.parsePublicReleasePair(value.pair), pair) || !matchesInstalledPublisherIntent(plan, pair) ||
      value.installation?.operationId !== plan.slotInstall.operationId ||
      value.installation?.slot?.name !== pair.publicWorker.service || value.installation.slot.versionId !== pair.publicWorker.versionId) refuse();
  if (!protocol.digest(value.installation.installPlanDigest)) refuse();
  for (const member of [value.installation.slot, value.installation.ingress]) {
    protocol.exact(member, ['name', 'planDigest', 'tag', 'workerId', 'versionId', 'deploymentId']);
    if (!protocol.digest(member.planDigest) || member.tag !== protocol.publicReleaseDigest({ attemptId: value.installation.operationId,
      planDigest: member.planDigest }) || !/^[a-f0-9]{32}$/.test(member.workerId ?? '') ||
      ![member.versionId, member.deploymentId].every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id ?? ''))) refuse();
  }
  return value;
}
export async function readInstalledPublisherCompletion({ firestore, plan, pair }) {
  if (plan.schemaVersion !== 3) return null;
  const row = await firestore.doc(rollout.publicReleasePairUploadCompletionPath(pair.pairId)).get();
  return assertInstalledPublisherCompletion(plan, pair, row);
}
