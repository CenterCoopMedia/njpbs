import cloudWork from "../functions/lib/no-build-cloud-work.js";

export const release = "a".repeat(40);
export const runtime = { owner: "cloudflare" as const, release };
export const operation = "A".repeat(20);
// Independent SHA-256 fixture for the public-context v1 revision-one contract.
export const digest = "6d0fea235ddd2bea4b171dc6ff77ba0f9e9abf2e23e687edb39d49a8847bfffc";
export const preparationPath = `cmsPublishQueue/${operation}/backgroundPreparation/${digest}`;
export const taskPath = `cmsPublishQueue/${operation}/backgroundOutputs/listings`;
export function documents(): Record<string, Record<string, any>> {
  return {
    "system/publicDeployment": { state: "idle", activeCommitSha: release, activeGeneration: 1 },
    "system/publicDeployment/aggregateContexts/current": { schemaVersion: 1, operationId: "D".repeat(20), contextDigest: digest, acceptedAt: 900, runtime },
    [`cmsPublishQueue/${"D".repeat(20)}`]: { transport: "public-context-no-build-v1", status: "success", runtime, publicContext: { contextDigest: digest },
      previewContext: { status: "verified", contextDigest: digest, publicationGeneration: 1, manifestId: "b".repeat(64), publicationArtifactReceiptDigest: "c".repeat(64) } },
    "system/publicDeployment/externalRefresh/current": { schemaVersion: 1, runtime, status: "verified", nextAttemptAt: Date.now() + 3_600_000 },
    "system/noBuildPostAdmission": { schemaVersion: 1, revision: 1, enabled: true, postId: "pilot", backgroundBucket: "fixture-bucket" },
    "system/publicDeployment/noBuildPosts/current": { schemaVersion: 1, servingEnabled: true,
      runtime, mode: "dynamic", operationId: operation, rendererSha: release, postId: "pilot", visible: true,
      sourceVersion: 1, slug: "pilot", ownedSlugs: ["pilot"], generation: 1 },
    "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 1, changedAt: 900 },
    [`cmsPublishQueue/${operation}`]: { transport: "post-no-build-v1", backgroundRuntime: runtime,
      noBuildPost: { postId: "pilot", operationId: operation, sourceVersion: 1 } },
    "cmsBackgroundOutputs/listings": { runtime, postId: "pilot", contextDigest: digest, status: "pending", taskPath, pendingSince: 900 },
    [taskPath]: { runtime, postId: "pilot", status: "pending", attempts: 0, nextAttemptAt: 1000 },
  };
}
// A prior release has a retained asset manifest and is still within its stale
// serving window. Healthy serving must not hide the required regeneration.
export function staleFamilyDocuments(): Record<string, Record<string, any>> {
  const docs = documents();
  const previous = { ...runtime, release: "b".repeat(40) };
  docs["cmsBackgroundOutputs/listings"] = {
    ...docs["cmsBackgroundOutputs/listings"], runtime: previous,
    owner: "post-background-v1", schemaVersion: 1, revision: 1, status: "verified",
    after: { visible: true, digest: "c".repeat(64) },
    receipt: { runtime: previous, rendererSha: previous.release, revision: 1,
      contextDigest: digest, verifiedAt: 900, withdrawalRevision: 0, assets: [] },
  };
  return docs;
}

