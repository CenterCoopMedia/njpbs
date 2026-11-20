"use strict";

const { isServerMintableSlugShape } = require("./post-slug-contract");
const { validateState: validatePostState, validateCapability, effectiveNoBuildPostState, candidateNoBuildContract, candidateSupportsPost } = require("./no-build-post-state");

const LEGACY_STATE_PATH = "system/publicDeployment/noBuildPosts/current";
const OWNER_COLLECTION = "system/publicDeployment/noBuildPostOwners";
const CAPABILITY_PATH = "system/publicDeployment/noBuildPosts/capability";
const isNoBuildPostId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function refuse(message = "Instant Post ownership is unavailable.") {
  throw Object.assign(new Error(message), { status: 409 });
}

function validateState(value) {
  const state = validatePostState(value);
  if (state?.mode === "static") require("./no-build-post-static-return").projectStaticProof(state.staticProof);
  return state;
}

async function readSnapshot(ref, transaction) {
  return transaction ? transaction.get(ref) : ref.get();
}

/** Legacy ownership remains at its original path. New ownership has one document
 * per Post, so a second admission cannot overwrite the first operation. */
async function readNoBuildPostOwner({ firestore, transaction, postId }) {
  if (!isNoBuildPostId(postId)) refuse();
  const ref = firestore.doc(`${OWNER_COLLECTION}/${postId}`);
  const legacyRef = firestore.doc(LEGACY_STATE_PATH);
  const [row, legacyRow] = await Promise.all([readSnapshot(ref, transaction), readSnapshot(legacyRef, transaction)]);
  const state = validateState(row.data());
  const legacy = validateState(legacyRow.data());
  if (state && state.postId !== postId) refuse();
  if (state && legacy?.postId === postId) refuse("Two documents claim the same instant Post.");
  if (state) return { ref, state };
  if (legacy?.postId === postId) return { ref: legacyRef, state: legacy };
  return { ref, state: null };
}

/** Enumeration is read only. Code activation changes the shared capability,
 * never an unbounded set of retained Post or queue documents. */
async function listNoBuildPostOwners({ firestore, transaction, slug, onMalformedOwner }) {
  let query = firestore.collection(OWNER_COLLECTION);
  if (slug !== undefined) {
    if (!isServerMintableSlugShape(slug)) refuse();
    query = query.where("ownedSlugs", "array-contains", slug);
  }
  const legacyRef = firestore.doc(LEGACY_STATE_PATH);
  const [rows, legacyRow] = await Promise.all([readSnapshot(query, transaction), readSnapshot(legacyRef, transaction)]);
  const malformed = [];
  const owners = rows.docs.flatMap(row => {
    const value = row.data();
    try {
      const state = validateState(value);
      if (!state || state.postId !== row.id) refuse();
      return [{ ref: row.ref, state }];
    } catch (error) {
      // Ordinary aggregate readers can withhold this owner only if its route
      // scope still has a bounded, unambiguous identity.
      if (!onMalformedOwner || value?.postId !== row.id || !isNoBuildPostId(value.postId) || value.mode === "static" ||
          !isServerMintableSlugShape(value.slug) || !Array.isArray(value.ownedSlugs) || value.ownedSlugs.length > 100 ||
          !value.ownedSlugs.includes(value.slug) || value.ownedSlugs.some(path => !isServerMintableSlugShape(path)) ||
          new Set(value.ownedSlugs).size !== value.ownedSlugs.length) throw error;
      malformed.push({ postId: value.postId, ownedSlugs: value.ownedSlugs });
      return [];
    }
  });
  const legacy = validateState(legacyRow.data());
  if (legacy && (slug === undefined || legacy.ownedSlugs.includes(slug))) owners.push({ ref: legacyRef, state: legacy });
  const ids = [...owners.map(owner => owner.state.postId), ...malformed.map(owner => owner.postId)];
  if (new Set(ids).size !== ids.length) refuse("Two documents claim the same instant Post.");
  if (onMalformedOwner) malformed.forEach(onMalformedOwner);
  return owners.sort((left, right) => left.state.postId.localeCompare(right.state.postId));
}

async function readNoBuildPostCapability({ firestore, transaction }) {
  return validateCapability((await readSnapshot(firestore.doc(CAPABILITY_PATH), transaction)).data());
}

async function findNoBuildPostOwnersForSlug({ firestore, transaction, slug }) {
  const owners = await listNoBuildPostOwners({ firestore, transaction, slug });
  // A retained static Post can change its published slug before its next code
  // receipt. Resolve those source routes too; ownership still decides serving.
  const posts = firestore.collection("cmsPosts");
  const rows = await Promise.all([
    readSnapshot(posts.where("published.metadata.slug", "==", slug), transaction),
    readSnapshot(posts.where("published.metadata.previousSlugs", "array-contains", slug), transaction),
  ]);
  const ids = [...new Set(rows.flatMap(row => row.docs.map(doc => doc.id)))];
  const sourceOwners = await Promise.all(ids.map(postId => readNoBuildPostOwner({ firestore, transaction, postId })));
  const combined = new Map(owners.map(owner => [owner.state.postId, owner]));
  for (const owner of sourceOwners) {
    if (owner.state?.operationId) combined.set(owner.state.postId, owner);
  }
  return [...combined.values()];
}

async function readNoBuildPostStateInTransaction(input) {
  return (await readNoBuildPostOwner(input)).state;
}

async function listNoBuildPostStatesInTransaction(input) {
  return (await listNoBuildPostOwners(input)).map(owner => owner.state);
}

module.exports = { LEGACY_STATE_PATH, OWNER_COLLECTION, CAPABILITY_PATH, isNoBuildPostId, validateState, validateCapability,
  readNoBuildPostOwner, listNoBuildPostOwners, readNoBuildPostCapability,
  readNoBuildPostStateInTransaction, listNoBuildPostStatesInTransaction, effectiveNoBuildPostState,
  candidateNoBuildContract, candidateSupportsPost, findNoBuildPostOwnersForSlug };
