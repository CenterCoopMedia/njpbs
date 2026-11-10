import protocol from "../../functions/lib/public-release-pair.js";

/** Parser adapters are local only; schema two persists no unassigned slot ID
 * or receipt. Publisher UUIDs must already be real upload readbacks. */
export function privatePublicReleasePlanPairs(plan) {
  return [plan.oldPair, plan.newPair].map(template => {
    if (plan.schemaVersion === 1) return protocol.parsePublicReleasePair(template);
    if (plan.schemaVersion !== 2 || Object.hasOwn(template, "readerReceiptDigest")) throw new Error("Private slot intent was refused");
    protocol.exact(template.publicWorker, ["service", "incarnation"]);
    if (template.publisher?.workerVersionId === "00000000-0000-0000-0000-000000000000") throw new Error("Private publisher upload is required");
    return protocol.parsePublicReleasePair({ ...template, readerReceiptDigest: "0".repeat(64),
      publicWorker: { ...template.publicWorker, versionId: template.publicWorker.incarnation } });
  });
}