export async function checkCloudWorkContract() {
  const observed = documents();
  observed[preparationPath] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  const observer = { read: async (path: string) => observed[path] ?? null, runtime, now: 1000 };
  if ((await cloudWork.currentCloudPostStates(observer)).length !== 1 ||
      (await cloudWork.activeCloudPostStates(observer)).length !== 0) {
    throw new Error("Health must retain current exhausted preparation while wake hints refuse it");
  }
  observed[preparationPath] = { runtime, status: "failed", attempts: 1, nextAttemptAt: 1001 };
  if ((await cloudWork.currentCloudPostStates(observer)).length !== 1 ||
      (await cloudWork.activeCloudPostStates(observer)).length !== 0) {
    throw new Error("Health must retain current backoff preparation while wake hints wait");
  }
  const unplaced = documents();
  delete unplaced["cmsBackgroundOutputs/listings"];
  unplaced["system/publicDeployment/noBuildPosts/current"].visible = false;
  unplaced[preparationPath] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  if ((await cloudWork.readNoBuildCloudWork({ runtime, now: 1000, read: async path => unplaced[path] ?? null })).maintenance) {
    throw new Error("Failed unplaced withdrawal must not bypass normal retry exhaustion for a nonexistent Home fallback");
  }
  const homeOnly = documents();
  delete homeOnly["cmsBackgroundOutputs/listings"];
  const homeTask = `cmsPublishQueue/${operation}/backgroundOutputs/home`;
  homeOnly["cmsBackgroundOutputs/home"] = { runtime, postId: "pilot", contextDigest: digest, status: "pending", taskPath: homeTask };
  homeOnly[homeTask] = { runtime, postId: "pilot", status: "pending", attempts: 0, nextAttemptAt: 1000 };
  const homeWork = () => cloudWork.readNoBuildCloudWork({ runtime, now: 1000, read: async path => homeOnly[path] ?? null });
  if (!(await homeWork()).maintenance) throw new Error("Home-only pending output must wake its existing cloud owner");
  homeOnly["system/publicDeployment/noBuildPosts/current"].visible = false;
  homeOnly["cmsBackgroundOutputs/home"].status = "failed";
  homeOnly[homeTask].attempts = 4;
  homeOnly[homeTask].nextAttemptAt = null;
  homeOnly[`cmsPublishQueue/${operation}`].homeFullBuild = { schemaVersion: 1, status: "reserved" };
  if (!(await homeWork()).maintenance) throw new Error("First Home removal must wake full-build fallback despite exhausted generation retries");
  homeOnly[`cmsPublishQueue/${operation}`].homeFullBuild.status = "queued";
  if ((await homeWork()).maintenance) throw new Error("Retained full-build fallback must not continuously wake exhausted Home work");
  const stale = staleFamilyDocuments();
  const staleWork = () => cloudWork.readNoBuildCloudWork({ runtime, now: 1000, read: async path => stale[path] ?? null });
  if (!(await staleWork()).maintenance) throw new Error("Readable prior release must still regenerate");
  const family = stale["cmsBackgroundOutputs/listings"];
  family.lastGood = { receipt: family.receipt, after: family.after };
  Object.assign(family, { runtime, status: "pending", receipt: null, revision: 2 });
  if (!(await staleWork()).maintenance) throw new Error("Readable last-good family must still wake due replacement");
  stale[taskPath].nextAttemptAt = 1001;
  if ((await staleWork()).maintenance) throw new Error("Readable last-good family must not bypass retry backoff");

  const docs = documents();
  const read = async (path: string) => docs[path] ?? null;
  const check = async (maintenance: boolean, reconcile = false) => {
    const result = await cloudWork.readNoBuildCloudWork({ read, runtime, now: 1000 });
    if (result.maintenance !== maintenance || result.reconcile !== reconcile) throw new Error("Cloud due-work contract differs");
  };
  await check(true);
  // Unchanged dependencies can keep a family's task in an earlier queue even
  // after the current detail operation advances. Its owner still fences it.
  const retainedTask = `cmsPublishQueue/${"B".repeat(20)}/backgroundOutputs/listings-2`;
  docs["cmsBackgroundOutputs/listings"].taskPath = retainedTask;
  docs[retainedTask] = { ...docs[taskPath] };
  docs[`cmsPublishQueue/${"B".repeat(20)}`] = { ...docs[`cmsPublishQueue/${operation}`],
    noBuildPost: { postId: "pilot", operationId: "B".repeat(20), sourceVersion: 1 } };
  await check(true);
  docs[retainedTask].nextAttemptAt = 1001;
  await check(false);
  docs[retainedTask].nextAttemptAt = 1000;
  docs[retainedTask].runtime = { owner: "node-compute", release };
  await check(false);
  docs["cmsBackgroundOutputs/listings"].taskPath = taskPath;
  docs[taskPath].nextAttemptAt = 1001;
  await check(false);
  docs[taskPath].nextAttemptAt = 1000;
  docs[taskPath].attempts = 4;
  await check(false);
  docs["cmsBackgroundOutputs/listings"].status = "verified";
  await check(true); // A legacy receipt needs the release identity added by #3072.
  docs["cmsBackgroundOutputs/listings"].receipt = { rendererSha: "b".repeat(40) };
  await check(true);
  docs["cmsBackgroundOutputs/listings"].receipt = { rendererSha: release };
  await check(false);
  docs["system/publicDeployment/contexts/public"].revision = 2;
  await check(true); // Non-Post context changes refresh even verified families.
  // Keep the independent context job current while proving retained Post wake.
  const nextDigest = "5a6eeba73a9c211d2c7b366c0f887963092ef52b7a2630a6c9993879f0c95b35";
  docs["system/publicDeployment/aggregateContexts/current"].contextDigest = nextDigest;
  docs[`cmsPublishQueue/${"D".repeat(20)}`].publicContext.contextDigest = nextDigest;
  docs[`cmsPublishQueue/${"D".repeat(20)}`].previewContext.contextDigest = nextDigest;
  docs["system/noBuildPostAdmission"].enabled = false;
  await check(true); // A pause fences new admissions, not accepted work.
  docs["system/publicDeployment/noBuildPosts/current"].visible = false;
  await check(true); // Admission pause never abandons withdrawal.
  docs["system/publicDeployment"].state = "deploying";
  docs["system/publicDeployment"].runtime = { owner: "node-compute", release };
  await check(false);
  docs["system/publicDeployment"].runtime = runtime;
  await check(false, true);
  docs["system/publicDeployment"].runtime = { ...runtime, release: "b".repeat(40) };
  await check(false);
  docs["system/publicDeployment"].state = "idle";
  docs["system/publicDeployment/noBuildPosts/current"].runtime = { owner: "node-compute", release };
  await check(false); // Post-only work cannot claim a node-compute owner.
  if ((await cloudWork.currentCloudPostStates({ read, runtime })).length) throw new Error("Cloud context must not claim the node-compute Post owner");
}

