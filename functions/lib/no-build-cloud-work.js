"use strict";

const { ownsPublication, samePublicationOwner, publicationRuntime } = require("./publication-runtime-owner");
const { validateState, validateCapability, effectiveNoBuildPostState } = require("./no-build-post-state");
const { assertCmsPublicationCloudAdmission, CmsPublicationRuntimeControlError } = require("./cms-publication-runtime-control");

const { contextOutputs } = require("./no-build-record-namespace");
const { slowBackgroundRetryDue, expiredBackgroundClaim } = require("./background-output-attempt");
const { verifiedPreviewProjection } = require("./editorial-preview-projection");
const FAMILIES = ["home", "listings", "authors", "feed", "contentApi", "sitemap", "search", "programs", "events"];
const STATE = "system/publicDeployment/noBuildPosts/current";
const CONTEXT = "system/publicDeployment/contexts/public";
const CAPABILITY = "system/publicDeployment/noBuildPosts/capability";

// Billing stops new spending. Runtime admission pauses still let accepted work
// drain and staged releases activate under the existing handoff contract.
async function cloudBillingPaused({ read, runtime }) {
  if (runtime?.owner !== "cloudflare") return false;
  return (await read("system/billing"))?.disabled === true;
}

function retryDue(value, now) {
  return ["pending", "failed", "building"].includes(value?.status) &&
    Number.isSafeInteger(value.attempts) && value.attempts < 4 &&
    Number.isFinite(value.nextAttemptAt) && value.nextAttemptAt <= now;
}

function previewContextDue(queue, pointer, now = Date.now(), claimMasked = false, preparation) {
  if (!["pending", "failed", "success"].includes(queue?.status)) return false;
  // A failed generated output cannot suppress retention of verified input.
  // Do not wake incomplete preparation work through this independent lane.
  if (queue.status !== "success" && !verifiedPreviewProjection(preparation, queue.runtime, queue.publicContext?.contextDigest) && !(preparation?.status === "verified" &&
      ownsPublication(preparation, queue.runtime) && preparation.contextDigest === queue.publicContext?.contextDigest &&
      /^[a-f0-9]{64}$/.test(preparation.preparedDigest ?? ""))) return false;
  const digest = /^[a-f0-9]{64}$/;
  const contextDigest = queue.publicContext?.contextDigest;
  const generation = pointer?.activeGeneration;
  if (!Number.isSafeInteger(generation) || generation < 1 || !digest.test(contextDigest ?? "")) {
    throw new Error("Invalid preview retention identity");
  }
  const preview = queue.previewContext;
  if (!preview) return true;
  if (preview.contextDigest !== contextDigest) throw new Error("Invalid preview retention context");
  if (preview.status === "verified") {
    if (!digest.test(preview.manifestId ?? "") || !digest.test(preview.publicationArtifactReceiptDigest ?? "")) {
      throw new Error("Invalid verified preview retention seal");
    }
    // Historical verified markers did not record the CODE generation.
    if (preview.publicationGeneration === undefined) return true;
    if (!Number.isSafeInteger(preview.publicationGeneration) || preview.publicationGeneration < 1) {
      throw new Error("Invalid verified preview retention generation");
    }
    return preview.publicationGeneration !== generation;
  }
  const terminal = preview.status === "failed" && preview.attempts === 4 && preview.nextAttemptAt === null;
  const seals = preview.manifestId === null && preview.publicationArtifactReceiptDigest === null ||
    digest.test(preview.manifestId ?? "") && digest.test(preview.publicationArtifactReceiptDigest ?? "");
  if (!["building", "failed"].includes(preview.status) ||
      !Number.isSafeInteger(preview.publicationGeneration) || preview.publicationGeneration < 1 ||
      !Number.isSafeInteger(preview.attempts) || preview.attempts < 1 || preview.attempts > 4 ||
      !Number.isFinite(preview.startedAt) || preview.startedAt < 0 ||
      !(terminal || Number.isFinite(preview.nextAttemptAt) && preview.nextAttemptAt >= preview.startedAt) || !seals ||
      preview.status === "building" && ((!claimMasked && !/^[A-Za-z0-9]{20}$/.test(preview.claim ?? "")) || !digest.test(preview.manifestId ?? ""))) {
    throw new Error("Invalid preview retention retry state");
  }
  if (preview.publicationGeneration !== generation) return true;
  // An interrupted final claim gets one wake to record terminal failure.
  return retryDue(preview, now) || preview.status === "building" && retryExhausted(preview, now);
}

