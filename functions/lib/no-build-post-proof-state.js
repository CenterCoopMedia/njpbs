"use strict";

const { publishedBlockResourceError } = require("./published-resource-check");
const { publicationAttempt } = require("./background-output-attempt");

const POST_PROOF_WARNING = "The public check failed after publication. The publisher will retry.";
const POST_PROOF_EXHAUSTED_WARNING = "The public check failed after publication. The publisher needs attention.";

function exhaustedPostProof(queue) {
  return queue?.transport === "post-no-build-v1" && queue.status === "success" &&
    queue.postProof?.status === "failed" && queue.postProof.nextAttemptAt === null &&
    Number.isSafeInteger(queue.postProof.attempts) && queue.postProof.attempts >= 4;
}

// Only the current publication's exhausted proof belongs in recovery. Read
// owners and records in batches, without hydrating unrelated publication jobs.
async function currentPostProofRecoveryIds(firestore, rows) {
  const candidates = rows.filter(row => exhaustedPostProof(row.data()) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(row.data().noBuildPost?.postId ?? ""));
  if (!candidates.length) return [];
  const legacy = (await firestore.doc("system/publicDeployment/noBuildPosts/current").get()).data();
  const postIds = [...new Set(candidates.map(row => row.data().noBuildPost.postId))];
  const current = new Map();
  for (let offset = 0; offset < postIds.length; offset += 100) {
    const batch = postIds.slice(offset, offset + 100);
    const documents = await firestore.getAll(...batch.flatMap(id => [
      firestore.doc(`system/publicDeployment/noBuildPostOwners/${id}`), firestore.doc(`cmsPosts/${id}`),
    ]));
    batch.forEach((id, index) => {
      const owner = documents[index * 2].data() ?? (legacy?.postId === id ? legacy : null);
      const record = documents[index * 2 + 1].data();
      if (owner?.mode !== "static" && record?.publicPostProof?.operationId === owner?.operationId &&
          postProofMetadata(record).postProofStatus === "failed") current.set(id, owner.operationId);
    });
  }
  const ids = candidates.filter(row => current.get(row.data().noBuildPost.postId) === row.id).map(row => row.id);
  return ids;
}

function postProofDue(queue, now) {
  return queue?.transport === "post-no-build-v1" && queue.status === "success" &&
    Boolean(publicationAttempt(queue.postProof, "postProof", now));
}

function postProofMetadata(document) {
  const proof = document?.publicPostProof;
  const sourceVersion = document?.published?.sourceVersion;
  if (!proof || !/^[A-Za-z0-9]{20}$/.test(proof.operationId ?? "") ||
      !Number.isSafeInteger(sourceVersion) || sourceVersion < 1 || proof.sourceVersion !== sourceVersion ||
      document.publiclyVisible !== true || document.publishBuildPending === true ||
      document.publicSourceVersion !== sourceVersion ||
      document.publishBuildSettlement?.status !== "success" ||
      document.publishBuildSettlement.sourceVersion !== sourceVersion ||
      document.publishBuildSettlement.operation !== "publish" ||
      !["pending", "failed", "verified"].includes(proof.status)) return {};
  const resourceError = proof.status === "failed" ? publishedBlockResourceError(document.published.blocks ?? [], "/posts/") : null;
  return { postServingConfirmed: proof.status !== "failed", postProofStatus: proof.status,
    postProofPending: proof.status !== "verified" && proof.retryPending === true,
    ...(proof.status === "failed" && proof.retryPending === false ? { postProofQueueId: proof.operationId } : {}),
    ...(proof.status === "failed" ? { postProofWarning: resourceError
      ? `The public page cannot be shown. ${resourceError}`
      : proof.retryPending ? POST_PROOF_WARNING : POST_PROOF_EXHAUSTED_WARNING } : {}) };
}

module.exports = { exhaustedPostProof, currentPostProofRecoveryIds, postProofDue, postProofMetadata, POST_PROOF_WARNING, POST_PROOF_EXHAUSTED_WARNING };
