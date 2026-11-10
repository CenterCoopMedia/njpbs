import { releasePair } from "./private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { PAIR_READER_CONTRACT, type ReaderSeals } from "../../site/scripts/public-release-pair-reader-contract";
export function sealedPair(origin = "https://private-reader.example.test", base = releasePair()) {
  const deployment = { schemaVersion: 1 as const, environment: base.environment, service: base.publicWorker.service,
    versionId: base.publicWorker.versionId, commitSha: base.commitSha, origin,
    contractDigest: protocol.publicReleaseDigest(PAIR_READER_CONTRACT) };
  const capabilities = { schemaVersion: 1 as const, rendererSha: base.commitSha,
    post: { dataFigureVersion: 1 as const, electionResultsVersion: 2 as const, liveBlogVersion: 1 as const },
    page: { dataFigureVersion: 1 as const, electionResultsVersion: 2 as const, dataHubReportingVersion: 1 as const, dataHubCompositionVersion: 1 as const },
    record: { families: ["programs", "events"] as const,
      terminalOwner: { schemaVersion: 1 as const, transport: "public-context-no-build-v1" as const, rendererSha: base.commitSha } } };
  const pair = { ...base, readerContractDigest: deployment.contractDigest, readerReceiptDigest: protocol.publicReleaseDigest(deployment),
    capabilityDigest: protocol.publicReleaseDigest(capabilities) };
  const seals: ReaderSeals = { schemaVersion: 1, status: "verified", deployment, capabilities };
  return { pair, seals };
}
