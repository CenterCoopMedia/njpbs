"use strict";

const { createHash } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");

// One identity for every admitted public dependency, updated with its owning
// transaction. Draft-only writes never advance it. Recovery reads one document.
const PUBLIC_CONTEXT_PATH = "system/publicDeployment/contexts/public";
function bumpPublicContextRevision(transaction, firestore, { withdrawal = false, homePublication = false } = {}) {
  transaction.set(firestore.doc(PUBLIC_CONTEXT_PATH), {
    schemaVersion: 1, revision: FieldValue.increment(1), changedAt: FieldValue.serverTimestamp(),
    ...(homePublication ? { homeRevision: FieldValue.increment(1) } : {}),
    ...(withdrawal ? { withdrawalRevision: FieldValue.increment(1) } : {}),
  }, { merge: true });
}
async function readPublicContextRevisionInTransaction(transaction, firestore) {
  const snapshot = await transaction.get(firestore.doc(PUBLIC_CONTEXT_PATH));
  const state = snapshot.data();
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1) {
    throw new Error("Public context identity is unavailable");
  }
  return state.revision;
}
function publicContextDigest(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Public context identity is unavailable");
  return createHash("sha256").update(`njpbs-public-context-v1:${revision}`).digest("hex");
}
async function readPublicContextInTransaction(transaction, firestore) {
  return publicContextDigest(await readPublicContextRevisionInTransaction(transaction, firestore));
}
async function readPublicBackgroundContextInTransaction(transaction, firestore) {
  const [snapshot, deployment] = await transaction.getAll(firestore.doc(PUBLIC_CONTEXT_PATH),
    firestore.doc("system/publicDeployment"));
  const state = snapshot.data();
  if (state?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(deployment.data()?.activeCommitSha ?? "")) throw new Error("Public context is unavailable");
  return { digest: publicContextDigest(state.revision), rendererSha: deployment.data().activeCommitSha,
    withdrawalRevision: state.withdrawalRevision ?? 0, homeRevision: state.homeRevision ?? 0,
    changedAt: state.changedAt?.toMillis() ?? null };
}
module.exports = { readPublicBackgroundContextInTransaction, PUBLIC_CONTEXT_PATH, bumpPublicContextRevision, readPublicContextInTransaction,
  readPublicContextRevisionInTransaction, publicContextDigest };
