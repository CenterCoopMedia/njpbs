import protocol from "../../functions/lib/public-release-pair.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import { PrivatePairProviderError } from "./private-pair-publisher-provider.mjs";

const resourceId = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fields = { identity: ["workerId"], version: ["workerVersionId"],
  deployment: ["deploymentId", "workerVersionId"], container: ["applicationId", "namespaceId"], trigger: ["workerVersionId"] };
function refuse() { throw new PrivatePairProviderError("provider-response-conflict"); }
function parsed(value, context) {
  const { plan, operation, requestDigest } = context;
  try {
    protocol.exact(value, ["schemaVersion", "planDigest", "operation", "requestDigest", "response"]);
    const ids = fields[operation];
    if (!ids || value.schemaVersion !== 2 || value.planDigest !== protocol.publicReleaseDigest(plan) ||
        value.operation !== operation || value.requestDigest !== requestDigest) refuse();
    protocol.exact(value.response, ["publisherApplication", ...ids]);
    if (value.response.publisherApplication !== plan.pairTemplate.publisher.application || ids.some(key =>
      typeof value.response[key] !== "string" || !(key === "workerVersionId" || key === "deploymentId" ? uuid : resourceId).test(value.response[key]))) refuse();
    return Object.freeze({ ...value.response });
  } catch { refuse(); }
}
function reference({ firestore, plan, operation }) {
  if (!Object.hasOwn(fields, operation)) refuse();
  return firestore.doc(`${rollout.publicReleasePairUploadPath(plan.pairTemplate.pairId)}/operations/${operation}/responses/provider`);
}
export async function readPrivatePairProviderResponse(context) {
  const row = await reference(context).get();
  return row.exists ? parsed(row.data(), context) : null;
}
/** Store only allowlisted public IDs, before their independent readback. A
 * retry must not forget a known POST identity and accept a different resource.
 */
export async function recordPrivatePairProviderResponse(context, response) {
  const { firestore, plan, operation, requestDigest } = context;
  const value = { schemaVersion: 2, planDigest: protocol.publicReleaseDigest(plan), operation, requestDigest, response };
  value.response = parsed(value, context);
  const ref = reference(context);
  await firestore.runTransaction(async transaction => {
    const [parent, prior] = await transaction.getAll(ref.parent.parent, ref);
    if (!parent.exists || parent.data().schemaVersion !== 2 || parent.data().planDigest !== value.planDigest || parent.data().requestDigest !== requestDigest ||
        parent.data().operation !== operation) refuse();
    if (prior.exists) {
      if (protocol.publicReleaseDigest(parsed(prior.data(), context)) !== protocol.publicReleaseDigest(response)) refuse();
      return;
    }
    transaction.create(ref, value);
  });
}