// #3221: context-only work never manufactures or claims a Post operation.
export async function checkCloudContextWorkContract() {
  const docs: Record<string, Record<string, any>> = {
    "system/publicDeployment": { state: "idle", activeCommitSha: release, activeGeneration: 1 },
    "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 1 },
  };
  const read = async (path: string) => docs[path] ?? null;
  const due = () => cloudWork.readNoBuildCloudWork({ runtime, now: 1000, read });
  if (!(await due()).maintenance) throw new Error("A cloud context without Posts must initialize");
  docs["system/publicDeployment/aggregateContexts/current"] = { schemaVersion: 1, operationId: operation, contextDigest: digest, runtime };
  docs[`cmsPublishQueue/${operation}`] = { transport: "public-context-no-build-v1", runtime, status: "pending", publicContext: { contextDigest: digest } };
  for (const family of ["listings", "authors", "feed", "contentApi", "sitemap", "search"]) {
    const path = `cmsPublishQueue/${operation}/backgroundOutputs/${family}`;
    docs[`cmsBackgroundOutputs/${family}`] = { taskPath: path, status: "pending", runtime, contextOnly: true, contextDigest: digest };
    docs[path] = { status: "pending", attempts: 0, nextAttemptAt: 1000, runtime };
  }
  if (!(await due()).maintenance) throw new Error("Context-only pending aggregates must wake");
  docs[preparationPath] = { runtime, status: "failed", attempts: 1, nextAttemptAt: 1001 };
  if ((await due()).maintenance) throw new Error("Context preparation must respect backoff");
  docs[preparationPath] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  if (!(await due()).maintenance) throw new Error("Interrupted context exhaustion must wake settlement once");
  docs[`cmsPublishQueue/${operation}`].status = "failed";
  if ((await due()).maintenance) throw new Error("Terminal context exhaustion must remain idle");
  docs[`cmsPublishQueue/${operation}`].status = "pending";
  docs[preparationPath] = { runtime, status: "verified" };
  for (const family of ["listings", "authors", "feed", "contentApi", "sitemap", "search"]) {
    docs[`cmsBackgroundOutputs/${family}`].status = "verified";
    docs[`cmsBackgroundOutputs/${family}`].receipt = { rendererSha: release };
  }
  if (!(await due()).maintenance) throw new Error("Complete families still need queue settlement");
  docs[`cmsPublishQueue/${operation}`].status = "success";
  if ((await due()).maintenance) throw new Error("Settled context must remain idle");
  if (!("previewContext" in await due()) || !(await due() as any).previewContext) throw new Error("Completed context must wake missing private retention");
  docs[`cmsPublishQueue/${operation}`].previewContext = { status: "verified", contextDigest: digest,
    publicationGeneration: 1, manifestId: "b".repeat(64), publicationArtifactReceiptDigest: "c".repeat(64) };
  if ((await due() as any).previewContext) throw new Error("Verified current private retention must remain idle");
  docs["system/publicDeployment/contexts/public"].revision = 2;
  if (!(await due()).maintenance) throw new Error("Context change must wake without a Post");
  const nextRelease = { owner: "cloudflare" as const, release: "b".repeat(40) };
  const releaseWork = await cloudWork.readNoBuildCloudWork({ runtime: nextRelease, now: 1000, read });
  if (releaseWork.maintenance || releaseWork.reconcile) throw new Error("Historical context must yield to the next release activation owner");
}
