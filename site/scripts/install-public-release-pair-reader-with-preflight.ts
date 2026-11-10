import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairRolloutReadback } from "../../functions/lib/public-release-pair-rollout";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { compilePrivateWorker } from "../../scripts/install-private-public-release.mjs";
import { createPrivatePairPreflightCaller, parsePrivatePairPreflightPlan, PrivatePairPreflightError, PRIVATE_PREFLIGHT_ATTEMPTS } from "../../scripts/lib/private-pair-preflight-caller.mjs";
import { privatePublicReleaseSlotTarget, inspectPrivatePublicReleaseSlotTarget } from "../../scripts/lib/private-public-release-slot-target.mjs";
import { installPublicReleasePairReader } from "./install-public-release-pair-reader";
import { exact } from "./public-release-pair-reader-contract";

const refuse = () => { throw new Error("Private reader installation was refused; reconcile the original attempt"); };
type InstallStage = "input" | "target" | "caller" | "seal";
export class PrivateReaderInstallationError extends Error {
  constructor(readonly stage: InstallStage, readonly code: string, readonly uncertain: boolean) {
    super(`Private reader installation was refused at ${stage}; ${!uncertain && (stage === "input" || stage === "target")
      ? "no caller authority was requested by this invocation" : "check the original attempt receipt"}`);
    this.name = "PrivateReaderInstallationError";
  }
}

/** Inert until explicitly called with authorization after both owners' rollout
 * receipts exist. The only effects are the existing one-shot ephemeral caller
 * and the existing transactional, create-only reader seal/receipt writer. */
export async function installPublicReleasePairReaderWithPreflight({ firestore, pair, installPlan, rollout,
  preflightOperationId, readToken, authorized = false, fetchImpl = fetch, signal, clock = Date.now }: {
  firestore: Firestore; pair: PublicReleasePair; installPlan: unknown; rollout: PairRolloutReadback;
  preflightOperationId: string; readToken(): Promise<string>; authorized?: boolean;
  fetchImpl?: typeof fetch; signal?: AbortSignal; clock?: () => number;
}) {
  let stage: InstallStage = "input";
  try {
    if (authorized !== true || signal?.aborted) refuse();
    const target = privatePublicReleaseSlotTarget({ pair, installPlan });
    // Validate the closed RPC plan before compilation, database or credentials.
    const template = parsePrivatePairPreflightPlan({ schemaVersion: 1, operationId: preflightOperationId, kind: "reader-installation",
      accountId: target.config.account_id, workerName: target.pair.publicWorker.service,
      workerVersion: target.pair.publicWorker.versionId, identity: target.pair, installedTargetDigest: "0".repeat(64) });
    exact(rollout, ["publisherApplication", "publisherWorkerVersionId", "imageDigest", "publicService", "publicWorkerVersionId",
      "publisherDeploymentId", "publicDeploymentId", "publisherTrafficPercent", "publicTrafficPercent"]);
    if (rollout.publisherApplication !== target.pair.publisher.application || rollout.publisherWorkerVersionId !== target.pair.publisher.workerVersionId ||
        rollout.imageDigest !== target.pair.publisher.imageDigest || rollout.publicService !== target.pair.publicWorker.service ||
        rollout.publicWorkerVersionId !== target.pair.publicWorker.versionId || rollout.publisherTrafficPercent !== 100 || rollout.publicTrafficPercent !== 100 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(rollout.publisherDeploymentId) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(rollout.publicDeploymentId)) refuse();
    const frozenRollout = Object.freeze({ ...rollout });
    const source = await compilePrivateWorker(target.config.main);
    if (createHash("sha256").update(source).digest("hex") !== target.sourceDigest) refuse();
    stage = "target";
    const inspect = () => inspectPrivatePublicReleaseSlotTarget({ firestore, target, rollout: frozenRollout, preflightOperationId, readToken, fetchImpl, signal });
    const observed = await inspect(), plan = { ...template, installedTargetDigest: observed.installedTargetDigest };
    stage = "caller";
    const readInstalled = createPrivatePairPreflightCaller({ firestore, plan, readToken, fetchImpl, signal, clock,
      assertTargetCurrent: async ({ plan: requested }: { plan: unknown }) => {
        if (protocol.publicReleaseDigest(requested) !== protocol.publicReleaseDigest(plan)) refuse();
        return (await inspect()).installedTargetDigest;
      } });
    const actual = await readInstalled(target.pair);
    signal?.throwIfAborted();
    stage = "seal";
    const result = await installPublicReleasePairReader({ firestore, pair: target.pair, rollout: frozenRollout, readInstalled: async () => actual });
    return { ...result, pairId: target.pair.pairId, preflightOperationId, installedTargetDigest: observed.installedTargetDigest };
  } catch (error) {
    const controlled = error instanceof PrivatePairPreflightError;
    let uncertain = controlled ? error.uncertain || error.code === "preflight-attempt-conflict" : stage === "caller" || stage === "seal";
    if (stage !== "input" && !uncertain) {
      // A definite refusal can hide a prior uncertain upload. Never downgrade
      // either uncertainty; a conflicting binding is already unknown above.
      uncertain = true;
      try {
        signal?.throwIfAborted();
        work.assertPublicReleasePairDatabase(firestore, pair);
        const original = (await firestore.collection(PRIVATE_PREFLIGHT_ATTEMPTS).doc(preflightOperationId).get()).data();
        uncertain = Boolean(original && original.state !== "complete");
      } catch { /* Keep the unknown original uncertain. */ }
    }
    throw new PrivateReaderInstallationError(stage, controlled ? error.code : `reader-install-${stage}-refused`, uncertain);
  }
}
