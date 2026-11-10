/** Inert protocol-two contracts. No deployed writer selects this protocol yet. */
export type PublicReleasePairReference = Readonly<{
  pairId: string;
  commitSha: string;
  publicWorkerVersionId: string;
}>;

export type PublicReleasePair = Readonly<{
  schemaVersion: 2;
  pairId: string;
  environment: "production" | "development";
  commitSha: string;
  publisher: Readonly<{
    application: string;
    workerVersionId: string;
    imageDigest: string;
    journalNamespace: string;
  }>;
  publicWorker: Readonly<{
    service: string;
    incarnation: string;
    versionId: string;
  }>;
  rendererDigest: string;
  environmentDigest: string;
  bindingsDigest: string;
  codeAssetManifestDigest: string;
  readerContractDigest: string;
  readerReceiptDigest: string;
  capabilityDigest: string;
}>;

export type PublicReleaseSelector = Readonly<{
  schemaVersion: 2;
  state: "idle";
  mediaLifecycleReady: true;
  epoch: number;
  activeGeneration: number;
  activeDeploymentId: string;
  activeCommitSha: string;
  lastReservedGeneration: number;
  newestEligibleGeneration: number;
  newestEligibleBuildBatchId: string;
  selectedPair: PublicReleasePairReference;
  recoveryPair: PublicReleasePairReference;
  contentHead: Readonly<{
    pairId: string;
    viewId: string;
    manifestDigest: string;
    contextSequence: number;
  }>;
  admittedContractDigest: string;
  priorSelectorDigest: string;
  switchOperationId: string;
  proofDigest: string;
}>;

export type PublicReleaseChangeInput = Readonly<{
  operationId: string;
  pair: PublicReleasePairReference;
  contextRevision: number;
  changes: readonly Readonly<{
    kind: "post" | "page" | "record" | "settings" | "library" | "media" |
      "author" | "provider" | "schedule" | "dataHub";
    id: string;
    action: "publish" | "withdraw" | "dependency";
    sourceVersion: number;
    snapshotDigest: string;
  }>[];
}>;

export type PublicReleaseChange = PublicReleaseChangeInput & Readonly<{
  schemaVersion: 2;
  sequence: number;
  previousDigest: string;
  entryDigest: string;
}>;

export type PublicReleaseChangeHead = Readonly<{
  schemaVersion: 2;
  sequence: number;
  baselineDigest: string;
  lastDigest: string;
}>;
