import { fileURLToPath } from "node:url";
import targets from "../functions/lib/publication-target.js";
import { planPublicReleasePairPublisher } from "./plan-public-release-pair-publisher.mjs";

/** Construct a NEW private application config from the isolated resource plan.
 * No checkout, image build, provider call or file write occurs here. Provider
 * version UUIDs are read from the immutable registry at runtime, not embedded
 * into the version whose UUID the provider has not assigned yet.
 */
export function configurePublicReleasePairPublisher({ pair, retainedPairs, legacyConfig, imageReference, executorReady = false,
  continuationEnabled = false, ingressProofService }) {
  if (typeof executorReady !== "boolean") throw new Error("Private pair executor readiness must be explicit");
  if (typeof continuationEnabled !== "boolean" || (continuationEnabled
    ? executorReady !== true || typeof ingressProofService !== "string" || !/^njpbs-private-ingress-[a-z0-9-]{1,30}$/.test(ingressProofService)
    : ingressProofService !== undefined)) throw new Error("Private pair continuation configuration was refused");
  const plan = planPublicReleasePairPublisher({ pair, retainedPairs, legacyConfig });
  if (typeof imageReference !== "string" ||
      !/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(imageReference) ||
      !imageReference.endsWith(`@${plan.requiredImageDigest}`)) throw new Error("Pair image must have its exact immutable digest");
  return {
    name: plan.applicationName,
    main: fileURLToPath(new URL("../publisher/pair-worker.ts", import.meta.url)),
    account_id: legacyConfig.account_id,
    compatibility_date: legacyConfig.compatibility_date,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    routes: [],
    secrets: { required: ["FIREBASE_SERVICE_ACCOUNT"] },
    vars: { PAIR_ID: plan.pair.pairId, PAIR_COMMIT_SHA: plan.pair.commitSha, PAIR_ENVIRONMENT: plan.environment,
      PAIR_JOURNAL_NAMESPACE: plan.journalNamespace, PAIR_EXECUTOR_READY: executorReady ? "true" : "false",
      ...continuationEnabled ? { PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED: "true", PUBLIC_PAIR_OWNER_WRITE_ENABLED: "true",
        PUBLIC_PAIR_TERMINAL_ENABLED: "true", PUBLIC_PAIR_SWITCH_CODE_ENABLED: "true" } : {} },
    ...continuationEnabled ? { services: [{ binding: "PUBLIC_RELEASE_INGRESS_PROOF", service: ingressProofService,
      entrypoint: "PublicReleaseIngressProofEntrypoint" }] } : {},
    r2_buckets: [{ binding: "PAIR_CONTENT", bucket_name: targets.publicationTarget(plan.environment).publicationBucket }],
    version_metadata: { binding: "PAIR_WORKER_VERSION" },
    containers: [{ name: plan.containerName, class_name: "PairPublicationRuntime", image: imageReference, instance_type: "standard-2", max_instances: 1 }],
    durable_objects: { bindings: [{ name: "PAIR_PUBLISHER", class_name: "PairPublicationRuntime" }] },
    exports: { PairPublicationRuntime: { type: "durable-object", storage: "sqlite" } },
    // Choose readiness before the initial sealed upload. It cannot be flipped
    // on a registered immutable Worker UUID; durable task gates still apply.
    triggers: { crons: ["* * * * *"] },
  };
}
