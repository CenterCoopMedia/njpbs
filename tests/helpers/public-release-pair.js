// Synthetic identities: no deployed resources or private content.
export function releasePair(slot = "a", commitSha = "a".repeat(40)) {
  const incarnation = `${slot.repeat(8)}-1111-4111-8111-111111111111`;
  const versionId = `${slot.repeat(8)}-2222-4222-8222-222222222222`;
  return {
    schemaVersion: 2,
    pairId: `njpbs-slot-${slot}:${incarnation}`,
    environment: "development",
    commitSha,
    publisher: { application: `njpbs-publisher-${slot}`, workerVersionId: versionId,
      imageDigest: `sha256:${"1".repeat(64)}`, journalNamespace: `publisher-${slot}-${incarnation}` },
    publicWorker: { service: `njpbs-slot-${slot}`, incarnation, versionId },
    rendererDigest: "2".repeat(64), environmentDigest: "3".repeat(64), bindingsDigest: "4".repeat(64),
    codeAssetManifestDigest: "5".repeat(64), readerContractDigest: "6".repeat(64),
    readerReceiptDigest: "7".repeat(64), capabilityDigest: "8".repeat(64),
  };
}
export function pairReference(pair = releasePair()) {
  return { pairId: pair.pairId, commitSha: pair.commitSha, publicWorkerVersionId: pair.publicWorker.versionId };
}
export function releaseSelector() {
  const pair = pairReference();
  return { schemaVersion: 2, state: "idle", mediaLifecycleReady: true, epoch: 1,
    activeGeneration: 7, activeDeploymentId: "slot-deployment-seven", activeCommitSha: pair.commitSha,
    lastReservedGeneration: 7, newestEligibleGeneration: 7, newestEligibleBuildBatchId: "switch-one",
    selectedPair: pair, recoveryPair: pairReference(releasePair("b", "b".repeat(40))),
    contentHead: { pairId: pair.pairId, viewId: "view-one", manifestDigest: "9".repeat(64), contextSequence: 0 },
    admittedContractDigest: "a".repeat(64), priorSelectorDigest: "b".repeat(64), switchOperationId: "switch-one", proofDigest: "c".repeat(64) };
}
export function changeInput(operationId = "publication-one") {
  return { operationId, pair: pairReference(), contextRevision: 12,
    changes: [{ kind: "post", id: "post-one", action: "publish", sourceVersion: 4, snapshotDigest: "d".repeat(64) }] };
}
