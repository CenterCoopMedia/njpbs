"use strict";
const { dependency, selectServingState } = require("./post-background-outputs");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");

/** One family receipt, never an HTTP request per card. Use the author reader's
 * exact current/last-good selection and withdrawal/staleness limits. */
async function readServingStaffAuthorPaths({ firestore, transaction, rendererSha, now, path }) {
  let namespace;
  try {
    namespace = await require("./no-build-post-publication").readNoBuildPostDecisionInTransaction({
      firestore, transaction, rendererSha, path });
  } catch (error) {
    if (error.status === 409) return new Set();
    throw error;
  }
  // null means the public reader deliberately yields to its static Assets.
  if (namespace.kind === "pass") return null;
  if (namespace.kind === "static") {
    try {
      const { state } = await require("./no-build-post-ownership").readNoBuildPostOwner({
        firestore, transaction, postId: namespace.receipt.postId });
      if (state?.mode !== "static" || state.operationId !== namespace.receipt.operationId ||
          state.rendererSha !== namespace.receipt.rendererSha) return new Set();
      const proof = require("./no-build-post-static-proof").projectStaticProof(state.staticProof);
      return new Set(proof.files.filter(file => /^\/authors\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(file.path)).map(file => file.path));
    } catch (error) {
      if (error.status === 409) return new Set();
      throw error;
    }
  }
  if (namespace.kind !== "background") return new Set();
  const [output, revision] = await transaction.getAll(firestore.doc("cmsBackgroundOutputs/authors"), firestore.doc(PUBLIC_CONTEXT_PATH));
  const state = output.data(), context = revision.data();
  // Infrastructure failures must reject this authority transaction, never
  // become a cacheable publishing label.
  const document = state && !state.contextOnly
    ? (await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data() : null;
  try {
    if (state?.output !== "authors" || context?.schemaVersion !== 1 ||
        ![context.withdrawalRevision ?? 0, context.homeRevision ?? 0].every(value => Number.isSafeInteger(value) && value >= 0)) return new Set();
    const source = state.contextOnly ? dependency(null) : dependency(document);
    const selected = selectServingState(state, source, { rendererSha, digest: publicContextDigest(context.revision),
      withdrawalRevision: context.withdrawalRevision ?? 0, homeRevision: context.homeRevision ?? 0,
      changedAt: context.changedAt?.toMillis?.() ?? null }, now.getTime());
    return new Set(selected.receipt.manifest.filter(file =>
      /^\/authors\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(file.path) && file.size > 0 &&
      file.contentType?.startsWith("text/html")).map(file => file.path));
  } catch {
    // The profile remains public on the roster; only its unconfirmed link waits.
    return new Set();
  }
}
module.exports = { readServingStaffAuthorPaths };
