"use strict";

const { isDeepStrictEqual } = require("node:util");
const { contentLink } = require("./content-link");
const { dependency } = require("./post-background-outputs");
const { readPublicContextInTransaction, readPublicContextRevisionInTransaction, publicContextDigest } = require("./public-context-revision");

const { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, projectStaticInput, projectStaticProof, staticProofInput } = require("./no-build-post-static-proof");
function refuse(message = "The static Post return no longer matches its admitted publication.") {
  throw Object.assign(new Error(message), { status: 409 });
}
async function currentStaticPublication({ firestore, transaction, state }) {
  const document = (await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data();
  const current = dependency(document);
  const slug = document?.published?.metadata?.slug;
  if (state.mode !== "static" && (current.sourceVersion !== state.sourceVersion ||
      current.visible !== state.visible || slug !== state.slug)) refuse();
  const input = projectStaticInput({ schemaVersion: 1, postId: state.postId, operationId: state.operationId,
    sourceVersion: current.sourceVersion, visible: current.visible, slug,
    ownedSlugs: [...new Set([...state.ownedSlugs, ...current.slugs])].sort(), snapshotDigest: current.digest,
    contextDigest: await readPublicContextInTransaction(transaction, firestore) });
  return { input, metadata: document?.published?.metadata };
}
async function currentStaticInput(options) {
  return (await currentStaticPublication(options)).input;
}
async function staticReturnIntentInTransaction({ firestore, transaction, postId }) {
  const { state } = await require("./no-build-post-ownership").readNoBuildPostOwner({ firestore, transaction, postId });
  if (!state?.operationId || state.mode === "static" || state.postId !== postId) refuse();
  return currentStaticInput({ firestore, transaction, state });
}
async function assertStaticReturnIntentInTransaction({ firestore, transaction, intent }) {
  const expected = projectStaticInput(intent);
  const current = await staticReturnIntentInTransaction({ firestore, transaction, postId: expected.postId });
  if (!isDeepStrictEqual(current, expected)) refuse();
}
async function staticInputForQueueInTransaction({ firestore, transaction, queueId, queue: suppliedQueue }) {
  const queue = suppliedQueue ?? (queueId === undefined ? null :
    (await transaction.get(firestore.doc(`cmsPublishQueue/${queueId}`))).data());
  const owners = require("./no-build-post-ownership");
  const targetId = queue?.noBuildStaticReturn?.postId ?? queue?.changes?.find(change => change.collection === "cmsPosts")?.id;
  const retained = targetId ? [await owners.readNoBuildPostOwner({ firestore, transaction, postId: targetId })] :
    (await owners.listNoBuildPostOwners({ firestore, transaction })).filter(owner => owner.state.mode === "static");
  const staticOwners = retained.filter(owner => owner.state?.operationId && (owner.state.mode === "static" || queue?.noBuildStaticReturn));
  if (!staticOwners.length) return null;
  if (staticOwners.length !== 1) refuse("The source release must preserve every retained static Post proof.");
  const state = staticOwners[0].state;
  if (state.mode !== "static" && !queue?.noBuildStaticReturn) return null;
  if (queueId !== undefined && queue?.transport !== "serializer") refuse();
  if (queue?.noBuildStaticReturn) await assertStaticReturnIntentInTransaction({ firestore, transaction, intent: queue.noBuildStaticReturn });
  return currentStaticInput({ firestore, transaction, state });
}


async function assertStaticCandidateInTransaction({ firestore, transaction, state, candidate }) {
  const proof = projectStaticProof(candidate.noBuildStatic);
  if (proof.postId !== state.postId || proof.operationId !== state.operationId) refuse();
  const input = await currentStaticInput({ firestore, transaction, state });
  const expected = staticProofInput(proof);
  if (!isDeepStrictEqual(input, expected)) refuse();
  const batch = (await transaction.get(firestore.doc(`system/publicDeployment/buildBatches/${candidate.buildBatchId}`))).data();
  if (!batch || !isDeepStrictEqual(batch.noBuildStaticInput, expected)) refuse();
  // Outcome advances public context with the same transaction as ownership.
  const nextContextDigest = publicContextDigest((await readPublicContextRevisionInTransaction(transaction, firestore)) + 1);
  return { proof, nextContextDigest };
}
async function readStaticDecision({ firestore, transaction, state, pointer, rendererSha, path, candidate }) {
  const { input, metadata } = await currentStaticPublication({ firestore, transaction, state });
  const link = input.visible ? contentLink(metadata, `/posts/${input.slug}/`) : null;
  const match = /^\/posts\/([^/]+)\/$/.exec(path);
  const owned = match && input.ownedSlugs.includes(match[1]);
  const receipt = { schemaVersion: 1, postId: input.postId, operationId: input.operationId, generation: state.generation,
    sourceVersion: input.sourceVersion, visible: input.visible, slug: input.slug, ownedSlugs: input.ownedSlugs,
    rendererSha, mode: "static", contextDigest: input.contextDigest,
    ...(link?.external ? { contentRedirectUrl: link.href } : {}) };
  // A withdrawal always removes owned detail routes, even if it invalidates the
  // promoted-but-unsettled artifact. Aggregates remain fenced until replacement.
  if (owned && !input.visible) return { kind: "gone", receipt };
  let proof;
  if (candidate) {
    proof = (await assertStaticCandidateInTransaction({ firestore, transaction, state, candidate })).proof;
    receipt.generation = candidate.generation;
  } else {
    if (rendererSha !== state.rendererSha || pointer.state !== "idle" || pointer.activeCommitSha !== rendererSha) refuse();
    proof = projectStaticProof(state.staticProof);
    const expected = staticProofInput(proof);
    if (!isDeepStrictEqual(input, expected)) refuse();
  }
  if (owned && match[1] !== input.slug) return { kind: "alias", location: `/posts/${input.slug}/`, receipt };
  const lookup = !path.endsWith("/") && !/\.[^/]+$/.test(path) ? `${path}/` : path;
  const file = proof.files.find(file => file.path === lookup);
  return { kind: "static", receipt, staticFile: file ?? null };
}
module.exports = { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, projectStaticInput, projectStaticProof, staticProofInput, currentStaticInput,
  staticReturnIntentInTransaction, assertStaticReturnIntentInTransaction, staticInputForQueueInTransaction,
  assertStaticCandidateInTransaction, readStaticDecision };
