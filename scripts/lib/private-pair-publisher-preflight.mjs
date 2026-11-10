import protocol from "../../functions/lib/public-release-pair.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import { createPrivatePairPreflightCaller, parsePrivatePairPreflightPlan, PrivatePairPreflightError } from "./private-pair-preflight-caller.mjs";
import { PrivatePairProviderError } from "./private-pair-publisher-provider.mjs";
import { inspectPrivatePairPublisherTarget } from "./private-pair-publisher-target.mjs";
import { installPrivatePairPublisher } from "./private-pair-publisher-install.mjs";

/** Concrete composition for the operator: no injected readiness callback.
 * Existing authorization and cancellation refusals still precede all I/O.
 */
export async function installPrivatePairPublisherWithPreflight({ preflightOperationId, clock, ...input }) {
  const preflightCaller = input.authorized === true && !input.signal?.aborted
    ? createPrivatePairPublisherPreflight({ ...input, operationId: preflightOperationId, clock }) : undefined;
  return installPrivatePairPublisher({ ...input, preflightCaller });
}

/** Construct before installation, invoke only after its UUID and all required
 * durable install receipts exist. Importing and construction perform no I/O.
 * The shared transport owns every ephemeral-authority request and its one-shot
 * receipt. This adapter owns only the actual installed publisher readback.
 */
export function createPrivatePairPublisherPreflight({ firestore, plan: input, prepared, operationId,
  readToken, fetchImpl = fetch, clock = Date.now, signal }) {
  const plan = rollout.parsePublicReleasePairUploadPlan(input);
  const template = parsePrivatePairPreflightPlan({ schemaVersion: 1, operationId, kind: "publisher", accountId: plan.accountId,
    workerName: plan.pairTemplate.publisher.application, workerVersion: "00000000-0000-0000-0000-000000000000",
    identity: { pairId: plan.pairTemplate.pairId, commitSha: plan.pairTemplate.commitSha, environment: plan.pairTemplate.environment,
      journalNamespace: plan.pairTemplate.publisher.journalNamespace }, installedTargetDigest: "0".repeat(64) });
  if (!firestore || typeof readToken !== "function" || typeof fetchImpl !== "function" || typeof clock !== "function") {
    throw new PrivatePairProviderError("private-preflight-unbound");
  }
  const inspect = () => inspectPrivatePairPublisherTarget({ firestore, plan, prepared, readToken, fetchImpl });
  return async rawIdentity => {
    try {
      if (signal?.aborted) throw new PrivatePairProviderError("preflight-cancelled");
      if (protocol.publicReleaseDigest(rawIdentity) !== protocol.publicReleaseDigest(template.identity)) {
        throw new PrivatePairProviderError("preflight-identity");
      }
      const observed = await inspect();
      const actual = { ...template, workerVersion: observed.pair.publisher.workerVersionId,
        installedTargetDigest: observed.installedTargetDigest };
      const caller = createPrivatePairPreflightCaller({ firestore, plan: actual, readToken, fetchImpl, clock, signal,
        assertTargetCurrent: async ({ plan: requested }) => {
          if (protocol.publicReleaseDigest(requested) !== protocol.publicReleaseDigest(actual)) {
            throw new PrivatePairProviderError("preflight-identity");
          }
          return (await inspect()).installedTargetDigest;
        } });
      return await caller(rawIdentity);
    } catch (error) {
      if (error instanceof PrivatePairProviderError) throw error;
      if (error instanceof PrivatePairPreflightError) {
        const refusal = new PrivatePairProviderError(error.code, error.uncertain);
        if (error.refusalHealth) refusal.refusalHealth = Object.freeze({ ...error.refusalHealth });
        throw refusal;
      }
      throw new PrivatePairProviderError("private-preflight-failed", true);
    }
  };
}
