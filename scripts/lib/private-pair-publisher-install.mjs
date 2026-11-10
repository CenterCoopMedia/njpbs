import protocol from "../../functions/lib/public-release-pair.js";
import ownership from "../../functions/lib/public-release-pair-work.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import { createPrivatePairPublisherProvider, PrivatePairProviderError } from "./private-pair-publisher-provider.mjs";
import { readPrivatePairProviderResponse, recordPrivatePairProviderResponse } from "./private-pair-publisher-response.mjs";

function requireValue(value, code) {
  if (!value) throw new PrivatePairProviderError(code);
}
function checkCancellation(signal) {
  if (signal?.aborted) throw new PrivatePairProviderError("install-cancelled");
}

/** Build-only transport entrypoint: importing performs no I/O. The caller must
 * supply explicit authorization, moment-of-use credential readers and an actual
 * private RPC caller before installation can report runtime readiness.
 * Provider calls are never retried here. A new invocation only reconciles the
 * recorded step and exact plan; it cannot repeat an uncertain mutation.
 */
export async function installPrivatePairPublisher({ firestore, plan: input, prepared, readToken, readServiceAccount,
  preflightCaller, fetchImpl = fetch, signal, authorized = false, uploadOnly = false }) {
  checkCancellation(signal);
  requireValue(authorized === true, "install-not-authorized");
  const plan = rollout.parsePublicReleasePairUploadPlan(input);
  requireValue(typeof uploadOnly === "boolean" && (!uploadOnly || plan.schemaVersion === 3), "prepared-plan-mismatch");
  const identity = { pairId: plan.pairTemplate.pairId, commitSha: plan.pairTemplate.commitSha,
    environment: plan.pairTemplate.environment, journalNamespace: plan.pairTemplate.publisher.journalNamespace };
  requireValue(prepared?.accountId === plan.accountId && prepared.applicationName === plan.pairTemplate.publisher.application &&
    prepared.imageReference === plan.imageReference && prepared.bundleDigest === plan.bundleDigest &&
    prepared.configurationDigest === plan.configurationDigest &&
    prepared.pairIdentity && protocol.publicReleaseDigest(prepared.pairIdentity) === protocol.publicReleaseDigest(identity), "prepared-plan-mismatch");
  ownership.assertPublicReleasePairDatabase(firestore, rollout.publicReleasePairUploadCandidate(plan));
  requireValue(uploadOnly || typeof preflightCaller === "function", "private-preflight-unbound");
  requireValue(typeof readToken === "function" && typeof readServiceAccount === "function", "credential-reader-unbound");
  let mutationToken = null;
  const provider = createPrivatePairPublisherProvider({ prepared, readToken: () => mutationToken ?? readToken(), fetchImpl, preflightCaller });
  const uploadPath = rollout.publicReleasePairUploadPath(identity.pairId);
  const prior = (await firestore.doc(uploadPath).get()).data();
  const inventory = await provider.readInitialInventory();
  if (!prior) requireValue(!inventory.intendedWorkerExists && !inventory.intendedContainerExists, "provider-name-collision");
  checkCancellation(signal);
  await rollout.reservePublicReleasePairUpload({ firestore, plan });

  async function stage(operation, request, mutate, readback, prepare) {
    checkCancellation(signal);
    const requestDigest = protocol.publicReleaseDigest({ planDigest: protocol.publicReleaseDigest(plan), operation, request });
    const context = { firestore, plan, operation, requestDigest };
    const priorOperation = await firestore.doc(`${uploadPath}/operations/${operation}`).get();
    let token, account;
    if (!priorOperation.exists) {
      // Read-only preconditions must finish before the one-attempt grant.
      // A failed GET must not consume permission for an unsent mutation.
      if (prepare) await prepare();
      // Credential failures and cancellation are definite local failures. Read
      // and validate immediately before the durable start, never after it.
      try {
        token = await readToken();
        requireValue(typeof token === "string" && token.length > 0 && !/[\r\n]/.test(token), "credential-unavailable");
        if (operation === "version") {
          account = await readServiceAccount();
          requireValue(typeof account === "string" && account.length > 0, "secret-unavailable");
        }
      } catch (error) {
        if (error instanceof PrivatePairProviderError) throw error;
        throw new PrivatePairProviderError("credential-unavailable");
      }
      checkCancellation(signal);
    }
    const grant = await rollout.reservePublicReleasePairInstallOperation(context);
    let response = await readPrivatePairProviderResponse(context);
    if (grant.mayStartProviderWrite && response !== null) throw new PrivatePairProviderError("provider-response-conflict");
    if (grant.mayStartProviderWrite) {
      try {
        // The durable grant is the start boundary. Cancellation after it stops
        // subsequent stages; it cannot cancel this already-started dispatch.
        mutationToken = token;
        response = await mutate(account);
      } catch (error) {
        if (error instanceof PrivatePairProviderError && !error.uncertain) throw error;
        await rollout.recordPublicReleasePairInstallOperation(context);
        // The response may be lost after commit. Only independent GET readback
        // can settle this same operation; the mutation is never sent again.
      } finally { mutationToken = null; }
      if (response !== null && response !== undefined) {
        try { await recordPrivatePairProviderResponse(context, response); }
        catch (error) {
          if (error instanceof PrivatePairProviderError) throw error;
          await rollout.recordPublicReleasePairInstallOperation(context);
          throw new PrivatePairProviderError("provider-response-write-pending", true);
        }
      }
    }
    // A concurrent owner may have saved its reply during our grant/readback.
    // Re-read it before verification; known IDs always take precedence.
    response = await readPrivatePairProviderResponse(context) ?? response;
    let receipt;
    try {
      receipt = await readback(response);
      requireValue(receipt !== null, "operation-readback-pending");
      if (response === null || response === undefined) {
        const known = await readPrivatePairProviderResponse(context);
        if (known !== null) {
          receipt = await readback(known);
          requireValue(receipt !== null, "operation-readback-pending");
        }
      }
    } catch (error) {
      if (grant.state !== "verified") await rollout.recordPublicReleasePairInstallOperation(context);
      if (error instanceof PrivatePairProviderError && !["request-failed", "operation-readback-pending", "deployment-missing", "application-readback-pending"].includes(error.code)) throw error;
      throw new PrivatePairProviderError("operation-readback-pending", true);
    }
    await rollout.recordPublicReleasePairInstallOperation({ ...context, readbackDigest: protocol.publicReleaseDigest(receipt) });
    return receipt;
  }

  const worker = await stage("identity", { name: prepared.applicationName, workersDev: false, previewUrls: false },
    () => provider.createWorkerIdentity(), async response => {
      const readback = await provider.readWorkerIdentity({ requireUndeployed: uploadOnly || prior?.state !== "uploaded" });
      if (response && readback) requireValue(readback.workerId === response.workerId, "worker-identity");
      return readback;
    });
  // These non-versioned controls are verified before version/deployment writes.
  await provider.readPrivateInventory();
  const version = await stage("version", { bundleDigest: plan.bundleDigest, configurationDigest: plan.configurationDigest },
    account => provider.uploadVersion({ readServiceAccount: () => account }), async response => {
      const readback = response ? await provider.readVersion({ versionId: response.workerVersionId }) : await provider.recoverVersion();
      if (readback === null) return null;
      // Namespace provisioning follows deployment. It is separately verified
      // below and cannot change the immutable pre-deployment upload receipt.
      const sealedVersion = { ...readback }; delete sealedVersion.namespaceId;
      return sealedVersion;
    });
  const uploadReadback = { planDigest: protocol.publicReleaseDigest(plan), publisherApplication: version.publisherApplication,
    workerVersionId: version.workerVersionId, bundleDigest: version.bundleDigest,
    configurationDigest: version.configurationDigest, imageDigest: version.imageDigest };
  await rollout.recordPublicReleasePairUploadReadback({ firestore, plan, readback: uploadReadback });
  if (uploadOnly) return Object.freeze({ schemaVersion: 1, kind: "private-pair-publisher-uploaded",
    planDigest: protocol.publicReleaseDigest(plan), worker, version, registered: false, deployed: false,
    publicSelectionChanged: false, publicationSuccess: false });
  const pair = await rollout.readPublicReleasePairUploadPair({ firestore, plan, workerVersionId: version.workerVersionId });
  await ownership.registerPublicReleasePair({ firestore, pair });
  await rollout.reservePublicReleasePairRollout({ firestore, pair });
  await provider.readPrivateInventory();
  const deployment = await stage("deployment", { workerVersionId: version.workerVersionId, trafficPercent: 100 },
    () => provider.deployVersion({ versionId: version.workerVersionId }), response => provider.readDeployment({
      versionId: version.workerVersionId, deploymentId: response?.deploymentId }));
  const namespace = await provider.readNamespace({ versionId: version.workerVersionId });
  const application = await stage("container", { namespaceId: namespace.namespaceId, imageReference: plan.imageReference,
    instanceType: "standard-2", maxInstances: 1 }, () => provider.createContainerApplication({ namespaceId: namespace.namespaceId }),
  response => response ? provider.readContainerApplication({ applicationId: response.applicationId, namespaceId: namespace.namespaceId })
    : provider.recoverContainer({ namespaceId: namespace.namespaceId, versionId: version.workerVersionId, deploymentId: deployment.deploymentId }));
  const trigger = prepared.continuationEnabled === true ? await stage("trigger", {
    workerVersionId: version.workerVersionId, schedules: [{ cron: "* * * * *" }] },
    () => provider.installOriginalTrigger({ versionId: version.workerVersionId }),
    response => {
      requireValue(!response || response.workerVersionId === version.workerVersionId, "trigger-identity");
      return provider.readOriginalTrigger({ versionId: version.workerVersionId });
    }, () => provider.prepareOriginalTrigger({ versionId: version.workerVersionId })) : null;
  const privacy = await provider.readPrivateInventory();
  checkCancellation(signal);
  const runtime = await provider.preflight({ identity });
  return Object.freeze({ schemaVersion: 2, kind: "private-pair-publisher-install", planDigest: protocol.publicReleaseDigest(plan),
    pair, worker, version, deployment, namespace, application, privacy, runtime, ...trigger ? { trigger } : {},
    executorReady: prepared.executorReady, publicSelectionChanged: false, publicationSuccess: false });
}
