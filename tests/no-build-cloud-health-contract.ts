import { readPublicationHealth, OVERDUE_MS } from "../publisher/publication-health";
import { documents, runtime, preparationPath, taskPath, digest, operation } from "./no-build-cloud-contract";
import cloudWork from "../functions/lib/no-build-cloud-work.js";

export async function checkCloudHealthContract() {
  const docs = documents();
  const read = async (path: string) => docs[path] ?? null;
  const now = 1000;
  const health = (time = now) => readPublicationHealth({ read, runtime, now: time });
  const check = async (healthy: boolean, reason?: string, time = now) => {
    const result = await health(time);
    if (result.healthy !== healthy || (reason && !result.reasons.includes(reason))) {
      throw new Error("Cloud durable-progress health contract differs");
    }
  };
  await check(true);
  await check(false, "work_overdue", 900 + OVERDUE_MS);
  docs[preparationPath] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  if ((await cloudWork.currentCloudPostStates({ read, runtime, listOwners: async () => [] })).length !== 1) {
    throw new Error("Health must retain the selected current owner before retry filtering");
  }
  await check(false, "preparation_exhausted");
  const admission = docs["system/noBuildPostAdmission"];
  docs["system/publicDeployment"].activeCommitSha = "b".repeat(40);
  await check(false, "preparation_exhausted");
  docs["system/publicDeployment"].activeCommitSha = runtime.release;
  admission.enabled = false;
  await check(false, "preparation_exhausted");
  admission.enabled = true;
  docs["system/noBuildPostAdmission"] = {};
  await check(false, "preparation_exhausted");
  docs["system/noBuildPostAdmission"] = admission;
  const queue = docs[`cmsPublishQueue/${operation}`];
  delete docs[`cmsPublishQueue/${operation}`];
  await check(false, "preparation_exhausted");
  docs[`cmsPublishQueue/${operation}`] = queue;
  docs[preparationPath] = { runtime, status: "building", attempts: 4, nextAttemptAt: 2000 };
  await check(true); // The fourth attempt still has its original bounded lease.
  docs[preparationPath].nextAttemptAt = 1000;
  await check(false, "preparation_exhausted");
  delete docs[preparationPath];
  docs[taskPath] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  await check(false, "family_exhausted");
  docs[taskPath] = { runtime, status: "pending", attempts: 1, nextAttemptAt: 2000 };
  await check(true); // A future retry does not start compute or count as exhausted.
  docs["system/publicDeployment/contexts/public"].withdrawalRevision = 1;
  docs["cmsBackgroundOutputs/listings"].lastGood = { receipt: { verifiedAt: now - 60_000, withdrawalRevision: 0 } };
  await check(false, "withdrawal_overdue"); // A non-pilot withdrawal has no explicit deadline.
  docs["cmsBackgroundOutputs/listings"].lastGood.receipt.verifiedAt = now;
  await check(true);
  docs["cmsBackgroundOutputs/listings"].withdrawalDeadlineRevision = 1;
  docs["cmsBackgroundOutputs/listings"].withdrawalDeadline = now;
  await check(false, "withdrawal_overdue");
  docs["cmsBackgroundOutputs/listings"].withdrawalDeadline = now + 60_000;
  docs["system/publicDeployment/contexts/public"].withdrawalRevision = 2;
  docs["cmsBackgroundOutputs/listings"].lastGood.receipt.verifiedAt = now - 60_000;
  await check(false, "withdrawal_overdue"); // A later removal cannot reuse another revision's grace.
  delete docs["system/publicDeployment/contexts/public"].withdrawalRevision;
  delete docs["cmsBackgroundOutputs/listings"].lastGood;
  delete docs["cmsBackgroundOutputs/listings"].withdrawalDeadlineRevision;
  delete docs["cmsBackgroundOutputs/listings"].withdrawalDeadline;
  docs["cmsBackgroundOutputs/listings"].pendingSince = now + 1;
  await check(false, "state_unreadable");
  docs["cmsBackgroundOutputs/listings"].pendingSince = 900;
  docs["cmsBackgroundOutputs/listings"].status = "verified";
  docs["cmsBackgroundOutputs/listings"].receipt = { rendererSha: runtime.release };
  await check(true, undefined, now + OVERDUE_MS);
  docs["cmsBackgroundOutputs/listings"].receipt.rendererSha = "b".repeat(40);
  await check(false, "work_overdue", now + OVERDUE_MS);
  docs["cmsBackgroundOutputs/listings"].runtime = { owner: "node-compute", release: runtime.release };
  await check(true, undefined, now + OVERDUE_MS); // Observe only the cloud-owned families.
  docs["cmsBackgroundOutputs/home"] = { runtime, status: "pending", contextDigest: digest,
    taskPath: `cmsPublishQueue/${"B".repeat(20)}/backgroundOutputs/home-2`, pendingSince: 900 };
  docs[docs["cmsBackgroundOutputs/home"].taskPath] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  await check(false, "family_exhausted");
  delete docs["cmsBackgroundOutputs/home"];
  docs["system/publicDeployment"] = { state: "reconciling", runtime, leaseAcquiredAt: 900 };
  await check(false, "activation_uncertain");
  docs["system/publicDeployment"].state = "deploying";
  await check(true);
  await check(false, "work_overdue", 900 + OVERDUE_MS);
  docs["system/publicDeployment"].runtime = { owner: "node-compute", release: runtime.release };
  await check(false, "work_overdue", 900 + OVERDUE_MS); // The shared fence still blocks cloud work.
}