function retryExhausted(value, now = Date.now()) {
  return ["failed", "building"].includes(value?.status) && Number.isSafeInteger(value.attempts) && value.attempts >= 4 &&
    (value.nextAttemptAt === null || Number.isFinite(value.nextAttemptAt) && value.nextAttemptAt <= now);
}

function publicContextProgressAt({ aggregate, queue, preparation, runtime, now, retainProgress = false }) {
  // Final-family progress still counts while settled bytes await their successor or preview retention.
  if (!(aggregate && ["pending", "failed", "success"].includes(queue?.status) && queue.transport === "public-context-no-build-v1" && preparation &&
    ownsPublication(aggregate, runtime) && ownsPublication(queue, runtime) && ownsPublication(preparation, runtime) &&
    preparation.contextDigest === aggregate.contextDigest &&
    (preparation.status === "verified" || queue.status === "pending" &&
      (preparation.status === "building" && preparation.nextAttemptAt > now ||
        retainProgress && ["building", "failed"].includes(preparation.status))))) return null;
  const progress = [preparation.progressAt, aggregate.progressAt].filter(at => Number.isFinite(at) && at >= 0 && at <= now);
  return progress.length ? Math.max(...progress) : null;
}

async function currentContextDigest(read) {
  const context = await read(CONTEXT);
  if (context?.schemaVersion !== 1 || !Number.isSafeInteger(context.revision) || context.revision < 1) {
    throw new Error("Invalid cloud context revision");
  }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`njpbs-public-context-v1:${context.revision}`));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function preparationAllowsWork(preparation, runtime, now) {
  return !preparation || (ownsPublication(preparation, runtime) &&
    (preparation.status === "verified" || retryDue(preparation, now)));
}

async function currentCloudPostStates({ read, listOwners, runtime }) {
  publicationRuntime(runtime);
  if (runtime.owner !== "cloudflare") throw new Error("Cloud work requires its cloud owner");
  const pointer = await read("system/publicDeployment");
  if (!pointer || !["idle", "deploying", "reconciling"].includes(pointer.state)) {
    throw new Error("Cloud publication coordinator is invalid");
  }
  if (pointer.state !== "idle" || pointer.activeCommitSha !== runtime.release) return [];
  const [legacy, records, rawCapability] = await Promise.all([
    read(STATE), listOwners ? listOwners() : [], read(CAPABILITY),
  ]);
  const capability = validateCapability(rawCapability);
  const owners = new Map();
  for (const record of [...records, ...(legacy ? [legacy] : [])]) {
    const state = validateState(record);
    if (!state || owners.has(state.postId)) throw new Error("Ambiguous cloud Post ownership");
    owners.set(state.postId, state);
  }
  const active = [];
  for (const state of [...owners.values()].sort((left, right) => left.postId.localeCompare(right.postId))) {
    const effective = effectiveNoBuildPostState(state, capability);
    if (!state.operationId || state.mode === "static" || !samePublicationOwner(state, runtime) ||
        effective.rendererSha !== runtime.release || (!effective.servingEnabled && state.visible !== false)) continue;
    const queue = await read(`cmsPublishQueue/${state.operationId}`);
    if (!queue || queue.transport !== "post-no-build-v1" || queue.noBuildPost?.postId !== state.postId ||
        queue.noBuildPost.operationId !== state.operationId || queue.noBuildPost.sourceVersion !== state.sourceVersion ||
        !samePublicationOwner({ runtime: queue.backgroundRuntime }, runtime)) continue;
    active.push(state);
  }
  return active;
}

/** Current Post operations only. Historical preparations never make a current
 * owner overdue; a code release uses its shared capability without rebinding it. */
