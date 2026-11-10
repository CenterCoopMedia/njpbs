import protocol from "../../functions/lib/public-release-pair.js";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { PAIR_READER_CONTRACT, privatePairReaderCapabilities } from "../../packages/content-core/src/private-pair-http.mjs";
import type { ReaderSeals } from "../../site/scripts/public-release-pair-reader-contract";

export { privatePairReaderCapabilities } from "../../packages/content-core/src/private-pair-http.mjs";
export function privatePairReaderDeployment(pair: Pick<PublicReleasePair, "environment" | "commitSha" | "publicWorker">, origin: string) {
  return { schemaVersion: 1 as const, environment: pair.environment, service: pair.publicWorker.service,
    versionId: pair.publicWorker.versionId, commitSha: pair.commitSha, origin,
    contractDigest: protocol.publicReleaseDigest(PAIR_READER_CONTRACT) };
}
export function privatePairReaderInstallation(pair: PublicReleasePair, origin: string): ReaderSeals {
  const capabilities = privatePairReaderCapabilities(pair.commitSha);
  const deployment = privatePairReaderDeployment(pair, origin);
  if (new URL(origin).origin !== origin || !origin.startsWith("https://") ||
      protocol.publicReleaseDigest(deployment) !== pair.readerReceiptDigest ||
      deployment.contractDigest !== pair.readerContractDigest || protocol.publicReleaseDigest(capabilities) !== pair.capabilityDigest) {
    throw new Error("Private reader installation refused");
  }
  return { schemaVersion: 1, status: "verified", deployment, capabilities };
}
