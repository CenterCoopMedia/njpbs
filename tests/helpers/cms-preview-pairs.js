import { createRequire } from "node:module";
const pairApi = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");
export const pair = (incarnation, source = "a") => ({ schemaVersion: 2, pairId: `preview-${incarnation}`,
  rendererSha: source.repeat(40), serializerId: `preview-${incarnation}`,
  workerName: `njpbs-preview-${incarnation}`, applicationName: `njpbs-preview-${incarnation}`,
  workerVersion: `${source.repeat(8)}-${source.repeat(4)}-${source.repeat(4)}-${source.repeat(4)}-${source.repeat(12)}`,
  imageDigest: `sha256:${source.repeat(64)}`,
  requirements: Object.fromEntries(pairApi.CONTRACT_KEYS.map(key => [key, 1])),
  capabilities: { dataHubCompositionVersion: 1, liveBlogVersion: 1, electionResultsVersion: 1 } });
export const reader = (component, now = Date.now()) => ({ schemaVersion: 2, component,
  sourceSha: "b".repeat(40), inputFingerprint: "c".repeat(64), configurationFingerprint: "d".repeat(64),
  providerIdentities: { deploymentId: "deployed-v1" },
  supported: Object.fromEntries(pairApi.CONTRACT_KEYS.map(key => [key, [1]])), verifiedAt: new Date(now).toISOString() });
export const receipt = (component, now) => ({ schemaVersion: 2, component, state: "complete", lastComplete: reader(component, now) });
export const selector = (old = pair("old"), next = pair("new", "b")) => ({ schemaVersion: 2, phase: "ready", epoch: 1,
  selectedPairId: old.pairId, recoveryPairId: next.pairId, rendererSha: old.rendererSha, serializerId: old.serializerId });
export function candidate(newPair = pair("new", "b"), now = Date.now()) {
  const { pairId, rendererSha, serializerId, workerName, applicationName, workerVersion, imageDigest } = newPair;
  return { schemaVersion: 2, component: "renderer", state: "verified", mutation: {
    sourceSha: rendererSha, trustedWorkflowSha: "e".repeat(40), runId: "100", runAttempt: 1,
    inputFingerprint: "f".repeat(64), configurationFingerprint: "d".repeat(64),
    startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(),
    providerIdentities: { pairId, rendererSha, serializerId, workerName, applicationName, workerVersion, imageDigest },
  } };
}
export function proof(old = pair("old"), next = pair("new", "b"), now = Date.now()) {
  return { schemaVersion: 2, oldPairDigest: pairApi.digest(old), newPairDigest: pairApi.digest(next),
    candidateReceiptId: "renderer-100-1", providerReadbackDigest: pairApi.digest(candidate(next, now).mutation.providerIdentities),
    savedInputsDigest: "a".repeat(64), replays: Object.fromEntries(["functionsOld", "functionsNew", "cmsApiOld", "cmsApiNew"].map(key => [key, "b".repeat(64)])),
    readerDigests: Object.fromEntries(["functions", "cmsApi"].map(key => [key, pairApi.digest(reader(key, now))])),
    verifiedAt: new Date(now).toISOString() };
}