async function activeCloudPostStates({ read, listOwners, runtime, now = Date.now() }) {
  if (await cloudBillingPaused({ read, runtime })) return [];
  const states = await currentCloudPostStates({ read, listOwners, runtime });
  if (!states.length) return [];
  const digest = await currentContextDigest(read);
  const active = [];
  for (const state of states) {
    const preparation = await read(`cmsPublishQueue/${state.operationId}/backgroundPreparation/${digest}`);
    if (preparationAllowsWork(preparation, runtime, now)) active.push(state);
  }
  return active;
}

/** Read-only hints shared by the Node operator and the minute Worker. Claims,
 * admission and activation still revalidate their durable transactions. */
async function readNoBuildCloudWork({ read, listOwners, runtime, now = Date.now() }) {
  let previewContext = false;
  const result = (maintenance, reconcile = false) => ({ maintenance, reconcile,
    ...(previewContext ? { previewContext: true } : {}) });
  publicationRuntime(runtime);
  if (runtime.owner !== "cloudflare") throw new Error("Cloud work requires its cloud owner");
  if (await cloudBillingPaused({ read, runtime })) return result(false);
  const pointer = await read("system/publicDeployment");
  if (!pointer || !["idle", "deploying", "reconciling"].includes(pointer.state)) {
    throw new Error("Cloud publication coordinator is invalid");
  }
  if (pointer.state !== "idle") return result(false, ownsPublication(pointer, runtime));
  // A new cloud release must reach its activation owner before it can prepare
  // successors for the active release. Historical context queues stay untouched.
  if (pointer.activeCommitSha !== runtime.release) return result(false);
  // A family successor may use an older queue even if the latest detail queue's
  // preparation is exhausted. Only the addressed task preparation governs it.
  const retainedOwners = listOwners && pointer.activeCommitSha === runtime.release ? await listOwners() : [];
  const owners = await currentCloudPostStates({ read, listOwners: async () => retainedOwners, runtime });
  const byPost = new Map(owners.map(state => [state.postId, state]));
  const contextJob = await read("system/publicDeployment/aggregateContexts/current");
  if (contextJob) {
    if (contextJob.schemaVersion !== 1 || !/^[A-Za-z0-9]{20}$/.test(contextJob.operationId ?? "") ||
        !/^[a-f0-9]{64}$/.test(contextJob.contextDigest ?? "") || !samePublicationOwner(contextJob, runtime)) {
      throw new Error("Invalid cloud aggregate context owner");
    }
    const digest = await currentContextDigest(read);
    if (pointer.activeCommitSha === runtime.release &&
        (contextJob.contextDigest !== digest || !ownsPublication(contextJob, runtime))) return result(true);
    // A historical Post-selected pointer needs one guarded aggregate handoff.
    // Once selected, ordinary retry paths keep the original preparation budget.
    if (contextJob.finalNamespaceOwner !== true) {
      const control = await read("system/cmsPublicationRuntime");
      try {
        assertCmsPublicationCloudAdmission(control ?? null, { commitSha: runtime.release });
        return result(true);
      } catch (error) {
        if (!(error instanceof CmsPublicationRuntimeControlError)) throw error;
      }
    } else if (!/^[A-Za-z0-9]{20}$/.test(contextJob.namespaceOperationId ?? "")) {
      throw new Error("Invalid final cloud namespace owner");
    }
    const queue = await read(`cmsPublishQueue/${contextJob.operationId}`);
    if (!queue || queue.transport !== "public-context-no-build-v1" || !ownsPublication(queue, runtime) ||
        queue.publicContext?.contextDigest !== digest) throw new Error("Invalid cloud aggregate context job");
    const previewPreparation = ["pending", "failed"].includes(queue.status) &&
      /^[A-Za-z0-9]{20}$/.test(contextJob.preparationOperationId ?? "")
      ? await read(`cmsPublishQueue/${contextJob.preparationOperationId}/backgroundPreparation/${digest}`) : null;
    try { previewContext = previewContextDue(queue, pointer, now, true, previewPreparation); }
    catch { /* Health keeps private state unreadable; accepted public work still runs. */ }
    if (["pending", "failed"].includes(queue.status) && pointer.activeCommitSha === runtime.release) {
      const preparationId = queue.status === "failed" ? contextJob.preparationOperationId ?? contextJob.operationId : contextJob.operationId;
      const preparation = await read(`cmsPublishQueue/${preparationId}/backgroundPreparation/${digest}`);
      if (queue.status === "pending" && preparation && ownsPublication(preparation, runtime) && retryExhausted(preparation, now)) return result(true);
      if (preparationAllowsWork(preparation, runtime, now) && (queue.status === "pending" || preparation?.status === "verified")) {
        let complete = true;
        for (const family of contextOutputs(queue.publicContext)) {
          const state = await read(`cmsBackgroundOutputs/${family}`);
          if (state?.contextOnly === true && ownsPublication(state, runtime) &&
              (contextJob.finalNamespaceOwner !== true || state.taskPath === `cmsPublishQueue/${contextJob.namespaceOperationId}/backgroundOutputs/${family}`) &&
              state.status === "verified" && state.receipt?.rendererSha === runtime.release && state.contextDigest === digest) continue;
          complete = false;
          const task = state?.taskPath ? await read(state.taskPath) : null;
          if (!task) throw new Error("Missing cloud aggregate family task");
          if (ownsPublication(task, runtime) && (slowBackgroundRetryDue(task, now) || expiredBackgroundClaim(task, now) ||
              queue.status === "pending" && (retryDue(task, now) || retryExhausted(task, now)))) return result(true);
        }
        // All family writes may have committed before queue settlement was interrupted.
        if (complete) return result(true);
      }
    }
  }
  if (!owners.length) {
    if (!contextJob && pointer.activeCommitSha === runtime.release && await read(CONTEXT)) {
      return result(true);
    }
    return result(false);
  }
  for (const state of owners) {
    const queue = await read(`cmsPublishQueue/${state.operationId}`);
    if (state.visible === false && queue?.homeFullBuild?.status === "reserved") return result(true);
  }
  const digest = await currentContextDigest(read);
  for (const family of FAMILIES) {
    const output = await read(`cmsBackgroundOutputs/${family}`);
    if (!output || !byPost.has(output.postId) || !samePublicationOwner(output, runtime)) continue;
    const changed = output.contextDigest !== digest || !ownsPublication(output, runtime) ||
      (output.status === "verified" && output.receipt?.rendererSha !== runtime.release);
    if (!changed && output.status === "verified") continue;
    // A context successor stays under its original queue even when the detail
    // operation advances. The task's exact owner/release remains the fence.
    if (typeof output.taskPath !== "string" ||
        !new RegExp(`^cmsPublishQueue/[A-Za-z0-9_-]{1,200}/backgroundOutputs/${family}(?:-[0-9]+)?$`).test(output.taskPath)) {
      throw new Error("Invalid cloud background task");
    }
    const task = await read(output.taskPath);
    if (!task || task.postId !== output.postId || !samePublicationOwner(task, runtime)) continue;
    const queueId = output.taskPath.split("/")[1];
    const queue = await read(`cmsPublishQueue/${queueId}`);
    if (!queue || queue.transport !== "post-no-build-v1" || queue.noBuildPost?.postId !== output.postId ||
        queue.noBuildPost.operationId !== queueId || !samePublicationOwner({ runtime: queue.backgroundRuntime }, runtime)) continue;
    const preparation = await read(`cmsPublishQueue/${queueId}/backgroundPreparation/${digest}`);
    if (preparationAllowsWork(preparation, runtime, now) &&
        (changed || (ownsPublication(task, runtime) && (retryDue(task, now) || slowBackgroundRetryDue(task, now) || expiredBackgroundClaim(task, now))))) {
      return result(true);
    }
  }
  return result(!contextJob && Boolean(await read(CONTEXT)));
}

module.exports = { cloudBillingPaused, readNoBuildCloudWork, currentCloudPostStates, activeCloudPostStates, retryDue, retryExhausted, previewContextDue, publicContextProgressAt };
