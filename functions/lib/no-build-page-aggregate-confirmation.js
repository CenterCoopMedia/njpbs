"use strict";

const { refuse } = require("./no-build-page-ownership");
const { publicContextDigest } = require("./public-context-revision");
const { publicationTarget } = require("./publication-target");
const { readCmsPublicationRuntimeControlInTransaction, assertCmsPublicationCloudAdmission } = require("./cms-publication-runtime-control");

const FAMILIES = ["listings", "authors", "feed", "contentApi", "sitemap", "search"];
const { validContextOutputs } = require("./no-build-record-namespace");
const CURRENT_PATH = "system/publicDeployment/aggregateContexts/current";
function pendingContext() {
  throw Object.assign(new Error("Current Page aggregates are still pending."), { code: "page-context-pending" });
}
function assertPageContextReference(queue, state) {
  const reference = queue.contextPublication;
  if (!reference && state.contextQueueId === undefined) return false;
  if (!reference || !/^[A-Za-z0-9]{20}$/.test(reference.queueId ?? "") || reference.queueId !== state.contextQueueId ||
      reference.contextRevision !== state.contextRevision || reference.contextDigest !== state.contextDigest ||
      !validContextOutputs(reference.outputs)) refuse("Page aggregate ownership is unavailable.");
  return true;
}
async function currentPageContext({ firestore, transaction, rendererSha, contextDigest }) {
  const [pointer, context, current] = await transaction.getAll(firestore.doc("system/publicDeployment"),
    firestore.doc("system/publicDeployment/contexts/public"), firestore.doc(CURRENT_PATH));
  const runtime = { owner: "cloudflare", release: rendererSha };
  const identity = current.data();
  if (pointer.data()?.state !== "idle" || pointer.data().activeCommitSha !== rendererSha ||
      publicContextDigest(context.data()?.revision) !== contextDigest ||
      identity?.schemaVersion !== 1 || identity.runtime?.owner !== runtime.owner || identity.runtime.release !== runtime.release ||
      !Number.isSafeInteger(identity.contextRevision) || identity.contextRevision < 1 ||
      identity.contextRevision > context.data().revision || identity.contextDigest !== publicContextDigest(identity.contextRevision) ||
      !/^[A-Za-z0-9]{20}$/.test(identity.operationId ?? "")) refuse("Current Page aggregates are unavailable.");
  const ref = firestore.doc(`cmsPublishQueue/${identity.operationId}`);
  const queue = (await transaction.get(ref)).data();
  if (queue?.transport !== "public-context-no-build-v1" || queue.runtime?.owner !== runtime.owner ||
      queue.runtime.release !== runtime.release || queue.publicContext?.schemaVersion !== 1 || queue.publicContext.operationId !== identity.operationId ||
      queue.publicContext.contextRevision !== identity.contextRevision || queue.publicContext.contextDigest !== identity.contextDigest ||
      !["pending", "publishing", "failed", "success"].includes(queue.status)) refuse("Current Page aggregates are unavailable.");
  if (identity.contextRevision < context.data().revision) pendingContext();
  return { ref, queue, identity, runtime };
}

/** A staff retry of a Page operation also resumes its failed current context
 * job. Page completion itself never reads this job; see no-build-page-recovery. */
async function preparePageAggregateRetryInTransaction({ firestore, transaction, queue, state }) {
  if (!assertPageContextReference(queue, state)) return () => {};
  const pointer = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
  const context = (await transaction.get(firestore.doc("system/publicDeployment/contexts/public"))).data();
  let current;
  try {
    current = await currentPageContext({ firestore, transaction, rendererSha: pointer?.activeCommitSha,
      contextDigest: publicContextDigest(context?.revision) });
  } catch (error) {
    if (error?.code === "page-context-pending") return () => {};
    throw error;
  }
  if (current.queue.status !== "failed") return () => {};
  const control = await readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
  assertCmsPublicationCloudAdmission(control, { commitSha: current.runtime.release,
    serializerId: publicationTarget(firestore.projectId === "njpbs-site-dev" ? "development" : "production").serializerId });
  if ((await transaction.get(firestore.doc("system/billing"))).data()?.disabled === true) refuse("Public publication is paused by the billing control.");
  return require("./public-context-publication").retryPublicContextInTransaction({ firestore, transaction,
    operationId: current.identity.operationId, runtime: current.runtime });
}

module.exports = { FAMILIES, preparePageAggregateRetryInTransaction };
