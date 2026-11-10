import protocol from "../../functions/lib/public-release-pair.js";
import { parsePrivateAccessPacket } from "./public-release-private-access-operator.mjs";

const ROOT = "system/publicReleasePrivateInstalls";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const refuse = () => { throw new Error("Retained development Access history refused"); };

/** The coordinator freezes original public evidence, never a namespace/prefix allowance.
 * This derives only the completed Access owner's sixteen documents. No provider or SDK call. */
export function parseRetainedPrivateAccess(value) {
  if (value == null) return null;
  protocol.exact(value, ["schemaVersion", "packet", "receipt"]);
  if (value.schemaVersion !== 1) refuse();
  const copy = structuredClone(value), packet = parsePrivateAccessPacket(copy.packet), receipt = copy.receipt;
  if (packet.environment !== "development" || packet.credentialIdentity.projectId !== "njpbs-site-dev") refuse();
  protocol.exact(receipt, ["mode", "original", "operationId", "packetDigest", "targets"]);
  const packetDigest = protocol.publicReleaseDigest(packet);
  if (receipt.mode !== "readback" || receipt.original !== true || receipt.operationId !== packet.operationId ||
      receipt.packetDigest !== packetDigest || !Array.isArray(receipt.targets) || receipt.targets.length !== 3) refuse();
  const documents = new Map(), collections = new Map(), groups = new Map([["steps", []], ["readbacks", []]]);
  const add = (path, data) => { if (documents.has(path)) refuse(); documents.set(path, protocol.freeze(data)); };
  add(`${ROOT}/plans/${packet.operationId}`, { schemaVersion: 1, attemptId: packet.operationId, planDigest: packetDigest });
  for (const [index, target] of packet.targets.entries()) {
    const result = receipt.targets[index], digest = protocol.publicReleaseDigest({ packet, target });
    protocol.exact(result, ["role", "original", "origin", "clientId", "applicationId", "audience", "name", "domain", "policy"]);
    const domain = new URL(target.origin).hostname, name = `njpbs-pair-${target.role}-${digest.slice(0, 24)}`;
    if (result.original !== true || result.role !== target.role || result.origin !== target.origin || result.clientId !== target.clientId ||
        result.domain !== domain || result.name !== name || !UUID.test(result.applicationId ?? "") || !/^[a-f0-9]{64}$/.test(result.audience ?? "")) refuse();
    protocol.exact(result.policy, ["policyId", "policyDigest"]);
    const policy = { name, decision: "non_identity", precedence: 1, include: [{ service_token: { token_id: target.serviceTokenId } }], exclude: [], require: [] };
    if (!UUID.test(result.policy.policyId ?? "") || result.policy.policyDigest !== protocol.publicReleaseDigest(policy)) refuse();
    const worker = `access:${domain}`, workerKey = protocol.publicReleaseDigest({ worker });
    // The plan uses the whole packet digest; ownership/steps use this target's digest.
    const seal = { schemaVersion: 1, attemptId: packet.operationId, worker, planDigest: digest };
    add(`${ROOT}/workers/${workerKey}`, seal);
    const application = Object.fromEntries(["applicationId", "audience", "name", "domain"].map(key => [key, result[key]]));
    for (const [action, observed] of [["access-app", application], ["access-policy", result.policy]]) {
      const step = `${ROOT}/attempts/${packet.operationId}/steps/${workerKey}-${action}`;
      const readback = `${ROOT}/attempts/${packet.operationId}/readbacks/${workerKey}-${action}`;
      add(step, { ...seal, action }); add(readback, { ...seal, action, result: observed });
      groups.get("steps").push(step); groups.get("readbacks").push(readback);
    }
  }
  for (const key of ["applicationId", "audience"]) if (new Set(receipt.targets.map(row => row[key])).size !== 3) refuse();
  if (new Set(receipt.targets.map(row => row.policy.policyId)).size !== 3) refuse();
  for (const collection of [`${ROOT}/plans`, `${ROOT}/workers`])
    collections.set(collection, [...documents.keys()].filter(path => path.startsWith(`${collection}/`)).sort());
  const proof = protocol.freeze({ schemaVersion: 1, packet, receipt });
  return { proof, digest: protocol.publicReleaseDigest(proof), documents, collections, groups };
}