export async function checkMultipleCloudHealthContract() {
  const docs = documents();
  const next = "B".repeat(20);
  const historical = "C".repeat(20);
  const states = [{ ...docs["system/publicDeployment/noBuildPosts/current"], postId: "second", operationId: next }];
  docs[`cmsPublishQueue/${next}/backgroundPreparation/${digest}`] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  docs[`cmsPublishQueue/${historical}/backgroundPreparation/${digest}`] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  const reads: string[] = [];
  const health = await readPublicationHealth({ runtime, now: 1000, listOwners: async () => states, read: async path => {
    reads.push(path); return docs[path] ?? null;
  } });
  if (health.healthy || !health.reasons.includes("preparation_exhausted") ||
      !reads.includes(`cmsPublishQueue/${operation}/backgroundPreparation/${digest}`) ||
      !reads.includes(`cmsPublishQueue/${next}/backgroundPreparation/${digest}`) ||
      reads.includes(`cmsPublishQueue/${historical}/backgroundPreparation/${digest}`)) {
    throw new Error("Health must observe every current owner and exclude historical preparation paths");
  }
}

export async function checkAggregateContextHealthContract() {
  const docs: Record<string, Record<string, any>> = {
    "system/publicDeployment": { state: "idle", activeCommitSha: runtime.release, activeGeneration: 1 },
    "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 1 },
    "system/publicDeployment/externalRefresh/current": { schemaVersion: 1, runtime, status: "verified", nextAttemptAt: 1_000_000 },
    "system/publicDeployment/aggregateContexts/current": { schemaVersion: 1, operationId: operation, contextDigest: digest, acceptedAt: 900, runtime },
    [`cmsPublishQueue/${operation}`]: { transport: "public-context-no-build-v1", status: "pending", runtime },
    [`cmsPublishQueue/${operation}/backgroundPreparation/${digest}`]: { runtime, status: "failed", attempts: 4, nextAttemptAt: null },
  };
  const read = async (path: string) => docs[path] ?? null;
  const failed = await readPublicationHealth({ runtime, now: 1000, read });
  if (failed.healthy || !failed.reasons.includes("preparation_exhausted")) throw new Error("Aggregate preparation exhaustion needs no Post owner to be unhealthy");
  delete docs[`cmsPublishQueue/${operation}/backgroundPreparation/${digest}`];
  const delayed = await readPublicationHealth({ runtime, now: 900 + OVERDUE_MS, read });
  if (delayed.healthy || !delayed.reasons.includes("work_overdue")) throw new Error("Aggregate acceptance must retain its original progress budget");
  docs[`cmsPublishQueue/${operation}`].status = "success";
  docs[`cmsPublishQueue/${operation}`].publicContext = { contextDigest: digest };
  docs[`cmsPublishQueue/${operation}`].previewContext = { status: "verified", contextDigest: digest,
    publicationGeneration: 1, manifestId: "b".repeat(64), publicationArtifactReceiptDigest: "c".repeat(64) };
  if (!(await readPublicationHealth({ runtime, now: 900 + OVERDUE_MS, read })).healthy) throw new Error("Settled aggregate context must be healthy");
  docs["system/publicDeployment/externalRefresh/current"].nextAttemptAt = 900;
  const missedRefresh = await readPublicationHealth({ runtime, now: 900 + OVERDUE_MS, read });
  if (missedRefresh.healthy || !missedRefresh.reasons.includes("work_overdue")) throw new Error("Verified provider history cannot hide a missed refresh");
  delete docs["system/publicDeployment/externalRefresh/current"];
  docs["system/publicDeployment/contexts/public"].changedAt = 900;
  const missingRefresh = await readPublicationHealth({ runtime, now: 900 + OVERDUE_MS, read });
  if (missingRefresh.healthy || !missingRefresh.reasons.includes("work_overdue")) throw new Error("Missing provider initialization must be unhealthy after its progress budget");
}

export async function checkMissingAggregateHealthContract() {
  const docs: Record<string, Record<string, any>> = {
    "system/publicDeployment": { state: "idle", activeCommitSha: runtime.release, activeGeneration: 1 },
    "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 1, changedAt: 900 },
  };
  const read = async (path: string) => docs[path] ?? null;
  if (!(await readPublicationHealth({ runtime, now: 1000, read })).healthy) throw new Error("Initial aggregate preparation has its normal progress budget");
  const delayed = await readPublicationHealth({ runtime, now: 900 + OVERDUE_MS, read });
  if (delayed.healthy || !delayed.reasons.includes("work_overdue")) throw new Error("Missing initial aggregate job must become overdue without any Post owner");
}

export async function checkPageHomeHealthContract() {
  const docs: Record<string, Record<string, any>> = {
    "system/publicDeployment": { state: "idle", activeCommitSha: runtime.release, activeGeneration: 1 },
    "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 1, changedAt: 1000 },
    "cmsBackgroundOutputs/home": { schemaVersion: 1, owner: "page-no-build-v1", pageId: "home", ownerPath: "system/publicDeployment/noBuildPageOwners/home" },
    "system/publicDeployment/noBuildPageOwners/home": { pageId: "home", ownedPaths: ["/", "/_home-sources.json"] },
  };
  const read = async (path: string) => docs[path] ?? null;
  if (!(await readPublicationHealth({ runtime, now: 1000, read })).healthy) throw new Error("Validated Page Home must yield legacy monitoring");
  docs["system/publicDeployment/noBuildPageOwners/home"].ownedPaths = ["/"];
  const invalid = await readPublicationHealth({ runtime, now: 1000, read });
  if (invalid.healthy || !invalid.reasons.includes("state_unreadable")) throw new Error("Invalid Home handoff must remain unhealthy");
}
