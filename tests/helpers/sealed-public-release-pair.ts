import { releasePair } from "./private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { privatePairReaderCapabilities } from "../../packages/content-core/src/private-pair-http.mjs";
import { PAIR_READER_CONTRACT, type ReaderSeals } from "../../site/scripts/public-release-pair-reader-contract";
export function sealedPair(origin = "https://private-reader.example.test", base = releasePair()) {
  const deployment = { schemaVersion: 1 as const, environment: base.environment, service: base.publicWorker.service,
    versionId: base.publicWorker.versionId, commitSha: base.commitSha, origin,
    contractDigest: protocol.publicReleaseDigest(PAIR_READER_CONTRACT) };
  const capabilities = privatePairReaderCapabilities(base.commitSha);
  const pair = { ...base, readerContractDigest: deployment.contractDigest, readerReceiptDigest: protocol.publicReleaseDigest(deployment),
    capabilityDigest: protocol.publicReleaseDigest(capabilities) };
  const seals: ReaderSeals = { schemaVersion: 1, status: "verified", deployment, capabilities };
  return { pair, seals };
}
