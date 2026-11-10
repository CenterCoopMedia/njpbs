import pairs from "../functions/lib/public-release-pair.js";
import targets from "../functions/lib/publication-target.js";
import ownership from "../functions/lib/public-release-pair-work.js";

/** Offline plan only. It cannot enable a publisher, upload an image, replace
 * the legacy application or carry the public activation credential. Execution
 * requires a distinct pair-aware entrypoint and versioned views.
 */
export function planPublicReleasePairPublisher({ pair: rawPair, retainedPairs, legacyConfig }) {
  const pair = pairs.parsePublicReleasePair(rawPair);
  ownership.assertPrivatePairResources(pair);
  const target = targets.publicationTarget(pair.environment);
  if (legacyConfig.name !== target.publisherWorker || legacyConfig.vars?.CMS_DEPLOYMENT_ENVIRONMENT !== pair.environment ||
      legacyConfig.r2_buckets?.some(bucket => bucket.bucket_name !== target.publicationBucket)) {
    throw new Error("Publisher template target differs");
  }
  const retained = retainedPairs.map(value => pairs.parsePublicReleasePair(value));
  if (pair.publisher.application === legacyConfig.name || pair.publisher.journalNamespace === target.serializerId ||
      retained.some(old => old.environment !== pair.environment ||
      old.pairId === pair.pairId || [old.publisher.application, old.publicWorker.service].includes(pair.publisher.application) ||
      [old.publisher.application, old.publicWorker.service].includes(pair.publicWorker.service) ||
      old.publisher.journalNamespace === pair.publisher.journalNamespace || old.publicWorker.service === pair.publicWorker.service)) {
    throw new Error("Publisher pair resources overlap retained ownership");
  }
  // Never clone an executable legacy configuration. Changing a boolean on a
  // copied config must not grant access to the legacy serializer or its shared
  // withdrawal-catalog writer. Execution requires a new entrypoint/config.
  return {
    schemaVersion: 2,
    pair: pairs.publicReleasePairReference(pair),
    environment: pair.environment,
    readyForDeployment: false,
    requiredRuntimeProtocol: 2,
    applicationName: pair.publisher.application,
    containerName: pair.publisher.application,
    containerKey: pair.pairId,
    journalNamespace: pair.publisher.journalNamespace,
    journalPath: `${ownership.publicReleasePairPath(pair.pairId)}/journals/${pair.publisher.journalNamespace}`,
    outputPrefix: `release-pairs/${pair.pairId}/`,
    requiredImageDigest: pair.publisher.imageDigest,
    publicRoutes: [],
    workersDev: false,
    previewUrls: false,
    cronStartup: false,
    publicationEnabled: false,
  };
}
